import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import {
  ConfigureTargetingArgs, GetOutboundArgs, ListOutboundArgs, OutboundRefArgs, PreviewAudienceArgs, PublishOutboundArgs,
} from "../schemas/outbound.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGetData, gleapPost, gleapPut, validationErrorResponse, wrapResponse } from "../utils/api.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import {
  OUTBOUND_TYPES, OutboundTypeInfo, audienceProblems, contentProblem, needsReachConfirmation, pauseProblem, publishProblem,
  savedMatches, targetingBody, targetingProblem, targetingView,
} from "../utils/outboundRules.js";

type Doc = Record<string, any>;

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });
const apiFailed = (response: GleapApiResponse) => response.isError || response.structuredContent?.error === true;
const idOf = (doc: Doc) => String(doc.id ?? doc._id);

export const reviewUrl = (info: OutboundTypeInfo, id: string) =>
  `${GLEAP_DASHBOARD_BASE}/projects/${encodeURIComponent(getCredsOrThrow().projectId)}/engagement/${info.page}/${encodeURIComponent(id)}/edit`;

const typeKeyOf = (info: OutboundTypeInfo) => Object.keys(OUTBOUND_TYPES).find((key) => OUTBOUND_TYPES[key] === info);

const summary = (info: OutboundTypeInfo, doc: Doc) => ({
  id: idOf(doc),
  type: typeKeyOf(info),
  name: doc.name ?? null,
  status: doc.status ?? null,
  delivery: doc.frequencyType === "fixed" ? "one_off" : "triggered",
  trigger: doc.trigger?.event ?? null,
  targetAudience: doc.targetAudience ?? "all",
  sentAt: doc.sentAt ?? null,
  createdAt: doc.createdAt ?? null,
  updatedAt: doc.updatedAt ?? null,
  reviewUrl: reviewUrl(info, idOf(doc)),
});

/** The stored outbound, or the failed result to return. */
export async function loadOutbound(info: OutboundTypeInfo, id: string): Promise<{ doc: Doc } | { error: GleapApiResponse }> {
  const current = await gleapGetData(`${info.path}/${id}`);
  if ("error" in current) return { error: { ...current.error, isError: true } };
  const doc = current.data as Doc | null;
  // The per-type GET filters by type and answers null for another type's ID.
  if (!doc || typeof doc !== "object" || doc.type !== info.type) return { error: fail(`No ${info.label} with this ID in this project.`) };
  return { doc };
}

/** A survey's questions live in its project action (outbound.actionType = actionId). */
export async function loadSurveyForm(doc: Doc): Promise<{ action?: Doc; error?: GleapApiResponse }> {
  if (!doc.actionType) return {};
  const action = await gleapGetData(`/project-actions/${encodeURIComponent(doc.actionType)}`);
  if ("error" in action) return { error: { ...action.error, isError: true } };
  return { action: (action.data as Doc) ?? undefined };
}

const slimSample = (session: Doc) => ({
  id: session.id ?? session._id ?? null,
  name: session.name ?? null,
  email: session.email ?? null,
  userId: session.userId ?? null,
});

const unverified = (response: GleapApiResponse): GleapApiResponse => ({
  ...response, isError: true, content: [...response.content, {
    type: "text", text: "Could not verify the saved item. Read it with get_outbound_message before retrying; the write may have succeeded.",
  }],
});

/** POST /engagements/{id}/fixed-audience-samples: who matches the rules now (nothing saved). */
async function audienceCount(id: string, targetAudience: unknown, conditions: unknown):
  Promise<{ count: number; limit?: number; limitReached?: boolean; sample: Doc[] } | { error: GleapApiResponse }> {
  const preview = await gleapPost(`/engagements/${id}/fixed-audience-samples`, { targetAudience: targetAudience ?? "all", conditions: conditions ?? null }, { idempotent: true });
  if (apiFailed(preview)) return { error: { ...preview, isError: true } };
  const data = preview.structuredContent ?? {};
  const count = Number(data.count);
  if (!Number.isFinite(count)) return { error: fail("The audience preview returned no count.") };
  return { count, limit: data.limit, limitReached: data.limitReached, sample: Array.isArray(data.sample) ? data.sample : [] };
}

