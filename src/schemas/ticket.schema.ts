import { z } from "zod";

// Priorities are configured per board: LOW / MEDIUM / HIGH always exist (they
// can be renamed or archived), custom ones get generated `p_…` keys. Writes
// accept a key or a title; update rejects an unknown or archived one, create
// falls back to the board's default.
const PRIORITY_DESCRIPTION =
  "Priority key or name from the ticket's board (see get_ticket_types → priorities). Built-in keys: LOW, MEDIUM, HIGH.";

// Custom form field values, shared by create_ticket, create_ticket_with_message
// and update_ticket so all three accept the same shapes. Rich-text fields take
// a TipTap document, which create_ticket used to refuse.
const TicketFormData = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Custom form field values for this ticket type. Keys are field names defined per ticket type — call get_ticket_types first to fetch the schema. Values are strings for text/email/textarea/number/single-select/rating fields, numbers for numeric scales, and string arrays for multi-select / priority-selection fields. Rich-text fields (e.g. `description`) take plain text, or a TipTap JSON document ({ type: 'doc', content: [...] }) for formatting such as headings and lists; a string is stored as plain text, so HTML and Markdown in it are not rendered. Example: { description: 'Crash on submit', severity: 'high', tags: ['ui', 'mobile'] }.",
  );

export const SearchTicketsArgs = z.object({
  searchTerm: z
    .string()
    .describe(
      "Free-text search across ticket title, body, and attached messages. Use this when you have keywords but no structured filter (status/assignee/tag). For structured filtering prefer find_tickets.",
    ),
});

export const FindTicketsArgs = z.object({
  status: z
    .string()
    .optional()
    .describe(
      "Filter by ticket status (lane KEY, not label). Every board has 'OPEN' (active) and 'DONE' (resolved/closed); boards also define their own lanes whose keys are opaque generated strings like '38jd9' — use get_ticket_types to see what a board offers. Omit to include tickets of any status.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      "Filter by ticket type. Accepts a single type key (e.g. 'BUG') or a comma-separated list (e.g. 'BUG,FEATURE_REQUEST'). Use 'BOT' to return bot conversations. Type keys are project-specific — call get_ticket_types to see them. Omit to include all types.",
    ),
  processingUser: z
    .string()
    .optional()
    .describe(
      "Filter to tickets assigned to this agent (Gleap user ID). Omit to include tickets assigned to anyone or unassigned.",
    ),
  priority: z
    .string()
    .optional()
    .describe(
      "Filter by priority: a key or name from the boards' priorities (see get_ticket_types → priorities), case-insensitive; comma-separate several (e.g. 'HIGH,Urgent'). A name matches that priority on every board that has it. Built-in keys: LOW, MEDIUM, HIGH; custom priorities have generated keys like 'p_…'.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Filter to tickets carrying any of these tag names. Matches if the ticket has at least one of the listed tags.",
    ),
  skip: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Pagination offset; number of tickets to skip. Default 0."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum tickets to return (1–100). Default 10."),
  sort: z
    .string()
    .optional()
    .describe(
      "Sort by a ticket field, optionally prefixed with '-' for descending. Examples: 'createdAt' (oldest first), '-createdAt' (newest first), '-updatedAt', 'priority'.",
    ),
  createdAtFrom: z
    .string()
    .optional()
    .describe(
      "Inclusive lower bound on the ticket's creation date — returns tickets created on or after this ISO-8601 timestamp (e.g. '2026-05-01T00:00:00.000Z').",
    ),
  createdAtTo: z
    .string()
    .optional()
    .describe(
      "Inclusive upper bound on the ticket's creation date — returns tickets created on or before this ISO-8601 timestamp.",
    ),
  updatedAtFrom: z
    .string()
    .optional()
    .describe(
      "Inclusive lower bound on the ticket's last-update date (ISO-8601 timestamp).",
    ),
  updatedAtTo: z
    .string()
    .optional()
    .describe(
      "Inclusive upper bound on the ticket's last-update date (ISO-8601 timestamp).",
    ),
  includeArchived: z
    .boolean()
    .optional()
    .describe(
      "Include archived tickets. By default only live (non-archived) tickets are returned, and AI conversations are archived automatically about 3 days after they end. Set true for reports, counts or any complete list over a date range.",
    ),
});

export const GetTicketArgs = z.object({
  ticketId: z
    .string()
    .describe(
      "The ticket to retrieve. Accepts the human-facing ticket number shown in the dashboard (e.g. '138803' from '#138803'), the 24-char ObjectId, or the shareToken. When a user references a ticket by its #number, pass that number here directly.",
    ),
});

