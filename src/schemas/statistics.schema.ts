import { z } from "zod";

// Base parameters for the aggregated endpoints (facts / lists / bar-chart).
// The raw-data endpoint deliberately does NOT build on this — see the comment on
// GetRawDataStatisticsArgs below.
//
// Everything declared here is forwarded verbatim as a query param, so only add a
// field the statistics API actually accepts. `groupedBy`, `createdAt` and
// `updatedAt` used to live here and were removed: the backend parses `groupedBy`
// and then never uses it, and `createdAt`/`updatedAt` are matched against columns
// of the events table as *equality* filters — `updatedAt` isn't a column at all,
// so passing it fails the whole query. Use startDate/endDate for the period.
const BaseStatsParams = z.object({
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone name (e.g. 'Europe/Paris', 'UTC') used to bucket dates and evaluate working-hours logic. Defaults to UTC.",
    ),
  groupInterval: z
    .enum(["day", "month", "year"])
    .optional()
    .describe(
      "Bucket size for time-grouped results. Only applies to bar-chart style endpoints.",
    ),
  skip: z
    .number()
    .optional()
    .describe(
      "Accepted but ignored — statistics results are not paginated. Narrow the period instead.",
    ),
  limit: z
    .number()
    .optional()
    .describe(
      "Accepted but ignored — each metric returns its full result set (some lists apply a fixed internal cap).",
    ),
  aggsType: z
    .enum(["MEDIAN", "AVERAGE"])
    .optional()
    .describe(
      "Aggregation mode for time-based metrics (reply time, time-to-close, etc.). 'MEDIAN' returns the 50th percentile, 'AVERAGE' returns the mean. Default: MEDIAN. Count-based and rating metrics are unaffected.",
    ),
  startDate: z
    .string()
    .optional()
    .describe(
      "Inclusive lower bound of the reporting period (ISO-8601 timestamp).",
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Inclusive upper bound of the reporting period (ISO-8601 timestamp).",
    ),
});

// Ticket-scope filters that the statistics backend applies to facts/lists/bar-chart queries.
// All are optional; when omitted, tickets of any type / tag / processing user are included.
const TicketScopeFilters = {
  "data.type_in": z
    .array(z.string())
    .optional()
    .describe(
      "Restrict metrics to tickets whose type is in this list (e.g. ['BUG', 'FEEDBACK', 'INQUIRY', 'FEATURE_REQUEST']). When omitted, every ticket type is included — including bot/survey/system-generated tickets, which can inflate counts. To reproduce a scoped report, pass the exact list of customer-facing ticket types in use.",
    ),
  "data.tags_in": z
    .array(z.string())
    .optional()
    .describe(
      "Restrict metrics to tickets tagged with any of these tag names. When omitted, tags are not filtered.",
    ),
  "data.processingUser": z
    .string()
    .optional()
    .describe(
      "Restrict metrics to actions performed by a specific agent (user ID). Used to scope per-agent reports.",
    ),
  useWorkingHours: z
    .boolean()
    .optional()
    .describe(
      "If true, time-based metrics (reply time, time-to-close, time-to-first-assignment) are computed using business hours only, skipping off-hours and weekends per the project's working-hours configuration. Default: false.",
    ),
};

