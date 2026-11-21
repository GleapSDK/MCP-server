/**
 * Compact views of survey objects, stats, insights and responses for agents
 * (Surveys 2.0). Pure. Every list is capped and long text is clipped, so a
 * tool result stays small no matter how many responses a survey has; lists
 * that were cut say so (`…Truncated: true` / counts).
 */
import { cleanDefinition, formatOf, hasUnpublishedChanges, textOf } from "./surveyDefinition.js";

type Doc = Record<string, any>;

export const clip = (value: unknown, max: number): unknown =>
  typeof value === "string" && value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Generic size guard for server payloads whose exact shape the MCP does not own. */
export const compact = (value: unknown, maxString = 500, maxArray = 25, depth = 6): unknown => {
  if (typeof value === "string") return clip(value, maxString);
  if (depth <= 0) return Array.isArray(value) ? `[${value.length} items]` : value && typeof value === "object" ? "{…}" : value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => compact(item, maxString, maxArray, depth - 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Doc)
      .filter(([key]) => key !== "__v")
      .map(([key, inner]) => [key === "_id" ? "id" : key, compact(inner, maxString, maxArray, depth - 1)]));
  }
  return value;
};

const idOf = (doc: Doc | undefined): string | null => {
  const id = doc?.id ?? doc?._id;
  return id == null ? null : String(id);
};

const languageOf = (definition: Doc | undefined) => definition?.defaultLanguage ?? "en";

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

const targetingOf = (survey: Doc) => ({
  trigger: survey.trigger?.event ? { event: survey.trigger.event, delaySeconds: survey.trigger.data ?? 0 } : null,
  frequencyType: survey.frequencyType ?? null,
  frequency: survey.frequency ?? null,
  frequencyDays: survey.frequencyDays ?? 0,
  targetAudience: survey.targetAudience ?? null,
  conditions: survey.conditions ?? null,
});

/** One row of list_surveys. */
export const slimSurvey = (survey: Doc): Doc => {
  if (!survey || typeof survey !== "object") return survey;
  const v2 = survey.survey;
  const draft = v2?.draft;
  return {
    id: idOf(survey),
    sdkSurveyId: survey.actionType ?? null,
    name: survey.name ?? null,
    status: survey.status ?? null,
    format: formatOf(survey),
    surveysV2: Boolean(v2),
    version: v2?.version ?? null,
    publishedAt: v2?.publishedAt ?? null,
    hasUnpublishedChanges: v2 ? hasUnpublishedChanges(survey) : null,
    questions: Array.isArray(draft?.blocks) ? draft.blocks.length : null,
    trigger: survey.trigger?.event ?? null,
    createdAt: survey.createdAt ?? null,
    updatedAt: survey.updatedAt ?? null,
  };
};

/** get_survey: the definition an agent edits plus status, versions and targeting. */
export const surveyView = (survey: Doc, which: "draft" | "published" = "draft"): Doc => {
  const v2 = survey.survey;
  const definition = v2 ? (which === "published" ? v2.published : v2.draft) : undefined;
  return {
    ...slimSurvey(survey),
    definitionVersion: which,
    definition: definition ? cleanDefinition(definition) : null,
    ...(v2 ? {} : {
      legacy: true,
      note: "Legacy survey (created before Surveys 2.0); it has no definition yet. update_survey saves a 2.0 draft for it; until a teammate publishes, respondents keep seeing the legacy form.",
    }),
    page: v2?.page ? compact(v2.page, 300, 10) : null,
    email: v2?.email ?? null,
    targeting: targetingOf(survey),
  };
};

// ---------------------------------------------------------------------------
// Stats / insights / ask
// ---------------------------------------------------------------------------

const rate = (part: unknown, whole: unknown) =>
  typeof part === "number" && typeof whole === "number" && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

const entriesOf = (value: unknown): [string, number][] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.map((item: Doc) => [String(item.value ?? item.key ?? item.id ?? item.to ?? ""), Number(item.count ?? item.n ?? 0)]);
  }
  return Object.entries(value as Doc).map(([key, count]) => [key, Number(count) || 0]);
};

const top = (entries: [string, number][], max: number) => [...entries].sort((a, b) => b[1] - a[1]).slice(0, max);

const choiceLabel = (block: Doc | undefined, value: string, language: string): string | null => {
  const choice = block?.choices?.find((item: Doc) => item.id === value);
  if (choice) return textOf(choice.label, language);
  if (block?.type === "yesno") return value === "true" ? "Yes" : value === "false" ? "No" : null;
  return null;
};

