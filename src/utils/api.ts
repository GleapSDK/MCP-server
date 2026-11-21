import axios, { AxiosError, AxiosResponse } from "axios";
import { API_TIMEOUT, GLEAP_API_BASE } from "../config/index.js";
import { GleapApiResponse } from "../types/index.js";
import { agentSessionHeaders, noteSessionSignals } from "./agentSession.js";
import { getCredsOrThrow, getSessionScope } from "./credentials.js";

// -------- Headers --------

export const defaultHeaders = (apiKey: string, projectId: string) => ({
  Authorization: `Bearer ${apiKey}`,
  project: projectId,
  // What this build shows the agent: `operator-feedback` = every session tool
  // prints the team's words from Gleap (operatorFeedbackLine). Without it the
  // API hands them out on report_progress only.
  "x-gleap-mcp-features": "operator-feedback",
  // A customer-scoped caller (Kai Support, the analyst) is scoped on the Server too, not only by this server's
  // tool policy: the Server leaves out what that customer may not see (round 6: kaiSupportFinding).
  ...(getSessionScope() ? { "x-gleap-scope-session": getSessionScope() as string } : {}),
});

/**
 * A write's headers: the coding session it is made for, when there is one
 * (utils/agentSession.ts). The API books the write to the session's agent,
 * runs the episode guard on it and answers with the session's stop / new
 * customer messages. Reads go without it.
 */
const writeHeaders = (apiKey: string, projectId: string) => ({
  ...defaultHeaders(apiKey, projectId),
  ...agentSessionHeaders(),
});

export const jsonHeaders = (apiKey: string, projectId: string) => ({
  ...writeHeaders(apiKey, projectId),
  "Content-Type": "application/json",
});

/** Whether a write of the current call names a coding session (its answers then speak for it). */
const writeNamesSession = (): boolean => Object.keys(agentSessionHeaders()).length > 0;

// -------- Response helpers --------

/**
 * MCP requires `structuredContent` to be a JSON *object*. A bare array or a
 * scalar makes the client reject the entire tool result as malformed — the tool
 * looks broken to the agent even though the API call succeeded. List endpoints
 * are normally wrapped by passing `listType`; this is the backstop for the ones
 * that don't (and for any endpoint that starts returning a bare array later).
 */
export const toStructuredRecord = (data: unknown): Record<string, unknown> => {
  if (Array.isArray(data)) {
    return { results: data, count: data.length, type: "list" };
  }
  if (data !== null && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return { result: data ?? null };
};

export const wrapResponse = (data: unknown): GleapApiResponse => {
  const structured = toStructuredRecord(data);
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
};

export const toStructuredListContent = (data: unknown, listType: string) =>
  Array.isArray(data)
    ? { results: data, count: data.length, type: listType }
    : data;

export const isNonEmptyObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  Object.keys(x).length > 0;

export const validationErrorResponse = (message: string): GleapApiResponse => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { error: true, validation: true, message },
});

// -------- Param helpers --------

/** Filters out null/undefined values from a flat object. */
export const buildParams = (
  fields: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));

// -------- Error handling --------

/**
 * The human-readable message of a Gleap API error body. The API's error
 * envelope nests it (`{ error: { statusCode, title, message } }`), which used
 * to reach the agent as "[object Object]".
 */
const apiErrorMessage = (err: AxiosError): string => {
  const data: any = err.response?.data;
  const candidates = [data?.message, data?.error?.message, data?.error, data?.title];
  const message = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (message) return message;
  return err.response ? `${err.response.status} ${err.response.statusText ?? ""}`.trim() : err.message;
};

/**
 * Error results carry `isError: true` (the MCP signal for a failed call) so
 * callers — the Gleap agents record tool calls from it — can tell a failure
 * from a result. `structuredContent.error` stays for existing consumers.
 */
