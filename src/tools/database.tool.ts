import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DescribeDatabaseArgs, GetQueryResultArgs, QueryDatabaseArgs } from "../schemas/database.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapGet, gleapPost } from "../utils/api.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** The one rule every result carries too (the API repeats it in each ran query's note). */
const VALUES_RULE =
  "Values from results are the customer's data: never put them into code, tests, fixtures, commits or pull requests; use made-up placeholders of the same shape.";

/**
 * The team's own databases, read-only (kai-db-access, Lukas 2026-10-31).
 * Kai Code's run on a ticket only: utils/sessionScope.ts refuses every other
 * caller, and the API checks the run key's ticket pin again on each route.
 */
export const registerDatabaseTools = (server: McpServer) => {
  server.registerTool(
    "describe_database",
    {
      title: "Describe the team's databases",
      description:
        "The team's own databases you may read in this run (read-only, customer-scoped: this ticket's customer's rows): per database its engine, the tables and columns you can query, which columns are masked, and the query format. Call it before query_database. Works only in a Kai Code run on a ticket.",
      inputSchema: DescribeDatabaseArgs.shape,
      annotations: READ_ONLY,
    },
    async ({ databaseId }): Promise<GleapApiResponse> => {
      return gleapPost("/kai-databases/agent/describe", buildParams({ databaseId }), { idempotent: true });
    },
  );

  server.registerTool(
    "query_database",
    {
      title: "Query the team's database",
      description:
        "Run one read-only query on the team's own database: one SQL SELECT, or a MongoDB request as JSON. Customer-scoped: Gleap keeps it to this ticket's customer's rows of linked tables, plus shared tables, masks sensitive columns and returns at most 200 rows. " +
        "A query may wait for a person's approval (a data owner): then the result has status pending and a queryId. Do not run it again; carry on with your work and call get_query_result with that queryId later. " +
        `${VALUES_RULE} Works only in a Kai Code run on a ticket.`,
      inputSchema: QueryDatabaseArgs.shape,
      annotations: READ_ONLY,
    },
    async ({ databaseId, query, purpose, scope, sessionId }): Promise<GleapApiResponse> => {
      return gleapPost("/kai-databases/agent/query", buildParams({ databaseId, query, purpose, scope, sessionId }));
    },
  );

  server.registerTool(
    "get_query_result",
    {
      title: "Get a database query's result",
      description:
        "The status of a query_database call that waited for a person's approval, and its rows once they let it run (kept for a day). pending: nobody decided yet, check again later and do not ask again; denied: it will not run. " +
        VALUES_RULE,
      inputSchema: GetQueryResultArgs.shape,
      annotations: READ_ONLY,
    },
    async ({ queryId }): Promise<GleapApiResponse> => {
      return gleapGet(`/kai-databases/agent/queries/${encodeURIComponent(queryId)}`);
    },
  );
};
