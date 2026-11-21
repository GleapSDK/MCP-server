import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetWorkflowsArgs,
  GetWorkflowsAvailableForTicketArgs,
  RunTicketWorkflowArgs,
} from "../schemas/workflow.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  gleapGet,
  gleapPost,
  validationErrorResponse,
  wrapResponse,
} from "../utils/api.js";
import { slimWorkflow, toIdString } from "../utils/projections.js";

const WORKFLOW_LIST_TYPE = "workflow_list";

/**
 * `wrapResponse` coerces the bare array `GET /bots` returns into
 * `{ results, count, type }` (MCP requires an object), so the bot list
 * lives at `structuredContent.results`. The bare-array branch stays as a
 * fallback in case the envelope ever goes away again.
 */
const botsFromResponse = (response: GleapApiResponse): any[] => {
  const sc = response.structuredContent as any;
  if (Array.isArray(sc?.results)) return sc.results;
  return Array.isArray(sc) ? sc : [];
};

/** True when a wrapped Gleap response carries an error envelope. */
const isErrorResponse = (response: GleapApiResponse): boolean => {
  const sc = response.structuredContent as any;
  return !!(sc && typeof sc === "object" && sc.error);
};

/**
 * True when a bot is a "workflow" as the dashboard defines one. Gleap has two
 * bot kinds — `workflow` and `aitask` — and legacy bots created before the
 * `type` field existed have no `type` at all. The backend defaults a typeless
 * bot to `workflow` (bots.service `type: payload.type || 'workflow'`) and the
 * in-ticket ⚡ "Run workflow" picker filters with exactly this predicate
 * (`!bot.type || bot.type === 'workflow'`). A strict `type === 'workflow'`
 * check silently drops those older typeless bots — which is why projects with
 * pre-`type` workflows saw an under-count here. Only `aitask` bots are
 * excluded; they are AI tasks, not runnable workflows.
 */
const isWorkflowBot = (bot: any): boolean =>
  !bot?.type || bot?.type === "workflow";

/**
 * Only conversation workflows run on a ticket. Pipeline automations
 * (PIPELINE_ENTRY) and survey automations (SURVEY_RESPONSE, trigger
 * "survey-response-completed") run on their own record and are refused by the
 * server's manual ticket start.
 */
const isConversationWorkflow = (bot: any): boolean =>
  !bot?.contextType || bot.contextType === "CONVERSATION";

type WorkflowAvailability =
  // An API call errored — return `response` to the caller verbatim.
  | { ok: false; response: GleapApiResponse }
  // Ticket exists but has no contact — nothing can be started on it.
  | { ok: true; hasContact: false }
  // Ticket has a contact — `liveWorkflows` are the startable workflows.
  | { ok: true; hasContact: true; liveWorkflows: any[] };

/**
 * Resolves which workflows can actually be started on a ticket via a manual
 * run. A manual start requires (matching the in-ticket ⚡ picker + the server's
 * `runWorkflowInTicket`): the ticket has a contact (`session`), and the bot is
 * a live workflow bot (`isWorkflowBot` — a `workflow` or legacy typeless bot,
 * NOT an `aitask`). It is NOT narrowed by channel/audience
 * — a manual start bypasses trigger conditions. Shared by
 * `get_workflows_available_for_ticket` and `run_ticket_workflow` so both agree
 * on what "available" means.
 */
const getTicketWorkflowAvailability = async (
  ticketId: string,
): Promise<WorkflowAvailability> => {
  const ticketResponse = await gleapGet(`/tickets/${ticketId}`);
  if (isErrorResponse(ticketResponse)) {
    return { ok: false, response: ticketResponse };
  }

  const ticket = ticketResponse.structuredContent as any;
  const hasContact = toIdString(ticket?.session) != null;
  if (!hasContact) {
    return { ok: true, hasContact: false };
  }

  const botsResponse = await gleapGet("/bots");
  if (isErrorResponse(botsResponse)) {
    return { ok: false, response: botsResponse };
  }

  const bots = botsFromResponse(botsResponse);
  const liveWorkflows = bots.filter(
    (bot) =>
      isWorkflowBot(bot) &&
      isConversationWorkflow(bot) &&
      bot?.status === "live",
  );

  return { ok: true, hasContact: true, liveWorkflows };
};

