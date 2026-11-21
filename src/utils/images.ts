import axios, { AxiosResponse } from "axios";
import { GLEAP_API_BASE } from "../config/index.js";
import { GleapApiResponse } from "../types/index.js";
import { defaultHeaders, gleapPost, validationErrorResponse, withRetry, wrapResponse } from "./api.js";
import { getCredsOrThrow } from "./credentials.js";

/**
 * Images for agent-written content (news covers, inline article images).
 * Every byte goes through the Gleap API's own upload routes with the caller's
 * credentials, so storage stays scoped to the caller's project: the MCP server
 * never writes to storage itself and never fetches caller-supplied URLs (the
 * API does that behind its SSRF guard).
 */

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Decoded size cap for inline base64 (the MCP JSON body limit is 10 MB). */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** The API's `coverImageUrl` limit. */
export const MAX_IMAGE_URL_LENGTH = 255;

/** PNG, JPEG, GIF or WebP by magic bytes; null for anything else (SVG, BMP, HTML, …). */
export const sniffImageType = (bytes: Uint8Array): string | null => {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
};

/** Base64 (optionally a `data:image/...;base64,` URI) -> bytes, or an error message. */
export const decodeBase64Image = (input: string): { bytes: Buffer; contentType: string } | { error: string } => {
  const payload = input.trim().replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    return { error: "data must be base64 (or a data:image/...;base64, URI)." };
  }
  if (Math.floor((payload.length * 3) / 4) > MAX_INLINE_IMAGE_BYTES + 3) {
    return { error: `Inline images are limited to ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MB. For larger files use create_image_upload_link.` };
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    return { error: `Inline images are limited to ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MB. For larger files use create_image_upload_link.` };
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) return { error: "Only PNG, JPEG, GIF and WebP images are accepted (checked by the file's bytes)." };
  return { bytes, contentType };
};

/** An absolute http(s) URL, or null. */
export const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

/** Already on Gleap's own file hosts (staticfiles/files, EU or US) — no import needed. */
export const isGleapHostedUrl = (value: string): boolean => {
  const url = parseHttpUrl(value);
  return !!url && url.protocol === "https:" && /(^|\.)gleap\.(io|ai)$/i.test(url.hostname);
};

const hasImageExtension = (fileUrl: string): boolean => {
  const ext = /\.([a-z0-9]+)$/i.exec(parseHttpUrl(fileUrl)?.pathname ?? "")?.[1]?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
};

const fileUrlOf = (response: GleapApiResponse): string | null => {
  const fileUrl = response.structuredContent?.fileUrl;
  return typeof fileUrl === "string" && fileUrl.length > 0 ? fileUrl : null;
};

const imageResult = (fileUrl: string, extra: Record<string, unknown> = {}): GleapApiResponse =>
  wrapResponse({
    fileUrl,
    ...extra,
    usage: "Use fileUrl as coverImageUrl on create_news_draft / update_news_draft, or embed it in TipTap content as a top-level node.",
    imageNode: { type: "imageBlock", attrs: { src: fileUrl, width: "100%", align: "center" } },
  });

/** Upload decoded bytes through `POST /uploads` (multipart). Not retried unless it never reached the API. */
export const uploadImageBytes = async (bytes: Buffer, contentType: string): Promise<GleapApiResponse> => {
  const { apiKey, projectId } = getCredsOrThrow();
  try {
    const resp: AxiosResponse = await withRetry("write", (timeout) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType }), `image.${IMAGE_TYPES[contentType]}`);
      return axios.post(`${GLEAP_API_BASE}/uploads`, form, {
        headers: defaultHeaders(apiKey, projectId),
        timeout,
        maxBodyLength: Infinity,
      });
    });
    const fileUrl = typeof resp.data?.fileUrl === "string" ? resp.data.fileUrl : null;
    if (!fileUrl) return validationErrorResponse("The Gleap API accepted the upload but returned no fileUrl.");
    return imageResult(fileUrl, { contentType, bytes: bytes.length });
  } catch (err) {
    return apiError(err);
  }
};

const apiError = (err: any): GleapApiResponse => {
  const status = err?.response?.status ?? 500;
  const data = err?.response?.data;
  const message = [data?.message, data?.error?.message, data?.errors?.detail, err?.message]
    .find((m) => typeof m === "string" && m.trim().length > 0) ?? "Upload failed";
  return {
    isError: true,
    content: [{ type: "text", text: `Gleap API error (${status}): ${message}` }],
    structuredContent: { error: true, status, message },
  };
};

/**
 * Copy a public image URL onto the project's Gleap CDN via `POST /uploads/from-url`
 * (the API downloads it behind its SSRF guard and checks the bytes are an image).
 */
export const importImageFromUrl = async (url: string): Promise<GleapApiResponse> => {
  if (!parseHttpUrl(url)) return validationErrorResponse("url must be an absolute http(s) URL.");
  const response = await gleapPost("/uploads/from-url", { url });
  if (response.isError) return response;
  const fileUrl = fileUrlOf(response);
  if (!fileUrl) return validationErrorResponse("The Gleap API accepted the import but returned no fileUrl.");
  if (!hasImageExtension(fileUrl)) {
    return validationErrorResponse(
      `Only PNG, JPEG, GIF and WebP images are accepted; ${url} is another image format (e.g. SVG or BMP). Convert it and upload again.`,
    );
  }
  return imageResult(fileUrl, { sourceUrl: url });
};