const handleApiError = (err: unknown, at?: { path: string; sentSessionId: boolean }): GleapApiResponse => {
  if (err instanceof AxiosError) {
    // The episode guard's refusal (409) carries the session's state: stop, or newer customer messages.
    if (at && err.response) noteSessionSignals({ ...at, body: err.response.data, refusedStatus: err.response.status });
    const status = err.response?.status ?? 500;
    const message = apiErrorMessage(err);
    // Pass the response body through so tools can react to typed API
    // errors (e.g. DUPLICATE_FEATURE_REQUEST carries the duplicate's id).
    const data = err.response?.data;
    const hasData =
      data != null && typeof data === "object" && Object.keys(data).length > 0;
    return {
      isError: true,
      content: [
        { type: "text", text: `Gleap API error (${status}): ${message}` },
      ],
      structuredContent: {
        error: true,
        status,
        message,
        ...(hasData ? { data } : {}),
      },
    };
  }
  throw err;
};

// -------- Retries --------

/**
 * Transient failures the Gleap API recovers from on its own — pods restarting
 * or shedding load (503), gateway errors while nodes join the load balancer
 * (502-504), rate limits (429), dropped connections — used to reach the agent
 * as final answers. Now:
 *  - "read" (GET): retried on any 5xx, 429 and network error;
 *  - "write" (POST, the default): retried only when the request provably never
 *    reached the API — connection refused or a DNS failure. Anything else may
 *    have been processed, and a repeat of send_message or run_ticket_workflow
 *    would double a customer-visible write;
 *  - "idempotentWrite" (POST with `idempotent: true`): also 502-504. Only for
 *    calls a repeat cannot double: subscribe_to_feature_request (idempotent)
 *    and create_feature_request (the Server's duplicate guard turns a
 *    re-create into a duplicate response).
 * At most 2 retries with backoff, inside a 20s budget from the first attempt
 * (the Gleap agents give a tool call 25s). Timeouts are not retried: the
 * attempt already spent most of that budget.
 */
export type RetryPolicy = "read" | "write" | "idempotentWrite";

const RETRY_DELAYS_MS = [400, 1200];
const RETRY_BUDGET_MS = 20_000;
const RETRY_AFTER_MAX_MS = 3_000;
// The request never reached the API: nothing to double.
const NEVER_SENT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const NETWORK_ERROR_CODES = new Set([
  ...NEVER_SENT_ERROR_CODES,
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "ERR_NETWORK",
]);

export const isRetryableError = (err: unknown, policy: RetryPolicy): boolean => {
  if (!(err instanceof AxiosError)) return false;
  const status = err.response?.status;
  if (typeof status === "number") {
    if (policy === "read") return status >= 500 || status === 429;
    if (policy === "idempotentWrite") return status === 502 || status === 503 || status === 504;
    return false;
  }
  const code = err.code ?? "";
  return policy === "read" ? NETWORK_ERROR_CODES.has(code) : NEVER_SENT_ERROR_CODES.has(code);
};

const retryDelayMs = (err: unknown, attempt: number): number => {
  const retryAfter = Number(
    (err as AxiosError)?.response?.headers?.["retry-after"] ?? NaN,
  );
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS);
  }
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return Math.round(base * (0.8 + Math.random() * 0.4));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `send` (one HTTP attempt, given its timeout) with the retry policy
 * above. Resolves with the first success; rejects with the last error.
 */
export const withRetry = async <T>(
  policy: RetryPolicy,
  send: (timeoutMs: number) => Promise<T>,
): Promise<T> => {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    const remaining = RETRY_BUDGET_MS - (Date.now() - startedAt);
    try {
      return await send(attempt === 0 ? API_TIMEOUT : Math.min(API_TIMEOUT, remaining));
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err, policy)) throw err;
      const delay = retryDelayMs(err, attempt);
      // Leave the next attempt at least a second of the budget.
      if (Date.now() - startedAt + delay + 1_000 > RETRY_BUDGET_MS) throw err;
      await sleep(delay);
    }
  }
};

// -------- API call helpers --------

