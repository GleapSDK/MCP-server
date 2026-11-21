import { z } from "zod";

// API uses objects for title/description (localized) and content (localized TipTap per locale). plainContent is read-only (server-derived).
// Factories, not shared instances: a schema object used for two properties is
// emitted as a $ref on the second one, which has no "type" for MCP clients.
const localizedField = () => z
  .record(z.string(), z.unknown())
  .describe(
    'Required. Localized text: a single object whose keys are locale codes (e.g. en, de) and values are the string for that locale. Example: { "en": "Getting started", "de": "Erste Schritte" }. Do not use a nested \'localized\' key; the object itself is keyed by locale.',
  );
const localizedTiptapContentField = () => z
  .record(z.string(), z.unknown())
  .describe(
    'Required. Localized TipTap document: one object per locale. Keys = locale codes (e.g. en, de). Each value = one TipTap document (JSON object with type \'doc\' and \'content\' array of nodes). Example: { "en": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Hello world" }] }] } }. See TipTap JSON format: https://tiptap.dev/docs/guides/output-json-html',
  );

// Help center sites (several per project; older servers have only the default).
const siteIdField = z
  .string()
  .trim()
  .min(1)
  .max(64);

// --- Read ---
export const GetHelpCenterSitesArgs = z.object({});

export const GetHelpCenterCollectionsTreeArgs = z.object({});

export const GetHelpCenterCollectionsArgs = z.object({
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of collections to skip for pagination"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of collections to return"),
  site: siteIdField
    .optional()
    .describe(
      "Help center site to list: 'default' (the project's main help center) or a site id from get_help_center_sites. Omit to list collections of every site.",
    ),
});

export const GetHelpCenterArticlesArgs = z.object({
  helpcenterCollectionId: z
    .string()
    .describe("The ID of the help center collection"),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of articles to skip for pagination"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of articles to return"),
});

export const GetHelpCenterArticleArgs = z.object({
  helpcenterCollectionId: z
    .string()
    .describe("The ID of the help center collection"),
  helpcenterArticleId: z.string().describe("The ID of the article to retrieve"),
});

// --- Create/update collection ---

export const CreateHelpCenterCollectionArgs = z.object({
  title: localizedField().describe(
    'REQUIRED. Title of the collection. Localized object, e.g. { "en": "Name", "de": "Name" }. Do not omit.',
  ),
  description: localizedField()
    .optional()
    .describe("Description of the collection (localized object)"),
  iconUrl: z.string().optional().describe("URL of the collection icon"),
  parent: z
    .string()
    .optional()
    .describe("Parent collection ID for nested collections"),
  lexorank: z.string().optional().describe("Lexorank for ordering"),
  docId: z.number().optional().describe("Document ID"),
  externalId: z.string().optional().describe("External identifier"),
  targetAudience: z
    .string()
    .optional()
    .default("all")
    .describe(
      "Who can see this content. 'all' (default) = everyone, 'users' = logged-in end-users only, 'guests' = anonymous visitors only.",
    ),
  site: siteIdField
    .optional()
    .describe(
      "Help center site for a top-level collection: 'default' (the project's main help center) or a site id from get_help_center_sites. Omit for the default site. Not allowed with parent: a sub-collection is always on its parent's site.",
    ),
});

export const MoveHelpCenterCollectionsToSiteArgs = z.object({
  siteId: siteIdField.describe(
    "Target help center site: 'default' (the project's main help center) or a site id from get_help_center_sites.",
  ),
  collectionIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(200)
    .describe(
      "IDs of the TOP-LEVEL collections to move (1-200). Their sub-collections and articles move with them. Sub-collection ids are rejected.",
    ),
});

export const UpdateHelpCenterCollectionArgs = z.object({
  helpcenterCollectionId: z
    .string()
    .describe("The ID of the collection to update"),
  title: localizedField()
    .optional()
    .describe("Title of the collection (localized object)"),
  description: localizedField()
    .optional()
    .describe("Description of the collection (localized object)"),
  iconUrl: z.string().optional().describe("URL of the collection icon"),
  parent: z
    .string()
    .optional()
    .describe("Parent collection ID for nested collections"),
  lexorank: z.string().optional().describe("Lexorank for ordering"),
  docId: z.number().optional().describe("Document ID"),
  externalId: z.string().optional().describe("External identifier"),
  targetAudience: z
    .string()
    .optional()
    .describe(
      "Who can see this content. 'all' = everyone, 'users' = logged-in end-users only, 'guests' = anonymous visitors only. Omit to leave unchanged on update.",
    ),
});

// --- Create/update article ---

export const CreateHelpCenterArticleArgs = z.object({
  helpcenterCollectionId: z
    .string()
    .describe("The ID of the collection to add the article to"),
  title: localizedField().describe(
    'REQUIRED. Title (localized object, e.g. { "en": "Title" }). Do not omit.',
  ),
  description: localizedField().describe(
    "REQUIRED. Short description (localized object). Do not omit.",
  ),
  content: localizedTiptapContentField().describe(
    "REQUIRED. Article body: one TipTap document per locale. Do not omit.",
  ),
  isDraft: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether the article is a draft (default: true)"),
  targetAudience: z
    .string()
    .optional()
    .default("all")
    .describe(
      "Who can see this content. 'all' (default) = everyone, 'users' = logged-in end-users only, 'guests' = anonymous visitors only.",
    ),
  tags: z.array(z.string()).optional().describe("Tags for the article"),
  externalId: z.string().optional().describe("External identifier"),
});

export const UpdateHelpCenterArticleArgs = z.object({
  helpcenterCollectionId: z
    .string()
    .describe("The ID of the help center collection"),
  helpcenterArticleId: z.string().describe("The ID of the article to update"),
  title: localizedField()
    .optional()
    .describe(
      'Title (localized object, e.g. { "de": "Titel" }). Only the locales you include are changed; every other stored locale keeps its current value. Omit to leave the title unchanged.',
    ),
  description: localizedField()
    .optional()
    .describe(
      "Short description (localized object). Only the locales you include are changed; other locales are preserved. Omit to leave unchanged.",
    ),
  content: localizedTiptapContentField()
    .optional()
    .describe(
      "Article body: one TipTap document per locale. Only the locales you include are changed; other locales are preserved. For large articles send ONE locale per call (e.g. content: { \"de\": <doc> }) so each request stays small. Omit to leave unchanged.",
    ),
  replaceLocales: z
    .boolean()
    .optional()
    .describe(
      "Default false: provided title/description/content are merged per locale into the stored article. Set true to replace the stored localized objects entirely (removes locales you do not include).",
    ),
  isDraft: z.boolean().optional().describe("Whether the article is a draft"),
  targetAudience: z
    .string()
    .optional()
    .describe(
      "Who can see this content. 'all' = everyone, 'users' = logged-in end-users only, 'guests' = anonymous visitors only. Omit to leave unchanged on update.",
    ),
  tags: z.array(z.string()).optional().describe("Tags for the article"),
  externalId: z.string().optional().describe("External identifier"),
});
