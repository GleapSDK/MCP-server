import { z } from "zod";
import {
  CONDITIONS_HELP, MAX_ENROLL, MAX_TEST_RECIPIENTS, SEQUENCE_TEMPLATES, STEPS_HELP,
} from "../utils/sequenceRules.js";

/**
 * Sequence tool arguments. Builders, not shared instances: one instance used
 * twice in a tool schema becomes an internal $ref, which some clients reject.
 * Steps and conditions are loose JSON here and checked in utils/sequenceRules.ts,
 * which names the exact field that is wrong.
 */

const objectId = () => z.string().regex(/^[a-fA-F0-9]{24}$/);
const sequenceId = () => objectId().describe("The sequence's Gleap ID (list_sequences).");
const eventName = () => z.string().trim().min(1).max(70);

const conditions = (what: string, help: string) => z.union([
  z.array(z.record(z.string(), z.unknown())).max(20),
  z.object({
    logicalOperator: z.enum(["AND", "OR"]).optional(),
    conditions: z.array(z.record(z.string(), z.unknown())).max(20),
  }).strict(),
]).describe(`${what} [] clears them. ${help}`);

const SAME_CONDITIONS = "Same rule format as enrollment.conditions.";
const SAME_AS_CREATE = "Same rule format as in create_sequence.";

const enrollment = (conditionsHelp = CONDITIONS_HELP) => z.object({
  triggers: z.array(z.union([
    z.object({ type: z.literal("event"), event: eventName().describe("Tracked event name, e.g. \"trial_started\" (get_targeting_options).") }).strict(),
    z.object({ type: z.literal("contactCreated") }).strict(),
    z.object({ type: z.literal("manual") }).strict(),
  ])).max(10).optional().describe(
    "Replaces the automatic triggers. Manual enrolling (enroll_in_sequence, dashboard, a workflow's 'Enroll in sequence' action) always works; [] = manual only. " +
    "contactCreated enrolls each newly identified contact; event enrolls a contact whenever it tracks that event.",
  ),
  targetAudience: z.enum(["all", "users", "guests"]).optional().describe("Who automatic triggers may enroll: users = identified contacts, guests = leads. Default all."),
  conditions: conditions("Enrollment conditions, checked when an automatic trigger fires (manual enrolling skips them).", conditionsHelp).optional(),
  reenroll: z.enum(["never", "always", "after"]).optional().describe("Whether a contact who already went through may enroll again. Default never."),
  reenrollAfterDays: z.number().int().min(1).max(3650).optional().describe("With reenroll 'after': days since the last run ended."),
}).strict().describe("Who gets enrolled and how. Only the keys you pass change.");

const exit = (conditionsHelp = SAME_CONDITIONS) => z.object({
  onReply: z.boolean().optional().describe("End the sequence when the contact replies to one of its emails (same thread) or to its chat message. Off (the default for new sequences): replies keep the sequence going, still count in the results and can drive an engagement If / else. Works for every email type. Auto-replies pause instead."),
  onNewConversation: z.boolean().optional().describe("Also end it when the contact writes in any other conversation (a new chat or email). Default false."),
  events: z.array(eventName()).max(20).optional().describe("Tracked events that end it, e.g. [\"booked_demo\"]. Replaces the list."),
  conditions: conditions("Exit conditions, checked before every step; when they match the contact leaves.", conditionsHelp).optional(),
}).strict().describe("When a contact leaves early. Only the keys you pass change.");

const goal = () => z.object({
  event: eventName().describe("The conversion event, e.g. \"subscribed\"."),
  withinDays: z.number().int().min(1).max(365).optional().describe("Counts as converted when tracked within this many days of enrolling. Default 14."),
  exitOnGoal: z.boolean().optional().describe("End the sequence once converted. Default true."),
}).strict().nullable().describe("Conversion goal shown as goal rate in the stats. null removes it.");

const sending = () => z.object({
  senderId: objectId().optional().describe("Teammate who sends and signs (user id from get_users; must be a member of the project). Default: who created it."),
  emailType: z.enum(["personal", "marketing"]).optional().describe("personal = 1:1 style, no unsubscribe link (default); marketing = broadcast stream with unsubscribe link."),
  emailLook: z.enum(["plain", "personal", "company"]).optional().describe("Default look of every email: plain (like hand-written, default), personal (sender card), company (branded)."),
  repliesTo: z.discriminatedUnion("type", [
    z.object({ type: z.literal("sender") }).strict(),
    z.object({ type: z.literal("teammate"), userId: objectId().describe("User id from get_users (a member of the project).") }).strict(),
    z.object({ type: z.literal("team"), teamId: objectId().describe("Team id from get_teams; the team's assignment rules pick the person.") }).strict(),
    z.object({ type: z.literal("none") }).strict(),
  ]).optional().describe("Who gets the conversation when a contact replies: the sender (default), one teammate, a team, or none (unassigned inbox)."),
  window: z.object({
    enabled: z.boolean().optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe("0 = Sunday … 6 = Saturday, e.g. [1,2,3,4,5]."),
    startHour: z.number().int().min(0).max(23).optional(),
    endHour: z.number().int().min(1).max(24).optional(),
    timezone: z.string().min(1).max(64).optional().describe("IANA timezone, e.g. \"Europe/Vienna\"."),
  }).strict().optional().describe("Sending window: messages due outside it wait for the next opening. Only the keys you pass change."),
}).strict().describe("Sender, email type/look, who gets replies and the sending window. Only the keys you pass change.");

