import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SearchKnowledgebaseArgs,
  SearchSimilarTicketsArgs,
} from "../schemas/knowledge.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapPost } from "../utils/api.js";

export const registerKnowledgeTools = (server: McpServer) => {
  server.registerTool(
    "search_knowledgebase",
    {
      title: "Search Knowledge Base",
      description:
        "Search the project knowledge base (help center articles, custom documents, code knowledge) using semantic vector search. Returns the most relevant content for answering questions. For multi-part questions, split into separate focused calls (max 2).",
      inputSchema: SearchKnowledgebaseArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      query,
      documentTypeFilter,
      internally,
      lang,
      limit,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        query,
        documentTypeFilter,
        internally,
        lang,
        limit,
      });
      return gleapPost("/knowledge/search", body);
    }
  );

  server.registerTool(
    "search_similar_tickets",
    {
      title: "Search Similar Tickets",
      description:
        "Find resolved tickets with similar issues using semantic vector search. Use this to discover how similar customer problems were solved in the past.",
      inputSchema: SearchSimilarTicketsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, excludeTicketId, limit }): Promise<GleapApiResponse> => {
      const body = buildParams({ query, excludeTicketId, limit });
      return gleapPost("/knowledge/similar-tickets", body);
    }
  );
};
