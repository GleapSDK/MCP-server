import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetBarChartStatisticsArgs,
  GetFactsStatisticsArgs,
  GetListStatisticsArgs,
  GetRawDataStatisticsArgs,
} from "../schemas/statistics.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapGet, gleapGetData, wrapResponse } from "../utils/api.js";

/**
 * Forwards the validated arguments as query params, dropping unset ones.
 *
 * Deliberately generic: re-listing the fields here is what let these tools
 * advertise filters they never sent. `get_raw_data_statistics` declared
 * actionType/actionUser/associatedEntity/description and dropped all four, so a
 * filtered question came back as a full unfiltered event dump with no error —
 * and the facts/list/bar-chart tools silently ignored `aggsType` (MEDIAN vs
 * AVERAGE) and the list tool's `team`. The MCP SDK strips anything the schema
 * doesn't declare before we get here, so passing the whole object through is
 * safe as long as every declared field is a real query param — which is now the
 * rule the statistics schemas are written to.
 */
const buildStatisticsParams = (args: Record<string, unknown>) => buildParams(args);

export const registerStatisticsTools = (server: McpServer) => {
  server.registerTool(
    "get_statistics_facts",
    {
      title: "Get Statistics Facts",
      description:
        "Retrieve fact-based statistics from Gleap. Use chartType to specify the type of metric you want.",
      inputSchema: GetFactsStatisticsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<GleapApiResponse> => {
      return gleapGet("/statistics/facts", {
        params: buildStatisticsParams(args),
      });
    }
  );

  server.registerTool(
    "get_statistics_list",
    {
      title: "Get Statistics List",
      description:
        "Retrieve list-based statistics from Gleap. Use chartType to specify the type of list data you want.",
      inputSchema: GetListStatisticsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<GleapApiResponse> => {
      return gleapGet("/statistics/lists", {
        params: buildStatisticsParams(args),
      });
    }
  );

  server.registerTool(
    "get_statistics_bar_chart",
    {
      title: "Get Statistics Bar Chart",
      description:
        "Retrieve bar chart statistics from Gleap. Use chartType to specify the type of chart data you want.",
      inputSchema: GetBarChartStatisticsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<GleapApiResponse> => {
      return gleapGet("/statistics/bar-chart", {
        params: buildStatisticsParams(args),
      });
    }
  );

  server.registerTool(
    "get_raw_data_statistics",
    {
      title: "Get Raw Data Statistics",
      description:
        "Retrieve individual event rows (the raw log the aggregated statistics are computed from) from Gleap. Every filter is ANDed; unset filters are not applied, so a call with only a date range returns every kind of event in that period. Rows have UTC timestamps and are sorted by actionType, then createdAt, then rowId, up to `limit` (max 10 000) per call. When more rows match, the result has a nextCursor: call again with it as `cursor` and the same filters for the next page; no nextCursor means you have every row. Narrow the period or set actionType before paging through large ranges (the endpoint allows 30 calls a minute per project). Prefer get_statistics_facts / get_statistics_bar_chart when a count or a trend is all you need.",
      inputSchema: GetRawDataStatisticsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<GleapApiResponse> => {
      const result = await gleapGetData("/statistics/raw-data", {
        params: buildStatisticsParams(args),
      });
      if ("error" in result) return result.error;
      // The next page's cursor travels in a response header, which the tool
      // envelope would drop; hand it to the model next to the rows.
      const rows = Array.isArray(result.data) ? result.data : [];
      const headers = result.headers as { get?: (name: string) => unknown } | undefined;
      const nextCursor = typeof headers?.get === "function" ? headers.get("x-next-cursor") : undefined;
      return wrapResponse({
        results: rows,
        count: rows.length,
        ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}),
      });
    }
  );
};
