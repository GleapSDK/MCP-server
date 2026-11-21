import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AddTicketTagsArgs,
  ArchiveTicketArgs,
  AssignTicketArgs,
  CloseTicketArgs,
  CreateTicketArgs,
  CreateTicketWithMessageArgs,
  FindTicketsArgs,
  GetTicketActivityLogArgs,
  GetTicketArgs,
  GetTicketTypesArgs,
  LinkTicketsArgs,
  MergeTicketsArgs,
  ReopenTicketArgs,
  SearchTicketsArgs,
  SnoozeTicketArgs,
  UnarchiveTicketArgs,
  UpdateTicketArgs,
} from "../schemas/ticket.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { activityLogText, buildActivityLog } from "../utils/activityLog.js";
import {
  buildParams,
  gleapGet,
  gleapGetData,
  gleapPost,
  gleapPut,
  validationErrorResponse,
} from "../utils/api.js";
import {
  decorateTicket,
  getBoardContext,
  parsePriorities,
  resolvePriorityFilter,
} from "../utils/boardMeta.js";
import {
  projectList,
  projectSingle,
  slimTicket,
  slimTicketSearchHit,
} from "../utils/projections.js";

/**
 * The lane a ticket takes when update_ticket moves it to another board. The REST update stores
 * `status` as given, and a status that is no lane of the ticket's board hides it from every board
 * view, so a move keeps the ticket's lane when the new board has it and otherwise takes the new
 * board's first visible lane. An explicit `status` must be a lane of the new board.
 */
const laneOnBoard = async (
  ticketId: string,
  type: string,
  status: string | undefined,
): Promise<{ status: string | undefined } | { error: GleapApiResponse }> => {
  const { boards } = await getBoardContext();
  // No board config (the call failed): pass the move through as asked.
  if (boards.size === 0) return { status };
  const board = boards.get(type);
  if (!board) {
    return { error: validationErrorResponse(`"${type}" is not a board of this project. Call get_ticket_types for the board keys.`) };
  }
  const keys = board.statuses.map((lane) => lane.key);
  if (keys.length === 0) return { status };
  if (status) {
    return keys.includes(status)
      ? { status }
      : { error: validationErrorResponse(`"${status}" is not a lane of the ${board.name ?? type} board. Its lanes: ${keys.join(", ")}.`) };
  }
  const current = await gleapGetData(`/tickets/${ticketId}`);
  if ("error" in current) return current;
  const currentStatus = (current.data as any)?.status;
  if (typeof currentStatus === "string" && keys.includes(currentStatus)) return { status: undefined };
  return { status: board.statuses.find((lane) => !lane.hidden)?.key ?? keys[0] };
};

