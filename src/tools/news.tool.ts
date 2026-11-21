import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateNewsArgs,
  DeleteNewsArgs,
  GetNewsArgs,
  GetNewsItemArgs,
  UpdateNewsArgs,
} from "../schemas/news.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  buildParams,
  gleapDelete,
  gleapGet,
  gleapPost,
  gleapPut,
  isNonEmptyObject,
  validationErrorResponse,
} from "../utils/api.js";
import { IMAGE_NODE_HELP, localizedImageNodeProblems, resolveImageUrl } from "../utils/images.js";
import { projectList, slimNews } from "../utils/projections.js";

const TIPTAP_DOCS = "https://tiptap.dev/docs/guides/output-json-html";

const newsRequiredFieldsHelp = (): string =>
  [
    "name must be a plain string (the internal label for the entry).",
    'subject must be a localized object: keys = locale codes, values = strings. Example: { "en": "What\'s New" }.',
    "message must be a localized TipTap document: keys = locale codes, each value = TipTap doc with type 'doc' and 'content' array.",
    `See TipTap JSON format: ${TIPTAP_DOCS}`,
    IMAGE_NODE_HELP,
  ].join(" ");

/** Image checks + cover import shared by create_news / update_news. */
const newsImageFields = async (
  message: unknown,
  coverImageUrl: string | null | undefined,
): Promise<{ fields: Record<string, unknown> } | { error: GleapApiResponse }> => {
  const problems = localizedImageNodeProblems(message, "message");
  if (problems.length > 0) {
    return { error: validationErrorResponse(`${problems.join("; ")}. ${IMAGE_NODE_HELP}`) };
  }
  if (coverImageUrl === undefined) return { fields: {} };
  if (coverImageUrl === null) return { fields: { coverImageUrl: null } };
  const cover = await resolveImageUrl(coverImageUrl);
  return "error" in cover ? { error: cover.error } : { fields: { coverImageUrl: cover.url } };
};

export const registerNewsTools = (server: McpServer) => {
  server.registerTool(
    "get_news",
    {
      title: "Get News",
      description:
        "Retrieve news and changelog items from Gleap with optional pagination. Use withoutChangelogs to filter to news-only items. Returns lightweight summaries (name, subject, type, status, timestamps); call `get_news_item` for the full localized message body.",
      inputSchema: GetNewsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ withoutChangelogs, skip, limit }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/engagement/news", {
        params: buildParams({ withoutChangelogs, skip, limit }),
        listType: "news_list",
      });
      return projectList(response, slimNews);
    },
  );

  server.registerTool(
    "get_news_item",
    {
      title: "Get News Item",
      description: "Retrieve a specific news or changelog item by ID.",
      inputSchema: GetNewsItemArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ newsId }): Promise<GleapApiResponse> => {
      return gleapGet(`/engagement/news/${newsId}`);
    },
  );

  server.registerTool(
    "create_news",
    {
      title: "Create News",
      description:
        'Create a new news or changelog entry. REQUIRED: name (string), subject (localized object, e.g. { "en": "What\'s New" }), and message (localized TipTap document). Do not call without all three required fields. Prefer create_news_draft for new content. Optional coverImageUrl sets the cover image.',
      inputSchema: CreateNewsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      name,
      subject,
      message,
      type,
      subType,
      sender,
      actionType,
      format,
      config,
      sound,
      trigger,
      pageFilterDelay,
      coverImageUrl,
    }): Promise<GleapApiResponse> => {
      const missing: string[] = [];
      if (name == null || String(name).trim() === "") missing.push("name");
      if (!isNonEmptyObject(subject)) missing.push("subject");
      if (!isNonEmptyObject(message)) missing.push("message");
      if (missing.length > 0) {
        return validationErrorResponse(
          `create_news requires: name, subject, and message. Missing or invalid: ${missing.join(
            ", ",
          )}. ${newsRequiredFieldsHelp()}`,
        );
      }
      const images = await newsImageFields(message, coverImageUrl);
      if ("error" in images) return images.error;
      const body = {
        ...images.fields,
        status: "draft",
        name,
        subject,
        message,
        type: type ?? "NEWS",
        subType: subType ?? "CHANGELOG",
        ...buildParams({
          sender,
          actionType,
          format,
          config,
          sound,
          trigger,
          pageFilterDelay,
        }),
      };
      return gleapPost("/engagement/news", body);
    },
  );

  server.registerTool(
    "update_news",
    {
      title: "Update News",
      description: "Update an existing news or changelog entry by ID.",
      inputSchema: UpdateNewsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({
      newsId,
      name,
      subject,
      message,
      type,
      subType,
      sender,
      actionType,
      format,
      config,
      sound,
      trigger,
      pageFilterDelay,
      coverImageUrl,
    }): Promise<GleapApiResponse> => {
      const images = await newsImageFields(message, coverImageUrl);
      if ("error" in images) return images.error;
      const body = buildParams({
        name,
        subject,
        message,
        type,
        subType,
        sender,
        actionType,
        format,
        config,
        sound,
        trigger,
        pageFilterDelay,
      });
      return gleapPut(`/engagement/news/${newsId}`, { ...body, ...images.fields });
    },
  );

  server.registerTool(
    "delete_news",
    {
      title: "Delete News",
      description:
        "Permanently delete a news or changelog item by ID. This action cannot be undone.",
      inputSchema: DeleteNewsArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ newsId }): Promise<GleapApiResponse> => {
      return gleapDelete(`/engagement/news/${newsId}`);
    },
  );
};