const steps = (help = STEPS_HELP) => z.array(z.record(z.string(), z.unknown())).max(100).describe(`Replaces the whole step list. ${help}`);

const name = () => z.string().trim().min(1).max(200).describe("Sequence name, e.g. \"Trial conversion\".");

export const ListSequencesArgs = z.object({
  status: z.enum(["draft", "live", "paused"]).optional().describe("Only sequences with this status."),
}).strict();

export const SequenceRefArgs = z.object({ sequenceId: sequenceId() }).strict();

export const GetSequenceTemplatesArgs = z.object({}).strict();

export const CreateSequenceArgs = z.object({
  template: z.enum(SEQUENCE_TEMPLATES).optional().describe("Start from blank (default), onboarding, trial or reengage (see get_sequence_templates). Steps you pass replace the template's steps."),
  name: name().optional(),
  timezone: z.string().min(1).max(64).optional().describe("IANA timezone for the default sending window (weekdays 8-18), e.g. \"America/New_York\". Default UTC."),
  enrollment: enrollment().optional(),
  exit: exit().optional(),
  goal: goal().optional(),
  sending: sending().optional(),
  steps: steps().optional(),
}).strict();

export const UpdateSequenceArgs = z.object({
  sequenceId: sequenceId(),
  name: name().optional(),
  enrollment: enrollment(SAME_AS_CREATE).optional(),
  exit: exit(SAME_AS_CREATE).optional(),
  goal: goal().optional(),
  sending: sending().optional(),
  steps: steps("Same step format as create_sequence (get_sequence returns the current list to edit; keep the ids of steps you keep so enrolled contacts stay on them).").optional(),
  stepChanges: z.array(z.record(z.string(), z.unknown())).min(1).max(100).optional().describe(
    "Instead of steps: change fields of existing steps by id, e.g. [{id:'welcome', subject:'Welcome aboard'}]. Only the fields you pass change; type and yes/no paths cannot change this way.",
  ),
}).strict();

export const SetSequenceStatusArgs = z.object({
  sequenceId: sequenceId(),
  status: z.enum(["live", "paused"]).describe("live = start enrolling and sending; paused = freeze every enrolled contact where it is."),
}).strict();

export const EnrollInSequenceArgs = z.object({
  sequenceId: sequenceId(),
  emails: z.array(z.string().trim().email()).max(MAX_ENROLL).optional().describe("Contact email addresses (exact match in the project)."),
  userIds: z.array(z.string().trim().min(1).max(200)).max(MAX_ENROLL).optional().describe("Your product's user ids, as sent with identify."),
  contactIds: z.array(objectId()).max(MAX_ENROLL).optional().describe("Gleap contact ids (search_contacts / get_contacts)."),
}).strict();

export const ListSequenceEnrollmentsArgs = z.object({
  sequenceId: sequenceId(),
  status: z.enum(["active", "completed", "exited"]).optional().describe("active includes paused enrollments; exited includes failed ones."),
  search: z.string().trim().min(1).max(100).optional().describe("Part of a contact's name or email."),
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const EnrollmentRefArgs = z.object({
  sequenceId: sequenceId(),
  enrollmentId: objectId().describe("The enrollment's ID (list_sequence_enrollments)."),
}).strict();

export const ManageSequenceEnrollmentArgs = EnrollmentRefArgs.extend({
  action: z.enum(["pause", "resume", "exit"]).describe("pause = hold this contact where it is; resume = continue (a due step runs right away); exit = end it for this contact (cannot be undone)."),
}).strict();

export const PreviewSequenceArgs = z.object({
  sequenceId: sequenceId(),
  email: z.string().trim().email().optional().describe("Render as the contact with this email."),
  contactId: objectId().optional().describe("Render as this contact. Without email/contactId: a sample contact from your own name and email."),
  includeHtml: z.boolean().optional().describe("Also return the rendered email HTML (large). Default false: subject + text."),
}).strict();

export const SendSequenceTestEmailArgs = z.object({
  sequenceId: sequenceId(),
  stepId: z.string().trim().min(1).max(64).describe("The id of an email step (get_sequence)."),
  emails: z.array(z.string().trim().email()).min(1).max(MAX_TEST_RECIPIENTS).optional().describe(`Up to ${MAX_TEST_RECIPIENTS} addresses. Default: your own address.`),
  contactId: objectId().optional().describe("Kai-written email steps only: the contact Kai writes the test for (default: the most recently active contact). The test still goes to emails / your address."),
}).strict();