// Statistics tool arguments - main endpoint
export const GetStatisticsArgs = BaseStatsParams.extend({
  factType: z
    .enum([
      "MEDIAN_FIRST_RESPONSE_TIME",
      "MEDIAN_TIME_TO_CLOSE",
      "TICKET_CLOSE_COUNT",
      "MEDIAN_CONVERSATION_RATING",
      "TICKET_MEDIAN_REPLY_TIME",
      "MEDIAN_FIRST_ASSIGNMENT_TIME",
      "NEW_TICKETS_COUNT",
      "TICKET_COUNT_BY_QUERY",
      "TICKET_REPLIES_COUNT",
      "TICKET_WORKED_ON_COUNT",
      "TICKETS_WITH_OTHER_STATUS_THEN_OPEN_OR_CLOSED_COUNT",
      "HELP_CENTER_ARTICLE_VIEW_COUNT",
      "NEWS_VIEW_COUNT",
      "KAI_ANSWERED_COUNT",
      "KAI_NO_ANSWER_COUNT",
      "KAI_ROUTED_TO_AGENT_RATE_COUNT",
      "KAI_DEFLECTION_RATE",
      "KAI_ROUTED_TO_AGENT_RATE",
      "KAI_POSITIVE_FEEDBACK_COUNT",
      "KAI_NEGATIVE_FEEDBACK_COUNT",
      "KAI_POSITIVE_FEEDBACK_PERCENTAGE",
      "SNAPSHOT_AGENTS_ONLINE_COUNT",
      "SNAPSHOT_OPEN_TICKETS",
      "MESSAGE_COUNT",
      "AI_QUESTIONS_ASKED_COUNT",
      "SLA_BREACHES",
      "SLA_COMPLIANCE",
      "SLA_NOT_COMPLIANCE",
      "SLA_BREACHES_COUNT",
      "SLA_NO_BREACHES_COUNT",
      "TICKETS_WITHOUT_COMMENTS_RATE",
      "KAI_DEFLECTION_COUNT",
      "KAI_ROUTED_TO_AGENT_COUNT",
    ])
    .optional(),
  chartType: z
    .enum([
      "NEW_TICKETS_COUNT",
      "TICKET_CLOSE_COUNT",
      "REPLIES_COUNT",
      "MEDIAN_FIRST_RESPONSE_TIME",
      "MEDIAN_TIME_TO_CLOSE",
      "MEDIAN_REPLY_TIME",
      "MEDIAN_CONVERSATION_RATING",
      "MEDIAN_REASSIGNMENT_COUNT",
      "MEDIAN_TIME_TO_FIRST_ASSIGNMENT",
      "HELP_CENTER_ARTICLE_VIEW_COUNT",
      "NEWS_VIEW_COUNT",
      "KAI_INVOLVED",
      "MESSAGE_COUNT",
      "AI_QUESTIONS_ASKED_COUNT",
      "CUSTOMER_SUPPORT_REQUESTED",
      "SLA_BREACHES_COUNT",
      "SLA_STARTED_COUNT",
      "TICKET_CREATION_GROUPED_BY_DATE_AND_TAGS",
      "AI_RATING_GROUPED_BY_DATE",
      "AVERAGE_RATING_PER_USER_RESULT_LIST",
      "TEAM_PERFORMANCE_LIST",
      "ARTICLE_SEARCH_RESULT_LIST",
      "ARTICLE_SEARCH_WITH_NO_RESULT_LIST",
      "ARTICLE_VIEW_STATISTICS_LIST",
      "TICKETS_WITH_RATING_LIST",
      "LIVE_AGENTS_TEAM",
      "SNAPSHOT_TICKETS",
      "LATEST_NEGATIVE_AI_FEEDBACK",
    ])
    .optional(),
  heatmapType: z
    .enum(["BUSIEST_HOURS_PER_WEEKDAY", "BUSIEST_COMMENTS_PER_WEEKDAY"])
    .optional(),
});

// Facts statistics arguments - specific enum for facts endpoint
export const GetFactsStatisticsArgs = BaseStatsParams.extend({
  ...TicketScopeFilters,
  chartType: z.enum([
    "MEDIAN_FIRST_RESPONSE_TIME",
    "MEDIAN_TIME_TO_CLOSE",
    "TICKET_CLOSE_COUNT",
    "MEDIAN_CONVERSATION_RATING",
    "TICKET_MEDIAN_REPLY_TIME",
    "MEDIAN_FIRST_ASSIGNMENT_TIME",
    "NEW_TICKETS_COUNT",
    "TICKET_COUNT_BY_QUERY",
    "TICKET_REPLIES_COUNT",
    "TICKET_WORKED_ON_COUNT",
    "TICKETS_WITH_OTHER_STATUS_THEN_OPEN_OR_CLOSED_COUNT",
    "HELP_CENTER_ARTICLE_VIEW_COUNT",
    "NEWS_VIEW_COUNT",
    "KAI_ANSWERED_COUNT",
    "KAI_NO_ANSWER_COUNT",
    "KAI_ROUTED_TO_AGENT_RATE_COUNT",
    "KAI_DEFLECTION_RATE",
    "KAI_ROUTED_TO_AGENT_RATE",
    // The server's fact values (services/stats/types.ts FactTypes): the feedback facts are rates.
    "KAI_POSITIVE_FEEDBACK_RATE",
    "KAI_NEGATIVE_FEEDBACK_RATE",
    "KAI_POSITIVE_FEEDBACK_PERCENTAGE",
    "SNAPSHOT_AGENTS_ONLINE_COUNT",
    "SNAPSHOT_OPEN_TICKETS",
    "MESSAGE_COUNT",
    "AI_QUESTIONS_ASKED_COUNT",
    "SLA_COMPLIANCE",
    "SLA_NOT_COMPLIANCE",
    "SLA_BREACHES_COUNT",
    "SLA_NO_BREACHES_COUNT",
    "TICKETS_WITHOUT_COMMENTS_RATE",
    "KAI_DEFLECTION_COUNT",
    "KAI_ROUTED_TO_AGENT_COUNT",
    "CONVERSATION_RATING_COUNT",
    "CONVERSATION_RATING_COVERAGE",
    "CONVERSATION_STARTED_COUNT",
  ]),
});

