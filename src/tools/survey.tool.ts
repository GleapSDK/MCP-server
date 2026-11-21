import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import {
  AskSurveyResultsArgs,
  CreateSurveyArgs,
  DEFINITION_HELP,
  GetSurveyAnalyticsArgs,
  GetSurveyArgs,
  GetSurveyResponseArgs,
  GetSurveyResponsesArgs,
  GetSurveyResultsArgs,
  GetSurveysArgs,
  GetSurveySummaryArgs,
  ListSurveysArgs,
  ReachOutArgs,
  SearchSurveyResponsesArgs,
  SurveyIdArgs,
  PublishSurveyArgs,
  UpdateSurveyArgs,
  ValidateSurveyArgs,
} from "../schemas/survey.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  buildParams, gleapGet, gleapGetData, gleapPost, gleapPut, validationErrorResponse, wrapResponse,
} from "../utils/api.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import {
  buildTrigger, conditionProblems, frequencyFields, isContactField, storedCondition,
} from "../utils/emailAutomationRules.js";
import { projectList } from "../utils/projections.js";
import { analyticsView, funnelView } from "../utils/surveyAnalytics.js";
import { normalizeDefinition } from "../utils/surveyDefinition.js";
import {
  askView, compact, insightsView, responseDetail, responsePage, slimSurvey, statsView, surveyView,
} from "../utils/surveyResults.js";

// Surveys 2.0 (SURVEYS_V2_SPEC.md §3/§10). Every route is the dashboard's
// JWT route under /engagement/surveys/:id, so the API applies the same project
// scoping and role permissions as the editor. create_survey / update_survey
// write drafts only (never a status or the published definition);
// publish_survey launches it through the Server's publish endpoint once the
// operator agreed (prompt, not a gate, like publish_outbound), and
// reach_out_to_respondent sends nothing unless `send: true`.
const PATH = "/engagement/surveys";

type Doc = Record<string, any>;

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });
const apiFailed = (response: GleapApiResponse) => response.isError || response.structuredContent?.error === true;
const asError = (response: GleapApiResponse): GleapApiResponse => ({ ...response, isError: true });
const zodMessage = (error: z.ZodError) =>
  error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");

const dashboardUrl = (id: string, suffix = "") =>
  `${GLEAP_DASHBOARD_BASE}/projects/${encodeURIComponent(getCredsOrThrow().projectId)}/engagement/surveys/${encodeURIComponent(id)}${suffix}`;
const reviewUrl = (id: string) => dashboardUrl(id, "/edit");
const resultsUrl = (id: string) => dashboardUrl(id);

const idOf = (doc: Doc | undefined): string | undefined => {
  const id = doc?.id ?? doc?._id;
  return id == null ? undefined : String(id);
};

const unverified = (response: GleapApiResponse, what: string): GleapApiResponse => ({
  ...response, isError: true, content: [...response.content, {
    type: "text", text: `Could not verify ${what}. Inspect the survey with get_survey before retrying; the write may have succeeded.`,
  }],
});

/** The stored survey (outbound of type SURVEY), or the failed result to return. */
async function loadSurvey(id: string): Promise<{ survey: Doc } | { error: GleapApiResponse }> {
  const current = await gleapGet(`${PATH}/${id}`);
  if (apiFailed(current)) return { error: asError(current) };
  const survey = current.structuredContent;
  if (!survey || survey.type !== "SURVEY") return { error: fail("No survey with this id in this project. Use list_surveys to find the id.") };
  return { survey };
}

/** Raw GET body, or a result that explains a missing 2.0 resource. */
async function getData(path: string, params?: Record<string, unknown>, legacyHint?: string):
  Promise<{ data: Doc } | { error: GleapApiResponse }> {
  const result = await gleapGetData(path, params ? { params } : undefined);
  if ("error" in result) {
    const status = result.error.structuredContent?.status;
    if (status === 404 && legacyHint) {
      return { error: { ...result.error, isError: true, content: [...result.error.content, { type: "text", text: legacyHint }] } };
    }
    return { error: asError(result.error) };
  }
  const data = result.data;
  return { data: (data && typeof data === "object" ? data : { result: data }) as Doc };
}

