import { z } from "zod";

export const GetTicketMessagesArgs = z.object({
  ticketId: z
    .string()
    .describe(
      "The ticket to get messages for. Accepts the human-facing ticket number shown in the dashboard (e.g. '143790' from '#143790'), the 24-char ObjectId, or the shareToken — the same identifiers get_ticket accepts.",
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum messages to return (default: 50)"),
  skip: z
    .number()
    .min(0)
    .optional()
    .describe("Number of messages to skip for pagination (default: 0)"),
});

/** Removed tool, kept for one release (message.tool.ts): its schema as it was. */
export const DraftReplyToComposerArgs = z.object({
  ticketId: z
    .string()
    .describe("The ID of the ticket to stage the drafted reply on"),
  text: z
    .string()
    .min(1)
    .describe(
      "The drafted reply, written exactly as it should be sent to the customer. " +
        "Supports Markdown: **bold**, *italic*, ~~strikethrough~~, `inline code`, " +
        "[links](https://example.com), bullet and numbered lists, # headings, " +
        "> blockquotes, and ``` fenced code blocks. Plain text renders as-is."
    ),
});

export const SendMessageArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to send the message to"),
  text: z
    .string()
    .describe(
      "The message text content to send. Supports Markdown: **bold**, *italic*, " +
        "~~strikethrough~~, `inline code`, [links](https://example.com), bullet and " +
        "numbered lists, # headings, > blockquotes, and ``` fenced code blocks. " +
        "Plain text renders as-is."
    ),
  isNote: z
    .boolean()
    .optional()
    .describe(
      "If true, sends as an internal note not visible to the customer (default: false)"
    ),
  sessionId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, "must be the 24-char Gleap coding-session id")
    .optional()
    .describe(
      "Coding agents working a ticket: your 24-char Gleap coding-session id (kickoff prompt, a report_progress result or .gleap/session.json). The reply is then sent as your session's agent, and Gleap checks that you have read the customer's latest messages."
    ),
});
