import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AskCodeArgs } from "../schemas/code.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapPost } from "../utils/api.js";

export const registerCodeTools = (server: McpServer) => {
  server.registerTool(
    "ask_code",
    {
      title: "Ask about the product code",
      description:
        "Ask a natural-language question about how the project's product works. Analyzes all source repositories that are connected to this project and returns an explanation of user-facing logic and click paths. Only available when the project has at least one connected code repository — if no repos are connected, the tool returns a message saying so. Never returns code, file paths, identifiers, or secrets — only product behavior in plain English.",
      inputSchema: AskCodeArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ question }): Promise<GleapApiResponse> => {
      return gleapPost("/code/ask", { question });
    },
  );
};
