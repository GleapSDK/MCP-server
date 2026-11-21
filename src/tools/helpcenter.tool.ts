import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateHelpCenterArticleArgs,
  CreateHelpCenterCollectionArgs,
  GetHelpCenterArticleArgs,
  GetHelpCenterArticlesArgs,
  GetHelpCenterCollectionsArgs,
  GetHelpCenterCollectionsTreeArgs,
  GetHelpCenterSitesArgs,
  MoveHelpCenterCollectionsToSiteArgs,
  UpdateHelpCenterArticleArgs,
  UpdateHelpCenterCollectionArgs,
} from "../schemas/helpcenter.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  buildParams,
  gleapGet,
  gleapGetData,
  gleapPost,
  gleapPut,
  isNonEmptyObject,
  validationErrorResponse,
  wrapResponse,
} from "../utils/api.js";
import { IMAGE_NODE_HELP, localizedImageNodeProblems } from "../utils/images.js";
import { projectList, slimArticle } from "../utils/projections.js";

const TIPTAP_DOCS = "https://tiptap.dev/docs/guides/output-json-html";

const articleRequiredFieldsHelp = (): string =>
  [
    'Title and description must be localized objects: keys = locale codes (e.g. en, de), values = string. Example: { "en": "Getting started", "de": "Erste Schritte" }.',
    'Content must be a localized TipTap document: keys = locale codes, each value = TipTap doc with type \'doc\' and \'content\' array. Example: { "en": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Hello" }] }] } }.',
    `See TipTap JSON format: ${TIPTAP_DOCS}`,
    IMAGE_NODE_HELP,
  ].join(" ");

type Localized = Record<string, unknown>;

/**
 * Per-locale merge for article updates. The backend `$set`s the whole
 * localized object, so a request carrying only `{ de: ... }` used to wipe every
 * other locale. LLM agents hit their output limit on large multi-locale
 * articles (#146355: ~227 KB for de/en/it/fr), so the only safe contract is
 * "locales you send are updated, locales you omit are preserved".
 */
const mergeLocalized = (
  current: unknown,
  incoming: Localized,
  replace: boolean,
): Localized =>
  replace || !isNonEmptyObject(current) ? incoming : { ...current, ...incoming };

const isTiptapDoc = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { type?: unknown }).type === "doc" &&
  Array.isArray((value as { content?: unknown }).content);

/**
 * Returns the locale keys whose value has the wrong shape. A truncated or
 * "repaired" tool call typically yields a string, `null`, or a doc without a
 * `content` array for the locales that got cut off — those must be rejected
 * before they overwrite real content.
 */
const invalidLocales = (
  field: Localized,
  isValid: (value: unknown) => boolean,
): string[] =>
  Object.entries(field)
    .filter(([, value]) => !isValid(value))
    .map(([locale]) => locale);

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

const statusOf = (response: GleapApiResponse): unknown =>
  (response.structuredContent as Record<string, unknown> | undefined)?.status;

const NO_SITES_MESSAGE =
  "This Gleap server has no help center sites yet: the project has one help center (the default site). Leave `site` out of the help center tools.";

/**
 * A help center site as agents need it: which ids exist and what each one is.
 * Drops the stored config, hosts, password state and audience filter.
 */
const slimSite = (site: any): Record<string, unknown> => ({
  id: site?.id ?? null,
  name: site?.name ?? "",
  isDefault: site?.isDefault === true,
  url: site?.url ?? null,
  accessMode: site?.access?.mode ?? "public",
  layout: site?.layout ?? null,
  collectionCount: site?.collectionCount ?? 0,
  articleCount: site?.articleCount ?? 0,
  isMessengerSite: site?.isMessengerSite === true,
});

