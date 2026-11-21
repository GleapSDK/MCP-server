import { z } from "zod";

export const SearchFeatureRequestsArgs = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Free-form feature description to dedupe against. Use the underlying customer need, not their literal wording. Backed by OpenSearch fuzzy match + Voyage AI rerank against the project's FEATURE_REQUEST tickets.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Size of the candidate pool that is reranked. Default 10. At most 5 matches come back, only those above the relevance threshold; fewer is normal when nothing semantically close exists.",
    ),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Relevance threshold from the Voyage AI reranker (0–1). Default 0.35. Lower it to surface weaker matches, raise it to only keep strong duplicates.",
    ),
});

export const GetFeatureRequestArgs = z.object({
  ticketId: z
    .string()
    .min(1)
    .describe(
      "The feature request's id (as returned by search_feature_requests or cited by an investigation) or its ticket number, e.g. \"#1234\".",
    ),
});

export const SubscribeToFeatureRequestArgs = z.object({
  ticketId: z
    .string()
    .describe(
      "The id of the FEATURE_REQUEST ticket to subscribe the customer to (from search_feature_requests, get_feature_request or a duplicate response), or its ticket number.",
    ),
  customerEmail: z
    .string()
    .describe(
      "The customer's email address. Used as the upvote key — repeated subscribes are idempotent.",
    ),
  customerName: z
    .string()
    .optional()
    .describe(
      "Optional. The customer's name when known, stored with their upvote so the team sees who asked for it. Never shown on the public roadmap.",
    ),
});

export const CreateFeatureRequestArgs = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "Short, specific feature title (3–10 words). Treat as a roadmap card heading.",
    ),
  description: z
    .string()
    .min(1)
    .describe(
      "Plain markdown description of the feature, including the underlying customer need.",
    ),
  customerEmail: z
    .string()
    .describe(
      "Email of the customer who first requested this feature. They are automatically added as the first upvoter (`upvotesCount: 1`).",
    ),
  customerName: z
    .string()
    .optional()
    .describe(
      "Display name of the requesting customer when known.",
    ),
  linkedTicketIds: z
    .array(z.string())
    .optional()
    .describe(
      "IDs of customer tickets that should be linked to this feature request (visible in the ticket sidebar's 'Linked tickets' section). Pass the originating ticket here.",
    ),
  notDuplicateOf: z
    .array(z.string())
    .optional()
    .describe(
      "Ids of candidates from a previous duplicate response that are NOT the same need as this request (e.g. the same feature on a different product surface). The duplicate check skips them. Only list candidates you compared and ruled out.",
    ),
});
