import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GleapApiResponse, ProjectCreds } from "../types/index.js";
import { wrapResponse } from "./api.js";
import { runInProject } from "./credentials.js";

/**
 * Multi-project OAuth grants: one connection, up to ten projects. The access
 * token lists them with a delegate key each (Gleap Server,
 * src/api/oauth/services/oauthGrantProjects.ts) and every tool call runs
 * against one of them:
 *
 *  - every tool gets an optional `projectId` argument, and `list_projects`
 *    names the projects;
 *  - a tool that only reads (`readOnlyHint`) without `projectId` uses the main
 *    project, and every result says which project it came from;
 *  - a tool that changes anything needs `projectId`. Without it the call is
 *    refused, so the model asks the user instead of guessing.
 *
 * A grant consented with several projects stays in this mode even when only
 * one is left, so a client still holding the old project list cannot write
 * into the wrong project. A listed project without a key (its workspace has
 * no Gleap MCP, or Gleap could not check it) is refused with the reason.
 * Applied only to multi-project grants: one-project connections, API-key
 * callers and Gleap's own agents see the tools exactly as before.
 */

export const PROJECT_ID_ARG = "projectId";
export const LIST_PROJECTS_TOOL = "list_projects";

const describeProject = (project: ProjectCreds) =>
  project.name ? `${project.name} (${project.projectId})` : project.projectId;

const projectList = (projects: ProjectCreds[]) => projects.map(describeProject).join(", ");

const unavailableReason = (project: ProjectCreds) =>
  project.error === "plan"
    ? `the workspace of ${describeProject(project)} has no Gleap MCP on its plan. An admin can upgrade it in Gleap`
    : `Gleap could not check ${describeProject(project)} just now. Try again in a few minutes`;

export type ToolProjectChoice = { project: ProjectCreds } | { error: string };

/**
 * The project one tool call runs against: the one it names by id, else the
 * main project for a read. A change without a project is refused, and so is
 * a project without a key.
 */
export const resolveToolProject = ({
  projects,
  requested,
  readOnly,
  toolName,
}: {
  projects: ProjectCreds[];
  requested: unknown;
  readOnly: boolean;
  toolName: string;
}): ToolProjectChoice => {
  const wanted = typeof requested === "string" ? requested.trim() : "";
  if (!wanted && !readOnly) {
    return {
      error:
        `${toolName} changes data in one Gleap project, so it needs projectId. ` +
        `Connected projects: ${projectList(projects)}. ` +
        "If the user has not said which project they mean, ask them first.",
    };
  }

  const project = wanted ? projects.find((entry) => entry.projectId === wanted) : projects[0];
  if (!project) {
    return {
      error: `projectId "${wanted.slice(0, 80)}" is not one of the connected projects: ${projectList(projects)}.`,
    };
  }
  if (!project.apiKey) return { error: `${toolName} cannot run: ${unavailableReason(project)}.` };
  return { project };
};

const refusal = (message: string): GleapApiResponse => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { error: true, projectSelection: true, message },
});

/** The result as the model sees it, with the project it came from as the last line. */
const withProjectLabel = (result: any, project: ProjectCreds) =>
  result && Array.isArray(result.content)
    ? { ...result, content: [...result.content, { type: "text", text: `Project: ${describeProject(project)}` }] }
    : result;

// Fixed text: project names live in list_projects and the server instructions only.
const READ_PROJECT_ARG = z
  .string()
  .optional()
  .describe(`Gleap project to read from (id from ${LIST_PROJECTS_TOOL}). Default: the main project.`);
const WRITE_PROJECT_ARG = z
  .string()
  .optional()
  .describe(`Gleap project to change (id from ${LIST_PROJECTS_TOOL}). Required: ask the user if they have not said which project.`);

/**
 * Patch `server.registerTool` so every tool registered afterwards takes
 * `projectId` and runs against that project's key. Call once per server
 * instance, after applyShareTokenRedaction and BEFORE applySessionScopePolicy
 * and the tool registrars: the project has to be chosen before any other
 * wrapper calls the API.
 */
export const applyProjectSelection = (server: McpServer, projects: ProjectCreds[]): void => {
  const originalRegisterTool = server.registerTool.bind(server);

  (server as any).registerTool = (name: string, meta: any, handler: (...handlerArgs: any[]) => any) => {
    if (name === LIST_PROJECTS_TOOL) return originalRegisterTool(name, meta, handler as any);

    const readOnly = meta?.annotations?.readOnlyHint === true;
    // The SDK calls a handler with (args, extra) only when its tool has an input schema.
    const takesArgs = meta?.inputSchema !== undefined;
    const withProjectArg = {
      ...meta,
      inputSchema: { ...(meta?.inputSchema ?? {}), [PROJECT_ID_ARG]: readOnly ? READ_PROJECT_ARG : WRITE_PROJECT_ARG },
    };

    const selected = async (args: any, extra: any) => {
      const { [PROJECT_ID_ARG]: requested, ...toolArgs } = args ?? {};
      const choice = resolveToolProject({ projects, requested, readOnly, toolName: name });
      if ("error" in choice) return refusal(choice.error);
      const result = await runInProject(choice.project, async () =>
        takesArgs ? handler(toolArgs, extra) : handler(extra),
      );
      return withProjectLabel(result, choice.project);
    };
    return originalRegisterTool(name, withProjectArg, selected as any);
  };
};

/** `list_projects`: the projects of this connection, main first. */
export const registerProjectTools = (server: McpServer, projects: ProjectCreds[]): void => {
  server.registerTool(
    LIST_PROJECTS_TOOL,
    {
      title: "List Projects",
      description:
        "The Gleap projects this connection can use, main project first. Pass a project's id as projectId to the other tools: reads without it use the main project, changes always need it.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (): Promise<GleapApiResponse> =>
      wrapResponse({
        projects: projects.map((project, index) => ({
          id: project.projectId,
          name: project.name,
          main: index === 0,
          ...(project.apiKey ? {} : { unavailable: unavailableReason(project) }),
        })),
      }),
  );
};

/** Added to the server instructions of a multi-project connection. */
export const projectInstructions = (projects: ProjectCreds[]): string =>
  `This connection covers several Gleap projects: ${projectList(projects)}. ${LIST_PROJECTS_TOOL} lists them. ` +
  "Tools that only read take an optional projectId and otherwise use the main project (the first one); " +
  "say which project an answer comes from. Tools that change anything need projectId: if the user has not said which project, ask them before calling.";