/**
 * A cover/inline image reference ready to store: Gleap-hosted URLs pass as-is,
 * any other public URL is imported first so published content never hotlinks
 * a third-party host.
 */
export const resolveImageUrl = async (value: string): Promise<{ url: string } | { error: GleapApiResponse }> => {
  if (!parseHttpUrl(value)) return { error: validationErrorResponse("Image URLs must be absolute http(s) URLs.") };
  if (isGleapHostedUrl(value)) {
    if (value.length > MAX_IMAGE_URL_LENGTH) {
      return { error: validationErrorResponse(`Image URLs are limited to ${MAX_IMAGE_URL_LENGTH} characters.`) };
    }
    return { url: value };
  }
  const imported = await importImageFromUrl(value);
  const fileUrl = imported.isError ? null : fileUrlOf(imported);
  return fileUrl ? { url: fileUrl } : { error: { ...imported, isError: true } };
};

// -------- TipTap image nodes --------

const IMAGE_NODE_TYPES = new Set(["imageBlock", "image"]);
// Editor-only placeholders; storing one leaves an endless skeleton.
const TRANSIENT_IMAGE_NODES = new Set(["imageUpload", "imageSkeleton", "imageUploadPlaceholder"]);
// Text blocks an image may not sit inside (images are block nodes).
const TEXT_BLOCKS = new Set(["paragraph", "heading"]);
/**
 * imageBlock width: a percentage, or a pixel width older editor content
 * stores (e.g. "540px"), so an edit can pass existing content back unchanged.
 */
const IMAGE_WIDTH = /^(\d{1,3}(\.\d+)?%|\d{1,4}px)$/;

/**
 * Image nodes in agent-written TipTap content, as the dashboard editors store
 * them and the widget / help center render them: a block node
 * `{ type: "imageBlock", attrs: { src, width?: "100%" | "540px", align?: "center", alt?, link?, target? } }`
 * at the top level of `doc.content` (or inside a column). The legacy
 * `{ type: "image", attrs: { src, alt?, title? } }` still renders. Returns one
 * problem per bad node so the write is refused before broken or bloated
 * content is stored.
 */
export const imageNodeProblems = (doc: unknown, where: string): string[] => {
  const problems: string[] = [];
  const visit = (node: unknown, path: string, parentType?: unknown) => {
    if (!node || typeof node !== "object") return;
    const { type, attrs, content } = node as { type?: unknown; attrs?: any; content?: unknown };
    if (typeof type === "string" && TRANSIENT_IMAGE_NODES.has(type)) {
      problems.push(`${path}: ${type} is an editor placeholder; use an imageBlock node with an uploaded src`);
    }
    if (typeof type === "string" && IMAGE_NODE_TYPES.has(type)) {
      const src = attrs?.src;
      if (typeof src !== "string" || !src) problems.push(`${path}: ${type} node needs attrs.src`);
      else if (/^data:/i.test(src)) problems.push(`${path}: image src must be a hosted URL, not a data: URI (upload it with upload_image)`);
      else if (!parseHttpUrl(src)) problems.push(`${path}: image src must be an absolute http(s) URL`);
      if (typeof parentType === "string" && TEXT_BLOCKS.has(parentType)) {
        problems.push(`${path}: images are block nodes; put the ${type} node next to paragraphs, not inside one`);
      }
      if (type === "imageBlock") {
        if (attrs?.width != null && !(typeof attrs.width === "string" && IMAGE_WIDTH.test(attrs.width))) {
          problems.push(`${path}: imageBlock attrs.width must be a percentage string such as "100%" (or a pixel width such as "540px" kept from existing content)`);
        }
        if (attrs?.align != null && !["left", "center", "right"].includes(attrs.align)) {
          problems.push(`${path}: imageBlock attrs.align must be left, center or right`);
        }
      }
    }
    if (Array.isArray(content)) content.forEach((child, i) => visit(child, `${path}.content[${i}]`, type));
  };
  visit(doc, where);
  return problems;
};

/** Problems across a localized map of TipTap docs ({ en: doc, de: doc }). */
export const localizedImageNodeProblems = (localized: unknown, field: string): string[] =>
  localized && typeof localized === "object"
    ? Object.entries(localized as Record<string, unknown>).flatMap(([locale, doc]) => imageNodeProblems(doc, `${field}.${locale}`))
    : [];

export const IMAGE_NODE_HELP =
  'Images: upload first (upload_image, or create_image_upload_link for a file on disk), then add a top-level block node { "type": "imageBlock", "attrs": { "src": "<fileUrl>", "width": "100%", "align": "center", "alt": "<description>" } } between paragraphs (never inside one). width is a percentage string (pixel widths such as "540px" in existing content are kept), align left|center|right; optional link + target ("_blank") make the image clickable.';
