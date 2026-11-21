import { GleapApiResponse } from "../types/index.js";
import { toStructuredRecord } from "./api.js";

// ── Response slimming ──────────────────────────────────────────────────────
// The Gleap REST backend sizes its list payloads for the dashboard UI, not for
// an LLM. A single list call can dump full `content` / `plainContent` /
// `formData` / `form` / TipTap document bodies / populated sub-documents for
// every result — tens of thousands of tokens the agent doesn't need just to
// *find* the right item. Every list/search tool projects to a slim summary
// here; agents that need the full document call the corresponding detail tool
// (`get_ticket`, `get_news_item`, `get_help_center_article`, `get_contact`).
//
// Slimming lives in the MCP server, not the backend, on purpose: the cost being
// optimized is LLM tokens, and the MCP boundary is what controls what the model
// sees. The backend `/tickets` endpoint is shared with the dashboard (which
// depends on the full projection), so its default shape can't change. See the
// "Token-Bloat Projection" plan for the full rationale.

const PREVIEW_CHARS = 200;
// Conversation messages are the detail view (no per-message fetch tool), so we
// keep their full text — only the TipTap *structure* is dropped. A generous cap
// still guards against a single pathologically long message.
const MESSAGE_PREVIEW_CHARS = 4000;

/** Truncates a string to `max` chars, or returns null for non-strings. */
const preview = (value: unknown, max = PREVIEW_CHARS): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

/** Coerces an id, a populated doc, or an ObjectId-ish object to its id string. */
export const toIdString = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj._id === "string") return obj._id;
    if (typeof obj.id === "string") return obj.id;
  }
  return null;
};

/**
 * Flattens a TipTap/ProseMirror doc to plain text by walking the node tree:
 * collecting `text` leaves, pulling text out of attr-bearing nodes (mentions,
 * emoji), and separating block-level nodes with newlines.
 *
 * We deliberately do NOT use TipTap's `generateText`/`generateHTML` here, even
 * though the backend does. Those require the full extension set registered and
 * throw on any unknown node type (the backend wraps them in try/catch → ''),
 * which for a token-slimming preview means losing an entire message's text over
 * one exotic node. This walker can't throw and degrades gracefully on schema
 * drift — the right tradeoff for a lossy, already-truncated triage preview. The
 * attr-text cases below mirror the backend's `sanitizeMentionNodes`.
 */
export const tiptapToPlainText = (doc: unknown): string => {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") {
      out.push(node.text);
    } else if (node.type === "mention" && node.attrs) {
      // Text lives in attrs, not a child text node — matches backend behavior.
      out.push(
        `@${node.attrs.label ?? node.attrs.name ?? node.attrs.id ?? ""}`,
      );
    } else if (node.type === "emoji" && node.attrs?.name) {
      out.push(`:${node.attrs.name}:`);
    } else if (node.type === "hardBreak" || node.type === "break") {
      out.push("\n");
    }
    let content = node.content;
    // Localized bodies wrap the value per locale: `{ localized: { en, de, … } }`.
    // Prefer English, else the first locale present — mirrors the backend.
    if (
      content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      content.localized &&
      typeof content.localized === "object"
    ) {
      content =
        content.localized.en ??
        content.localized[Object.keys(content.localized)[0]];
    }
    if (Array.isArray(content)) {
      content.forEach(walk);
      // Block separator after container nodes so paragraphs don't run together.
      if (node.type && node.type !== "text") out.push("\n");
    } else if (typeof content === "string") {
      // Answer-bot answers and chat replies store their body as a bare markdown
      // string under `data.content`, not as a TipTap doc tree. Without this the
      // entire visible text of those messages is dropped (returns null).
      out.push(content);
    } else if (content && typeof content === "object") {
      // Messages wrap the doc one level deep, e.g. `data: { content: <doc> }`.
      walk(content);
    }
  };
  walk(doc);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

