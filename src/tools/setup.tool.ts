import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateTeamArgs,
  GetAgentsArgs,
  GetSetupStatusArgs,
  SetAiModeArgs,
  SetDefaultTeamArgs,
  UpdateTeamArgs,
  UpdateWorkflowArgs,
} from "../schemas/setup.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  gleapGet,
  gleapGetData,
  gleapPost,
  gleapPut,
  validationErrorResponse,
  wrapResponse,
} from "../utils/api.js";
import { REMOVED_TOOL_ANNOTATIONS, removedToolResponse } from "../utils/removedTool.js";
import { slimWorkflow, toIdString } from "../utils/projections.js";

/**
 * Setting a project up for AI support by talking (Kai Operator, 2026-10-24): where the project
 * stands (how hard tickets start, the default team, the signup steps), its agents, which channels a
 * workflow answers on, teams and the default team. Every call acts with the connected person's role,
 * so a member without the right permissions gets the API's refusal. In Gleap, Kai Operator shows a
 * card before any of the writes runs.
 */

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const ID = /^[a-f0-9]{24}$/i;
const unique = (values: readonly string[]) => [...new Set(values.map((value) => `${value}`.trim()).filter(Boolean))];

/**
 * The Hard tickets settings (GET /hard-tickets/settings, effective values): when Kai Support
 * starts working a hard ticket (`click`, the default, or `auto`), where an automatic start runs and
 * what happens when that Bridge machine is offline, and what Gleap does when a ticket is done
 * (thank-you, review ask). Null when the Server does not have them (an older Server: 404).
 */
const hardTicketSettingsOf = (result: { error: GleapApiResponse } | { data: unknown }) => {
  if ("error" in result) return null;
  const view: any = (result as { data: unknown }).data;
  if (!view || typeof view !== "object") return null;
  return {
    hardTickets: view.hardTickets ?? null,
    ticketDone: view.ticketDone ?? null,
    bridgeDevices: Array.isArray(view.bridgeDevices)
      ? view.bridgeDevices.map((device: any) => ({ id: device?.id ?? null, name: device?.name ?? null, online: device?.online === true }))
      : [],
  };
};

const slimAgent = (agent: any) => ({
  id: agent?.id ?? agent?._id ?? null,
  name: agent?.name ?? null,
  status: agent?.status ?? null,
  // "customer": talks to customers (Kai Support and customer agents); "team": works for the team.
  kind: agent?.kind ?? (agent?.isConversational ? "customer" : "team"),
  managed: agent?.managedTemplateKey ?? null,
  system: agent?.isSystem === true,
  description: typeof agent?.description === "string" ? agent.description.slice(0, 200) : null,
});

const errorOf = (result: { error: GleapApiResponse } | { data: unknown }) =>
  "error" in result ? result.error : null;

/**
 * The new workspace's setup (GET /copilot/setup, Kai Copilot's setup chat): only for admins and while
 * it is not done; null otherwise (an older server answers 404, a teammate without the right reads
 * `none`). Steps done at signup never show; credits are in minor units of `currency`.
 */
const onboardingOf = (result: { error: GleapApiResponse } | { data: unknown }) => {
  if ("error" in result) return null;
  const view: any = (result as { data: unknown }).data;
  if (!view || view.status === "none" || view.status === "done" || view.mayManage !== true) return null;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  return {
    status: view.status,
    title: view.title ?? null,
    left: view.left ?? null,
    minutes: view.minutesLabel ?? null,
    next: view.next ?? null,
    currency: view.credits?.currency ?? "USD",
    steps: steps
      .filter((step: any) => step?.state === "open" || step?.state === "waiting")
      .map((step: any) => ({
        id: step.id,
        title: step.title,
        state: step.state,
        creditMinor: step.creditMinor ?? 0,
        decision: step.card?.question ?? null,
      })),
    claimable: Array.isArray(view.credits?.claimable) ? view.credits.claimable : [],
  };
};

