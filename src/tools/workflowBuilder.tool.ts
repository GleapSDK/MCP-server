import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ChangeWorkflowDraftArgs,
  CreateWorkflowDraftArgs,
  GetWorkflowBuildOptionsArgs,
  GetWorkflowStepsArgs,
  PublishWorkflowDraftArgs,
} from "../schemas/workflow.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGet, gleapPost, gleapPut, validationErrorResponse } from "../utils/api.js";

/**
 * Building workflows from steps: the same compiler and checks as Kai Copilot's workflow tools and the
 * editor's Publish (Server api/bots/workflowDrafts.service). Saves are drafts, a change to a live
 * workflow waits as a draft, and only publish_workflow_draft makes anything live, for the version the
 * person agreed to (draftHash). Every call acts with the connected person's role.
 */

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const DRAFT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false } as const;
const ID = /^[a-f0-9]{24}$/i;

/** A save the Server refused is a tool error, with what to fix. */
const withFailure = (response: GleapApiResponse, ok: string): GleapApiResponse => {
  const sc = response.structuredContent as any;
  return sc && sc[ok] === false && !sc.unchanged ? { ...response, isError: true } : response;
};

export const registerWorkflowBuilderTools = (server: McpServer) => {
  server.registerTool(
    "get_workflow_build_options",
    {
      title: "Get Workflow Build Options",
      description:
        "What a workflow can use, by name: teams, customer agents, ticket tags, priorities, Your API endpoints (with inputs and answer fields), webhooks, integrations, email sequences, contact fields and message variables. Read it before create_workflow_draft or change_workflow_draft. People are assigned by email (get_users).",
      inputSchema: GetWorkflowBuildOptionsArgs.shape,
      annotations: READ,
    },
    async (): Promise<GleapApiResponse> => gleapGet("/workflow-drafts/options"),
  );

  server.registerTool(
    "get_workflow_steps",
    {
      title: "Get Workflow Steps",
      description:
        "One conversation workflow step by step, in plain words: when it starts, its channels and audience, and every path with its id and numbered steps (what change_workflow_draft edits). `pending` is what could go live, with the hashes publish_workflow_draft needs and anything that blocks it.",
      inputSchema: GetWorkflowStepsArgs.shape,
      annotations: READ,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!ID.test(args.workflowId)) return validationErrorResponse("workflowId must be a workflow id from get_workflows.");
      return withFailure(await gleapGet(`/workflow-drafts/${args.workflowId}`), "found");
    },
  );

  server.registerTool(
    "create_workflow_draft",
    {
      title: "Create Workflow Draft",
      description:
        "Build a new conversation workflow from steps. Saved as a DRAFT: no customer gets it. Returns the steps in words, notes on what it means for Kai Support, editorUrl and draftHash; publish_workflow_draft makes it live after the person agreed. A tag condition sees the tags a conversation has at that moment: on a new conversation, add an ai_tag step first or use an ai condition. Teams, people (email), agents, endpoints, webhooks and sequences must exist (get_workflow_build_options, get_users); new ticket tags are added when it goes live. Steps that end a path (kai_answers, hand_to_agent, close, end, branch, buttons) come last in their list. A conversation_started workflow decides who answers new conversations on its channels: end a path with kai_answers wherever Kai Support should still answer. Collect data and Give Kai a task steps can't be built here: add them in the editor. When saved is false nothing was saved: fix what `problems` lists and call it again.",
      inputSchema: CreateWorkflowDraftArgs.shape,
      annotations: DRAFT,
    },
    async (args): Promise<GleapApiResponse> => withFailure(await gleapPost("/workflow-drafts", args), "saved"),
  );

  server.registerTool(
    "change_workflow_draft",
    {
      title: "Change Workflow Draft",
      description:
        "Change a conversation workflow: its name, trigger, channels, audience, and edits to its steps (read it with get_workflow_steps first for the path ids and step numbers). A draft changes directly. A live workflow never changes in place: the change waits as a draft and customers see no difference until publish_workflow_draft applies it. Kai Support's own workflow keeps its channels: update_workflow changes those. When saved is false nothing was saved: fix what `problems` lists and call it again.",
      inputSchema: ChangeWorkflowDraftArgs.shape,
      annotations: DRAFT,
    },
    async ({ workflowId, ...changes }): Promise<GleapApiResponse> => {
      if (!ID.test(workflowId)) return validationErrorResponse("workflowId must be a workflow id from get_workflows.");
      return withFailure(await gleapPut(`/workflow-drafts/${workflowId}`, changes), "saved");
    },
  );

  server.registerTool(
    "publish_workflow_draft",
    {
      title: "Publish Workflow Draft",
      description:
        "Make a drafted workflow live, or apply the change waiting on a live one, so it starts reaching customers. Only after the person agreed to what get_workflow_steps or the draft's answer showed them: pass that answer's draftHash (and liveHash for a change). A draft or live workflow that changed since is refused, and so is what the editor's Publish would refuse. A new webhook address must be confirmed by a person in the editor first.",
      inputSchema: PublishWorkflowDraftArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    },
    async ({ workflowId, draftHash, liveHash }): Promise<GleapApiResponse> => {
      if (!ID.test(workflowId)) return validationErrorResponse("workflowId must be a workflow id from get_workflows.");
      return withFailure(await gleapPost(`/workflow-drafts/${workflowId}/publish`, { draftHash, ...(liveHash ? { liveHash } : {}) }), "published");
    },
  );
};
