import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Ticket share tokens never leave this MCP server.
 *
 * `shareToken` opens a ticket without a login (`GET /v3/shared/tickets/{shareToken}`,
 * the public `/share/{shareToken}` page); `secretShareToken` grants the same through
 * the `secret-share-token` header. The Gleap REST API answers ticket calls with the
 * ticket as the dashboard sees it, tokens included, and the ticket tools passed that
 * through (`get_ticket`, `close_ticket`, `update_ticket`, …; `search_tickets` even
 * projected `shareToken` on purpose). Every MCP client — Claude, Cursor, Kai Code
 * sandboxes, Gleap's own agents — then had them in the model's context and its logs.
 *
 * Nothing an MCP client does needs them: tools address tickets by id or number,
 * `dashboardUrl` is built from the id, and feature-request `shareUrl`s are roadmap
 * links (`…/feature-requests?id=…`), not token links. The Gleap Server strips the
 * same keys from Gleap MCP results inside its agent runtime (GleapSDK/Server#2261,
 * `src/services/agents/shareTokenRedaction.ts`); keep the two in step.
 *
 * Enforced centrally (`applyShareTokenRedaction`), so every tool — current and
 * future — is covered, success and error results alike.
 */

/**
 * `shareToken`, `secretShareToken`, `ticketShareToken`, any case; and the contact's widget
 * credentials: `gleapId` + `gleapHash` read and answer the customer's conversations,
 * `fileAccessToken` opens their files (live E2E 2026-10-13 B3: `get_ticket` returned the
 * pair under `session`). No tool needs them: contacts are addressed by id.
 */
const SECRET_KEY_NAMES = ["gleaphash", "gleapid", "gleapidsecret", "fileaccesstoken"];
const isShareTokenKey = (key: string): boolean =>
  /sharetoken$/i.test(key) || SECRET_KEY_NAMES.includes(key.toLowerCase()) || SECRET_OBJECT_KEYS.includes(key.toLowerCase());

/**
 * A contact's `signed` record leaves as its head only (`userId`, `kind`, `kid`, `at`): the
 * verified token's `claims` and `exp` stay in Gleap. `authTokens` is dropped like a credential.
 */
const SIGNED_HEAD_KEYS = ["userId", "kind", "kid", "at"];
const SECRET_OBJECT_KEYS = ["authtokens"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A copy of `value` without share-token keys at any depth; the input is not changed. */
export const stripShareTokens = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => stripShareTokens(item)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isShareTokenKey(key)) continue;
    if (key === "signed" && isPlainObject(child)) {
      out[key] = Object.fromEntries(SIGNED_HEAD_KEYS.filter((k) => k in child).map((k) => [k, child[k]]));
      continue;
    }
    out[key] = stripShareTokens(child);
  }
  return out as T;
};

/**
 * `"…shareToken": "value"` in any text, also inside JSON escaped into a string
 * (`\"shareToken\":\"value\"`): the quote form is captured and matched again.
 */
const SHARE_TOKEN_PAIR =
  /(\\*")(\w*sharetoken|gleaphash|gleapid|gleapidsecret|fileaccesstoken)\1(\s*:\s*)\1(?:(?!\1)[\s\S])*?\1/gi;
/** Text that may hold one of the keys (a cheap check before parsing). */
const MENTIONS_SECRET = /sharetoken|gleaphash|gleapid|fileaccesstoken|authtokens|"signed"/i;

const REMOVED = "[removed]";

/**
 * A text result without share tokens. JSON (what the tools return) loses the keys
 * and keeps its formatting style; anything the parser can't read (prose around
 * JSON, JSON escaped in a string) has the token values replaced. Text that never
 * mentions a share token comes back unchanged.
 */
export const stripShareTokensFromText = (text: string): string => {
  if (typeof text !== "string" || !MENTIONS_SECRET.test(text)) return text;
  let out = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      out = JSON.stringify(stripShareTokens(parsed), null, text.includes("\n") ? 2 : undefined);
    }
  } catch {
    // Not JSON as a whole: the pattern below handles it.
  }
  return out.replace(
    SHARE_TOKEN_PAIR,
    (_match, quote: string, key: string, colon: string) =>
      `${quote}${key}${quote}${colon}${quote}${REMOVED}${quote}`,
  );
};

/** A tool result (`content` text blocks + `structuredContent`) without share tokens. */
export const stripShareTokensFromResult = <T>(result: T): T => {
  if (!isPlainObject(result)) return result;
  const out: Record<string, unknown> = { ...result };
  if (Array.isArray(result.content)) {
    out.content = result.content.map((block) =>
      isPlainObject(block) && typeof block.text === "string"
        ? { ...block, text: stripShareTokensFromText(block.text) }
        : block,
    );
  }
  if ("structuredContent" in result) {
    out.structuredContent = stripShareTokens(result.structuredContent);
  }
  return out as T;
};

/**
 * Patch `server.registerTool` so every handler registered afterwards has its result
 * stripped of share tokens. Call once per server instance, BEFORE
 * `applySessionScopePolicy` and the tool registrars, so the redaction wraps
 * everything (scope refusals included).
 */
export const applyShareTokenRedaction = (server: McpServer): void => {
  const originalRegisterTool = server.registerTool.bind(server);

  (server as any).registerTool = (
    name: string,
    meta: any,
    handler: (...handlerArgs: any[]) => any,
  ) => {
    const redacted = async (...handlerArgs: any[]) =>
      stripShareTokensFromResult(await handler(...handlerArgs));
    return originalRegisterTool(name, meta, redacted as any);
  };
};