export const registerWorkflowTools = (server: McpServer) => {
  server.registerTool(
    "get_workflows",
    {
      title: "Get Workflows",
      description:
        "List all workflows (workflow-type bots) in the project, both live and draft. Use this for a full inventory. contextType says what a workflow runs on: CONVERSATION (tickets), PIPELINE_ENTRY (CRM pipeline automations) or SURVEY_RESPONSE (survey automations: trigger \"survey-response-completed\" runs once per completed Surveys 2.0 response, optionally scoped to one survey via triggerFilter.outboundId and filtered by answer conditions; teammates build them in the dashboard). To start a workflow on a ticket use get_workflows_available_for_ticket (only live conversation workflows on a ticket with a contact can be started), then run_ticket_workflow.",
      inputSchema: GetWorkflowsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      const response = await gleapGet("/bots");
      if (isErrorResponse(response)) return response;

      const workflows = botsFromResponse(response)
        .filter(isWorkflowBot)
        .map(slimWorkflow);

      return wrapResponse({
        results: workflows,
        count: workflows.length,
        type: WORKFLOW_LIST_TYPE,
      });
    },
  );

  server.registerTool(
    "get_workflows_available_for_ticket",
    {
      title: "Get Workflows Available For Ticket",
      description:
        "List the workflows that can actually be started on a specific ticket — i.e. the exact set run_ticket_workflow accepts. These are the project's live workflows, but only if the ticket has an associated contact; a ticket without a contact returns an empty list (nothing can be started on it).",
      inputSchema: GetWorkflowsAvailableForTicketArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      const availability = await getTicketWorkflowAvailability(ticketId);
      if (!availability.ok) return availability.response;

      if (!availability.hasContact) {
        return wrapResponse({
          results: [],
          count: 0,
          type: WORKFLOW_LIST_TYPE,
          note: "This ticket has no associated contact, so no workflow can be started on it.",
        });
      }

      const workflows = availability.liveWorkflows.map(slimWorkflow);
      return wrapResponse({
        results: workflows,
        count: workflows.length,
        type: WORKFLOW_LIST_TYPE,
      });
    },
  );

  server.registerTool(
    "run_ticket_workflow",
    {
      title: "Run Ticket Workflow",
      description:
        "Manually start a workflow on a ticket — the equivalent of the ⚡ 'Start a workflow' action inside a ticket. Only a live workflow that is available for the ticket can be started (call get_workflows_available_for_ticket first). The workflow runs asynchronously against the ticket's contact; a success response means it was accepted, not that it has finished.",
      inputSchema: RunTicketWorkflowArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, workflowId }): Promise<GleapApiResponse> => {
      const missing: string[] = [];
      if (ticketId == null || String(ticketId).trim() === "")
        missing.push("ticketId");
      if (workflowId == null || String(workflowId).trim() === "")
        missing.push("workflowId");
      if (missing.length > 0) {
        return validationErrorResponse(
          `Missing required field(s): ${missing.join(
            ", ",
          )}. Both ticketId and workflowId are required.`,
        );
      }

      const availability = await getTicketWorkflowAvailability(ticketId);
      if (!availability.ok) return availability.response;

      if (!availability.hasContact) {
        return validationErrorResponse(
          `Ticket ${ticketId} has no associated contact, so no workflow can be started on it.`,
        );
      }

      const match = availability.liveWorkflows.find(
        (workflow) => toIdString(workflow) === workflowId,
      );
      if (!match) {
        return validationErrorResponse(
          `Workflow '${workflowId}' is not available for ticket ${ticketId}. It may not exist, may be a draft (only live workflows can be started), or may belong to another project. Call get_workflows_available_for_ticket to see valid options.`,
        );
      }

      const response = await gleapPost(`/tickets/${ticketId}/workflow`, {
        workflowId,
      });
      if (isErrorResponse(response)) return response;

      return wrapResponse({
        success: true,
        ticketId,
        workflowId,
        workflowName: match.name ?? null,
        message: `Workflow '${
          match.name ?? workflowId
        }' has been started on ticket ${ticketId}. It runs asynchronously — check the ticket timeline for progress.`,
      });
    },
  );
};
