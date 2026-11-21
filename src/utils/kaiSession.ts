import { GleapApiResponse } from "../types/index.js";
import { STOP_TEXT } from "./agentSession.js";
import { decodeBase64Image, IMAGE_TYPES } from "./images.js";
import { validationErrorResponse } from "./api.js";

/**
 * Shared plumbing for the external-session tools (report_progress, update_plan,
 * wrap_up, share_screenshot, publish_artifact) and the workflow prompts.
 *
 * Tenant scoping lives in the Gleap API: every call carries the caller's
 * project + credentials (never anything from the tool args), and the API only
 * resolves sessions/tickets of that project. This module keeps the path safe
 * (a session id is 24 hex chars or nothing; a ticket ref travels in the body
 * or query, never in the path).
 */

export type SessionTarget = { sessionId?: string; ticketId?: string };

export const SESSION_ID_RE = /^[a-f0-9]{24}$/i;

export const MISSING_TARGET =
  "Pass sessionId (from your kickoff prompt or a report_progress result) or, when you have none, the ticketId you are working on.";

/**
 * The route for `/gleapcode/sessions/{id}/<suffix>`, or its by-ticket
 * variant `/gleapcode/sessions/<suffix>` with `ticketId` in the body/query.
 * Null when neither id was given (or the session id is malformed).
 */
export const sessionRoute = (
  target: SessionTarget,
  suffix: string,
): { path: string; ticketId?: string } | null => {
  const sessionId = typeof target.sessionId === "string" ? target.sessionId.trim() : "";
  if (sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    return { path: `/gleapcode/sessions/${sessionId}/${suffix}` };
  }
  const ticketId = typeof target.ticketId === "string" ? target.ticketId.trim() : "";
  if (!ticketId) return null;
  return { path: `/gleapcode/sessions/${suffix}`, ticketId };
};

export const missingTargetResponse = (): GleapApiResponse => ({
  isError: true,
  content: [{ type: "text", text: MISSING_TARGET }],
  structuredContent: { error: "sessionId or ticketId is required" },
});

export const failure = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });

/** "Pass sessionId …" when the session was resolved from the ticket. */
export const sessionIdLine = (target: SessionTarget, result: Record<string, any> | undefined): string | null =>
  !target.sessionId && typeof result?.sessionId === "string"
    ? `Gleap coding session ${result.sessionId}. Pass sessionId "${result.sessionId}" on your next Gleap session calls (report_progress, update_plan, wrap_up, share_screenshot, publish_artifact).`
    : null;

/**
 * The `stop` flag of an agent route result (every tool's, utils/agentSession.ts)
 * and the `hook` block (§8 of the native-turns contract): what the Gleap
 * plugin's hooks read from `<repo>/.gleap/session.json` to sync the plan and a
 * fallback wrap-up without the agent calling the tools.
 */
const stopLine = (result: Record<string, any> | undefined): string | null => (result?.stop === true ? STOP_TEXT : null);

export const hookLine = (result: Record<string, any> | undefined): string | null => {
  const hook = result?.hook;
  if (!hook || typeof hook !== "object" || typeof hook.token !== "string" || typeof hook.sessionId !== "string") return null;
  const file = JSON.stringify(
    { sessionId: hook.sessionId, token: hook.token, apiBase: hook.apiBase, expiresAt: hook.expiresAt },
    null,
    2,
  );
  return `Write this to .gleap/session.json at the root of the repository you work in (overwrite it if it exists), make it readable only by you (\`chmod 600 .gleap/session.json\`; skip this on Windows), and add the line \`.gleap/\` to .git/info/exclude once so it is never committed. The Gleap plugin's hooks use it to keep your plan and wrap-up in sync:\n${file}`;
};

/**
 * What the team asked for in Gleap since the agent's last call ("Request
 * changes" on its pull request card, or a message to Kai Code), worded by the
 * API with the next step. Gleap hands it out once: it must reach the agent.
 */
export const operatorFeedbackLine = (result: Record<string, any> | undefined): string | null => {
  const message = result?.operatorFeedback?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
};

/**
 * Checked FIRST on every agent-route result: a session stopped in Gleap gets
 * only the STOP instruction (no success sentence, nothing to retry), and a
 * `success: false` body is a failure even with HTTP 200.
 */