/** get_survey_results: stored counters, labelled with the survey's questions when the definition is known. */
export const statsView = (stats: Doc, definition: Doc | undefined, includeDaily: boolean): Doc => {
  const language = languageOf(definition);
  const blocks: Doc[] = Array.isArray(definition?.blocks) ? definition!.blocks : [];
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const totals = stats.totals ?? {};
  const perBlock: Doc = stats.perBlock ?? {};
  const orderedKeys = [
    ...blocks.map((block) => block.key).filter((key) => key in perBlock),
    ...Object.keys(perBlock).filter((key) => !byKey.has(key)),
  ];
  const perQuestion = orderedKeys.slice(0, 60).map((key) => {
    const counts: Doc = perBlock[key] ?? {};
    const block = byKey.get(key);
    const values = entriesOf(counts.values);
    const reached = Number(counts.reached ?? 0);
    const answered = Number(counts.answered ?? 0);
    return {
      key,
      question: clip(textOf(block?.title, language), 160) ?? null,
      type: block?.type ?? null,
      reached,
      answered,
      skipped: Number(counts.skipped ?? 0),
      answerRate: rate(answered, reached),
      values: top(values, 25).map(([value, count]) => {
        const label = choiceLabel(block, value, language);
        return label ? { value, label, count } : { value, count };
      }),
      ...(values.length > 25 ? { valuesTruncated: true } : {}),
    };
  });
  const endingTitles = new Map((definition?.endings ?? []).map((ending: Doc) => [ending.id, textOf(ending.title, language)]));
  const edges = entriesOf(stats.edges);
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  return {
    totals: {
      ...compact(totals, 100, 10, 2) as Doc,
      startRate: rate(totals.started, totals.shown),
      completionRate: rate(totals.completed, totals.started),
    },
    nps: stats.nps ? compact(stats.nps, 100, 15, 3) : null,
    perQuestion,
    endings: top(entriesOf(stats.endings), 10).map(([id, count]) => ({ id, title: clip(endingTitles.get(id) ?? null, 120), count })),
    channels: Object.fromEntries(top(entriesOf(stats.channels), 10)),
    topPaths: top(edges, 20).map(([edge, count]) => {
      const [from, to] = edge.split(">");
      return { from, to: to ?? null, count };
    }),
    ...(edges.length > 20 ? { pathsTruncated: true } : {}),
    ...(includeDaily ? { daily: daily.slice(-92).map((day: unknown) => compact(day, 60, 20, 2)) } : { dailyDays: daily.length }),
  };
};

/** get_survey_insights: themes, summary, drivers, segments and alerts, capped. */
export const insightsView = (insights: Doc): Doc => {
  const themes = Array.isArray(insights.themes) ? insights.themes : [];
  const segments = Array.isArray(insights.segments) ? insights.segments : [];
  const generation = (insights.generation ?? {}) as Doc;
  return {
    updatedAt: insights.updatedAt ?? null,
    ...(generation.status === "updating" ? { updating: true } : {}),
    ...(generation.capped ? { capped: true } : {}),
    themes: themes.slice(0, 30).map((theme: Doc) => compact(theme, 200, 10, 2)),
    ...(themes.length > 30 ? { themesTruncated: themes.length } : {}),
    summary: insights.summary ? compact(insights.summary, 600, 10, 4) : null,
    drivers: Array.isArray(insights.drivers) ? insights.drivers.slice(0, 15).map((driver: unknown) => compact(driver, 120, 10, 2)) : [],
    segments: segments.slice(0, 8).map((segment: Doc) => ({
      property: segment.property ?? null,
      rows: Array.isArray(segment.rows) ? segment.rows.slice(0, 12).map((row: unknown) => compact(row, 80, 10, 2)) : [],
    })),
    alerts: Array.isArray(insights.alerts) ? insights.alerts.slice(0, 10).map((alert: unknown) => compact(alert, 120, 10, 2)) : [],
  };
};

/** ask_survey_results: the answer with its cited responses. */
export const askView = (result: Doc): Doc => {
  const citations = Array.isArray(result.citations) ? result.citations : [];
  return {
    answer: clip(result.answer ?? null, 6000),
    basedOn: result.basedOn ?? null,
    citations: citations.slice(0, 25).map((citation: Doc) => ({
      responseId: citation.responseId ?? null,
      quote: clip(citation.quote ?? null, 300),
    })),
    ...(citations.length > 25 ? { citationsTruncated: citations.length } : {}),
  };
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Contact summary of a response (v2 `contact`, legacy ticket `session`, or just the userId). */
export const contactOf = (response: Doc, contact?: Doc): Doc | null => {
  const source = contact ?? response.contact ?? (response.session && typeof response.session === "object" ? response.session : undefined);
  if (source && typeof source === "object") {
    return {
      id: idOf(source),
      userId: source.userId ?? response.contactUserId ?? null,
      name: source.name ?? null,
      email: source.email ?? null,
      ...(source.plan ? { plan: source.plan } : {}),
      ...(source.companyName ? { companyName: source.companyName } : {}),
    };
  }
  return response.contactUserId ? { userId: response.contactUserId } : null;
};

const compactAnswer = (value: unknown, maxString: number): unknown => {
  if (typeof value === "string") return clip(value, maxString);
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => compact(item, maxString, 10, 2));
  return compact(value, maxString, 10, 2);
};