// List statistics arguments - specific enum for lists endpoint
export const GetListStatisticsArgs = BaseStatsParams.extend({
  ...TicketScopeFilters,
  chartType: z.enum([
    "AVERAGE_RATING_PER_USER_RESULT_LIST",
    "TEAM_PERFORMANCE_LIST",
    "ARTICLE_SEARCH_RESULT_LIST",
    "ARTICLE_SEARCH_WITH_NO_RESULT_LIST",
    "ARTICLE_VIEW_STATISTICS_LIST",
    "TICKETS_WITH_RATING_LIST",
    "LIVE_AGENTS_TEAM",
    "SNAPSHOT_TICKETS",
    "LATEST_NEGATIVE_AI_FEEDBACK",
    "CONVERSATION_RATING_DISTRIBUTION_LIST",
    "KAI_HANDED_TO_TEAM_LIST",
    "OPEN_TICKETS_PER_AGENT",
    "SLA_REPORTS_LIST",
  ]),
  team: z
    .string()
    .optional()
    .describe(
      "TEAM_PERFORMANCE_LIST only: restrict the list to members of the given team ID; omit to include all project users. Every other chartType treats it as a column filter and fails the request, so never set it for those.",
    ),
});

// Bar chart statistics arguments - specific enum for bar-chart endpoint
export const GetBarChartStatisticsArgs = BaseStatsParams.extend({
  ...TicketScopeFilters,
  chartType: z.enum([
    "NEW_TICKETS_COUNT",
    "TICKET_CLOSE_COUNT",
    "REPLIES_COUNT",
    "MEDIAN_FIRST_RESPONSE_TIME",
    "MEDIAN_TIME_TO_CLOSE",
    "MEDIAN_REPLY_TIME",
    "MEDIAN_CONVERSATION_RATING",
    "MEDIAN_REASSIGNMENT_COUNT",
    "MEDIAN_TIME_TO_FIRST_ASSIGNMENT",
    "HELP_CENTER_ARTICLE_VIEW_COUNT",
    "NEWS_VIEW_COUNT",
    "KAI_INVOLVED",
    "MESSAGE_COUNT",
    "AI_QUESTIONS_ASKED_COUNT",
    "CUSTOMER_SUPPORT_REQUESTED",
    "SLA_BREACHES_COUNT",
    "SLA_STARTED_COUNT",
    "TICKET_CREATION_GROUPED_BY_DATE_AND_TAGS",
    "AI_RATING_GROUPED_BY_DATE",
  ]),
});

