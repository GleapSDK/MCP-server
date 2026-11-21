import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GleapApiResponse } from "../types/index.js";
import { gleapPost, validationErrorResponse, wrapResponse } from "../utils/api.js";
import { decodeBase64Image, importImageFromUrl, IMAGE_NODE_HELP, uploadImageBytes } from "../utils/images.js";

const UploadImageArgs = z.object({
  data: z.string().min(1).optional().describe(
    "Base64 of a PNG, JPEG, GIF or WebP (a data:image/...;base64, URI works too), at most 5 MB decoded. Only for small images you already hold as base64; for a file on disk use create_image_upload_link instead.",
  ),
  url: z.string().min(1).optional().describe(
    "Public http(s) URL of a PNG, JPEG, GIF or WebP. Gleap downloads it and stores a copy on its CDN.",
  ),
}).strict();

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });

export function registerImageTools(server: McpServer) {
  server.registerTool("upload_image", {
    title: "Upload Image",
    description: `Store an image in this Gleap project's CDN and return its permanent fileUrl, for news/changelog covers (coverImageUrl) and images inside TipTap content (news, newsletters, help center articles). Pass exactly one of data (base64) or url (public http(s) URL). PNG, JPEG, GIF and WebP only, judged by the bytes. For a file on disk (e.g. a generated cover), prefer create_image_upload_link — base64 in a tool call is slow and costly. ${IMAGE_NODE_HELP}`,
    inputSchema: UploadImageArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (input) => {
    const parsed = UploadImageArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { data, url } = parsed.data;
    if ((data == null) === (url == null)) return fail("Pass exactly one of data (base64) or url.");
    if (url != null) return importImageFromUrl(url);
    const decoded = decodeBase64Image(data!);
    if ("error" in decoded) return fail(decoded.error);
    return uploadImageBytes(decoded.bytes, decoded.contentType);
  });

  server.registerTool("create_image_upload_link", {
    title: "Create Image Upload Link",
    description: `Create a single-use link (valid 15 minutes) that uploads ONE image from disk into this Gleap project, for agents with a shell. The result holds the curl command that uploads a file to it; the upload's JSON response carries fileUrl. PNG, JPEG, GIF and WebP up to 20 MB. Use fileUrl as coverImageUrl on create_news_draft / update_news_draft or as an image src in TipTap content. ${IMAGE_NODE_HELP}`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async () => {
    const response = await gleapPost("/uploads/links", {});
    if (response.isError) return response;
    const link = response.structuredContent ?? {};
    if (typeof link.uploadUrl !== "string") return fail("The Gleap API returned no upload link.");
    return wrapResponse({
      ...link,
      curl: `curl -sS -F "file=@<path-to-image>" "${link.uploadUrl}"`,
      nextStep: "Run the curl command once with your image path. The response is { success, fileUrl }. The link works once; create a new one for each image.",
    });
  });
}
