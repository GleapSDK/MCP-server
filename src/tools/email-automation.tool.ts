import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGet, gleapPut, validationErrorResponse, wrapResponse } from "../utils/api.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import {
  automationView, configureBody, configureProblem, pauseProblem, publishProblem, writeMatches,
} from "../utils/emailAutomationRules.js";
import { audienceCondition, eventName, MAX_DELAY_SECONDS } from "../schemas/targeting.schema.js";

// The same route the dashboard saves and publishes an email through
// (PUT /engagement/emails/:id → updateEngagement): project scoping, role
// permission, plan gate, live-edit lock and publish guards all run there.
const PATH = "/engagement/emails";
const emailId = z.string().regex(/^[a-fA-F0-9]{24}$/).describe("The email's Gleap ID.");
const condition = audienceCondition;

const ConfigureArgs = z.object({
  emailId,
  trigger: z.object({
    event: eventName().describe("Streamed event name, e.g. \"trial_started\"."),
    type: z.enum(["firstoccured", "lastoccured"]).optional()
      .describe("Measure the delay from the event's first or last occurrence. Default: firstoccured for once, lastoccured otherwise."),
    delaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS).describe("Send this long after the event; 0 = immediately."),
  }).strict().optional().describe("Event trigger. Makes the email dynamic (sent per contact when the event fires)."),
  frequency: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("once") }).strict(),
    z.object({ mode: z.literal("every_time") }).strict(),
    z.object({ mode: z.literal("every_n_days"), days: z.number().int().min(1).max(365) }).strict(),
  ]).optional().describe("once per contact, every time the trigger fires, or at most once every N days."),
  audience: z.object({
    targetAudience: z.enum(["all", "users", "guests"]).optional().describe("users = identified contacts, guests = leads."),
    logicalOperator: z.enum(["AND", "OR"]).optional().describe("How conditions combine. Default AND."),
    conditions: z.array(condition).max(20).optional().describe(
      "Replaces all audience conditions; [] clears them. Checked when the email is due, so they also work as stop conditions. " +
      "Event count: {event, type:'count', matchOperator:'is', data:0}. " +
      "Current page: {event:'pageView', type:'latestdata', dataKey:'page', matchOperator:'contains', data:'/pricing'} (custom event data is not stored; put values on the contact). " +
      "Contact attribute: event 'gleap-up-<attribute>' (custom data: 'gleap-up-customData.<key>'), type 'latestdata', no dataKey, e.g. {event:'gleap-up-email', type:'latestdata', matchOperator:'notcontains', data:'gleap.io'}. Tags: {event:'tags', type:'latestdata', matchOperator:'in', data:'<tag>'}. " +
      "Event date: {event, type:'firstoccured'|'lastoccured', dateOperator:'relative', matchOperator:'greaterthan'|'lessthan'|'exactly', data:<seconds>}. " +
      "Find event and attribute names with get_targeting_options; if the one you need is missing, get_event_tracking_guide.",
    ),
  }).strict().optional(),
  dropIfConditionsFail: z.boolean().optional().describe(
    "Skip if conditions no longer match: when the email is due and its audience conditions fail, its send is dropped instead of waiting " +
    "(by default it stays pending and goes out once they match, up to 30 days later). Use it for sequences keyed on state that moves on, " +
    "e.g. an onboarding step email with condition gleap-up-customData.onboardingGoal is 'email'. The only setting that may change on a live email.",
  ),
}).strict();
const PublishArgs = z.object({
  emailId,
  oneOffAudience: z.enum(["users", "guests"]).optional().describe(
    "Only for a one-off email without a trigger: the email's stored audience, confirming who it is sent to now. Never accepted for all.",
  ),
}).strict();
const EmailArgs = z.object({ emailId }).strict();

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });
const apiFailed = (response: GleapApiResponse) => response.isError || response.structuredContent?.error === true;

const withReview = (email: Record<string, any>, extra: Record<string, unknown> = {}) => {
  const view = automationView(email);
  const projectId = getCredsOrThrow().projectId;
  return wrapResponse({
    ...view,
    reviewUrl: `${GLEAP_DASHBOARD_BASE}/projects/${encodeURIComponent(projectId)}/engagement/emails/${encodeURIComponent(String(view.id))}/edit`,
    ...extra,
  });
};

/** The stored email, or the failed result to return. */
async function loadEmail(id: string): Promise<{ email: Record<string, any> } | { error: GleapApiResponse }> {
  const current = await gleapGet(`${PATH}/${id}`);
  if (apiFailed(current)) return { error: { ...current, isError: true } };
  const email = current.structuredContent;
  if (!email || email.type !== "EMAIL") return { error: fail("No email with this ID in this project.") };
  return { email };
}

