import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "Use the 24-character Gleap id");

export const BULK_TICKET_ACTIONS = ["tag", "close", "assign", "team", "priority", "snooze", "archive"] as const;

export const BulkUpdateTicketsArgs = z.object({
  ticketIds: z
    .array(objectId)
    .min(1)
    .max(200)
    .describe("Every ticket to change (ids from search_tickets / find_tickets), up to 200."),
  action: z
    .enum(BULK_TICKET_ACTIONS)
    .describe(
      "tag: add tags; close: close (runs each board's close workflows, e.g. the rating request); assign: to a teammate; team: to a team; priority: set a priority; snooze: hide for a while; archive.",
    ),
  tags: z.array(z.string().min(1).max(100)).max(10).optional().describe("tag: the tags to add, stored exactly as given."),
  userId: objectId.optional().describe("assign: the teammate's user id (get_users)."),
  teamId: objectId.optional().describe("team: the team id (get_teams)."),
  priority: z.string().min(1).max(60).optional().describe("priority: a priority key or title of the tickets' board (get_ticket_types)."),
  snoozeMinutes: z.number().int().min(5).max(60 * 24 * 90).optional().describe("snooze: for how long, in minutes."),
});

/** Removed tool, kept for one release (toolbox.tool.ts): its schema as it was. */
export const StartKaiResolveArgs = z.object({
  ticketId: objectId.describe("Ignored: this tool was removed and changes nothing. A hard ticket starts with Work on it on the ticket in Gleap."),
  guidance: z
    .string()
    .max(2000)
    .optional()
    .describe("Ignored: this tool was removed."),
});

const localizedText = z
  .record(z.string(), z.string().trim().min(1))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale");
const tiptapDoc = z.object({ type: z.literal("doc"), content: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const localizedDoc = z
  .record(z.string(), tiptapDoc)
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale");

export const SaveArticleDraftArgs = z.object({
  helpcenterCollectionId: objectId.describe("The article's collection id."),
  helpcenterArticleId: objectId.describe("The article id."),
  title: localizedText.optional().describe('New title per locale, e.g. { "en": "Refund policy" }.'),
  description: localizedText.optional().describe("New short description per locale."),
  content: localizedDoc
    .optional()
    .describe("New body per locale: a complete TipTap document ({ type: 'doc', content: [...] }). Locales you leave out keep their text."),
});

export const GetArticleDraftArgs = z.object({
  helpcenterCollectionId: objectId.describe("The article's collection id."),
  helpcenterArticleId: objectId.describe("The article id."),
});

export const PublishArticleDraftArgs = z.object({
  helpcenterCollectionId: objectId.describe("The article's collection id."),
  helpcenterArticleId: objectId.describe("The article id whose draft goes live."),
});

export const GetSnippetsArgs = z.object({
  searchTerm: z.string().max(200).optional().describe("Words in the question or answer."),
  // Models ask for 100 ("all of them"): accepted and read as the most a page holds (50), not refused.
  limit: z.number().int().min(1).max(200).optional().describe("How many (default 20, at most 50 are returned)."),
  skip: z.number().int().min(0).optional().describe("How many to skip, for the next page (the nextSkip of the last result)."),
});

export const CreateSnippetArgs = z.object({
  question: z.string().min(3).max(500).describe("The question as a customer would ask it."),
  answer: z.string().min(3).max(8000).describe("The answer Kai gives, in plain text or Markdown."),
  internal: z.boolean().optional().describe("true: only the team's agents use it, never shown to customers as a source."),
});

export const UpdateSnippetArgs = z.object({
  snippetId: objectId.describe("The snippet id (get_snippets)."),
  question: z.string().min(3).max(500).optional().describe("A new question."),
  answer: z.string().min(3).max(8000).optional().describe("A new answer."),
});

export const GetKnowledgeGapsArgs = z.object({
  limit: z.number().int().min(1).max(200).optional().describe("How many (default 20, at most 50 are returned), the most asked first."),
});

export const GetSupportHoursArgs = z.object({});

// The values Gleap's office-hours editor stores (and the schedule reads): a group of days or one day.
const DAYS = ["Weekdays", "Weekends", "All days", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
// The editor's steps: quarter hours, and 23:59 for the end of the day.
const clock = z.string().regex(/^(([01]\d|2[0-3]):(00|15|30|45)|23:59)$/, "Use HH:MM in quarter hours, e.g. 09:00, 17:30, or 23:59");

export const UpdateOfficeHoursArgs = z.object({
  openingTimes: z
    .array(z.object({ day: z.enum(DAYS), openingTime: clock, closingTime: clock }))
    .max(14)
    .optional()
    .describe('The whole week, replacing what is stored: rows of a day group or a day with its hours (days nobody names are closed), e.g. [{ day: "Weekdays", openingTime: "09:00", closingTime: "17:00" }].'),
  timezone: z.string().min(1).max(64).optional().describe('IANA timezone, e.g. "Europe/Vienna".'),
  alwaysOnline: z.boolean().optional().describe("true: show the team as always online, whatever the hours."),
});

export const UpdateSlaArgs = z.object({
  enabled: z.boolean().optional().describe("false switches the SLA off."),
  minutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .optional()
    .describe("The reply deadline for new conversations, in minutes (e.g. 240 for 4 hours)."),
});
