import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateFeatureRequestArgs,
  GetFeatureRequestArgs,
  SearchFeatureRequestsArgs,
  SubscribeToFeatureRequestArgs,
} from "../schemas/featurerequest.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapGet, gleapGetData, gleapPost } from "../utils/api.js";

/**
 * Feature-request tools — feature requests are `Bug` documents with
 * `type: 'FEATURE_REQUEST'`. These tools are thin wrappers around
 * dedicated Server endpoints so any agent with the Gleap MCP enabled
 * can dedupe, subscribe customers, or file new roadmap items.
 *
 *   - search_feature_requests:      GET  /tickets/search-feature-requests (hidden lanes included)
 *   - get_feature_request:          GET  /tickets/:ticketId/feature-request
 *   - subscribe_to_feature_request: POST /tickets/:ticketId/vote (action='subscribe')
 *   - create_feature_request:       POST /tickets/tracker-tickets (with customerEmail)
 *
 * search and the create-time duplicate guard share one retrieval on the
 * Server, so a request the guard would call a duplicate is one search shows.
 */

const text = (payload: unknown): string => JSON.stringify(payload);

const jsonResult = (payload: Record<string, unknown>, isError = false): GleapApiResponse => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: text(payload) }],
  structuredContent: payload,
});

const NOT_PUBLIC_HINT =
  "Not on the public roadmap yet: you may subscribe the customer, but share no link and state no roadmap status; say the request is tracked.";

/** A duplicate candidate as the agent sees it (no internal lane keys). */
const toCandidate = (candidate: any) => ({
  id: String(candidate?.id ?? ""),
  title: String(candidate?.title ?? ""),
  status: candidate?.status ?? candidate?.statusLabel ?? null,
  public: candidate?.public ?? !!(candidate?.status ?? candidate?.statusLabel ?? candidate?.shareUrl),
  score: typeof candidate?.score === "number" ? Math.round(candidate.score * 100) / 100 : null,
  ...(candidate?.matchedBy ? { matchedBy: candidate.matchedBy } : {}),
  ...(typeof candidate?.upvotesCount === "number" ? { upvotesCount: candidate.upvotesCount } : {}),
  shareUrl: candidate?.shareUrl ?? null,
  ...(candidate?.descriptionPreview ? { descriptionPreview: candidate.descriptionPreview } : {}),
});

