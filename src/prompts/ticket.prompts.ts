import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchWorkflow } from "../tools/session.tool.js";
import { gleapGetData } from "../utils/api.js";
import { ProjectCreds } from "../types/index.js";
import { getSessionScope, runInProject } from "../utils/credentials.js";
import { sessionRoute } from "../utils/kaiSession.js";
import { slimTicket } from "../utils/projections.js";
import { stripShareTokens } from "../utils/shareTokenRedaction.js";
import { untrustedBlock } from "../utils/untrustedBlock.js";

/**
 * MCP prompts (slash commands in most clients): `/fix_ticket #123` and
 * `/answer_ticket #123` start a Gleap ticket workflow in the agent with the
 * workflow text and a summary of the ticket.
 *
 * Prompts are not tools, so neither the session-scope policy nor the share
 * token redaction (both patch registerTool) covers them: they refuse
 * customer-scoped requests outright and strip tokens from the summary here.
 */

const TICKET_ARG = {
  ticket: z.string().min(1).max(40).describe("The ticket: #number (as shown in Gleap) or its 24-char id."),
};

// Multi-project connections only (utils/projectSelection.ts): ticket numbers repeat across projects.
const PROJECT_ARG = {
  project: z
    .string()
    .max(40)
    .optional()
    .describe("Gleap project id (from list_projects). Default: the main project, then the other projects."),
};

const ticketRef = (value: string): string => value.trim();

const loadTicket = async (ref: string): Promise<Record<string, any>> => {
  if (getSessionScope()) throw new Error("Gleap ticket prompts are not available in customer-scoped runs.");
  const fetched = await gleapGetData(`/tickets/${encodeURIComponent(ref.replace(/^#/, ""))}`);
  if ("error" in fetched) {
    const message = (fetched.error.structuredContent as any)?.message ?? "not found";
    throw new Error(`Ticket ${ref} could not be loaded from this Gleap project: ${message}`);
  }
  return (fetched.data ?? {}) as Record<string, any>;
};

/**
 * The ticket and, on a multi-project connection, the project it is in: the
 * named one, else the first project (main first) that has it.
 */
const findTicket = async (
  ref: string,
  projects: ProjectCreds[] | undefined,
  requested: string | undefined,
): Promise<{ data: Record<string, any>; project?: ProjectCreds }> => {
  if (!projects) return { data: await loadTicket(ref) };
  const candidates = requested
    ? projects.filter((project) => project.projectId === requested.trim())
    : projects;
  for (const project of candidates.filter((entry) => entry.apiKey)) {
    try {
      return { data: await runInProject(project, () => loadTicket(ref)), project };
    } catch {
      // Not in this project: try the next one.
    }
  }
  throw new Error(
    requested
      ? `Ticket ${ref} could not be loaded from Gleap project ${requested}.`
      : `Ticket ${ref} was not found in any connected Gleap project.`,
  );
};

/** For a multi-project connection: the project every following tool call must name. */
const projectLine = (project: ProjectCreds | undefined): string =>
  project
    ? `\n\nThe ticket is in Gleap project ${project.name || project.projectId}: pass projectId "${project.projectId}" to every Gleap tool call for it.`
    : "";

const inProject = <T>(project: ProjectCreds | undefined, fn: () => Promise<T>): Promise<T> =>
  project ? runInProject(project, fn) : fn();

const summaryOf = (ticket: Record<string, any>): string => {
  const slim = stripShareTokens(slimTicket(ticket)) as Record<string, unknown>;
  return JSON.stringify(slim, null, 2);
};

const workflowText = async (ref: string, kind: string): Promise<string> => {
  const route = sessionRoute({ ticketId: ref }, "agent-workflow")!;
  const res = await fetchWorkflow(route, kind, { ticketId: ref });
  const text = res.content.map((c) => c.text).join("\n\n");
  return res.isError ? `(The workflow could not be loaded: ${text})` : text;
};

const promptMessage = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export const registerTicketPrompts = (server: McpServer, projects?: ProjectCreds[]) => {
  const argsSchema = projects ? { ...TICKET_ARG, ...PROJECT_ARG } : TICKET_ARG;

  server.registerPrompt(
    "fix_ticket",
    {
      title: "Fix a Gleap ticket",
      description: "Work a Gleap bug report or feature request in this repository with Gleap's workflow: plan, fix, verify, open a PR, report progress.",
      argsSchema,
    },
    async ({ ticket, project: requested }: { ticket: string; project?: string }) => {
      const ref = ticketRef(ticket);
      const { data, project } = await findTicket(ref, projects, requested);
      const kind = data.type === "FEATURE_REQUEST" ? "feature" : "fix";
      const workflow = await inProject(project, () => workflowText(ref, kind));
      return promptMessage(
        `Work Gleap ticket ${ref} in this repository. You own this ticket until it is solved: keep working it through the customer's replies. Follow the workflow below; the ticket summary is the starting point, fetch the full ticket and conversation with the Gleap tools.${projectLine(project)}\n\n## Workflow\n${workflow}\n\n${untrustedBlock({ label: "Ticket", lang: "json", text: summaryOf(data) })}`,
      );
    },
  );

  server.registerPrompt(
    "answer_ticket",
    {
      title: "Answer a Gleap ticket",
      description: "Research a customer's question in this repository and answer the Gleap ticket with Gleap's workflow.",
      argsSchema,
    },
    async ({ ticket, project: requested }: { ticket: string; project?: string }) => {
      const ref = ticketRef(ticket);
      const { data, project } = await findTicket(ref, projects, requested);
      const workflow = await inProject(project, () => workflowText(ref, "answer"));
      return promptMessage(
        `Answer Gleap ticket ${ref} from what this repository's code does. You own this ticket until it is solved: keep working it through the customer's replies. Follow the workflow below; fetch the full conversation with the Gleap tools first.${projectLine(project)}\n\n## Workflow\n${workflow}\n\n${untrustedBlock({ label: "Ticket", lang: "json", text: summaryOf(data) })}`,
      );
    },
  );
};