// ── Generic envelope projector ─────────────────────────────────────────────
// Re-maps the list inside a GleapApiResponse and re-encodes BOTH the structured
// form and the text `content[0]` so clients that read either see the slim
// payload. Handles every container shape the API + `toStructuredListContent`
// produce: a bare array, or an object wrapping the list under `results`,
// `tickets`, `data`, or `items`. Error envelopes pass through untouched.
const LIST_KEYS = ["results", "tickets", "data", "items"] as const;

export const projectList = (
  response: GleapApiResponse,
  slim: (item: any) => unknown,
): GleapApiResponse => {
  if (response.structuredContent === undefined) return response;

  const sc = response.structuredContent as any;
  if (sc && typeof sc === "object" && sc.error) return response;

  const slimPayload = (payload: unknown): unknown => {
    if (Array.isArray(payload)) return payload.map(slim);
    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      for (const key of LIST_KEYS) {
        if (Array.isArray(obj[key])) {
          return { ...obj, [key]: (obj[key] as unknown[]).map(slim) };
        }
      }
    }
    return payload;
  };

  // A bare-array payload stays an array through `slimPayload`, so re-apply the
  // record guard here too — this path builds the envelope itself instead of
  // going back through `wrapResponse`.
  const slimmed = toStructuredRecord(slimPayload(response.structuredContent));
  return {
    ...response,
    content: [{ type: "text", text: JSON.stringify(slimmed, null, 2) }],
    structuredContent: slimmed as any,
  };
};

/**
 * Same envelope re-encoding as `projectList`, for responses whose
 * `structuredContent` is a single document rather than a list — used to
 * decorate a detail payload (e.g. `get_ticket`) without slimming it.
 */
export const projectSingle = (
  response: GleapApiResponse,
  map: (item: any) => unknown,
): GleapApiResponse => {
  const sc = response.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return response;
  if ((sc as any).error) return response;

  const mapped = map(sc);
  return {
    ...response,
    content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }],
    structuredContent: mapped as any,
  };
};

// ── Per-entity slim functions (allowlists) ─────────────────────────────────
// Allowlists, not blocklists: any new backend field is excluded by default, so
// the slim payload can't silently regrow. Keep these in sync with what an agent
// needs to *triage/filter*; full data is one detail-tool call away.

export const slimTicket = (ticket: any): Record<string, unknown> => {
  if (!ticket || typeof ticket !== "object") return ticket;

  const latestComment = ticket.latestComment;
  const latestCommentPreview =
    latestComment && typeof latestComment === "object"
      ? {
          createdAt: latestComment.createdAt ?? null,
          sender: toIdString(latestComment.sender ?? latestComment.user),
          // The populated comment carries its body as `text`/`plainContent`/
          // `comment`, or as a TipTap doc under `data` — fall through them all.
          preview:
            preview(latestComment.text) ||
            preview(latestComment.plainContent) ||
            preview(latestComment.comment) ||
            preview(tiptapToPlainText(latestComment.data)) ||
            null,
        }
      : null;

  return {
    id: ticket.id ?? ticket._id ?? null,
    // Human-facing ticket number ("#138803"). Exposed so agents can map a
    // user's "#number" reference to this ticket and pass it to get_ticket
    // (which resolves bugId server-side). Mirrors slimTicketSearchHit.
    bugId: ticket.bugId ?? null,
    title: ticket.title ?? null,
    status: ticket.status ?? null,
    priority: ticket.priority ?? null,
    type: ticket.type ?? null,
    processingUser: toIdString(ticket.processingUser),
    processingTeam: toIdString(ticket.processingTeam),
    tags: Array.isArray(ticket.tags) ? ticket.tags : [],
    aiSummary: ticket.aiSummary ?? null,
    conversationClosed: ticket.conversationClosed ?? null,
    slaBreached: ticket.slaBreached ?? null,
    archived: ticket.archived ?? null,
    archivedAt: ticket.archivedAt ?? null,
    latestComment: latestCommentPreview,
    // Customer-submitted structured data. Kept in the slim payload because
    // filtering / triage / survey-answer workflows commonly need these
    // key/value answers without a second detail round-trip. The bulkier `form`
    // definition is intentionally excluded — fetch the full ticket if needed.
    formData: ticket.formData ?? null,
    createdAt: ticket.createdAt ?? null,
    updatedAt: ticket.updatedAt ?? null,
  };
};

