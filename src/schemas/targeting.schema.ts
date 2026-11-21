import { z } from "zod";

/**
 * Outbound targeting shapes shared by the email automation and survey tools.
 * They mirror what the dashboard stores (OutboundTriggerConfiguration +
 * ConditionPicker); see utils/emailAutomationRules.ts for the stored form.
 */

export const MAX_DELAY_SECONDS = 365 * 86400;

// A factory: one instance reused in a tool schema becomes an internal $ref.
export const eventName = () => z.string().trim().min(1).max(200);
const value = z.union([z.string(), z.number(), z.boolean()]);

const countCondition = z.object({
  event: eventName(),
  type: z.literal("count"),
  matchOperator: z.enum(["is", "isnot", "greaterthan", "lessthan"]),
  data: z.number().int().min(0),
}).strict();
const latestDataCondition = z.object({
  event: eventName(),
  type: z.literal("latestdata"),
  dataKey: z.string().trim().min(1).optional(),
  matchOperator: z.enum(["is", "isnot", "contains", "notcontains", "startswith", "endswith", "greaterthan", "lessthan", "empty", "notempty", "in", "notin"]),
  data: value.optional(),
}).strict();
const occurredCondition = z.object({
  event: eventName(),
  type: z.enum(["firstoccured", "lastoccured"]),
  dateOperator: z.enum(["relative", "absolute"]),
  matchOperator: z.enum(["greaterthan", "lessthan", "exactly", "on", "before", "after"]),
  data: z.union([z.number().int().min(0), z.string()]),
}).strict();

export const audienceCondition = z.union([countCondition, latestDataCondition, occurredCondition]);

export const AUDIENCE_CONDITIONS_HELP =
  "Event count: {event, type:'count', matchOperator:'is', data:0}. " +
  "Latest event data: {event, type:'latestdata', dataKey, matchOperator:'is', data}. " +
  "Contact attribute: event 'gleap-up-<attribute>', type 'latestdata', no dataKey, e.g. {event:'gleap-up-email', type:'latestdata', matchOperator:'notcontains', data:'gleap.io'}. " +
  "Event date: {event, type:'firstoccured'|'lastoccured', dateOperator:'relative', matchOperator:'greaterthan'|'lessthan'|'exactly', data:<seconds>}.";

export const frequencyInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("once") }).strict(),
  z.object({ mode: z.literal("every_time") }).strict(),
  z.object({ mode: z.literal("every_n_days"), days: z.number().int().min(1).max(365) }).strict(),
]);

export const audienceInput = z.object({
  targetAudience: z.enum(["all", "users", "guests"]).optional().describe("users = identified contacts, guests = leads."),
  logicalOperator: z.enum(["AND", "OR"]).optional().describe("How conditions combine. Default AND."),
  conditions: z.array(audienceCondition).max(20).optional().describe(
    `Replaces all audience conditions; [] clears them. Checked when the message is due, so they also work as stop conditions. ${AUDIENCE_CONDITIONS_HELP}`,
  ),
}).strict();