export const registerSetupTools = (server: McpServer) => {
  server.registerTool(
    "get_setup_status",
    {
      title: "Get Setup Status",
      description:
        "Where the project stands for AI support: how hard tickets start (hardTickets.start: click, when someone clicks Work on it; auto, Kai Support starts on its own, on autoRunner: Kai Code Cloud or one of bridgeDevices, with offlineFallback when that machine is offline), what Gleap does when a ticket is done (ticketDone: thank-you on confirm, review ask), and the default team, which owns escalated tickets (null: none yet; set it with set_default_team). These are changed in Gleap under AI agents › Kai Support › Hard tickets. Who answers each channel is in get_workflows (kaiAnswers, channels). For a new workspace (admins), also `onboarding`: the setup steps left from signup (add Gleap to the app, Kai Support, email, the store, channels, calendar, invite), the next one and the trial credit each earns. Start every setup with this, then fix what is missing and check again.",
      inputSchema: GetSetupStatusArgs.shape,
      annotations: READ,
    },
    async (): Promise<GleapApiResponse> => {
      const [hardTickets, tasks, onboarding] = await Promise.all([
        gleapGetData("/hard-tickets/settings"),
        gleapGetData("/tasks/settings"),
        gleapGetData("/copilot/setup"),
      ]);
      const error = errorOf(tasks);
      if (error) return error;
      const taskSettings: any = (tasks as { data: unknown }).data;
      return wrapResponse({
        ...(hardTicketSettingsOf(hardTickets) ?? { hardTickets: null, ticketDone: null, bridgeDevices: [] }),
        defaultTeamId: typeof taskSettings?.defaultTeamId === "string" ? taskSettings.defaultTeamId : null,
        onboarding: onboardingOf(onboarding),
      });
    },
  );

  server.registerTool(
    "get_agents",
    {
      title: "Get Agents",
      description:
        "The project's AI agents: name, live or draft, and kind (customer: answers customers, like Kai Support and customer agents; team: works for the team, like Kai Copilot). Kai Support is one agent: it answers on the first line and works the hard tickets it escalates (its hard-ticket mode, formerly Kai Resolve). To see which workflow puts an agent on a channel, use get_workflows (kaiAnswers, passesToAgentId, channels).",
      inputSchema: GetAgentsArgs.shape,
      annotations: READ,
    },
    async (): Promise<GleapApiResponse> => {
      const result = await gleapGetData("/agents");
      const error = errorOf(result);
      if (error) return error;
      const data: any = (result as { data: unknown }).data;
      const agents = (Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : []).map(slimAgent);
      return wrapResponse({ results: agents, count: agents.length, type: "agent_list" });
    },
  );

  // Removed (Hard tickets, SPEC §8/§12): AI-first and AI-assisted are gone. Kept
  // as a stub for one release (utils/removedTool.ts).
  server.registerTool(
    "set_ai_mode",
    {
      title: "Set AI Mode (removed)",
      description:
        "Removed: AI-first and AI-assisted are gone, and this tool does nothing. Kai Support answers on the channels its workflows run on (update_workflow); whether it starts working hard tickets on its own or when someone clicks is set under AI agents › Kai Support › Hard tickets in Gleap (get_setup_status shows it).",
      inputSchema: SetAiModeArgs.shape,
      annotations: REMOVED_TOOL_ANNOTATIONS,
    },
    async (): Promise<GleapApiResponse> =>
      removedToolResponse(
        "set_ai_mode",
        "AI-first and AI-assisted are gone. Put Kai Support on a channel with update_workflow; whether hard tickets start on their own or when someone clicks Work on it is set under AI agents › Kai Support › Hard tickets in Gleap (get_setup_status shows the current setting).",
      ),
  );

  server.registerTool(
    "update_workflow",
    {
      title: "Update Workflow",
      description:
        "Change which channels a workflow runs on and whether it is live, never its steps. Typical setup: put the Kai Support workflow (kaiAnswers: true in get_workflows) on a channel that has no agent yet. Steps, triggers and audiences stay as they are: change_workflow_draft edits those, and publish_workflow_draft makes a drafted workflow live with the same checks as the editor.",
      inputSchema: UpdateWorkflowArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!ID.test(args.workflowId)) return validationErrorResponse("workflowId must be a workflow id from get_workflows.");
      if (!args.addChannels?.length && !args.removeChannels?.length && !args.status) {
        return validationErrorResponse("Say what to change: addChannels, removeChannels or status.");
      }
      const current = await gleapGetData(`/bots/${args.workflowId}`);
      const error = errorOf(current);
      if (error) return error;
      const bot: any = (current as { data: unknown }).data;
      const update: Record<string, unknown> = {};
      if (args.addChannels?.length || args.removeChannels?.length) {
        const remove = new Set(args.removeChannels ?? []);
        const channels = unique([...(Array.isArray(bot?.platforms) ? bot.platforms : []), ...(args.addChannels ?? [])]).filter(
          (channel) => !remove.has(channel as any),
        );
        update.platforms = channels;
      }
      if (args.status) update.status = args.status;
      const changed = Object.keys(update);
      // PUT /bots clears a triggerFilter the payload leaves out. Kai Support's "type is BOT" filter is
      // what keeps a new chat out of the Inbox until Kai hands it over, so send the stored one back.
      if (bot?.triggerFilter) update.triggerFilter = bot.triggerFilter;
      const response = await gleapPut(`/bots/${args.workflowId}`, update);
      const saved: any = response.structuredContent;
      if (!saved || saved.error) return response;
      return wrapResponse({ workflow: slimWorkflow(saved), changed });
    },
  );

  server.registerTool(
    "create_team",
    {
      title: "Create Team",
      description:
        "Create a team with its members (user ids from get_users). Agents ask a team when they need a person; make it the default with set_default_team.",
      inputSchema: CreateTeamArgs.shape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args): Promise<GleapApiResponse> => {
      const members = unique(args.memberIds);
      if (!members.length || members.some((id) => !ID.test(id))) return validationErrorResponse("memberIds must be user ids from get_users.");
      return gleapPost("/teams", { name: args.name.trim(), members, assignmentMethod: args.assignmentMethod ?? "balanced" });
    },
  );

  server.registerTool(
    "update_team",
    {
      title: "Update Team",
      description:
        "Rename a team, add or remove members, or change how it hands out tickets. Members you don't name stay in the team; a team keeps at least one member.",
      inputSchema: UpdateTeamArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!ID.test(args.teamId)) return validationErrorResponse("teamId must be a team id from get_teams.");
      const teams = await gleapGetData("/teams");
      const error = errorOf(teams);
      if (error) return error;
      const list: any[] = Array.isArray((teams as { data: unknown }).data) ? ((teams as { data: unknown }).data as any[]) : [];
      const team = list.find((entry) => toIdString(entry?._id ?? entry?.id) === args.teamId || `${entry?._id ?? entry?.id}` === args.teamId);
      if (!team) return validationErrorResponse("No team with that id in this project. Use get_teams.");
      const added = unique(args.addMemberIds ?? []);
      if (added.some((id) => !ID.test(id))) return validationErrorResponse("addMemberIds must be user ids from get_users.");
      const removed = new Set(unique(args.removeMemberIds ?? []));
      const members = unique([...(Array.isArray(team.members) ? team.members.map((member: any) => toIdString(member) ?? `${member}`) : []), ...added]).filter(
        (id) => !removed.has(id),
      );
      if (!members.length) return validationErrorResponse("A team keeps at least one member.");
      return gleapPut(`/teams/${args.teamId}`, {
        name: (args.name ?? team.name ?? "Team").trim(),
        assignmentMethod: args.assignmentMethod ?? team.assignmentMethod ?? "balanced",
        members,
      });
    },
  );

  server.registerTool(
    "set_default_team",
    {
      title: "Set Default Team",
      description:
        "Pick the team agents escalate to when nobody else is named (null clears it): it owns the hard tickets Kai Support escalates, and a person request goes to it when the ticket has no owner. Admins only.",
      inputSchema: SetDefaultTeamArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (args.teamId !== null && !ID.test(args.teamId)) return validationErrorResponse("teamId must be a team id from get_teams, or null.");
      return gleapPut("/tasks/settings", { defaultTeamId: args.teamId });
    },
  );
};