const LEGACY_HINT = "Not found as a Surveys 2.0 survey/response. Legacy surveys (created before Surveys 2.0) have no stored stats or insights; use get_survey_responses and get_survey_summary for them.";

/** Stored targeting fields for an in-app trigger/audience given to create_survey. */
function targetingFields(args: z.infer<typeof CreateSurveyArgs>): { fields: Doc } | { problem: string } {
  const fields: Doc = {};
  if (args.trigger) {
    const event = args.trigger.event;
    if (isContactField(event) || event === "pageView") {
      return { problem: `"${event}" cannot be set as a survey trigger through the MCP: use a streamed event (e.g. "subscription_cancelled"). Contact-attribute and page-view triggers are set in the Gleap dashboard.` };
    }
    const frequency = frequencyFields(args.trigger.frequency ?? { mode: "once" });
    Object.assign(fields, frequency, {
      frequencyType: "dynamic",
      trigger: buildTrigger({ event, delaySeconds: args.trigger.delaySeconds ?? 0 }, frequency.frequency),
    });
  }
  if (args.audience) {
    const problems = (args.audience.conditions ?? []).flatMap(conditionProblems);
    if (problems.length > 0) return { problem: `Invalid audience conditions: ${problems.join("; ")}.` };
    if (args.audience.targetAudience) fields.targetAudience = args.audience.targetAudience;
    if (args.audience.conditions) {
      fields.conditions = {
        logicalOperator: args.audience.logicalOperator ?? "AND",
        conditions: args.audience.conditions.map(storedCondition),
      };
    }
  }
  return { fields };
}

/** `{ ok, errors }` from the Server's validator; null when it could not be reached. */
async function serverValidation(id: string, definition: Doc): Promise<Doc | null> {
  const result = await gleapPost(`${PATH}/${id}/validate`, { definition }, { idempotent: true });
  if (apiFailed(result)) return null;
  const data = result.structuredContent ?? {};
  const errors = Array.isArray(data.errors) ? data.errors : [];
  return { ok: data.ok === true || (data.ok === undefined && errors.length === 0), errors: compact(errors, 300, 50, 3) };
}

/**
 * Keys of the questions whose contactField / skipWhenKnown the saved draft
 * lost: a Server from before "skip when known" (Server#2079) strips unknown
 * block fields on save. Empty when nothing was dropped or the saved draft is
 * not in the response.
 */
const droppedContactSettings = (sent: Doc, saved: Doc | undefined): string[] => {
  if (!Array.isArray(saved?.blocks)) return [];
  const savedById = new Map<string, Doc>(saved.blocks.map((block: Doc) => [block.id, block]));
  return (sent.blocks ?? [])
    .filter((block: Doc) => {
      const stored = savedById.get(block.id);
      return stored && ["contactField", "skipWhenKnown"].some((field) => block[field] !== undefined && stored[field] !== block[field]);
    })
    .map((block: Doc) => block.key);
};

const droppedContactNote = (keys: string[]) => keys.length === 0 ? {} : {
  contactSettingsNote: `This Gleap Server does not support contactField / skipWhenKnown yet and did not save them on: ${keys.join(", ")}. These questions are asked to everyone for now; do not tell the operator that known contacts skip them.`,
};

const validationNextStep = (validation: Doc | null) =>
  validation === null
    ? "The Server validator could not be reached; run validate_survey before asking for review."
    : validation.ok
      ? "Valid. Show the operator what it asks and who sees it (reviewUrl, preview_outbound_audience); once they agree to launch it, call publish_survey (goLive: true to show it in the app)."
      : "Saved as a draft, but publishing would be rejected. Fix the listed errors with update_survey (send the complete definition).";

