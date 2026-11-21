import { z } from "zod";

/**
 * The team's own databases, read-only (kai-db-access, Lukas 2026-10-31):
 * Kai Code reads them through these three tools, in a run on a ticket only
 * (its key's ticket pin, utils/sessionScope.ts). The Gleap API checks, scopes,
 * masks and logs every query (`/kai-databases/agent/*`); the customer comes
 * from the ticket's contact, never from these arguments.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/i;

const DATABASE_ID = z
  .string()
  .max(40)
  .optional()
  .describe("Which database: its id from describe_database. Leave it out when only one is switched on for Kai Code.");

export const DescribeDatabaseArgs = z.object({
  databaseId: DATABASE_ID,
});

export const QueryDatabaseArgs = z.object({
  databaseId: DATABASE_ID,
  query: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'One SQL SELECT in the database\'s dialect, or the MongoDB request as JSON: {"collection": "...", "filter": {...}, "projection": {...}, "sort": {...}, "limit": 50} or {"collection": "...", "pipeline": [...]}. Name tables and columns exactly as describe_database lists them.',
    ),
  purpose: z
    .string()
    .min(3)
    .max(200)
    .describe('Why you need it, in a few words ("check the customer\'s last 3 payments"). A data owner may read it before the query runs.'),
  scope: z
    .enum(["customer", "team"])
    .optional()
    .describe(
      "customer (the default): only this ticket's customer's rows, plus shared tables. team: across customers, only when the fix cannot do without it; it always waits for a data owner's OK.",
    ),
  sessionId: z
    .string()
    .regex(OBJECT_ID, "must be the 24-char Gleap coding-session id")
    .optional()
    .describe("Your 24-char Gleap coding-session id (kickoff prompt or a report_progress result), when you have it."),
});

export const GetQueryResultArgs = z.object({
  queryId: z
    .string()
    .regex(OBJECT_ID, "must be the queryId query_database returned")
    .describe("The queryId query_database returned with status pending."),
});
