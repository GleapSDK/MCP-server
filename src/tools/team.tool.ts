import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetTeamsArgs, GetUsersArgs } from "../schemas/team.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGet } from "../utils/api.js";
import { projectList, slimUser } from "../utils/projections.js";

export const registerTeamTools = (server: McpServer) => {
  server.registerTool(
    "get_teams",
    {
      title: "Get Teams",
      description:
        "Get all teams in the project with their members. Useful for finding the right team to assign a ticket to.",
      inputSchema: GetTeamsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      return gleapGet("/teams", { listType: "team_list" });
    }
  );

  server.registerTool(
    "get_users",
    {
      title: "Get Users",
      description:
        "Get all support agents and users in the project. Useful for finding who to assign a ticket to.",
      inputSchema: GetUsersArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      // The dashboard-user list lives under /projects/users; a bare /users
      // route doesn't exist (404).
      const response = await gleapGet("/projects/users", {
        listType: "user_list",
      });
      return projectList(response, slimUser);
    }
  );
};