export const gleapGet = async (
  path: string,
  opts?: { params?: Record<string, unknown>; listType?: string }
): Promise<GleapApiResponse> => {
  const { apiKey, projectId } = getCredsOrThrow();
  try {
    const resp: AxiosResponse = await withRetry("read", (timeout) =>
      axios.get(`${GLEAP_API_BASE}${path}`, {
        params: opts?.params,
        headers: defaultHeaders(apiKey, projectId),
        timeout,
      }),
    );
    noteSessionSignals({ path, body: resp.data, sentSessionId: false });
    const data = opts?.listType
      ? toStructuredListContent(resp.data, opts.listType)
      : resp.data;
    return wrapResponse(data);
  } catch (err) {
    return handleApiError(err, { path, sentSessionId: false });
  }
};

/**
 * GET that returns the raw response body instead of the tool envelope, for
 * tools that must project a payload before any of it is serialized
 * (`gleapGet` stringifies the whole body into the text content first). API
 * errors come back as the usual error envelope.
 */
export const gleapGetData = async (
  path: string,
  opts?: { params?: Record<string, unknown> }
): Promise<{ data: unknown; headers?: Record<string, unknown> } | { error: GleapApiResponse }> => {
  const { apiKey, projectId } = getCredsOrThrow();
  try {
    const resp: AxiosResponse = await withRetry("read", (timeout) =>
      axios.get(`${GLEAP_API_BASE}${path}`, {
        params: opts?.params,
        headers: defaultHeaders(apiKey, projectId),
        timeout,
      }),
    );
    noteSessionSignals({ path, body: resp.data, sentSessionId: false });
    return { data: resp.data, headers: resp.headers as Record<string, unknown> };
  } catch (err) {
    return { error: handleApiError(err, { path, sentSessionId: false }) };
  }
};

/**
 * POST. Retried only when the request never reached the API, unless the call
 * passes `idempotent: true` (a repeat cannot double it): then 502-504 are
 * retried too. See the retry policy above.
 */
export const gleapPost = async (
  path: string,
  body: unknown,
  opts?: { params?: Record<string, unknown>; idempotent?: boolean }
): Promise<GleapApiResponse> => {
  const { apiKey, projectId } = getCredsOrThrow();
  const sentSessionId = writeNamesSession();
  try {
    const resp: AxiosResponse = await withRetry(opts?.idempotent ? "idempotentWrite" : "write", (timeout) =>
      axios.post(`${GLEAP_API_BASE}${path}`, body, {
        params: opts?.params,
        headers: jsonHeaders(apiKey, projectId),
        timeout,
      }),
    );
    noteSessionSignals({ path, body: resp.data, sentSessionId });
    return wrapResponse(resp.data);
  } catch (err) {
    return handleApiError(err, { path, sentSessionId });
  }
};

export const gleapPut = async (
  path: string,
  body: unknown
): Promise<GleapApiResponse> => {
  const { apiKey, projectId } = getCredsOrThrow();
  const sentSessionId = writeNamesSession();
  try {
    const resp = await axios.put(`${GLEAP_API_BASE}${path}`, body, {
      headers: jsonHeaders(apiKey, projectId),
      timeout: API_TIMEOUT,
    });
    noteSessionSignals({ path, body: resp.data, sentSessionId });
    return wrapResponse(resp.data);
  } catch (err) {
    return handleApiError(err, { path, sentSessionId });
  }
};

export const gleapDelete = async (path: string): Promise<GleapApiResponse> => {
  const { apiKey, projectId } = getCredsOrThrow();
  const sentSessionId = writeNamesSession();
  try {
    const resp = await axios.delete(`${GLEAP_API_BASE}${path}`, {
      headers: writeHeaders(apiKey, projectId),
      timeout: API_TIMEOUT,
    });
    noteSessionSignals({ path, body: resp.data, sentSessionId });
    return wrapResponse(resp.data);
  } catch (err) {
    return handleApiError(err, { path, sentSessionId });
  }
};
