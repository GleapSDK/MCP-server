import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import {
  BulkUpdateTicketsArgs,
  CreateSnippetArgs,
  GetArticleDraftArgs,
  GetKnowledgeGapsArgs,
  GetSnippetsArgs,
  GetSupportHoursArgs,
  PublishArticleDraftArgs,
  SaveArticleDraftArgs,
  StartKaiResolveArgs,
  UpdateOfficeHoursArgs,
  UpdateSlaArgs,
  UpdateSnippetArgs,
} from "../schemas/toolbox.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import { REMOVED_TOOL_ANNOTATIONS, removedToolResponse } from "../utils/removedTool.js";
import {
  gleapGetData,
  gleapPost,
  gleapPut,
  validationErrorResponse,
  wrapResponse,
} from "../utils/api.js";

/**
 * Kai Operator's toolbox (plan 2026-10-24, "What it can do"): a batch of tickets in one call, a
 * help-center article edited as a draft and published, the answers
 * Kai uses (snippets) and the questions it could not answer, the support hours and the SLA. Every
 * call acts with the connected person's role; in Gleap, Kai Operator shows a card before any of
 * the writes runs (drafts excepted: nobody outside the team sees them).
 */

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type Result = { error: GleapApiResponse } | { data: unknown };
const errorOf = (result: Result) => ("error" in result ? result.error : null);
const dataOf = (result: Result): any => ("data" in result ? result.data : null);
const failed = (response: GleapApiResponse) => response.isError === true || (response.structuredContent as any)?.error === true;

const localizedMerge = (current: unknown, next: Record<string, unknown> | undefined) =>
  next ? { ...(current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {}), ...next } : undefined;

const first = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const text = record.en ?? Object.values(record).find((entry) => typeof entry === "string");
  return typeof text === "string" ? text : "";
};