export const registerSurveyTools = (server: McpServer) => {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  // ---------------------------------------------------------------- list / get
  const listSurveys = async ({ status, limit, skip }: z.infer<typeof ListSurveysArgs>): Promise<GleapApiResponse> =>
    projectList(await gleapGet(PATH, {
      params: buildParams({ status, limit: limit ?? 20, skip: skip ?? 0 }),
      listType: "survey_list",
    }), slimSurvey);

  server.registerTool("list_surveys", {
    title: "List Surveys",
    description: "List the project's surveys, newest first: id (use it in every other survey tool), sdkSurveyId (for Gleap.showSurvey), name, status (live/draft), format (card/full), published version, whether the draft has unpublished changes, question count and trigger.",
    inputSchema: ListSurveysArgs.shape,
    annotations: readOnly,
  }, listSurveys);

  server.registerTool("get_surveys", {
    title: "Get Surveys",
    description: "Alias of list_surveys (kept for existing clients).",
    inputSchema: GetSurveysArgs.shape,
    annotations: readOnly,
  }, listSurveys);

  server.registerTool("get_survey", {
    title: "Get Survey",
    description: "Read one survey: its draft definition (questions/blocks with keys, logic jumps, endings, hidden fields), status, published version, unpublished changes, survey page settings and in-app targeting. The returned definition can be edited and sent back unchanged in shape to update_survey.",
    inputSchema: GetSurveyArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = GetSurveyArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const loaded = await loadSurvey(parsed.data.surveyId);
    if ("error" in loaded) return loaded.error;
    return wrapResponse({ ...surveyView(loaded.survey, parsed.data.version ?? "draft"), reviewUrl: reviewUrl(parsed.data.surveyId) });
  });

  // ---------------------------------------------------------------- drafts
  server.registerTool("create_survey", {
    title: "Create Survey Draft",
    description: `Create a new survey as an unpublished DRAFT and return its id, Server validation and reviewUrl. Never publishes or shows it to anyone. Optional in-app trigger (streamed event + frequency) and audience are stored on the draft and only take effect once it is published with publish_survey (goLive: true). ${DEFINITION_HELP}`,
    inputSchema: CreateSurveyArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = CreateSurveyArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const args = parsed.data;
    const targeting = targetingFields(args);
    if ("problem" in targeting) return fail(targeting.problem);
    const definition = normalizeDefinition(args.definition, args.format);
    const saved = await gleapPost(PATH, {
      name: args.name,
      format: args.format,
      definition,
      ...targeting.fields,
      status: "draft",
    });
    if (apiFailed(saved)) return asError(saved);
    const data = saved.structuredContent;
    const id = idOf(data);
    if (!data || !id || data.status !== "draft" || data.type !== "SURVEY" || data.survey?.published) {
      return unverified(saved, "the saved draft");
    }
    const validation = Array.isArray(data.warnings)
      ? { ok: data.warnings.length === 0, errors: compact(data.warnings, 300, 50, 3) }
      : await serverValidation(id, definition);
    return wrapResponse({
      ...slimSurvey(data),
      validation,
      reviewUrl: reviewUrl(id),
      nextStep: validationNextStep(validation),
      ...droppedContactNote(droppedContactSettings(definition, data.survey?.draft)),
    });
  });

  server.registerTool("update_survey", {
    title: "Update Survey Draft",
    description: `Replace a survey's DRAFT definition (send the complete definition; read it with get_survey first). On a live survey this saves the next draft version: respondents keep seeing the published version until it is published again with publish_survey. Never publishes, never changes status or targeting. Returns the Server's warnings and reviewUrl. ${DEFINITION_HELP}`,
    inputSchema: UpdateSurveyArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = UpdateSurveyArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, definition, format, name } = parsed.data;
    const loaded = await loadSurvey(surveyId);
    if ("error" in loaded) return loaded.error;
    const survey = loaded.survey;
    const live = survey.status === "live";
    if (name !== undefined && live) {
      return fail("This survey is live; rename it in the Gleap dashboard. Call update_survey again without name to save the draft.");
    }
    const normalized = normalizeDefinition(definition, format ?? definition.format ?? survey.survey?.draft?.format ?? slimSurvey(survey).format ?? undefined);
    const saved = await gleapPut(`${PATH}/${surveyId}/draft`, { definition: normalized });
    if (apiFailed(saved)) return asError(saved);
    if (!saved.structuredContent?.definition) return unverified(saved, "the saved draft");
    const warnings = Array.isArray(saved.structuredContent.warnings) ? saved.structuredContent.warnings : [];
    let renameNote: string | undefined;
    if (name !== undefined) {
      const renamed = await gleapPut(`${PATH}/${surveyId}`, { name });
      if (apiFailed(renamed)) renameNote = `Draft saved, but the rename failed: ${renamed.structuredContent?.message ?? "unknown error"}.`;
    }
    const liveVersion = survey.survey?.version ?? 0;
    return wrapResponse({
      id: surveyId,
      name: name ?? survey.name ?? null,
      status: survey.status ?? null,
      draftSaved: true,
      liveVersion,
      validation: { ok: warnings.length === 0, errors: compact(warnings, 300, 50, 3) },
      reviewUrl: reviewUrl(surveyId),
      nextStep: live && liveVersion > 0
        ? `Live survey unchanged: respondents see version ${liveVersion} until this draft is published (publish_survey, after the operator agreed). ${warnings.length ? "Fix the listed errors first; publishing would reject them." : ""}`.trim()
        : validationNextStep({ ok: warnings.length === 0 }),
      ...(renameNote ? { note: renameNote } : {}),
      ...droppedContactNote(droppedContactSettings(normalized, saved.structuredContent.definition)),
    });
  });

  server.registerTool("validate_survey", {
    title: "Validate Survey",
    description: "Check a survey definition with the Server's validator without saving: unknown or backward jump targets (loops), unreachable questions, paths without an ending, duplicate ids/keys, conditions that do not fit the question type, limits (60 blocks, 10 endings, 25 choices, 20 jumps). Pass a definition to check it, or omit it to check the stored draft. Returns { ok, errors: [{ path, code, message }] }.",
    inputSchema: ValidateSurveyArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = ValidateSurveyArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, definition } = parsed.data;
    let toCheck: Doc;
    if (definition) {
      toCheck = normalizeDefinition(definition);
    } else {
      const loaded = await loadSurvey(surveyId);
      if ("error" in loaded) return loaded.error;
      const draft = loaded.survey.survey?.draft;
      if (!draft) return fail("This survey has no Surveys 2.0 draft yet (legacy survey). Save one with update_survey.");
      toCheck = draft;
    }
    const result = await gleapPost(`${PATH}/${surveyId}/validate`, { definition: toCheck }, { idempotent: true });
    if (apiFailed(result)) return asError(result);
    const data = result.structuredContent ?? {};
    const errors = Array.isArray(data.errors) ? data.errors : [];
    return wrapResponse({
      ok: data.ok === true || (data.ok === undefined && errors.length === 0),
      errors: compact(errors, 300, 50, 3),
      ...(errors.length > 50 ? { errorsTruncated: errors.length } : {}),
      checked: definition ? "definition" : "stored draft",
    });
  });

  // ---------------------------------------------------------------- publish / pause
  server.registerTool("publish_survey", {
    title: "Publish Survey",
    description: "Launch a survey: publish its draft as the next version (the dashboard's \"Publish changes\") and, with goLive: true, start showing it in the app to the audience from configure_outbound_targeting. Call it once the operator agreed to launch this survey (a clear go-ahead like \"launch it\" counts); for an already-live survey, once they agreed to the change. The survey page and emails serve the new version right away. Invalid drafts are rejected with the validator's errors.",
    inputSchema: PublishSurveyArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = PublishSurveyArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, goLive } = parsed.data;
    // Servers before agent publishing answered 403 requiresApproval.
    const needsApproval = (message?: unknown) => wrapResponse({
      id: surveyId,
      published: false,
      requiresApproval: true,
      message: typeof message === "string" && message ? message : "Publishing this survey needs a teammate's approval.",
      reviewUrl: reviewUrl(surveyId),
      nextStep: "Not published. Ask a teammate to review the draft at reviewUrl and click Publish changes. Do not retry publish_survey.",
    });
    const result = await gleapPost(`${PATH}/${surveyId}/publish`, goLive === true ? { goLive: true } : {});
    if (apiFailed(result)) {
      const status = result.structuredContent?.status;
      const data: Doc = result.structuredContent?.data ?? {};
      const message = result.structuredContent?.message;
      if (data.requiresApproval === true || (status === 403 && typeof message === "string" && /needs a teammate/i.test(message))) return needsApproval(message);
      if (status === 422) {
        const errors = data.errors ?? data.error?.errors ?? [];
        return {
          ...result,
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ published: false, errors: compact(errors, 300, 50, 3), nextStep: "Fix the errors with update_survey, then call publish_survey again." }, null, 2) }],
          structuredContent: { error: true, status, published: false, errors: compact(errors, 300, 50, 3) },
        };
      }
      return asError(result);
    }
    const data = result.structuredContent ?? {};
    if (data.requiresApproval === true) return needsApproval(data.message);
    const version = data.version ?? data.survey?.version;
    if (typeof version !== "number" || version < 1) return unverified(result, "the publish");
    return wrapResponse({
      id: surveyId,
      published: true,
      version,
      publishedAt: data.publishedAt ?? data.survey?.publishedAt ?? null,
      status: data.status ?? null,
      reviewUrl: reviewUrl(surveyId),
      nextStep: data.status === "live"
        ? "Live in the app for its audience; the survey page and emails serve this version too. Read results with get_survey_results / get_survey_insights; stop the in-app survey with pause_survey."
        : "Published: the survey page and emails serve this version. It is not showing in the app; call publish_survey with goLive: true to start that.",
    });
  });

  server.registerTool("pause_survey", {
    title: "Pause Survey",
    description: "Stop showing a survey in the app (the dashboard's Share → In the app switch): in-app triggers stop showing it; the survey page and emails keep working. Definition, versions and responses stay. Returns the survey's resulting status.",
    inputSchema: SurveyIdArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = SurveyIdArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId } = parsed.data;
    const loaded = await loadSurvey(surveyId);
    if ("error" in loaded) return loaded.error;
    if (loaded.survey.status !== "live") {
      return wrapResponse({ ...slimSurvey(loaded.survey), note: "Not live; nothing changed.", reviewUrl: reviewUrl(surveyId) });
    }
    const saved = await gleapPut(`${PATH}/${surveyId}`, { status: "draft" });
    if (apiFailed(saved)) return asError(saved);
    if (saved.structuredContent?.status !== "draft") return unverified(saved, "the pause");
    return wrapResponse({ ...slimSurvey(saved.structuredContent), reviewUrl: reviewUrl(surveyId) });
  });

  // ---------------------------------------------------------------- results
  server.registerTool("get_survey_results", {
    title: "Get Survey Results",
    description: "Survey results from stored counters (cheap, any volume): totals (shown, started, completed, partial, duration) with start/completion rates, NPS, per-question reached/answered/skipped and answer counts (choices labelled), endings, channels and most common paths, plus the step funnel (viewed/answered/drop-off per question) when analytics events exist. Filter by day range and version. For trends, devices, timing and previous-period comparison use get_survey_analytics.",
    inputSchema: GetSurveyResultsArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = GetSurveyResultsArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, from, to, version, includeDaily } = parsed.data;
    const [stats, survey, analytics] = await Promise.all([
      getData(`${PATH}/${surveyId}/stats`, buildParams({ from, to, version }), LEGACY_HINT),
      gleapGetData(`${PATH}/${surveyId}`),
      // Step funnel from the analytics events; optional, any failure is ignored.
      gleapGetData(`${PATH}/${surveyId}/analytics`, { params: buildParams({ from, to, version }) }).catch(() => null),
    ]);
    if ("error" in stats) return stats.error;
    const stored: Doc | undefined = "data" in survey ? (survey.data as Doc) : undefined;
    const definition = stored?.survey?.published ?? stored?.survey?.draft;
    const events: Doc | undefined = analytics && "data" in analytics ? (analytics.data as Doc) : undefined;
    const funnel = events?.available === true ? { funnelRange: events.range ?? null, ...funnelView(events) } : {};
    return wrapResponse({
      id: surveyId,
      name: stored?.name ?? null,
      ...statsView(stats.data, definition, includeDaily === true),
      ...funnel,
      resultsUrl: resultsUrl(surveyId),
    });
  });

  server.registerTool("get_survey_analytics", {
    title: "Get Survey Analytics",
    description: "Survey analytics from view/answer events (no answer values), with the previous period of the same length for comparison: views, unique views, starts, submissions, start/completion rate (%) and time to complete with change; the step funnel (key, title, viewed, answered, drop-off %, closed here, median seconds on step) and the worst step; dismissals; timing; top close points; score (NPS/CSAT/rating, current vs previous); per-version results; top rows per channel/device/OS/language; top pages/referrers/UTM; busiest day/hour slots; reminder and email totals; low-quality response counts (speeders, straight-liners). Default range: last 30 days (max 400). available: false means no events in the range: use get_survey_results.",
    inputSchema: GetSurveyAnalyticsArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = GetSurveyAnalyticsArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, from, to, version, channel, device, interval, tz } = parsed.data;
    const result = await getData(`${PATH}/${surveyId}/analytics`, buildParams({ from, to, version, channel, device, interval, tz }), LEGACY_HINT);
    if ("error" in result) return result.error;
    return wrapResponse({ id: surveyId, ...analyticsView(result.data), resultsUrl: resultsUrl(surveyId) });
  });

  server.registerTool("get_survey_insights", {
    title: "Get Survey Insights",
    description: "Stored AI insights of a survey: themes with counts and sentiment, summary findings, drivers (NPS difference of people mentioning a theme), segments (e.g. by plan) and spike alerts. Theme ids filter get_survey_responses. Returns the stored insights at once; when responses came in since they were generated (and that was over 5 minutes ago), reading them starts one update in the background (updating: true).",
    inputSchema: SurveyIdArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = SurveyIdArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId } = parsed.data;
    const insights = await getData(`${PATH}/${surveyId}/insights`, undefined, LEGACY_HINT);
    if ("error" in insights) return insights.error;
    const view = insightsView(insights.data);
    const empty = view.themes.length === 0 && !view.summary;
    return wrapResponse({
      id: surveyId,
      ...view,
      ...(view.updating
        ? { note: "Kai is updating these insights from new responses; read them again in a minute or two." }
        : view.capped
          ? { note: "The project's daily AI budget for surveys is used up: insights update again tomorrow." }
          : empty
            ? { note: "No insights yet: a survey needs a few responses (themes need about 20 text answers)." }
            : {}),
      resultsUrl: resultsUrl(surveyId),
    });
  });

  server.registerTool("ask_survey_results", {
    title: "Ask Survey Results",
    description: "Ask a plain-language question about a survey's responses (e.g. \"Why are detractors unhappy this week?\"). Returns a Markdown answer with cited response ids and quotes (read one with get_survey_response). Uses AI (billed as token usage); prefer get_survey_results / get_survey_insights for numbers.",
    inputSchema: AskSurveyResultsArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = AskSurveyResultsArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, question } = parsed.data;
    const result = await gleapPost(`${PATH}/${surveyId}/insights/ask`, { question });
    if (apiFailed(result)) return asError(result);
    return wrapResponse({ id: surveyId, question, ...askView(result.structuredContent ?? {}) });
  });

  server.registerTool("get_survey_responses", {
    title: "Get Survey Responses",
    description: "List a survey's responses, newest first, as compact rows (id, status, contact, channel, version, answers keyed by question key, prefilled, AI themes). prefilled lists the answer keys the Server filled in from the identified contact (skipped contact questions: email, name, phone), not answers the respondent gave. Filters: status (completed/partial/in_progress), answers by key (exact or \"min..max\", e.g. { nps_score: \"0..6\" }), theme, channel, contactUserId, text search q. Cursor pagination: pass nextCursor back as cursor. Use get_survey_response for one full response.",
    inputSchema: GetSurveyResponsesArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = GetSurveyResponsesArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, status, answers, theme, channel, contactUserId, q, limit, cursor, skip } = parsed.data;
    const result = await getData(`${PATH}/${surveyId}/responses`, buildParams({
      // v=2 always selects the Surveys 2.0 shape ({ items, nextCursor, total }),
      // even without a cursor or filters; plain skip/limit would get the legacy array.
      v: 2,
      status, theme, channel, contactUserId, q, cursor, skip,
      limit: limit ?? 20,
      filter: answers && Object.keys(answers).length > 0 ? answers : undefined,
    }));
    if ("error" in result) return result.error;
    const body = result.data.result === undefined ? result.data : result.data.result;
    // A legacy survey not migrated yet answers `{ items: [], legacy: true }`: its answers are
    // still tickets, served by the plain skip/limit list (filters other than paging don't apply).
    if (body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).legacy === true) {
      const legacy = await getData(`${PATH}/${surveyId}/responses`, buildParams({ skip: skip ?? 0, limit: limit ?? 20 }));
      if ("error" in legacy) return legacy.error;
      const page = responsePage(legacy.data.result === undefined ? legacy.data : legacy.data.result);
      return wrapResponse({ id: surveyId, legacySurvey: true, ...page, resultsUrl: resultsUrl(surveyId) });
    }
    const page = responsePage(body);
    // Free plan: only the first responses of a survey are readable (enforced by the API).
    const limited = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>).limited : undefined;
    return wrapResponse({
      id: surveyId,
      ...page,
      ...(limited ? { planLimit: { ...limited, note: `The Free plan shows the first ${limited.limit} responses of a survey (${limited.visible} of ${limited.total} here). Upgrading to Team shows every response.` } } : {}),
      resultsUrl: resultsUrl(surveyId),
    });
  });

  server.registerTool("search_survey_responses", {
    title: "Search Survey Responses",
    description: "Keyword search over what respondents answered, across ALL surveys of the project (or one with surveyId), newest first: e.g. every survey answer mentioning \"pricing\". It also matches the respondent's name or email (\"Jane Doe\", \"jane@acme.com\", \"@acme.com\"), so it finds what one person answered; a name and an answer word in one query do not combine. Survey answers are not tickets, so search_tickets never finds them. Returns compact hits (id, surveyId, surveyName, status, NPS score, matching snippet, contact); open one with get_survey_response(surveyId, id). `available: false` means search is not set up in this region: use get_survey_responses with q per survey instead.",
    inputSchema: SearchSurveyResponsesArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = SearchSurveyResponsesArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { query, surveyId, status, limit } = parsed.data;
    const result = await getData(`${PATH}/responses/search`, buildParams({ q: query, surveyId, status, limit: limit ?? 10 }));
    if ("error" in result) return result.error;
    const hits: Doc[] = Array.isArray(result.data.hits) ? result.data.hits : [];
    return wrapResponse({
      query,
      available: result.data.available !== false,
      hits: hits.map((hit) => ({
        id: hit.id,
        surveyId: hit.surveyId,
        surveyName: hit.surveyName,
        status: hit.status,
        nps: hit.nps ?? undefined,
        snippet: typeof hit.snippet === "string" ? hit.snippet.slice(0, 300) : undefined,
        contact: hit.contact && (hit.contact.name || hit.contact.email || hit.contact.userId)
          ? { name: hit.contact.name ?? undefined, email: hit.contact.email ?? undefined, userId: hit.contact.userId ?? undefined }
          : undefined,
        createdAt: hit.createdAt,
        resultsUrl: hit.surveyId ? dashboardUrl(String(hit.surveyId), `/results/responses/${encodeURIComponent(String(hit.id))}`) : undefined,
      })),
      ...(result.data.available === false ? { note: "Response search is not available here; use get_survey_responses with q for one survey." } : {}),
    });
  });

  server.registerTool("get_survey_response", {
    title: "Get Survey Response",
    description: "One survey response in full: answers in question order with question text and choice labels, the path through the survey, ending, contact, hidden fields, AI themes and conversations started from it. prefilled lists the answer keys the Server filled in from the identified contact (contact questions it skipped because the email, name or phone was known): the respondent did not type those answers.",
    inputSchema: GetSurveyResponseArgs.shape,
    annotations: readOnly,
  }, async (input: unknown) => {
    const parsed = GetSurveyResponseArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, responseId } = parsed.data;
    const result = await getData(`${PATH}/${surveyId}/responses/${encodeURIComponent(responseId)}`, undefined, LEGACY_HINT);
    if ("error" in result) return result.error;
    return wrapResponse({ ...responseDetail(result.data), resultsUrl: resultsUrl(surveyId) });
  });

  // ---------------------------------------------------------------- reach out
  server.registerTool("reach_out_to_respondent", {
    title: "Reach Out to Respondent",
    description: "Start a conversation (messenger or email) with the person behind a survey response, linked to that response. By default sends NOTHING: returns the draft and recipient for the operator to approve. Only with send: true — after the operator explicitly approved this exact message — it creates the conversation and sends the message.",
    inputSchema: ReachOutArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = ReachOutArgs.safeParse(input);
    if (!parsed.success) return fail(zodMessage(parsed.error));
    const { surveyId, responseId, message, subject, assignToMe, send } = parsed.data;
    const channel = parsed.data.channel ?? "messenger";
    const draft = buildParams({ channel, subject, message, assignToMe: assignToMe ?? false });
    if (send !== true) {
      const result = await getData(`${PATH}/${surveyId}/responses/${encodeURIComponent(responseId)}`, undefined, LEGACY_HINT);
      if ("error" in result) return result.error;
      const detail = responseDetail(result.data);
      return wrapResponse({
        sent: false,
        draft,
        recipient: detail.contact,
        response: { id: detail.id, status: detail.status, answers: (detail.answers as Doc[]).slice(0, 8) },
        nextStep: detail.contact
          ? "Nothing was sent. Show the operator this exact message and recipient. Only after they explicitly approve it, call reach_out_to_respondent again with the same arguments and send: true."
          : "Nothing was sent. This response has no identified contact, so there is nobody to reach out to.",
      });
    }
    const result = await gleapPost(`${PATH}/${surveyId}/responses/${encodeURIComponent(responseId)}/reach-out`, draft);
    if (apiFailed(result)) return asError(result);
    const ticketId = result.structuredContent?.ticketId;
    if (typeof ticketId !== "string" || !ticketId) return unverified(result, "the conversation; check the respondent's conversations with get_survey_response");
    return wrapResponse({
      sent: true,
      channel,
      ticketId,
      nextStep: "Conversation started and linked to the response. Read it with get_ticket / get_ticket_messages.",
    });
  });

  // ---------------------------------------------------------------- legacy
  server.registerTool("get_survey_summary", {
    title: "Get Survey Summary",
    description: "Get an AI-generated summary of survey responses (stored; regenerated at most once a minute). For Surveys 2.0 prefer get_survey_insights and ask_survey_results.",
    inputSchema: GetSurveySummaryArgs.shape,
    annotations: readOnly,
  }, async ({ surveyId }): Promise<GleapApiResponse> => gleapGet(`${PATH}/${surveyId}/responses/summarize`));
};