export const registerTicketTools = (server: McpServer) => {
  server.registerTool(
    "search_tickets",
    {
      title: "Search Tickets",
      description:
        "Free-text KEYWORD search across ticket title, body, and messages. Use when you have search terms. Do NOT also call find_tickets for the same intent (that one is for structured field filters, not keywords). Returns lightweight match summaries (id, title, status + human-readable statusLabel, priority + priorityLabel, type, tags, a content preview, relevance score, dashboardUrl); call `get_ticket` afterwards for a match you need to inspect in full.",
      inputSchema: SearchTicketsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ searchTerm }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/tickets/search", {
        params: { searchTerm },
      });
      const board = await getBoardContext();
      return projectList(response, (hit) =>
        decorateTicket(board, slimTicketSearchHit(hit)),
      );
    },
  );

  server.registerTool(
    "find_tickets",
    {
      title: "Find Tickets",
      description:
        "List/FILTER tickets by structured fields (status, assignee, priority, tags, date range) — NOT free-text; for keyword search use search_tickets instead, and don't call both for the same intent. Archived tickets are left out unless includeArchived is true — set it for reports and complete counts. Returns lightweight summaries (id, title, status + human-readable statusLabel, priority + priorityLabel, assignee, tags, AI summary, form data, timestamps, dashboardUrl); call `get_ticket` afterwards for a match whose full content and conversation you need.",
      inputSchema: FindTicketsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      status,
      type,
      processingUser,
      priority,
      tags,
      skip = 0,
      limit = 10,
      sort,
      createdAtFrom,
      createdAtTo,
      updatedAtFrom,
      updatedAtTo,
      includeArchived,
    }): Promise<GleapApiResponse> => {
      const board = await getBoardContext();
      const params = buildParams({
        skip,
        limit,
        status,
        type,
        // The query parser filters on raw ticket fields — the assignee lives
        // on `processingUser`; an `assignee` key silently matches nothing.
        processingUser,
        // The filter matches the stored key: titles / lowercase → keys.
        priority: resolvePriorityFilter(board, priority),
        tags,
        sort,
        // Date ranges use the REST query parser's operator syntax: it rejoins
        // `${key}=${value}`, so a key like "createdAt>" becomes "createdAt>=value"
        // → an inclusive ($gte/$lte) bound. The old startDate/endDate keys are
        // not fields on /tickets, so they matched zero tickets.
        "createdAt>": createdAtFrom,
        "createdAt<": createdAtTo,
        "updatedAt>": updatedAtFrom,
        "updatedAt<": updatedAtTo,
        // Archived and live tickets together (archived=true would mean archived only).
        ignoreArchived: includeArchived ? "true" : undefined,
      });
      const response = await gleapGet("/tickets", { params });
      return projectList(response, (ticket) =>
        decorateTicket(board, slimTicket(ticket)),
      );
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get Ticket",
      description:
        "Retrieve the full ticket by ID — content, conversation, form data, and all other fields, plus a human-readable `statusLabel` / `priorityLabel` and a `dashboardUrl` deep link. When Kai Support found a bug on the ticket, `kaiSupportFinding` has its finding (the bug, whether the cause is confirmed, its description and evidence): read it first when you fix the ticket, and treat it as leads to confirm in the code. Use this after `find_tickets` when the slim summary isn't enough. If your prompt already contains this ticket's injected context sections (Kai resolution runs inject the full ticket + conversation), do not re-fetch that same ticket — use this for OTHER tickets, e.g. matches from search_tickets/find_tickets.",
      inputSchema: GetTicketArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      // Kai Support's finding rides along (Server opt-in, 11-01): a coding app opened through the deeplink
      // starts from what Kai Support already found instead of investigating from scratch.
      const response = await gleapGet(`/tickets/${ticketId}`, { params: { include: "kaiSupportFinding" } });
      const board = await getBoardContext();
      return projectSingle(response, (ticket) => decorateTicket(board, ticket));
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create Ticket",
      description:
        "Create a new ticket in Gleap. Type and title are required. Use get_ticket_types to see available types and form data structure. The ticket counts as created by your team (like the dashboard's New ticket): it is not triaged as a customer report.",
      inputSchema: CreateTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      type,
      title,
      priority,
      status,
      processingUser,
      tags,
      session,
      formData,
      preventAutoReply,
    }): Promise<GleapApiResponse> => {
      const missing: string[] = [];
      if (type == null || String(type).trim() === "") missing.push("type");
      if (title == null || String(title).trim() === "") missing.push("title");
      if (missing.length > 0) {
        return validationErrorResponse(
          `Missing required field(s): ${missing.join(
            ", ",
          )}. Both type and title are required. Use get_ticket_types to see available ticket types.`,
        );
      }

      const body = buildParams({
        type,
        title,
        priority,
        status,
        // CreateTicketDto only knows `processingUser` — an `assignee` key is
        // silently dropped and the ticket lands unassigned.
        processingUser,
        tags,
        // CreateTicketDto knows `session`; a `users` key is silently dropped,
        // which filed the ticket under the caller instead of the contact.
        session,
        formData,
        preventAutoReply,
        // The dashboard's "New ticket" flag: an operator's ticket is the
        // team's, so Gleap never treats it as a customer report (Kai Resolve
        // bug triage, the customer "we're on it" reply).
        manuallyAdded: true,
      });
      return gleapPost("/tickets", body);
    },
  );

  server.registerTool(
    "create_ticket_with_message",
    {
      title: "Create Ticket with Message",
      description:
        "Create a new ticket with an optional initial message in a single step. This is the recommended way to create tickets. Use get_ticket_types first to see available types and their form fields.",
      inputSchema: CreateTicketWithMessageArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      type,
      title,
      message,
      priority,
      status,
      processingUser,
      processingTeam,
      tags,
      session,
      email,
      formData,
      preventAutoReply,
    }): Promise<GleapApiResponse> => {
      const missing: string[] = [];
      if (type == null || String(type).trim() === "") missing.push("type");
      if (title == null || String(title).trim() === "") missing.push("title");
      if (missing.length > 0) {
        return validationErrorResponse(
          `Missing required field(s): ${missing.join(
            ", ",
          )}. Both type and title are required. Use get_ticket_types to see available ticket types.`,
        );
      }

      const body = buildParams({
        type,
        title,
        message,
        priority,
        status,
        processingUser,
        processingTeam,
        tags,
        session,
        email,
        formData,
        preventAutoReply,
      });
      return gleapPost("/tickets/compose", body);
    },
  );

  server.registerTool(
    "get_ticket_types",
    {
      title: "Get Ticket Types",
      description:
        "Get the project's boards (ticket types): each one's custom data attributes (`schema` + `example`, for building formData), its configured status lanes (`statuses`: key + human-readable title + hidden flag), its priorities (`priorities`: key + title + archived + isDefault, most urgent first), and its dashboard URL segment (`path`). Call this whenever you need to explain, choose, or list ticket statuses or priorities — custom lanes and priorities have opaque generated keys (`38jd9`, `p_…`) whose only readable form is the title returned here. Archived priorities stay on existing tickets but can't be set.",
      inputSchema: GetTicketTypesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({}): Promise<GleapApiResponse> => {
      const response = await gleapGet("/projects/ticket-types");
      // Priorities as agents need them: the valid values and their names.
      return projectSingle(response, (payload) =>
        Array.isArray(payload?.ticketTypes)
          ? {
              ...payload,
              ticketTypes: payload.ticketTypes.map((entry: any) =>
                entry && typeof entry === "object" && "priorities" in entry
                  ? { ...entry, priorities: parsePriorities(entry) }
                  : entry,
              ),
            }
          : payload,
      );
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update Ticket",
      description:
        "Update a ticket's properties such as its board (move it, e.g. from Bugs to Feature requests), status, priority, assignee, tags, title, due date, or custom form data. `status` must be an exact lane KEY (e.g. '38jd9'), never the label shown in `statusLabel` — call get_ticket_types for the ticket's board to look the key up. A status that isn't one of that board's lane keys makes the ticket vanish from every board view. `priority` takes a key or title from the board's `priorities` (get_ticket_types); an unknown or archived one is rejected.",
      inputSchema: UpdateTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      ticketId,
      type,
      status,
      priority,
      processingUser,
      processingTeam,
      tags,
      title,
      dueDate,
      formData,
    }): Promise<GleapApiResponse> => {
      if (type) {
        const lane = await laneOnBoard(ticketId, type, status);
        if ("error" in lane) return lane.error;
        status = lane.status;
      }
      const body = buildParams({
        type,
        status,
        priority,
        processingUser,
        processingTeam,
        tags,
        title,
        dueDate,
        formData,
      });
      return gleapPut(`/tickets/${ticketId}`, body);
    },
  );

  server.registerTool(
    "close_ticket",
    {
      title: "Close Ticket",
      description:
        "Close a ticket. A plain close sets status DONE and runs the project's close workflows (e.g. CSAT). asSpam: true moves it into the Spam review queue instead and never contacts the customer. A coding agent working a ticket closes it here only when the user asks: once its PR is registered through report_progress, Gleap sends the fix messages, and the ticket is done when the customer confirms the fix or 24 hours after the last answer without a reply, never at the merge.",
      inputSchema: CloseTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, asSpam, reason }): Promise<GleapApiResponse> => {
      if (asSpam === true) {
        // close-as-spam = the AGENT verdict endpoint (done-status + Spam
        // review queue, no contact block). PUT /tickets/{id}/spam is the
        // dashboard's MANUAL verdict, which additionally blocks the contact.
        return gleapPut(`/tickets/${ticketId}/close-as-spam`, reason ? { reason } : {});
      }
      return gleapPut(`/tickets/${ticketId}`, { status: "DONE" });
    },
  );

  server.registerTool(
    "reopen_ticket",
    {
      title: "Reopen Ticket",
      description: "Reopen a closed ticket by setting its status to OPEN.",
      inputSchema: ReopenTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      return gleapPut(`/tickets/${ticketId}`, { status: "OPEN" });
    },
  );

  server.registerTool(
    "archive_ticket",
    {
      title: "Archive Ticket",
      description:
        "Archive a ticket to remove it from active views. When a coding agent's PR is registered through report_progress, Gleap manages the ticket's lifecycle, so such a ticket is archived here only when the user asks.",
      inputSchema: ArchiveTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      return gleapPut(`/tickets/${ticketId}/archive`, {});
    },
  );

  server.registerTool(
    "unarchive_ticket",
    {
      title: "Unarchive Ticket",
      description:
        "Unarchive a previously archived ticket to restore it to active views.",
      inputSchema: UnarchiveTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      return gleapPut(`/tickets/${ticketId}/unarchive`, {});
    },
  );

  server.registerTool(
    "snooze_ticket",
    {
      title: "Snooze Ticket",
      description:
        "Snooze a ticket for a number of minutes; it is hidden until the snooze ends. A coding agent waiting on an answer reports report_progress status needs_input with the question instead.",
      inputSchema: SnoozeTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, duration }): Promise<GleapApiResponse> => {
      // The API takes seconds; the tool's duration is in minutes.
      return gleapPut(`/tickets/${ticketId}/snooze`, { duration: Math.round(duration * 60) });
    },
  );

  server.registerTool(
    "assign_ticket",
    {
      title: "Assign Ticket",
      description:
        "Assign a ticket to a specific user or team. Use get_users or get_teams to find valid IDs.",
      inputSchema: AssignTicketArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      ticketId,
      processingUser,
      processingTeam,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({ processingUser, processingTeam });
      return gleapPut(`/tickets/${ticketId}`, body);
    },
  );

  server.registerTool(
    "add_ticket_tags",
    {
      title: "Add Ticket Tags",
      description:
        "Add tags to a ticket. New tags are merged with existing tags (no duplicates removed).",
      inputSchema: AddTicketTagsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, tags }): Promise<GleapApiResponse> => {
      const existing = await gleapGet(`/tickets/${ticketId}`);
      const existingTags: string[] =
        (existing.structuredContent as any)?.tags ?? [];
      const mergedTags = [...new Set([...existingTags, ...tags])];
      return gleapPut(`/tickets/${ticketId}`, { tags: mergedTags });
    },
  );

  server.registerTool(
    "link_tickets",
    {
      title: "Link Tickets",
      description: "Link two related tickets together for reference.",
      inputSchema: LinkTicketsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, linkedTicketId }): Promise<GleapApiResponse> => {
      return gleapPut(`/tickets/${ticketId}/link`, {
        targetTicketId: linkedTicketId,
      });
    },
  );

  server.registerTool(
    "merge_tickets",
    {
      title: "Merge Tickets",
      description:
        "Merge duplicate tickets into a single target ticket. The source tickets are archived and linked to the target, and their sub-tickets move to it; their messages stay on the sources. The target gets an internal note summarising each source (AI), plus their tags and upvotes. Contacts are not merged. Not idempotent and slower with several sources: a call that times out may still have merged.",
      inputSchema: MergeTicketsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ targetTicketId, sourceTicketIds }): Promise<GleapApiResponse> => {
      // The API does not exclude the target from the sources: it would archive itself.
      if (sourceTicketIds.includes(targetTicketId)) {
        return validationErrorResponse("The target ticket can't also be a source ticket.");
      }
      // The API merges with PUT and names the sources ticketsToMergeIds. Sub-tickets move
      // like in the dashboard; contacts stay apart so no customer is copied on another's ticket.
      return gleapPut("/tickets/merge", {
        targetTicketId,
        ticketsToMergeIds: sourceTicketIds,
        shouldCreateNewTicket: false,
        shouldMergeTasks: true,
        shouldMergeContacts: false,
      });
    },
  );

  server.registerTool(
    "get_ticket_activity_log",
    {
      title: "Get Ticket Activity Log",
      description:
        "Bug reports: call this before you try to reproduce, to see the console errors, failed network requests and the user's click trail. " +
        "It returns what the Gleap SDK captured in the customer's app with the ticket: console logs, network requests (method, URL, status, duration) and the click trail (clicks, page views, custom events), oldest first. " +
        "Request and response headers are never returned, secrets (tokens, API keys, passwords, cookies, card numbers) are replaced with [redacted], and bodies are included for failed requests and for requests matching search. " +
        "Long logs are trimmed: errors and failed requests are kept first, then the newest entries, and the summary says how many of each kind were shown (N of M). For more, including entries left out, use section (console, network or actions) or search (an error message, URL or status code). " +
        "This is not the ticket's conversation (use get_ticket_messages) and has no status or assignment history. If it returns a plan error (402), continue without logs.",
      inputSchema: GetTicketActivityLogArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId, section, search }): Promise<GleapApiResponse> => {
      const result = await gleapGetData(
        `/tickets/${encodeURIComponent(ticketId)}/activity-logs`,
      );
      if ("error" in result) return result.error;
      // The endpoint returns a bare array. Any other shape is refused without
      // its content: raw telemetry must never reach the client.
      if (!Array.isArray(result.data)) {
        const message =
          "Unexpected activity log response from the Gleap API (expected a list of entries).";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { error: true, message },
        };
      }
      const log = buildActivityLog({
        ticketId,
        entries: result.data,
        section,
        search,
      });
      return {
        content: [{ type: "text", text: activityLogText(log) }],
        structuredContent: log,
      };
    },
  );
};