const unverified = (response: GleapApiResponse): GleapApiResponse => ({
  ...response, isError: true, content: [...response.content, {
    type: "text", text: "Could not verify the saved email. Read it with get_email_automation before retrying; the write may have succeeded.",
  }],
});

export function registerEmailAutomationTools(server: McpServer) {
  server.registerTool("get_email_automation", {
    title: "Get Email Automation",
    description: "Read an email's status, kind (newsletter, automated or kai = Kai-written), look (emailStyle, tracking), Kai-written config, trigger, frequency and audience (targetAudience + conditions), plus its dashboard reviewUrl. Content: get_email.",
    inputSchema: EmailArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = EmailArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadEmail(parsed.data.emailId);
    return "error" in loaded ? loaded.error : withReview(loaded.email);
  });

  server.registerTool("configure_email_automation", {
    title: "Configure Email Automation",
    description: "Set a non-live email's event trigger (event, first/last occurrence, delay), frequency, audience and dropIfConditionsFail (skip the send when the audience no longer matches when it is due; this one also on a live email). A trigger makes a newsletter an automated email (a Kai-written email stays Kai-written, now sent per contact on the trigger). Works for every kind; content, look and Kai config are set with create_email / update_email. Never publishes; refuses live emails (pausing them first drops every queued send; content edits need no pause, use update_email). Returns the saved settings.",
    inputSchema: ConfigureArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = ConfigureArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { emailId: id, ...args } = parsed.data;
    const loaded = await loadEmail(id);
    if ("error" in loaded) return loaded.error;
    const problem = configureProblem(loaded.email, args);
    if (problem) return fail(problem);
    const body = configureBody(loaded.email, args);
    const saved = await gleapPut(`${PATH}/${id}`, body);
    if (apiFailed(saved)) return { ...saved, isError: true };
    const email = saved.structuredContent;
    if (!email || (email.status === "live" && loaded.email.status !== "live") || !writeMatches(email, body)) return unverified(saved);
    if (email.status === "live") return withReview(email);
    return withReview(email, { nextStep: "Not published. After the operator approves going live, call publish_email." });
  });

  server.registerTool("publish_email", {
    title: "Publish Email",
    description: "Set an email live, through the dashboard's publish path. Requires an event trigger; refuses one-off sends unless oneOffAudience confirms a narrowed users/guests audience. A Kai-written email also needs instructions and review (all or firstN; review off is dashboard-only); once live, Kai starts writing and the emails held for review wait in its Review tab. Only after the operator approved publishing. Returns the live settings.",
    inputSchema: PublishArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = PublishArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadEmail(parsed.data.emailId);
    if ("error" in loaded) return loaded.error;
    if (loaded.email.status === "live") return withReview(loaded.email, { note: "Already live; nothing changed." });
    const problem = publishProblem(loaded.email, parsed.data.oneOffAudience);
    if (problem) return fail(problem);
    const saved = await gleapPut(`${PATH}/${parsed.data.emailId}`, { status: "live" });
    if (apiFailed(saved)) return { ...saved, isError: true };
    if (saved.structuredContent?.status !== "live") return unverified(saved);
    return withReview(saved.structuredContent);
  });

  server.registerTool("pause_email", {
    title: "Pause Email",
    description: "Take a live email off (the dashboard's Unpublish): it stops sending. WARNING: every queued pending send (e.g. contacts waiting out a \"1 day after signup\" delay) is deleted for good; publishing again does NOT re-create them, so those contacts never get the email. Never pause just to fix content: update_email edits a live automated email in place and keeps its queued sends. Pause only to stop sending or to change trigger, audience or frequency, and only with the operator's approval. Settings and content stay. Already-sent one-offs cannot be paused.",
    inputSchema: EmailArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = EmailArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadEmail(parsed.data.emailId);
    if ("error" in loaded) return loaded.error;
    if (loaded.email.status !== "live") return withReview(loaded.email, { note: "Not live; nothing changed." });
    const problem = pauseProblem(loaded.email);
    if (problem) return fail(problem);
    const saved = await gleapPut(`${PATH}/${parsed.data.emailId}`, { status: "draft" });
    if (apiFailed(saved)) return { ...saved, isError: true };
    if (saved.structuredContent?.status !== "draft") return unverified(saved);
    return withReview(saved.structuredContent);
  });
}
