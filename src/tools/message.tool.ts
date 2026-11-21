import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DraftReplyToComposerArgs,
  GetTicketMessagesArgs,
  SendMessageArgs,
} from "../schemas/message.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGet, gleapPost, gleapPut } from "../utils/api.js";
import { projectList, slimMessage } from "../utils/projections.js";

export const registerMessageTools = (server: McpServer) => {
  server.registerTool(
    "get_ticket_messages",
    {
      title: "Get Ticket Messages",
      description:
        "Get the full conversation history (messages) for a specific ticket in chronological order — user messages, AI bot answers, and human agent replies. Each message includes the visible text as plain text (TipTap/markdown flattened), the author (senderType: user/agent/bot/system, plus the sender id), AI answer signals (answerBot, hasAnswer, and cited sources), attachments, and timestamps. If your prompt already contains this ticket's conversation, call this only to page OLDER history beyond what was injected (skip/limit), never to re-read what you already have.",
      inputSchema: GetTicketMessagesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId, limit, skip }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/messages", {
        params: {
          ticket: ticketId,
          limit: limit ?? 50,
          skip: skip ?? 0,
        },
        listType: "message_list",
      });
      return projectList(response, slimMessage);
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a reply to the customer on a ticket, or add an internal note with isNote: true (the customer never sees notes). The text supports Markdown (bold, italic, links, lists, headings, code); workflow customer replies stay plain text. A reply reaches the customer right away, so send one only when the user asked for it or approved the text; to have them review it, show it to them in your own conversation first, or stage it in the ticket with draft_reply_to_composer. A coding agent working a ticket passes its sessionId: the reply is sent as the agent, and the result lists customer messages you have not read yet (read them before you go on). Once a PR is registered with report_progress, Gleap sends the fix and release messages itself, so a manual \"fixed\" or \"live\" reply would message the customer twice.",
      inputSchema: SendMessageArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    // `sessionId` is not sent in the body: it travels as X-Gleap-Session-Id
    // (utils/agentSession.ts), like the session the connection names.
    async ({ ticketId, text, isNote }): Promise<GleapApiResponse> => {
      const body = {
        ticket: ticketId,
        // Sent as Markdown; the backend converts it to TipTap JSON via
        // `convertMarkdownToTipTap` (see `markdownComment` in createComment).
        markdownComment: text,
        type: isNote ? "NOTE" : "TEXT",
        isNote: isNote ?? false,
      };
      return gleapPost("/messages", body);
    },
  );

  // A person's own AI client only: the API refuses Kai run keys and coding
  // sessions (Hard tickets, SPEC §6/§8) with a 410, which reaches the agent as
  // an error result.
  server.registerTool(
    "draft_reply_to_composer",
    {
      title: "Draft Reply to Composer",
      description:
        "Stage a drafted reply in the ticket's dashboard composer for a human to review, edit and send. Nothing is sent to the customer. The draft appears instantly for everyone viewing the ticket and replaces any existing draft (so it can also revise one); it is cleared once a reply is sent or the team dismisses it. Use it when the user asks for a draft or wants to review a reply in the ticket before it goes out, not as a side effect of another request; to send a reply, use send_message. The text supports Markdown. A coding agent working a ticket in a Gleap session cannot use it: ask your operator in your own conversation and send with send_message.",
      inputSchema: DraftReplyToComposerArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, text }): Promise<GleapApiResponse> => {
      // Markdown in; the backend converts to the composer's TipTap format.
      return gleapPut(`/tickets/${ticketId}/draft-message`, { content: text });
    },
  );
};
