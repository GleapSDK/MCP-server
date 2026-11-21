import { z } from "zod";

/** The channels a workflow can run on (Gleap's ChannelTypes). */
export const CHANNELS = [
  "widget",
  "email",
  "whatsapp",
  "instagram",
  "facebook",
  "telegram",
  "slack",
] as const;

export const GetSetupStatusArgs = z.object({});

export const GetAgentsArgs = z.object({});

/** Removed tool, kept for one release (setup.tool.ts): its schema as it was. */
export const SetAiModeArgs = z.object({
  mode: z
    .enum(["first", "assisted"])
    .describe(
      "Ignored: this tool was removed and changes nothing. Put Kai Support on a channel with update_workflow; when it takes hard tickets is set under AI agents › Kai Support › Hard tickets in Gleap.",
    ),
});

export const UpdateWorkflowArgs = z.object({
  workflowId: z
    .string()
    .describe("The workflow (bot) id from get_workflows."),
  addChannels: z
    .array(z.enum(CHANNELS))
    .optional()
    .describe(
      'Channels the workflow should also run on, e.g. ["whatsapp"] to put the Kai Support workflow on WhatsApp. Channels it already has stay.',
    ),
  removeChannels: z
    .array(z.enum(CHANNELS))
    .optional()
    .describe("Channels the workflow should stop running on."),
  status: z
    .enum(["live", "draft"])
    .optional()
    .describe('"live" turns the workflow on, "draft" turns it off.'),
});

export const CreateTeamArgs = z.object({
  name: z.string().min(1).describe('The team\'s name, e.g. "Support".'),
  memberIds: z
    .array(z.string())
    .min(1)
    .describe("User ids of the members (from get_users). At least one."),
  assignmentMethod: z
    .enum(["balanced", "circular", "random", "manual"])
    .optional()
    .describe(
      "How the team hands out tickets: balanced (fewest open tickets first, the default), circular (round robin), random, or manual (nobody is picked; the team shares the ticket).",
    ),
});

export const UpdateTeamArgs = z.object({
  teamId: z.string().describe("The team id from get_teams."),
  name: z.string().min(1).optional().describe("A new name."),
  addMemberIds: z
    .array(z.string())
    .optional()
    .describe("User ids to add (from get_users). Members already in the team stay."),
  removeMemberIds: z
    .array(z.string())
    .optional()
    .describe("User ids to take out of the team. Everyone else stays."),
  assignmentMethod: z
    .enum(["balanced", "circular", "random", "manual"])
    .optional()
    .describe("How the team hands out tickets."),
});

export const SetDefaultTeamArgs = z.object({
  teamId: z
    .string()
    .nullable()
    .describe(
      "The team agents escalate to when nobody else is named (from get_teams); null clears it.",
    ),
});