// `search_tickets` returns OpenSearch-style hits: `{ _id, _score, _source,
// document, matchedBy }` — and `_source` duplicates `document`. Collapse to a
// single flat slim record (drops `plainContent` body + the duplication).
export const slimTicketSearchHit = (hit: any): Record<string, unknown> => {
  if (!hit || typeof hit !== "object") return hit;
  const doc = hit.document ?? hit._source ?? hit;
  return {
    id: doc.id ?? doc._id ?? hit._id ?? null,
    bugId: doc.bugId ?? null,
    title: doc.title ?? null,
    status: doc.status ?? null,
    priority: doc.priority ?? null,
    type: doc.type ?? null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    archived: doc.archived ?? null,
    archivedAt: doc.archivedAt ?? null,
    session: toIdString(doc.session),
    preview: preview(doc.plainContent),
    score: hit._score ?? null,
    matchedBy: hit.matchedBy ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

export const slimContact = (contact: any): Record<string, unknown> => {
  if (!contact || typeof contact !== "object") return contact;
  return {
    id: contact.id ?? contact._id ?? null,
    gleapId: contact.gleapId ?? null,
    userId: contact.userId ?? null,
    name: contact.name ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    companyId: contact.companyId ?? null,
    companyName: contact.companyName ?? null,
    plan: contact.plan ?? null,
    value: contact.value ?? null,
    tags: Array.isArray(contact.tags) ? contact.tags : [],
    lang: contact.lang ?? null,
    country: contact.location?.country ?? null,
    unsubscribed: contact.unsubscribed ?? null,
    lastActivity: contact.lastActivity ?? null,
    createdAt: contact.createdAt ?? null,
    // `customData` and `eventData` are dropped here — they can be large and are
    // rarely needed to identify a contact. Fetch via `get_contact` if required.
  };
};

// `/projects/users` returns dashboard users with the backend's SECURE
// projection — still dozens of profile/notification fields per user. Agents
// only need enough to pick an assignee.
export const slimUser = (user: any): Record<string, unknown> => {
  if (!user || typeof user !== "object") return user;
  return {
    id: user.id ?? user._id ?? null,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    // Membership role (admin/user) + whether it comes from the project or the
    // organisation — both attached by the backend's user-list endpoint.
    role: user.role ?? null,
    type: user.type ?? null,
    available: user.available ?? null,
    lastSeen: user.lastSeen ?? null,
  };
};

export const slimMessage = (message: any): Record<string, unknown> => {
  if (!message || typeof message !== "object") return message;
  const body =
    preview(message.plainContent, MESSAGE_PREVIEW_CHARS) ||
    preview(message.comment, MESSAGE_PREVIEW_CHARS) ||
    preview(tiptapToPlainText(message.data), MESSAGE_PREVIEW_CHARS) ||
    null;
  const data =
    message.data && typeof message.data === "object" ? message.data : {};
  // Author identity is split across two refs: human teammates live on `user`,
  // end users (incl. their replies inside a bot flow, which also carry
  // `bot: true`) live on `session`. Surface both an id and a role so callers can
  // attribute every entry instead of guessing from `bot`/`type`.
  const senderType =
    message.type === "SYSTEM_MESSAGE"
      ? "system"
      : message.session
        ? "user"
        : message.user
          ? "agent"
          : message.bot
            ? "bot"
            : null;
  return {
    id: message.id ?? message._id ?? null,
    type: message.type ?? null,
    senderType,
    sender:
      toIdString(message.user) ??
      message.fallbackUser?.username ??
      toIdString(message.session) ??
      null,
    bot: message.bot ?? false,
    text: body,
    // Answer-bot signals — kept on the message itself because conversation
    // messages are the detail view (there is no per-message fetch tool) and
    // these drive bot QA / "missing answer" review.
    answerBot: data.answerBot ?? false,
    ...(data.answerBot ? { hasAnswer: data.hasAnswer ?? null } : {}),
    sources: Array.isArray(data.sources)
      ? data.sources.map((s: any) => ({
          title: s?.title ?? null,
          url: s?.url ?? null,
        }))
      : [],
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((a: any) => ({
          name: a?.name ?? null,
          url: a?.url ?? null,
          type: a?.type ?? null,
        }))
      : [],
    createdAt: message.createdAt ?? null,
    updatedAt: message.updatedAt ?? null,
  };
};

export const slimNews = (news: any): Record<string, unknown> => {
  if (!news || typeof news !== "object") return news;
  return {
    id: news.id ?? news._id ?? null,
    name: news.name ?? null,
    // `subject` is a small localized title object; keep it. The heavy
    // `markdownMessage` / `localized` TipTap bodies are dropped — use
    // `get_news_item` for the full content.
    subject: news.subject ?? null,
    type: news.type ?? null,
    subType: news.subType ?? null,
    status: news.status ?? null,
    pinned: news.pinned ?? null,
    sender: news.sender ?? null,
    coverImageUrl: news.coverImageUrl ?? null,
    targetAudience: news.targetAudience ?? null,
    createdAt: news.createdAt ?? null,
    updatedAt: news.updatedAt ?? null,
  };
};

export const slimArticle = (article: any): Record<string, unknown> => {
  if (!article || typeof article !== "object") return article;
  return {
    id: article.id ?? article._id ?? null,
    // `title` / `description` are small localized objects; the heavy localized
    // TipTap `content` body is dropped — use `get_help_center_article` for it.
    title: article.title ?? null,
    description: article.description ?? null,
    slug: article.slug ?? null,
    helpcenterCollection: toIdString(article.helpcenterCollection),
    language: article.language ?? null,
    isDraft: article.isDraft ?? null,
    tags: Array.isArray(article.tags) ? article.tags : [],
    docId: article.docId ?? null,
    createdAt: article.createdAt ?? null,
    updatedAt: article.updatedAt ?? null,
  };
};

// Companies serialize with `_id` (no `id` virtual, unlike sessions). The Gleap
// `id` is surfaced explicitly because it is what the pipeline tools take as
// `recordId` for COMPANY pipelines; `companyId` stays the customer's external id.
export const slimCompany = (company: any): Record<string, unknown> => {
  if (!company || typeof company !== "object") return company;
  return {
    id: company._id ?? company.id ?? null,
    companyId: company.companyId ?? null,
    name: company.name ?? null,
    plan: company.plan ?? null,
    value: company.value ?? null,
    domain: company.domain ?? null,
    lastSeenAt: company.lastSeenAt ?? null,
    createdAt: company.createdAt ?? null,
    // `customData` and `address` are dropped here — fetch via `get_company`.
  };
};

// The backend calls stages "lanes"; the MCP surface speaks "stages" like the
// dashboard UI. Array order is the board order; `id` is what stageId params take.
const slimStage = (lane: any): Record<string, unknown> => ({
  id: lane?.id ?? null,
  title: lane?.title ?? null,
  archived: lane?.archived ?? false,
});

export const slimPipeline = (pipeline: any): Record<string, unknown> => {
  if (!pipeline || typeof pipeline !== "object") return pipeline;
  return {
    id: pipeline.id ?? pipeline._id ?? null,
    name: pipeline.name ?? null,
    recordType: pipeline.recordType ?? null,
    viewType: pipeline.viewType ?? null,
    stages: Array.isArray(pipeline.lanes) ? pipeline.lanes.map(slimStage) : [],
    createdAt: pipeline.createdAt ?? null,
    updatedAt: pipeline.updatedAt ?? null,
  };
};

// A pipeline field is a PIPELINE-scoped property. `fieldId` is the key entry
// `values` are stored under; `calculation` is joined in from the pipeline's
// column config by the caller (the property doc itself doesn't carry it).
export const slimPipelineField = (
  property: any,
  calculation?: string | null,
): Record<string, unknown> => {
  if (!property || typeof property !== "object") return property;
  return {
    fieldId: property.fieldId ?? null,
    label: property.label ?? null,
    type: property.type ?? null,
    currency: property.currency ?? null,
    calculation: calculation ?? null,
  };
};

// `record` is the entry's cached snapshot of its parent company/contact —
// enough to recognize the entry without a second lookup. `stage` is resolved
// from the pipeline's lanes by the caller (entries only store the id).
export const slimPipelineEntry = (
  entry: any,
  stageTitles?: Map<string, string>,
): Record<string, unknown> => {
  if (!entry || typeof entry !== "object") return entry;
  const snapshot =
    entry.recordSnapshot && typeof entry.recordSnapshot === "object"
      ? entry.recordSnapshot
      : {};
  return {
    id: entry.id ?? entry._id ?? null,
    pipelineId: toIdString(entry.pipeline),
    recordType: entry.recordType ?? null,
    recordId: toIdString(entry.recordId),
    record: {
      name: snapshot.name ?? null,
      subtitle: snapshot.subtitle ?? null,
      plan: snapshot.plan ?? null,
      value: snapshot.value ?? null,
      externalCompanyId: snapshot.externalId ?? null,
    },
    stageId: entry.laneId ?? null,
    stage: stageTitles?.get(entry.laneId) ?? null,
    values:
      entry.values && typeof entry.values === "object" ? entry.values : {},
    stageChangedAt: entry.laneChangedAt ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  };
};

// A "workflow" is a bot with `type: 'workflow'` (or a legacy typeless bot; see
// `isWorkflowBot`). The full bot doc carries the
// `actionFlows` graph, `conditions`, `dataSources`, and `triggerFilter` — large
// and irrelevant for *picking* a workflow to run. Keep only what identifies a
// workflow and tells the caller whether it can be started (`status`).
const workflowActions = (workflow: any): any[] =>
  (Array.isArray(workflow?.actionFlows) ? workflow.actionFlows : []).flatMap((flow: any) => (Array.isArray(flow?.actions) ? flow.actions : []));

export const slimWorkflow = (workflow: any): Record<string, unknown> => {
  if (!workflow || typeof workflow !== "object") return workflow;
  return {
    id: workflow.id ?? workflow._id ?? null,
    name: workflow.name ?? null,
    status: workflow.status ?? null,
    type: workflow.type ?? null,
    // CONVERSATION (absent on older workflows), PIPELINE_ENTRY or SURVEY_RESPONSE.
    contextType: workflow.contextType ?? "CONVERSATION",
    trigger: workflow.trigger ?? null,
    triggerType: workflow.triggerType ?? null,
    // Survey workflows: { outboundId: { data: <survey id> | "ALL" } } scopes the survey.
    triggerFilter: workflow.triggerFilter ?? null,
    aiDescription: workflow.aiDescription ?? null,
    invocations: workflow.invocations ?? null,
    targetAudience: workflow.targetAudience ?? null,
    platforms: Array.isArray(workflow.platforms) ? workflow.platforms : [],
    // customer-facing (answers customers), team or internal, as the server derives it.
    workflowKind: workflow.workflowKind ?? null,
    // Kai Support answers in it (an AI answer step), and the agent it passes conversations to.
    kaiAnswers: workflowActions(workflow).some((action: any) => action?.type === "answerbotflow"),
    passesToAgentId: toIdString(workflowActions(workflow).find((action: any) => action?.type === "passtoagent" && action?.agentId)?.agentId) ?? null,
    createdAt: workflow.createdAt ?? null,
    updatedAt: workflow.updatedAt ?? null,
  };
};
