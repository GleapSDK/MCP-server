import { z } from "zod";

export const SearchKnowledgebaseArgs = z.object({
  query: z
    .string()
    .describe(
      "A focused search query. Must be self-contained and specific. For multi-part questions, split into separate calls (max 2)."
    ),
  documentTypeFilter: z
    .string()
    .optional()
    .describe(
      "Filter results to a specific document type (e.g., 'helpcenter', 'custom', 'code')"
    ),
  internally: z
    .boolean()
    .optional()
    .describe("Include internal-only documents (default: false)"),
  lang: z
    .string()
    .optional()
    .describe("Language code for results (e.g., 'en', 'de')"),
  limit: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum results to return (default: 10, max: 20)"),
});

export const SearchSimilarTicketsArgs = z.object({
  query: z
    .string()
    .describe("Description of the issue to find similar resolved tickets for"),
  excludeTicketId: z
    .string()
    .optional()
    .describe(
      "Ticket ID to exclude from results (e.g., the current ticket being worked on)"
    ),
  limit: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum results to return (default: 10, max: 20)"),
});