export const registerHelpCenterTools = (server: McpServer) => {
  server.registerTool(
    "get_help_center_sites",
    {
      title: "Get Help Center Sites",
      description:
        "List the project's help center sites (a project can run several help centers, e.g. a public one and a team-only one). Returns per site: id ('default' for the main help center, otherwise a site id), name, url, accessMode (public, password, signedin, segment or team), layout, collectionCount, articleCount, and whether the Messenger shows it. Use the ids as `site` on get_help_center_collections and create_help_center_collection, and as siteId on move_help_center_collections_to_site. `limit` is how many sites the plan allows (null = unlimited).",
      inputSchema: GetHelpCenterSitesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      const result = await gleapGetData("/helpcenter/sites");
      if ("error" in result) {
        // Servers from before help center sites have no such route.
        if (statusOf(result.error) === 404) {
          return wrapResponse({
            sites: [{ id: "default", name: "", isDefault: true }],
            count: 1,
            sitesSupported: false,
            message: NO_SITES_MESSAGE,
          });
        }
        return result.error;
      }
      const data = (result.data ?? {}) as Record<string, unknown>;
      const sites = Array.isArray(data.sites) ? data.sites.map(slimSite) : [];
      return wrapResponse({
        sites,
        count: sites.length,
        limit: data.limit ?? null,
        sitesSupported: true,
      });
    },
  );

  server.registerTool(
    "get_help_center_collections",
    {
      title: "Get Help Center Collections",
      description:
        "Retrieve help center collections from Gleap with optional pagination. Optional: site ('default' or a site id from get_help_center_sites) to list one help center site's collections.",
      inputSchema: GetHelpCenterCollectionsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ skip, limit, site }): Promise<GleapApiResponse> => {
      return gleapGet("/helpcenter/collections", {
        params: buildParams({ skip, limit, site }),
        listType: "helpcenter_list",
      });
    },
  );

  server.registerTool(
    "get_help_center_collections_tree",
    {
      title: "Get Help Center Collections Tree",
      description:
        "Retrieve all help center collections including subcollections in tree structure, across every help center site. Each collection carries `site` (a site id; absent = the default site); use get_help_center_collections with `site` to list one site's top-level collections.",
      inputSchema: GetHelpCenterCollectionsTreeArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      return gleapGet("/helpcenter/collections/all", {
        listType: "helpcenter_list",
      });
    },
  );

  server.registerTool(
    "get_help_center_articles",
    {
      title: "Get Help Center Articles",
      description:
        "Retrieve articles in a help center collection with optional pagination. Returns lightweight summaries (title, description, slug, tags, draft state, timestamps); call `get_help_center_article` for the full localized article content.",
      inputSchema: GetHelpCenterArticlesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      helpcenterCollectionId,
      skip,
      limit,
    }): Promise<GleapApiResponse> => {
      const response = await gleapGet(
        `/helpcenter/collections/${helpcenterCollectionId}/articles`,
        {
          params: buildParams({ skip, limit }),
          listType: "helpcenter_list",
        },
      );
      return projectList(response, slimArticle);
    },
  );

  server.registerTool(
    "get_help_center_article",
    {
      title: "Get Help Center Article",
      description: "Retrieve a specific help center article by ID.",
      inputSchema: GetHelpCenterArticleArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      helpcenterCollectionId,
      helpcenterArticleId,
    }): Promise<GleapApiResponse> => {
      return gleapGet(
        `/helpcenter/collections/${helpcenterCollectionId}/articles/${helpcenterArticleId}`,
      );
    },
  );

  server.registerTool(
    "create_help_center_collection",
    {
      title: "Create Help Center Collection",
      description:
        'Create a new help center collection. REQUIRED: title (localized object, e.g. { "en": "Name" }). Optional: description, iconUrl, parent, externalId, targetAudience, site (\'default\' or a site id from get_help_center_sites; top-level collections only, a sub-collection is on its parent\'s site). Do not call without title.',
      inputSchema: CreateHelpCenterCollectionArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      title,
      description,
      iconUrl,
      parent,
      lexorank,
      docId,
      externalId,
      targetAudience,
      site,
    }): Promise<GleapApiResponse> => {
      if (!isNonEmptyObject(title)) {
        return validationErrorResponse(
          'create_help_center_collection requires the field: title. You must provide title (a localized object, e.g. { "en": "My Collection", "de": "Meine Sammlung" }). Optional fields only: description, iconUrl, parent, lexorank, docId, externalId, targetAudience, site. Do not call this tool without title.',
        );
      }
      if (site && parent) {
        return validationErrorResponse(
          "create_help_center_collection rejected the request; nothing was created. Pass either parent or site, not both: a sub-collection is always on its parent's site. To put a collection tree on another site, create the top-level collection with site, or move it with move_help_center_collections_to_site.",
        );
      }
      const body = {
        title,
        targetAudience: targetAudience ?? "all",
        ...buildParams({
          description,
          iconUrl,
          parent,
          lexorank,
          docId,
          externalId,
          site,
        }),
      };
      return gleapPost("/helpcenter/collections", body);
    },
  );

  server.registerTool(
    "move_help_center_collections_to_site",
    {
      title: "Move Help Center Collections to Site",
      description:
        "Move top-level help center collections, with their sub-collections and articles, to another help center site. REQUIRED: siteId ('default' or a site id from get_help_center_sites) and collectionIds (1-200 top-level collection ids; sub-collections move with their parent and are rejected on their own). This changes the collections' URLs and who can read them: they follow the target site's access mode (e.g. team or password), and links on the old site redirect. Only when your operator asked for the move. Returns how many collections and articles moved.",
      inputSchema: MoveHelpCenterCollectionsToSiteArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ siteId, collectionIds }): Promise<GleapApiResponse> => {
      const response = await gleapPut(
        `/helpcenter/sites/${encodeURIComponent(siteId)}/collections`,
        { collectionIds },
      );
      if (statusOf(response) === 404) {
        const message = `No help center site "${siteId}" in this project, or this Gleap server has no help center sites yet. Nothing was moved. Run get_help_center_sites for the site ids.`;
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { error: true, status: 404, message },
        };
      }
      return response;
    },
  );

  server.registerTool(
    "update_help_center_collection",
    {
      title: "Update Help Center Collection",
      description: "Update an existing help center collection in Gleap.",
      inputSchema: UpdateHelpCenterCollectionArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      helpcenterCollectionId,
      title,
      description,
      iconUrl,
      parent,
      lexorank,
      docId,
      externalId,
      targetAudience,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        title,
        description,
        iconUrl,
        parent,
        lexorank,
        docId,
        externalId,
        targetAudience,
      });
      return gleapPut(
        `/helpcenter/collections/${helpcenterCollectionId}`,
        body,
      );
    },
  );

  server.registerTool(
    "create_help_center_article",
    {
      title: "Create Help Center Article",
      description:
        "Create a new help center article. REQUIRED: title, description, and content (all localized objects; content = TipTap doc per locale). Optional: isDraft, targetAudience, tags, externalId. Do not call without title, description, and content. Articles have no cover image; add images inline as imageBlock nodes (see upload_image).",
      inputSchema: CreateHelpCenterArticleArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      helpcenterCollectionId,
      title,
      description,
      content,
      isDraft,
      targetAudience,
      tags,
      externalId,
    }): Promise<GleapApiResponse> => {
      const missing: string[] = [];
      if (!isNonEmptyObject(title)) missing.push("title");
      if (!isNonEmptyObject(description)) missing.push("description");
      if (!isNonEmptyObject(content)) missing.push("content");
      if (missing.length > 0) {
        return validationErrorResponse(
          `create_help_center_article requires: title, description, and content. Missing or invalid: ${missing.join(
            ", ",
          )}. Optional only: isDraft, targetAudience, tags, externalId. Do not call this tool without all three required fields. ${articleRequiredFieldsHelp()}`,
        );
      }
      const imageProblems = localizedImageNodeProblems(content, "content");
      if (imageProblems.length > 0) {
        return validationErrorResponse(
          `create_help_center_article rejected the request; nothing was created. ${imageProblems.join("; ")}. ${IMAGE_NODE_HELP}`,
        );
      }
      const body = {
        title,
        description,
        content,
        isDraft: isDraft ?? true,
        targetAudience: targetAudience ?? "all",
        helpcenterCollection: helpcenterCollectionId,
        ...buildParams({ tags, externalId }),
      };
      return gleapPost(
        `/helpcenter/collections/${helpcenterCollectionId}/articles`,
        body,
      );
    },
  );

  server.registerTool(
    "update_help_center_article",
    {
      title: "Update Help Center Article",
      description:
        "Update an existing help center article. All fields are optional; pass only what changes. title/description/content are localized objects and are merged PER LOCALE: locales you include are updated, locales you omit keep their current value (set replaceLocales: true to replace them entirely). For large or multi-language articles, update ONE locale per call (e.g. content: { \"de\": <TipTap doc> }) to keep each request small. Each content value must be a complete TipTap doc ({ type: 'doc', content: [...] }); partial or truncated docs are rejected without writing.",
      inputSchema: UpdateHelpCenterArticleArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      helpcenterCollectionId,
      helpcenterArticleId,
      title,
      description,
      content,
      replaceLocales,
      isDraft,
      targetAudience,
      tags,
      externalId,
    }): Promise<GleapApiResponse> => {
      const hasTitle = isNonEmptyObject(title);
      const hasDescription = isNonEmptyObject(description);
      const hasContent = isNonEmptyObject(content);
      const otherChanges = buildParams({
        isDraft,
        targetAudience,
        tags,
        externalId,
      });

      if (
        !hasTitle &&
        !hasDescription &&
        !hasContent &&
        Object.keys(otherChanges).length === 0
      ) {
        return validationErrorResponse(
          `update_help_center_article received nothing to update. Provide at least one of: title, description, content (localized objects — only the locales you include are changed), isDraft, targetAudience, tags, externalId. ${articleRequiredFieldsHelp()}`,
        );
      }

      // Reject malformed per-locale values before touching the article. A
      // truncated tool call must fail loudly here, not silently blank a locale.
      const problems: string[] = [];
      if (hasTitle) {
        const bad = invalidLocales(title, isNonEmptyString);
        if (bad.length) problems.push(`title[${bad.join(", ")}] must be a non-empty string`);
      }
      if (hasDescription) {
        const bad = invalidLocales(description, isNonEmptyString);
        if (bad.length) problems.push(`description[${bad.join(", ")}] must be a non-empty string`);
      }
      if (hasContent) {
        const bad = invalidLocales(content, isTiptapDoc);
        if (bad.length)
          problems.push(
            `content[${bad.join(", ")}] must be a complete TipTap document ({ type: 'doc', content: [...] }) — the value looks truncated or malformed`,
          );
        problems.push(...localizedImageNodeProblems(content, "content"));
      }
      if (problems.length > 0) {
        return validationErrorResponse(
          `update_help_center_article rejected the request; nothing was changed. ${problems.join(
            "; ",
          )}. If the article is large, send one locale per call. ${articleRequiredFieldsHelp()}`,
        );
      }

      // Read-merge-write: the backend replaces localized objects wholesale.
      const currentResponse = await gleapGet(
        `/helpcenter/collections/${helpcenterCollectionId}/articles/${helpcenterArticleId}`,
      );
      const current = currentResponse.structuredContent as
        | Record<string, unknown>
        | undefined;
      if (!current || current.error) {
        return currentResponse;
      }

      const replace = replaceLocales === true;
      const body: Record<string, unknown> = { ...otherChanges };
      if (hasTitle) body.title = mergeLocalized(current.title, title, replace);
      if (hasDescription)
        body.description = mergeLocalized(
          current.description,
          description,
          replace,
        );
      if (hasContent)
        body.content = mergeLocalized(current.content, content, replace);
      // Optimistic concurrency: if someone edits the article between our read
      // and write, the backend answers 409 instead of clobbering their change.
      if (typeof current.version === "number") {
        body.expectedVersion = current.version;
      }

      return gleapPut(
        `/helpcenter/collections/${helpcenterCollectionId}/articles/${helpcenterArticleId}`,
        body,
      );
    },
  );
};