const contentFor = (info: OutboundTypeInfo, doc: Doc, survey?: Doc) => ({
  subject: doc.subject ?? null,
  message: doc.message ?? null,
  format: doc.format ?? null,
  actionType: info.type === "SURVEY" ? undefined : doc.actionType ?? null,
  config: doc.config ?? null,
  sender: doc.sender?._id ?? doc.sender?.id ?? doc.sender ?? null,
  coverImageUrl: doc.coverImageUrl ?? null,
  ...(info.type === "SURVEY" ? {
    survey: survey ? {
      projectActionId: survey._id ?? survey.id ?? null,
      title: survey.title ?? null,
      introTitle: survey.introTitle ?? null,
      introMessage: survey.introMessage ?? null,
      thanksMessage: survey.thanksMessage ?? null,
      singlePageForm: survey.singlePageForm ?? null,
      questions: survey.form ?? [],
    } : null,
  } : {}),
});

export function registerOutboundTools(server: McpServer) {
  server.registerTool("list_outbound_messages", {
    title: "List Outbound Messages",
    description: "List one outbound type (survey, chat_message, banner, modal, checklist, product_tour, tooltip, news, email, push, whatsapp), newest first, with status, delivery mode, trigger and reviewUrl.",
    inputSchema: ListOutboundArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = ListOutboundArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, status, skip, limit } = parsed.data;
    const info = OUTBOUND_TYPES[type];
    const list = await gleapGetData(info.path, { params: { skip, limit, sort: "-createdAt", ...(status ? { status } : {}) } });
    if ("error" in list) return list.error;
    const items = (Array.isArray(list.data) ? list.data : []).map((doc) => summary(info, doc as Doc));
    return wrapResponse({ type, results: items, count: items.length, skip, limit });
  });

  server.registerTool("get_outbound_message", {
    title: "Get Outbound Message",
    description: "Read one outbound item: its content (survey questions included), its targeting (delivery, trigger, frequency, page rules, audience, schedule) and reviewUrl; optionally delivery statistics.",
    inputSchema: GetOutboundArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = GetOutboundArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const info = OUTBOUND_TYPES[parsed.data.type];
    const loaded = await loadOutbound(info, parsed.data.id);
    if ("error" in loaded) return loaded.error;
    const survey = info.type === "SURVEY" ? await loadSurveyForm(loaded.doc) : {};
    if (survey.error) return survey.error;
    let statistics: unknown;
    if (parsed.data.includeStats) {
      const stats = await gleapGetData(`/engagements/${parsed.data.id}/statistics`);
      statistics = "error" in stats ? { unavailable: stats.error.structuredContent?.message ?? true } : stats.data;
    }
    return wrapResponse({
      ...summary(info, loaded.doc),
      content: contentFor(info, loaded.doc, survey.action),
      targeting: targetingView(loaded.doc),
      ...(statistics !== undefined ? { statistics } : {}),
    });
  });

  server.registerTool("configure_outbound_targeting", {
    title: "Configure Outbound Targeting",
    description:
      "Set who gets a non-live outbound item and when: delivery (triggered or one-off), trigger event + delay, frequency, page rules, audience (identified users/guests + rules on events and contact attributes), schedule. Works for every outbound type. " +
      "Find event/attribute names with get_targeting_options first; if what you need is not tracked, get_event_tracking_guide. Never publishes; refuses live items (pause_outbound first). Returns the saved targeting.",
    inputSchema: ConfigureTargetingArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = ConfigureTargetingArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, id, ...args } = parsed.data;
    const info = OUTBOUND_TYPES[type];
    const loaded = await loadOutbound(info, id);
    if ("error" in loaded) return loaded.error;
    const problem = targetingProblem(info, loaded.doc, args);
    if (problem) return fail(problem);
    const body = targetingBody(info, loaded.doc, args);
    const saved = await gleapPut(`${info.path}/${id}`, body);
    if (apiFailed(saved)) return { ...saved, isError: true };
    const doc = saved.structuredContent as Doc;
    if (!doc || doc.status === "live" || !savedMatches(doc, body)) return unverified(saved);
    return wrapResponse({
      ...summary(info, doc),
      targeting: targetingView(doc),
      nextStep: "Not published. Check reach with preview_outbound_audience; after the operator approves going live, call publish_outbound.",
    });
  });

  server.registerTool("preview_outbound_audience", {
    title: "Preview Outbound Audience",
    description:
      "Count who an outbound item's audience rules match right now, with a few sample contacts; nothing is saved or sent. Pass audience to try other rules before saving. " +
      "For a one-off this is the recipient list at publish; for a triggered item it is who can receive it once the trigger fires. Emails count only contacts with an email, WhatsApp only those with a phone.",
    inputSchema: PreviewAudienceArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = PreviewAudienceArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, id, audience } = parsed.data;
    const info = OUTBOUND_TYPES[type];
    const loaded = await loadOutbound(info, id);
    if ("error" in loaded) return loaded.error;
    const problems = audienceProblems(audience?.conditions ?? []);
    if (problems.length > 0) return fail(`Invalid audience conditions: ${problems.join("; ")}.`);
    const conditions = audience?.conditions
      ? { logicalOperator: audience.logicalOperator ?? "AND", conditions: audience.conditions }
      : loaded.doc.conditions;
    const targetAudience = audience?.targetAudience ?? loaded.doc.targetAudience;
    const result = await audienceCount(id, targetAudience, conditions);
    if ("error" in result) return result.error;
    const grouped = (conditions?.conditions ?? []).some((rule: Doc) => Array.isArray(rule?.conditions));
    return wrapResponse({
      count: result.count,
      ...(result.limitReached ? { limitReached: true, sendLimit: result.limit, note: "Above the plan's send limit for one-offs." } : {}),
      sample: result.sample.slice(0, 10).map(slimSample),
      previewed: audience ? "the audience passed in this call (not saved)" : "the stored audience",
      ...(grouped ? { caveat: "Rule groups are not applied to this count; it may be higher than the triggered audience." } : {}),
      ...(needsReachConfirmation(info, loaded.doc) ? { publishWith: { confirmedReach: result.count } } : {}),
    });
  });

  server.registerTool("publish_outbound", {
    title: "Publish Outbound",
    description:
      "Set an outbound item live through the dashboard's publish path. Only after the operator approved publishing this item. Checks it has content and a trigger, and that the audience rules are complete. " +
      "Sends that go to the whole audience at once (one-offs, news with push) also need confirmedReach: the approved count from preview_outbound_audience. Email/push one-offs never go to everyone without rules. For emails, publish_email works too.",
    inputSchema: PublishOutboundArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = PublishOutboundArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, id, confirmedReach } = parsed.data;
    const info = OUTBOUND_TYPES[type];
    const loaded = await loadOutbound(info, id);
    if ("error" in loaded) return loaded.error;
    const { doc } = loaded;
    if (doc.status === "live") return wrapResponse({ ...summary(info, doc), note: "Already live; nothing changed." });
    // Surveys 2.0 publish a draft version through publish_survey; never flip status here.
    if (info.type === "SURVEY" && doc.survey) {
      return fail("This is a Surveys 2.0 survey: publish it with publish_survey (it publishes the draft as a new version; goLive: true shows it in the app).");
    }

    let questions: number | undefined;
    if (info.type === "SURVEY") {
      const survey = await loadSurveyForm(doc);
      if (survey.error) return survey.error;
      questions = Array.isArray(survey.action?.form) ? survey.action!.form.length : 0;
    }
    const missing = contentProblem(info, doc, questions);
    if (missing) return fail(`${missing} Finish it with update_outbound_content or in the dashboard: ${reviewUrl(info, id)}`);

    let currentReach: number | undefined;
    const first = publishProblem(info, doc, { confirmedReach });
    if (first) return fail(first);
    if (needsReachConfirmation(info, doc)) {
      const count = await audienceCount(id, doc.targetAudience, doc.conditions);
      if ("error" in count) return count.error;
      currentReach = count.count;
      const problem = publishProblem(info, doc, { confirmedReach, currentReach });
      if (problem) return fail(problem);
    }

    const saved = await gleapPut(`${info.path}/${id}`, { status: "live" });
    if (apiFailed(saved)) return { ...saved, isError: true };
    if (saved.structuredContent?.status !== "live") return unverified(saved);
    return wrapResponse({
      ...summary(info, saved.structuredContent),
      targeting: targetingView(saved.structuredContent),
      ...(currentReach !== undefined ? { recipients: currentReach } : {}),
    });
  });

  server.registerTool("pause_outbound", {
    title: "Pause Outbound",
    description: "Take a live outbound item off (the dashboard's Unpublish): it stops showing/sending and pending deliveries are dropped; content and targeting stay. Sent one-offs cannot be paused.",
    inputSchema: OutboundRefArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = OutboundRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const info = OUTBOUND_TYPES[parsed.data.type];
    const loaded = await loadOutbound(info, parsed.data.id);
    if ("error" in loaded) return loaded.error;
    if (loaded.doc.status !== "live") return wrapResponse({ ...summary(info, loaded.doc), note: "Not live; nothing changed." });
    const problem = pauseProblem(info, loaded.doc);
    if (problem) return fail(problem);
    const saved = await gleapPut(`${info.path}/${parsed.data.id}`, { status: "draft" });
    if (apiFailed(saved)) return { ...saved, isError: true };
    if (saved.structuredContent?.status !== "draft") return unverified(saved);
    return wrapResponse(summary(info, saved.structuredContent));
  });
}