/**
 * `prefilled`: keys of the answers the Server filled in from the identified
 * contact ("skip when known", Server knownContact.ts) instead of the
 * respondent typing them. Omitted when there are none (and on Servers or
 * responses from before it existed).
 */
const prefilledOf = (response: Doc): Doc => {
  const keys = Array.isArray(response.prefilled) ? response.prefilled.filter((key: unknown) => typeof key === "string") : [];
  return keys.length > 0 ? { prefilled: keys.slice(0, 60) } : {};
};

/** One row of get_survey_responses (v2 response or legacy survey ticket). */
export const responseRow = (response: Doc): Doc => {
  const answers: Doc = response.answers ?? response.formData ?? {};
  const keys = Object.keys(answers);
  return {
    id: idOf(response),
    status: response.status ?? null,
    contact: contactOf(response),
    channel: response.channel ?? null,
    version: response.version ?? null,
    createdAt: response.createdAt ?? null,
    completedAt: response.completedAt ?? null,
    answers: Object.fromEntries(keys.slice(0, 30).map((key) => [key, compactAnswer(answers[key], 300)])),
    ...(keys.length > 30 ? { answersTruncated: keys.length } : {}),
    ...prefilledOf(response),
    themes: Array.isArray(response.themes) ? response.themes.map((theme: Doc) => (theme.sentiment ? `${theme.id}:${theme.sentiment}` : theme.id)) : [],
    conversations: Array.isArray(response.conversations) ? response.conversations.length : 0,
    ...(response.bugId ? { legacyTicketNumber: response.bugId } : {}),
  };
};

/** The page of responses + cursor, whatever envelope the API used. */
export const responsePage = (data: unknown): Doc => {
  const envelope = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Doc;
  const items: Doc[] = Array.isArray(data) ? data
    : envelope.responses ?? envelope.items ?? envelope.results ?? envelope.data ?? [];
  return {
    responses: items.map(responseRow),
    count: items.length,
    nextCursor: envelope.nextCursor ?? null,
    ...(typeof envelope.total === "number" ? { total: envelope.total } : {}),
  };
};

const answerDisplay = (block: Doc | undefined, value: unknown, language: string): string | null => {
  if (value === undefined || value === null) return null;
  if (value && typeof value === "object" && !Array.isArray(value) && "other" in (value as Doc)) {
    return `Other: ${String((value as Doc).other)}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => choiceLabel(block, String(item), language) ?? String(item)).join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return choiceLabel(block, String(value), language) ?? String(value);
};

/** get_survey_response: answers in question order with their question text and labels. */
export const responseDetail = (data: Doc): Doc => {
  const response: Doc = data.response ?? data;
  const definition: Doc | undefined = data.definition ?? response.definition;
  const language = response.language ?? languageOf(definition);
  const blocks: Doc[] = Array.isArray(definition?.blocks) ? definition!.blocks : [];
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const answers: Doc = response.answers ?? response.formData ?? {};
  const known = new Set(blocks.map((block) => block.key));
  const endings: Doc[] = definition?.endings ?? [];
  const titleOfId = (id: string) => textOf(byId.get(id)?.title ?? endings.find((ending) => ending.id === id)?.title, language);
  return {
    id: idOf(response),
    status: response.status ?? null,
    version: response.version ?? null,
    channel: response.channel ?? null,
    language: response.language ?? null,
    contact: contactOf(response, data.contact),
    startedAt: response.startedAt ?? response.createdAt ?? null,
    lastAnswerAt: response.lastAnswerAt ?? null,
    completedAt: response.completedAt ?? null,
    durationMs: response.durationMs ?? null,
    pageUrl: clip(response.pageUrl ?? null, 300),
    fields: response.fields ? compact(response.fields, 200, 30, 1) : null,
    answers: [
      ...blocks.filter((block) => block.key in answers).map((block) => ({
        key: block.key,
        question: clip(textOf(block.title, language), 300),
        type: block.type,
        value: compactAnswer(answers[block.key], 4000),
        display: clip(answerDisplay(block, answers[block.key], language), 4000),
      })),
      ...Object.keys(answers).filter((key) => !known.has(key)).slice(0, 30).map((key) => ({
        key, question: null, type: null, value: compactAnswer(answers[key], 4000),
      })),
    ],
    ...prefilledOf(response),
    path: Array.isArray(response.path) ? response.path.slice(0, 80).map((id: string) => ({ id, title: clip(titleOfId(id), 120) })) : [],
    ending: response.endingId ? { id: response.endingId, title: clip(titleOfId(response.endingId), 120) } : null,
    themes: Array.isArray(response.themes) ? response.themes : [],
    conversations: Array.isArray(response.conversations) ? response.conversations.map(String) : [],
    ...(response.legacyTicket ? { legacyTicket: String(response.legacyTicket) } : {}),
  };
};