export const CreateTicketArgs = z.object({
  type: z
    .string()
    .describe(
      "Ticket type key for this project (e.g. 'BUG', 'FEEDBACK', 'INQUIRY'). Types are project-specific — call get_ticket_types first to see the available types and their required formData fields.",
    ),
  title: z
    .string()
    .describe("Short human-readable title summarizing the ticket."),
  priority: z
    .string()
    .optional()
    .describe(
      `${PRIORITY_DESCRIPTION} Defaults to the board's default priority when omitted; an unknown or archived value falls back to the board's default priority.`,
    ),
  status: z
    .string()
    .optional()
    .describe(
      "Initial ticket status (lane KEY). Common values: 'OPEN' (default), 'DONE'. See get_ticket_types for the board's own lanes. Usually leave unset.",
    ),
  processingUser: z
    .string()
    .optional()
    .describe("User ID of the agent to assign the ticket to on creation."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tag names to attach to the ticket."),
  session: z
    .string()
    .optional()
    .describe(
      "Contact (end-user) ID the ticket belongs to. Use search_contacts or get_contact to resolve the ID from name/email.",
    ),
  formData: TicketFormData,
  preventAutoReply: z
    .boolean()
    .optional()
    .describe(
      "If true, suppress the 'Feedback received' confirmation email that Gleap otherwise sends to the contact when a ticket is created. Useful when migrating tickets from another system so users aren't double-notified. Default false.",
    ),
});

export const CreateTicketWithMessageArgs = z.object({
  type: z
    .string()
    .describe(
      "The ticket type (use get_ticket_types to see available options)",
    ),
  title: z.string().describe("The ticket title"),
  message: z
    .string()
    .optional()
    .describe("Optional initial message text for the ticket"),
  priority: z
    .string()
    .optional()
    .describe(
      `${PRIORITY_DESCRIPTION} Defaults to the board's default priority when omitted; an unknown or archived value falls back to the board's default priority.`,
    ),
  status: z
    .string()
    .optional()
    .describe(
      "Initial ticket status (lane KEY). Defaults to 'OPEN'. See get_ticket_types for the board's own lanes.",
    ),
  processingUser: z
    .string()
    .optional()
    .describe("User ID to assign the ticket to"),
  processingTeam: z
    .string()
    .optional()
    .describe("Team ID to assign the ticket to"),
  tags: z.array(z.string()).optional().describe("Tags to add to the ticket"),
  session: z
    .string()
    .optional()
    .describe(
      "Contact ID to associate with the ticket. Use either session or email, not both.",
    ),
  email: z
    .string()
    .optional()
    .describe(
      "Email address to associate with the ticket. If no contact exists with this email, one will be created automatically. Use either email or session, not both.",
    ),
  formData: TicketFormData,
  preventAutoReply: z
    .boolean()
    .optional()
    .describe(
      "If true, suppress the 'Feedback received' confirmation email that Gleap otherwise sends to the contact when a ticket is created. Default false.",
    ),
});

export const GetTicketTypesArgs = z.object({});

export const UpdateTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to update"),
  type: z
    .string()
    .optional()
    .describe(
      "Move the ticket to another board: the board's type KEY from get_ticket_types (e.g. 'FEATURE_REQUEST'). The ticket keeps its lane when the new board has it, else it lands in the new board's first lane; pass `status` (a lane KEY of the NEW board) to choose one.",
    ),
  status: z
    .string()
    .optional()
    .describe(
      "New status for the ticket — an exact lane KEY (e.g. '38jd9'), never the label from `statusLabel`. Look it up with get_ticket_types for the ticket's board.",
    ),
  priority: z
    .string()
    .optional()
    .describe(
      `New priority. ${PRIORITY_DESCRIPTION} An unknown or archived priority is rejected.`,
    ),
  processingUser: z
    .string()
    .optional()
    .describe("User ID to assign the ticket to"),
  processingTeam: z
    .string()
    .optional()
    .describe("Team ID to assign the ticket to"),
  tags: z.array(z.string()).optional().describe("Tags to set on the ticket"),
  title: z.string().optional().describe("New title for the ticket"),
  dueDate: z
    .string()
    .optional()
    .describe("Due date for the ticket (ISO format)"),
  formData: TicketFormData,
});

export const CloseTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to close"),
  asSpam: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY for junk/spam: archives the conversation into the Spam review queue, flags the sender's conversation, and suppresses every customer-facing follow-up (no CSAT, no notifications). A real-but-finished conversation is closed WITHOUT this flag.",
    ),
  reason: z
    .string()
    .optional()
    .describe("Short internal justification, shown in the ticket's activity log (used with asSpam)."),
});

export const ReopenTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to reopen"),
});

export const ArchiveTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to archive"),
});

export const UnarchiveTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to unarchive"),
});

export const SnoozeTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to snooze"),
  duration: z.number().describe("Snooze duration in minutes"),
});

export const AssignTicketArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to assign"),
  processingUser: z
    .string()
    .optional()
    .describe("User ID to assign the ticket to"),
  processingTeam: z
    .string()
    .optional()
    .describe("Team ID to assign the ticket to"),
});

export const AddTicketTagsArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to add tags to"),
  tags: z.array(z.string()).describe("Tags to add to the ticket"),
});

export const LinkTicketsArgs = z.object({
  ticketId: z.string().describe("The ID of the ticket to link from"),
  linkedTicketId: z.string().describe("The ID of the ticket to link to"),
});

export const MergeTicketsArgs = z.object({
  targetTicketId: z
    .string()
    .describe("The ID of the target ticket to merge into"),
  sourceTicketIds: z
    .array(z.string())
    .min(1)
    .describe("Array of source ticket IDs to merge into the target"),
});

export const GetTicketActivityLogArgs = z.object({
  ticketId: z
    .string()
    .describe("The ID of the ticket whose SDK activity log to read"),
  section: z
    .enum(["all", "console", "network", "actions"])
    .optional()
    .describe(
      "Return only one part of the log: console (console logs), network (network requests) or actions (clicks, page views and custom events). Default all. A single section gets a larger share of the size limit.",
    ),
  search: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Case-insensitive text to find in log messages, request methods, URLs and status codes, and click, page and event text. Only matching entries are returned, and matching requests include their redacted bodies even when they succeeded.",
    ),
});