export const registerFeatureRequestTools = (server: McpServer) => {
  server.registerTool(
    "search_feature_requests",
    {
      title: "Search Feature Requests",
      description:
        "Semantic dedupe search over the project's feature requests (OpenSearch fuzzy match + Voyage AI rerank): up to 5 matches, best first, each with its rerank `score`. Call this BEFORE create_feature_request. Matches with `public: false` are tracked but not on the public roadmap yet (e.g. just filed into the intake lane): subscribing the customer works, but they have no share link and no status to state. For public matches, `status` is the customer-facing roadmap label (when null, state no status) and `shareUrl` the public link: repeat it verbatim, never build roadmap URLs yourself. `ranked: false` means the reranker was unavailable and the matches are keyword hits: judge them by title and description. To read a feature request you already have an id for, use get_feature_request. If the response contains `searchUnavailable: true`, the dedupe index could not be queried — do NOT proceed to create_feature_request; retry the search later or escalate to the team.",
      inputSchema: SearchFeatureRequestsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit, minScore }): Promise<GleapApiResponse> => {
      const params = buildParams({ query, limit, minScore, includeHiddenLanes: true });
      return gleapGet("/tickets/search-feature-requests", { params });
    },
  );

  server.registerTool(
    "get_feature_request",
    {
      title: "Get Feature Request",
      description:
        "Read one feature request by id or ticket number (\"#1234\"): title, a description excerpt, roadmap status, upvote count and public share link. Use it when an investigation, a teammate or the thread cites a feature request, to confirm it is the customer's need before subscribe_to_feature_request (which takes the same id). Only feature requests of this project resolve. `public: false` means it is tracked but not on the public roadmap yet: no link and no status to share. Repeat `shareUrl` verbatim, never build roadmap URLs yourself.",
      inputSchema: GetFeatureRequestArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => {
      const result = await gleapGetData(
        `/tickets/${encodeURIComponent(ticketId.trim())}/feature-request`,
      );
      if ("error" in result) return result.error;
      const data: any = result.data;
      // Only a feature-request summary passes: anything else is refused
      // without its content (this tool runs in customer-scoped runs).
      if (!data || typeof data !== "object" || data.type !== "FEATURE_REQUEST" || !data.id) {
        return jsonResult(
          { error: `No feature request with id "${ticketId}" was found in this project.` },
          true,
        );
      }
      const isPublic = data.public === true;
      return jsonResult({
        id: String(data.id),
        ...(data.bugId != null ? { bugId: data.bugId } : {}),
        title: String(data.title ?? ""),
        descriptionExcerpt: data.descriptionExcerpt ?? null,
        status: isPublic ? (data.status ?? null) : null,
        public: isPublic,
        ...(data.archived === true ? { archived: true } : {}),
        upvotesCount: typeof data.upvotesCount === "number" ? data.upvotesCount : 0,
        dueDate: data.dueDate ?? null,
        shareUrl: isPublic ? (data.shareUrl ?? null) : null,
        ...(isPublic ? {} : { hint: NOT_PUBLIC_HINT }),
      });
    },
  );

  server.registerTool(
    "subscribe_to_feature_request",
    {
      title: "Subscribe to Feature Request",
      description:
        "Idempotently add a customer's email to a feature request's upvoter list, so they are notified when it ships. Safe to call repeatedly — no-ops when the customer is already subscribed. Takes the id from search_feature_requests, get_feature_request or a duplicate response (or the ticket number). The result carries the request's `status` and `shareUrl` (null when it is not public yet): tell the customer they are subscribed, state only that status, and repeat the link verbatim.",
      inputSchema: SubscribeToFeatureRequestArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticketId, customerEmail, customerName }): Promise<GleapApiResponse> => {
      const body = buildParams({
        email: customerEmail,
        name: customerName,
        action: "subscribe",
      });
      // Idempotent (action 'subscribe'): safe to retry on a gateway error.
      const result = await gleapPost(
        `/tickets/${encodeURIComponent(ticketId.trim())}/vote`,
        body,
        { idempotent: true },
      );
      if (result.isError) return result;
      const data: any = result.structuredContent ?? {};
      // Servers before the roadmap fields returned only the vote counts.
      const hasRoadmap = typeof data.public === "boolean";
      const isPublic = data.public === true;
      return jsonResult({
        subscribed: true,
        alreadySubscribed: data.alreadyUpvoted === true,
        id: String(data.id ?? ticketId),
        ...(data.title ? { title: data.title } : {}),
        ...(hasRoadmap
          ? {
              status: isPublic ? (data.status ?? null) : null,
              public: isPublic,
              shareUrl: isPublic ? (data.shareUrl ?? null) : null,
            }
          : {}),
        upvotesCount: typeof data.upvotesCount === "number" ? data.upvotesCount : null,
        ...(hasRoadmap && !isPublic ? { hint: NOT_PUBLIC_HINT } : {}),
      });
    },
  );

  server.registerTool(
    "create_feature_request",
    {
      title: "Create Feature Request",
      description:
      "File a new FEATURE_REQUEST ticket on the project's roadmap. The requesting customer becomes the request's creator (their session is attached) and first upvoter automatically. Use only after search_feature_requests returned no strong match. Pass the originating customer ticket id in `linkedTicketIds`. On success the response includes a `shareUrl`: reply with it verbatim, never construct roadmap URLs yourself. When existing requests match, NOTHING is created and the result is `{ok: false, duplicate: true, candidates, hint}`: subscribe the customer to the candidate that is their need (subscribe_to_feature_request with its id), or, when you compared the candidates and none is the same need (e.g. a different product surface), call create_feature_request again with their ids in `notDuplicateOf`.",
      inputSchema: CreateFeatureRequestArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      title,
      description,
      customerEmail,
      customerName,
      linkedTicketIds,
      notDuplicateOf,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        type: "FEATURE_REQUEST",
        title,
        description,
        customerEmail,
        customerName,
        linkedTicketIds,
        notDuplicateOf: notDuplicateOf?.length ? notDuplicateOf : undefined,
        // Provenance: the MCP server has no caller identity, so the honest
        // generic label. sourceTicketBugId is resolved server-side.
        createdByAgent: {
          agentName: "AI agent (Gleap MCP)",
          ...(linkedTicketIds?.[0] ? { sourceTicketId: linkedTicketIds[0] } : {}),
        },
      });
      // Retry-safe on a gateway error: the Server's duplicate guard answers a
      // re-create of a request that did land with a duplicate response.
      const result = await gleapPost("/tickets/tracker-tickets", body, { idempotent: true });

      const sc: any = result?.structuredContent;
      // Success: return a SLIM result instead of the raw ticket document.
      // The full doc carries near-identical ObjectIds (upvote subdoc ids are
      // generated right after the ticket id — `…544b` vs `…544c`) plus both
      // share tokens; a model composing its reply from that blob picked the
      // upvote id once and sent the customer a 404 portal link. The only id
      // and the only URL the model ever sees are now the correct ones, and
      // the secret token never enters model context.
      const createdId = sc?.id ?? sc?._id ?? sc?.result?.id;
      if (!result.isError && sc && sc.error !== true && createdId) {
        const slim = {
          id: String(createdId),
          title: sc.title ?? sc.result?.title ?? title,
          status: sc.status ?? sc.result?.status ?? null,
          shareUrl: sc.shareUrl ?? sc.result?.shareUrl ?? null,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Feature request created: "${slim.title}" (id ${slim.id}). The customer was added as the first upvoter.` +
                (slim.shareUrl
                  ? ` Public share link — repeat it to the customer VERBATIM, never modify or rebuild it: ${slim.shareUrl}`
                  : ""),
            },
          ],
          structuredContent: slim,
        };
      }

      // Server-side duplicate guard (409): a structured refusal the agent can
      // act on, and that reads as a failure to anything auditing the call —
      // the old prose read as a successful create.
      const data = sc?.data;
      if (sc?.error === true && sc?.status === 409 && data?.code === "DUPLICATE_FEATURE_REQUEST") {
        const candidates = (
          Array.isArray(data.candidates) && data.candidates.length > 0
            ? data.candidates
            : data.duplicate
              ? [data.duplicate]
              : []
        ).map(toCandidate);
        return jsonResult(
          {
            ok: false,
            duplicate: true,
            error: "Not created: matching feature requests already exist.",
            candidates,
            hint: "Call subscribe_to_feature_request with the id of the candidate that is the customer's need. If none is the same need (e.g. a different product surface), call create_feature_request again with notDuplicateOf: [their ids].",
          },
          true,
        );
      }
      return result;
    },
  );
};