// Raw event rows (the `stats_events` table behind every aggregated metric).
//
// This endpoint does not build on BaseStatsParams: every key it receives other
// than startDate/endDate is matched against a *column* of the events table, and
// an unknown one is rejected with a 400 naming it. So `type`, `updatedAt` and
// `groupedBy` are intentionally absent (no such column — they used to be
// advertised here and broke the call), and `timezone`, `groupInterval` and
// `aggsType` are absent because the endpoint ignores them (rows carry UTC
// timestamps). `skip` is absent because the endpoint rejects it: it pages by the
// `cursor` it hands back, sorted by actionType, then createdAt, then rowId.
export const GetRawDataStatisticsArgs = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe("Rows per page, at most 10 000 (the default). Use a small value when you only need a sample."),
  cursor: z
    .string()
    .optional()
    .describe(
      "The nextCursor from the previous call, passed back unchanged with the same filters to get the next page. Omit for the first page.",
    ),
  startDate: z
    .string()
    .optional()
    .describe(
      "Inclusive lower bound on the event timestamp (ISO-8601, interpreted as UTC).",
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Inclusive upper bound on the event timestamp (ISO-8601, interpreted as UTC).",
    ),
  actionType: z
    .enum([
      "CREATE_TICKET",
      "DELETE_TICKET",
      "ASSIGN_TICKET",
      "UNASSIGN_TICKET",
      "TICKET_REPLY",
      "COMMENT_CREATED",
      "TICKET_STATUS_CHANGE",
      "TICKET_FORCE_CLOSED_WITH_MISSING_FIELDS",
      "BOT_ROUTED_TO_AGENT",
      "RATED_CONVERSATION",
      "KAI_QUESTION",
      "KAI_ANSWERED",
      "KAI_ANSWERED_WITH_NO_ANSWER",
      "CUSTOMER_SUPPORT_REQUESTED",
      "KAI_INVOLVED",
      "CUSTOM_LLM_REPLY",
      "TICKET_SLA_ESCALATED",
      "TICKET_SLA_STARTED",
      "AGENT_RUN_COMPLETED",
      "AGENT_TOOL_CALL",
      "AGENT_TASK_CREATED",
      "AGENT_TASK_RESOLVED",
      "WORKFLOW_RUN_COMPLETED",
      "WIDGET_OPENED",
      "HOME_MENU_CLICK",
      "CONVERSATION_STARTED",
      "PIPELINE_ENTRY_ADDED",
      "PIPELINE_ENTRY_STAGE_CHANGED",
      "PIPELINE_ENTRY_FIELD_CHANGED",
      "PIPELINE_ENTRY_REMOVED",
      "PIPELINE_ENTRY_WORKFLOW_RUN",
    ])
    .optional()
    .describe(
      "Restrict rows to a single kind of event. Unset means every event type is returned — a period that looks quiet can still hold thousands of WIDGET_OPENED / AGENT_TOOL_CALL rows, so always set this when answering a question about one kind of action.",
    ),
  resourceType: z
    .enum([
      "TICKET",
      "COMMENT",
      "AGENT_RUN",
      "AGENT_TASK",
      "AGENT_TOOL_CALL",
      "WIDGET",
      "WORKFLOW_RUN",
      "PIPELINE_ENTRY",
    ])
    .optional()
    .describe("Restrict rows to events recorded against this kind of resource."),
  actionUser: z
    .string()
    .optional()
    .describe(
      "Restrict rows to events triggered by this user or session ID (the actor). For agent performance use data.processingUser instead — that's the agent the event is attributed to.",
    ),
  associatedEntity: z
    .string()
    .optional()
    .describe(
      "Restrict rows to events recorded against this entity ID (ticket, comment, agent run, … depending on resourceType).",
    ),
  description: z
    .string()
    .optional()
    .describe("Exact-match filter on the event description. Use `q` to search for a substring."),
  q: z
    .string()
    .optional()
    .describe("Free-text search: keeps rows whose description contains this text."),
  "data.processingUser": z
    .string()
    .optional()
    .describe(
      "Restrict rows to events attributed to this agent (user ID). This is the filter to use for per-agent reporting.",
    ),
  "data.ticketId": z
    .string()
    .optional()
    .describe("Restrict rows to events belonging to a single ticket."),
  "data.contact": z
    .string()
    .optional()
    .describe("Restrict rows to events belonging to a single contact."),
  "data.agent": z
    .string()
    .optional()
    .describe("Restrict rows to events produced by a single AI agent (agent ID)."),
  "data.type": z
    .string()
    .optional()
    .describe(
      "Restrict rows by the event's own sub-type — ticket type for ticket events (BUG, INQUIRY, …), message kind for message events (USER_TEXT, BOT_REPLY, SHARED_COMMENT, …).",
    ),
  "data.type_in": z
    .array(z.string())
    .optional()
    .describe("Same as data.type, but keeps rows matching any value in the list."),
  "data.tags_in": z
    .array(z.string())
    .optional()
    .describe("Restrict rows to events on tickets tagged with any of these tag names."),
});

export type GetStatisticsArgs = z.infer<typeof GetStatisticsArgs>;
export type GetFactsStatisticsArgs = z.infer<typeof GetFactsStatisticsArgs>;
export type GetListStatisticsArgs = z.infer<typeof GetListStatisticsArgs>;
export type GetBarChartStatisticsArgs = z.infer<
  typeof GetBarChartStatisticsArgs
>;
export type GetRawDataStatisticsArgs = z.infer<typeof GetRawDataStatisticsArgs>;