const clip = (text: unknown, max: number) => {
  const value = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export const registerToolboxTools = (server: McpServer) => {
  server.registerTool(
    "bulk_update_tickets",
    {
      title: "Bulk Update Tickets",
      description:
        "Change many tickets in one call: tag, close, assign, move to a team, set a priority, snooze or archive. Use it whenever two or more tickets change the same way (\"tag every refund ticket with refund\"): find them first (search_tickets / find_tickets), then pass every id. Respects each ticket's board and the person's access; tickets that already have a tag, or whose board lacks the priority, are skipped and counted.",
      inputSchema: BulkUpdateTicketsArgs.shape,
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (args): Promise<GleapApiResponse> => {
      const ids = [...new Set(args.ticketIds)];
      const needs: Record<string, unknown> = { tag: args.tags?.length, assign: args.userId, team: args.teamId, priority: args.priority, snooze: args.snoozeMinutes };
      if (args.action in needs && !needs[args.action]) {
        const field = { tag: "tags", assign: "userId", team: "teamId", priority: "priority", snooze: "snoozeMinutes" }[args.action as "tag"];
        return validationErrorResponse(`${args.action} needs ${field}.`);
      }
      const payloads: Array<Record<string, unknown>> =
        args.action === "tag"
          ? (args.tags ?? []).map((tag) => ({ tag }))
          : [
              {
                ...(args.action === "assign" ? { processingUser: args.userId } : {}),
                ...(args.action === "team" ? { processingTeam: args.teamId } : {}),
                ...(args.action === "priority" ? { priority: args.priority } : {}),
                // The bulk route snoozes for a duration in seconds, like the single snooze.
                ...(args.action === "snooze" ? { duration: (args.snoozeMinutes ?? 0) * 60 } : {}),
              },
            ];
      const results: Array<{ tag?: string; matched: number; changed: number; skipped: number }> = [];
      for (const payload of payloads) {
        const response = await gleapPut("/tickets/bulk", { action: args.action, selection: { ids }, payload });
        if (failed(response)) return response;
        const data: any = response.structuredContent ?? {};
        results.push({
          ...(payload.tag ? { tag: `${payload.tag}` } : {}),
          matched: Number(data.matchedCount ?? 0),
          changed: Number(data.modifiedCount ?? 0),
          skipped: Number(data.skippedCount ?? 0),
        });
      }
      const changed = results.reduce((sum, row) => sum + row.changed, 0);
      return wrapResponse({
        action: args.action,
        tickets: ids.length,
        results,
        message: `${args.action === "tag" ? `Tagged` : "Changed"} ${changed} ${changed === 1 ? "ticket" : "tickets"} of ${ids.length}${results.some((row) => row.skipped) ? ` (${results.reduce((sum, row) => sum + row.skipped, 0)} skipped: already done or not possible on their board)` : ""}.`,
      });
    },
  );

  // Removed (Hard tickets, SPEC §1/§8): Kai Resolve is Kai Support's
  // hard-ticket mode now, started from the ticket. Kept as a stub for one
  // release (utils/removedTool.ts).
  server.registerTool(
    "start_kai_resolve",
    {
      title: "Escalate to Kai Support (removed)",
      description:
        "Removed: Kai Resolve is now Kai Support's hard-ticket mode, and this tool does nothing. A hard ticket starts from the ticket in Gleap (Work on it), or on its own when the project starts hard tickets automatically (AI agents › Kai Support › Hard tickets).",
      inputSchema: StartKaiResolveArgs.shape,
      annotations: REMOVED_TOOL_ANNOTATIONS,
    },
    async (): Promise<GleapApiResponse> =>
      removedToolResponse(
        "start_kai_resolve",
        "Kai Resolve is now Kai Support's hard-ticket mode. Ask a teammate to click Work on it on the ticket in Gleap (Kai Support then works on it in Kai Code Cloud or on a Bridge machine), or have the project start hard tickets automatically under AI agents › Kai Support › Hard tickets.",
      ),
  );

  server.registerTool(
    "save_help_center_article_draft",
    {
      title: "Save Help Center Article Draft",
      description:
        "Improve an existing help-center article without publishing: the changes are saved as the article's draft and the live article stays exactly as it is. Pass only what changes; per locale, the locales you leave out keep their text. When the article already has a draft (get_help_center_article_draft), your changes go into that draft and its other changes stay. Then publish_help_center_article_draft makes the draft live. Read the article and its draft first and keep what is still right.",
      inputSchema: SaveArticleDraftArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!args.title && !args.description && !args.content) return validationErrorResponse("Say what changes: title, description or content.");
      const base = `/helpcenter/collections/${args.helpcenterCollectionId}/articles/${args.helpcenterArticleId}`;
      const [article, draft] = await Promise.all([gleapGetData(base), gleapGetData(`${base}/draft`)]);
      const error = errorOf(article) ?? errorOf(draft);
      if (error) return error;
      const live: any = dataOf(article) ?? {};
      // No draft yet answers with an empty body: start from the live article then.
      const draftData: any = dataOf(draft);
      const staged: any = draftData && typeof draftData === "object" && Object.keys(draftData).length ? draftData : null;
      const from = staged ?? live;
      const body: Record<string, unknown> = {
        ...(args.title ? { title: localizedMerge(from.title, args.title) } : {}),
        ...(args.description ? { description: localizedMerge(from.description, args.description) } : {}),
        ...(args.content ? { content: localizedMerge(from.content, args.content) } : {}),
        ...(typeof staged?.draftVersion === "number" ? { expectedDraftVersion: staged.draftVersion } : {}),
      };
      const response = await gleapPut(`${base}/draft`, body);
      if (failed(response)) return response;
      const { projectId } = getCredsOrThrow();
      return wrapResponse({
        articleId: args.helpcenterArticleId,
        title: first(args.title) || first(from.title) || null,
        status: "draft saved",
        reviewUrl: `${GLEAP_DASHBOARD_BASE}/projects/${projectId}/helpcenter/collections/${args.helpcenterCollectionId}/articles/${args.helpcenterArticleId}`,
        message: "Saved as a draft; the live article has not changed. publish_help_center_article_draft makes it live.",
      });
    },
  );

  server.registerTool(
    "get_help_center_article_draft",
    {
      title: "Get Help Center Article Draft",
      description:
        "An article's saved draft (unpublished changes): its title, description and text per locale, or hasDraft false when there is none. The live article is get_help_center_article.",
      inputSchema: GetArticleDraftArgs.shape,
      annotations: READ,
    },
    async (args): Promise<GleapApiResponse> => {
      const base = `/helpcenter/collections/${args.helpcenterCollectionId}/articles/${args.helpcenterArticleId}`;
      const result = await gleapGetData(`${base}/draft`);
      const error = errorOf(result);
      if (error) return error;
      const draft: any = dataOf(result);
      if (!draft || typeof draft !== "object" || !Object.keys(draft).length) return wrapResponse({ articleId: args.helpcenterArticleId, hasDraft: false });
      return wrapResponse({
        articleId: args.helpcenterArticleId,
        hasDraft: true,
        title: draft.title ?? null,
        description: draft.description ?? null,
        content: draft.content ?? null,
        draftVersion: draft.draftVersion ?? null,
        updatedAt: draft.updatedAt ?? null,
      });
    },
  );

  server.registerTool(
    "publish_help_center_article_draft",
    {
      title: "Publish Help Center Article Draft",
      description: "Make an article's saved draft live (save_help_center_article_draft first). The help center and Kai answer from it right away.",
      inputSchema: PublishArticleDraftArgs.shape,
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (args): Promise<GleapApiResponse> => {
      const base = `/helpcenter/collections/${args.helpcenterCollectionId}/articles/${args.helpcenterArticleId}`;
      const response = await gleapPost(`${base}/draft/publish`, {});
      if (failed(response)) return response;
      const article: any = response.structuredContent ?? {};
      return wrapResponse({ articleId: args.helpcenterArticleId, title: first(article.title) || null, status: "published", message: "The draft is live." });
    },
  );

  server.registerTool(
    "get_snippets",
    {
      title: "Get Snippets",
      description:
        "The answers Kai uses (knowledge snippets: a question and its answer). With words, the snippets whose question contains them; without, every snippet, page by page (total says how many, nextSkip gives the next page). To change one, update_snippet with its id; for a new one, create_snippet.",
      inputSchema: GetSnippetsArgs.shape,
      annotations: READ,
    },
    async (args): Promise<GleapApiResponse> => {
      const limit = Math.min(args.limit ?? 20, 50);
      const skip = args.skip ?? 0;
      // The search endpoint answers an empty search with no snippets, so a full list reads the snippet list instead.
      const result = args.searchTerm
        ? await gleapGetData("/qaanswers/search", { params: { searchTerm: args.searchTerm, limit, skip } })
        : await gleapGetData("/qaanswers", { params: { type: "text", limit, skip } });
      const error = errorOf(result);
      if (error) return error;
      const page = dataOf(result)?.answers;
      const answers: any[] = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
      const total = typeof page?.count === "number" ? page.count : null;
      const rows = answers.slice(0, limit).map((answer) => ({
        id: answer?._id ?? answer?.id ?? null,
        question: clip(answer?.question, 300),
        answer: clip(answer?.answer, 600),
        internal: Array.isArray(answer?.tags) && answer.tags.includes("internal"),
      }));
      const more = total !== null ? skip + rows.length < total : rows.length === limit;
      return wrapResponse({ results: rows, count: rows.length, total, nextSkip: more ? skip + rows.length : null, type: "snippet_list" });
    },
  );

  server.registerTool(
    "create_snippet",
    {
      title: "Create Snippet",
      description:
        "Teach Kai an answer: a question as customers ask it and the answer. Kai uses it in its next answers (it is learned within seconds). Check get_snippets first so the same question is not taught twice.",
      inputSchema: CreateSnippetArgs.shape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args): Promise<GleapApiResponse> => {
      const response = await gleapPost("/qaanswers", {
        question: args.question.trim(),
        answer: args.answer.trim(),
        ...(args.internal ? { tags: ["internal"] } : {}),
      });
      if (failed(response)) return response;
      const saved: any = response.structuredContent ?? {};
      return wrapResponse({ id: saved._id ?? saved.id ?? null, question: saved.question ?? args.question, message: "Kai learns it within seconds." });
    },
  );

  server.registerTool(
    "update_snippet",
    {
      title: "Update Snippet",
      description: "Change an answer Kai uses (a snippet from get_snippets): its question, its answer or both.",
      inputSchema: UpdateSnippetArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!args.question && !args.answer) return validationErrorResponse("Say what changes: question or answer.");
      const response = await gleapPut(`/qaanswers/${args.snippetId}`, {
        ...(args.question ? { question: args.question.trim() } : {}),
        ...(args.answer ? { answer: args.answer.trim() } : {}),
      });
      if (failed(response)) return response;
      return wrapResponse({ id: args.snippetId, message: "Saved; Kai learns the change within seconds." });
    },
  );

  server.registerTool(
    "get_knowledge_gaps",
    {
      title: "Get Knowledge Gaps",
      description:
        "What customers asked that Kai could not answer (or answered wrong), found in closed conversations, the most asked first: each with the question, how often it came up, and a proposed answer or article change. Use it to decide which snippets and articles to write.",
      inputSchema: GetKnowledgeGapsArgs.shape,
      annotations: READ,
    },
    async (args): Promise<GleapApiResponse> => {
      const result = await gleapGetData("/contentsuggestions", { params: { status: "pending", limit: Math.min(args.limit ?? 20, 50), skip: 0 } });
      const error = errorOf(result);
      if (error) return error;
      const data: any = dataOf(result) ?? {};
      const suggestions: any[] = Array.isArray(data.suggestions) ? data.suggestions : [];
      const rows = suggestions.map((suggestion) => ({
        id: suggestion?._id ?? suggestion?.id ?? null,
        kind: suggestion?.kind ?? null,
        question: clip(suggestion?.proposedQuestion, 300),
        proposedAnswer: clip(suggestion?.proposedAnswer, 500),
        kaiOutcome: suggestion?.aiOutcome ?? null,
        askedTimes: Number(suggestion?.supportCount ?? 1),
        topic: suggestion?.topic ?? null,
        article: suggestion?.targetArticle ?? null,
        change: clip(suggestion?.changeSummary, 200) || null,
      }));
      return wrapResponse({ results: rows, count: rows.length, pending: data.pendingCount ?? rows.length, type: "knowledge_gap_list" });
    },
  );

  server.registerTool(
    "get_support_hours",
    {
      title: "Get Support Hours",
      description: "The project's office hours (per day, with the timezone), whether the team shows as always online, and the SLA (on or off, the reply deadline).",
      inputSchema: GetSupportHoursArgs.shape,
      annotations: READ,
    },
    async (): Promise<GleapApiResponse> => {
      const result = await gleapGetData("/projects/current");
      const error = errorOf(result);
      if (error) return error;
      const project: any = dataOf(result) ?? {};
      const flow = project.flowConfig ?? {};
      const sla = project.slaOptions ?? {};
      return wrapResponse({
        timezone: flow.timezone ?? null,
        alwaysOnline: flow.alwaysOnline === true,
        openingTimes: Array.isArray(flow.openingTimes)
          ? flow.openingTimes.map((row: any) => ({ day: row?.day ?? null, openingTime: row?.openingTime ?? null, closingTime: row?.closingTime ?? null }))
          : [],
        sla: { enabled: sla.enabled === true, minutes: typeof sla.defaultSla === "number" ? Math.round(sla.defaultSla / 60) : null },
      });
    },
  );

  server.registerTool(
    "update_office_hours",
    {
      title: "Update Office Hours",
      description:
        "Set the office hours: the whole week (each open day with its opening and closing time; days left out are closed), the timezone, or always online. Customers see when the team is back, and reply times follow the hours.",
      inputSchema: UpdateOfficeHoursArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!args.openingTimes && !args.timezone && args.alwaysOnline === undefined) {
        return validationErrorResponse("Say what changes: openingTimes, timezone or alwaysOnline.");
      }
      const bad = (args.openingTimes ?? []).filter((row) => row.closingTime <= row.openingTime);
      if (bad.length) return validationErrorResponse(`Closing time must be after opening time (${bad.map((row) => row.day).join(", ")}).`);
      const flowConfig: Record<string, unknown> = {
        ...(args.openingTimes ? { openingTimes: args.openingTimes } : {}),
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.alwaysOnline !== undefined ? { alwaysOnline: args.alwaysOnline } : {}),
      };
      // PUT /projects sets flowConfig one level deep: the fields above are replaced, the rest stays.
      const response = await gleapPut("/projects", { flowConfig });
      if (failed(response)) return response;
      return wrapResponse({ changed: Object.keys(flowConfig), message: "Office hours saved." });
    },
  );

  server.registerTool(
    "update_sla",
    {
      title: "Update SLA",
      description:
        "Switch the SLA on or off and set the reply deadline for new conversations, in minutes. Board-specific SLAs and the SLA webhook stay as they are. Needs the Pro plan to switch on or change.",
      inputSchema: UpdateSlaArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> => {
      if (args.enabled === undefined && args.minutes === undefined) return validationErrorResponse("Say what changes: enabled or minutes.");
      const current = await gleapGetData("/projects/current");
      const error = errorOf(current);
      if (error) return error;
      // slaOptions is stored as one object: send it whole, with only these two fields changed.
      const stored: Record<string, unknown> = { ...((dataOf(current) as any)?.slaOptions ?? {}) };
      const slaOptions = {
        ...stored,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : args.minutes !== undefined ? { enabled: true } : {}),
        ...(args.minutes !== undefined ? { defaultSla: args.minutes * 60 } : {}),
      };
      const response = await gleapPut("/projects", { slaOptions });
      if (failed(response)) return response;
      return wrapResponse({
        sla: { enabled: slaOptions.enabled === true, minutes: typeof slaOptions.defaultSla === "number" ? Math.round((slaOptions.defaultSla as number) / 60) : null },
        message: slaOptions.enabled === true ? "SLA saved." : "SLA off.",
      });
    },
  );
};