export const stoppedOrFailed = (result: Record<string, any> | undefined): GleapApiResponse | null => {
  const stop = stopLine(result);
  if (stop) return { content: [{ type: "text", text: stop }], structuredContent: { ...(result ?? {}), stop: true } };
  if (result?.success === false) {
    const message =
      [result.message, result.error?.message, result.error].find((m) => typeof m === "string" && m.trim()) ??
      "Gleap did not accept this call.";
    return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ...result, error: true } };
  }
  return null;
};

/** Append text lines to a successful result. */
export const withLines = (res: GleapApiResponse, lines: Array<string | null | undefined>): GleapApiResponse => {
  for (const text of lines) if (typeof text === "string" && text) res.content.push({ type: "text", text });
  return res;
};

// -------- update_plan --------

const STATUS_ALIASES: Record<string, string> = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  inprogress: "in_progress",
  "in-progress": "in_progress",
  active: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export const normalizePlanStatus = (status: string): string | null =>
  STATUS_ALIASES[status.trim().toLowerCase()] ?? STATUS_ALIASES[status.trim()] ?? null;

export const normalizePlan = (
  items: Array<{ content: string; status: string }>,
): { items: Array<{ content: string; status: string }> } | { error: string } => {
  const out: Array<{ content: string; status: string }> = [];
  for (const [i, item] of items.entries()) {
    const status = normalizePlanStatus(item.status);
    if (!status) return { error: `items[${i}].status "${item.status}" is not one of pending, in_progress, completed, cancelled.` };
    const content = item.content.trim();
    if (!content) return { error: `items[${i}].content is empty.` };
    out.push({ content, status });
  }
  return { items: out };
};

// -------- wrap_up --------

export const wrapUpProblem = (
  actions: Array<{ label: string; action?: string; message?: string }> | undefined,
): string | null => {
  for (const [i, a] of (actions ?? []).entries()) {
    if (!a.action && !a.message) return `actions[${i}] needs an action.`;
    if (!a.action) {
      return `actions[${i}] is a reply button (message only). Gleap cannot send a reply to an agent running on your operator's machine, so use one of the actions or put the question in ask.`;
    }
    // Removed (Hard tickets, SPEC §6/§8): it put a draft in the ticket composer. Kept in the
    // schema for one release so an older workflow gets this answer, not a schema error.
    if (a.action === "send_customer_update") {
      return `actions[${i}] send_customer_update was removed: Gleap no longer stages replies in the ticket composer. Ask your operator in your own conversation, then send the approved text with send_message.`;
    }
  }
  return null;
};

// -------- share_screenshot --------

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const mimeFromPath = (path: string): string | undefined =>
  EXT_MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""];

export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Single-quote a path for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Decode, size-check (≤ maxBytes decoded) and sniff inline screenshots.
 * Returns the cleaned base64 (no data: prefix) and the sniffed type, or the
 * first problem.
 */
export const checkInlineImages = (
  images: string[],
  maxBytes: number,
): { images: Array<{ base64: string; mimeType: string; bytes: number }> } | { error: string } => {
  const out: Array<{ base64: string; mimeType: string; bytes: number }> = [];
  for (const [i, raw] of images.entries()) {
    const payload = raw.trim().replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
    // Cheap pre-check before decoding a huge string.
    if (Math.floor((payload.length * 3) / 4) > maxBytes + 3) {
      return { error: `imageBase64[${i}] is larger than ${(maxBytes / 1_000_000).toFixed(1)} MB. Save it to a file and pass path instead (you upload it with the returned command).` };
    }
    const decoded = decodeBase64Image(payload);
    if ("error" in decoded) return { error: `imageBase64[${i}]: ${decoded.error}` };
    if (decoded.bytes.length > maxBytes) {
      return { error: `imageBase64[${i}] is larger than ${(maxBytes / 1_000_000).toFixed(1)} MB. Save it to a file and pass path instead (you upload it with the returned command).` };
    }
    out.push({ base64: decoded.bytes.toString("base64"), mimeType: decoded.contentType, bytes: decoded.bytes.length });
  }
  return { images: out };
};

export const imageExtension = (mimeType: string): string => IMAGE_TYPES[mimeType] ?? "png";

// -------- publish_artifact --------

export const htmlSizeProblem = (html: string, maxBytes: number): string | null => {
  const bytes = Buffer.byteLength(html, "utf8");
  return bytes > maxBytes
    ? `html is ${(bytes / 1_000_000).toFixed(2)} MB; pages are limited to ${(maxBytes / 1_000_000).toFixed(0)} MB. Inline less data (link large images instead of embedding them as data: URIs).`
    : null;
};
