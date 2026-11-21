/**
 * Secret redaction for SDK telemetry (console lines, network URLs and bodies,
 * event data) before `get_ticket_activity_log` returns it to an MCP client.
 *
 * Ported from the Gleap Server's Kai Resolve telemetry redaction
 * (`src/api/resolutionanalysis/services/ticket.telemetry.redaction.ts`), which
 * redacts the same data for the code investigator. Keep the two in step: this
 * module matches Server `ticket.telemetry.redaction.ts` as of
 * GleapSDK/Server#1783, commit d24241285, including these two guards (each
 * covered by a test):
 *  - The JWT rule is anchored to the start of a base64url run instead of a
 *    word boundary, so a long run with many `-eyJ` inside cannot restart the
 *    match at every dash (quadratic).
 *  - The JSON-pair rule also redacts a string value that runs to the end of
 *    the text (cut inside it) and numbers under credential-like keys.
 *
 * The SDKs apply the project's network privacy settings at capture
 * (`networkLogPropsToIgnore` strips keys, `networkLogBlacklist` drops URLs).
 * This module adds the part no setting covers: credentials a customer's app
 * happens to log or send. Headers are never rendered at all (see
 * activityLog.ts), so this only has to handle values that appear in text, URLs
 * and JSON bodies.
 *
 * It is deliberately key- and shape-based: values under credential-like keys,
 * bearer tokens, JWTs, well-known API key formats and card numbers. The
 * customer's own identity (e-mail, user ids) stays, because debugging looks
 * records up by it. Placeholder values such as `undefined` or an empty token
 * stay visible too: "Bearer undefined" is a finding, not a secret.
 * Leaf module: no I/O.
 */

export const REDACTED = "[redacted]";

// Keys compared after lower-casing and dropping everything but [a-z0-9]
// ("X-API-Key" -> "xapikey").
const SENSITIVE_KEY_NAMES = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "secret",
  "token",
  "auth",
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "session",
  "sessionid",
  "sid",
  "jwt",
  "bearer",
  "otp",
  "pin",
  "cvc",
  "cvv",
  "cvv2",
  "cardnumber",
  "ccnumber",
  "pan",
  "iban",
  "ssn",
  "apikey",
  "xapikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "signature",
  "sig",
  "credential",
  "credentials",
]);
const SENSITIVE_KEY_SUFFIX =
  /(password|passwd|passphrase|secret|token|apikey|accesskey|secretkey|privatekey|signature|credentials?|cookie|sessionid|authorization)$/;
// A payment card object is dropped whole: its fields have generic names
// (`number`, `exp`) that no key rule can tell apart from ordinary data.
const CARD_CONTAINER_KEY =
  /^(credit|debit|payment|bank)?card(details|info|data)?$/;

// Values that are never secrets and are worth seeing ("token=undefined").
const PLACEHOLDER_VALUES = new Set([
  "",
  "undefined",
  "null",
  "none",
  "nil",
  "false",
  "true",
  "nan",
  REDACTED,
]);

export const normalizeKey = (key: string): string =>
  String(key ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  return (
    SENSITIVE_KEY_NAMES.has(normalized) || SENSITIVE_KEY_SUFFIX.test(normalized)
  );
};

const isPlaceholder = (value: string): boolean =>
  PLACEHOLDER_VALUES.has(value.trim().toLowerCase());

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

// Card numbers: 13-19 digits (spaces or dashes allowed), a card-network first
// digit (3-6, which also keeps millisecond timestamps out) and a valid Luhn
// checksum.
const looksLikeCardNumber = (candidate: string): boolean => {
  const digits = candidate.replace(/\D/g, "");
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    /^[3-6]/.test(digits) &&
    passesLuhn(digits)
  );
};

const STRONG_TEXT_KEYS =
  "password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|private[_-]?key";

const TEXT_RULES: Array<(text: string) => string> = [
  // Bearer credentials, unless the "token" is a placeholder.
  (text) =>
    text.replace(
      /\b(Bearer)(\s+)(?!(?:undefined|null|none|false|true|nan)\b)[A-Za-z0-9\-._~+/]{8,}=*/gi,
      (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`,
    ),
  // The "Token <key>" scheme. "Token" is also an ordinary word ("Token
  // refreshed successfully"), so only long values with a digit count.
  (text) =>
    text.replace(
      /\b(Token)(\s+)(?=[A-Za-z0-9\-._~+/]*\d)[A-Za-z0-9\-._~+/]{16,}=*/g,
      (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`,
    ),
  // JWTs. The lookbehind pins the match to the start of a base64url run; a
  // word boundary would also match after every "-" inside one run and rescan
  // it from each (quadratic).
  (text) =>
    text.replace(
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
      REDACTED,
    ),
  // Well-known API key formats (Stripe secret/restricted, OpenAI/Anthropic,
  // GitHub, Slack, AWS access key ids, Google API keys).
  (text) =>
    text
      .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED)
      .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, REDACTED)
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
        REDACTED,
      )
      .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED)
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED),
  // JSON-style pairs inside text: "token": "…". A string value that runs to
  // the end of the text counts too: a trimmed log line or body can end inside
  // one, and a secret cut there must not survive as a prefix. Numbers under a
  // credential-like key ("pin": 1234) are redacted, as redactJson does.
  (text) =>
    text.replace(
      /"([^"\\]{1,64})"(\s*:\s*)(?:"((?:[^"\\]|\\.)*\\?)("|$)|(-?\d+(?:\.\d+)?))/g,
      (
        match,
        key: string,
        separator: string,
        value: string | undefined,
        close: string | undefined,
        number: string | undefined,
      ) => {
        if (!isSensitiveKey(key)) return match;
        if (number !== undefined) return `"${key}"${separator}"${REDACTED}"`;
        return isPlaceholder(value ?? "")
          ? match
          : `"${key}"${separator}"${REDACTED}${close ?? ""}`;
      },
    ),
  // Query-string / form / cookie pairs: token=…. The lookbehind pins the key
  // to its first character and the key length is capped; unanchored, this
  // pattern backtracks quadratically over a long run of word characters.
  (text) =>
    text.replace(
      /(?<![A-Za-z0-9_.\-[\]])([A-Za-z0-9_.\-[\]]{1,64})=([^&\s#,;"']+)/g,
      (match, key: string, value: string) =>
        isSensitiveKey(safeDecode(key)) && !isPlaceholder(value)
          ? `${key}=${REDACTED}`
          : match,
    ),
  // "password: hunter2" in prose. Only for keys that are never followed by
  // anything but the secret; "token: expired" stays readable.
  (text) =>
    text.replace(
      new RegExp(
        `\\b(${STRONG_TEXT_KEYS})(\\s*[:=]\\s*)(?!\\[redacted\\])([^\\s,;"'&]+)`,
        "gi",
      ),
      (match, key: string, separator: string, value: string) =>
        isPlaceholder(value) ? match : `${key}${separator}${REDACTED}`,
    ),
  // Card numbers.
  (text) =>
    text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) =>
      looksLikeCardNumber(match) ? REDACTED : match,
    ),
];

export const redactText = (text: string): string => {
  if (!text) return text;
  let out = String(text);
  for (const rule of TEXT_RULES) out = rule(out);
  return out;
};

export const redactUrl = (url: string): string => {
  if (!url) return url;
  let out = String(url).replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i,
    `$1${REDACTED}@`,
  );
  out = out.replace(
    /([?&#;])([^=&#;?]+)=([^&#;]*)/g,
    (match, separator: string, key: string, value: string) =>
      value &&
      !isPlaceholder(safeDecode(value)) &&
      isSensitiveKey(safeDecode(key))
        ? `${separator}${key}=${REDACTED}`
        : match,
  );
  return redactText(out);
};

const MAX_JSON_DEPTH = 12;

/** Marks where a budgeted copy stopped (see `budgetChars`). */
export const JSON_CUT_MARKER = "…";

/**
 * Deep copy of a parsed JSON body or event payload with credential-like keys
 * redacted, card objects dropped and the project's ignored keys removed.
 * Only strings and numbers are redacted: null and booleans cannot carry a
 * secret, and "hasPassword: true" is useful.
 *
 * `maxStringChars` cuts long strings before redaction and `budgetChars` stops
 * copying once roughly that much serialized output exists (the rest becomes
 * `…`), so the work stays proportional to what the caller will show even for
 * a 150 KB body.
 */
export const redactJson = (
  value: unknown,
  options: {
    propsToIgnore?: string[];
    maxStringChars?: number;
    budgetChars?: number;
  } = {},
): unknown => {
  const ignored = new Set(
    (options.propsToIgnore ?? []).map(normalizeKey).filter(Boolean),
  );
  const maxStringChars = options.maxStringChars ?? Infinity;
  let remaining = options.budgetChars ?? Infinity;

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      const cut =
        node.length > maxStringChars
          ? `${node.slice(0, maxStringChars)}…`
          : node;
      remaining -= cut.length + 2;
      return redactText(cut);
    }
    if (node === null || typeof node !== "object") {
      remaining -= String(node).length;
      return node;
    }
    if (depth >= MAX_JSON_DEPTH) return JSON_CUT_MARKER;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        if (remaining <= 0) {
          out.push(JSON_CUT_MARKER);
          break;
        }
        out.push(walk(item, depth + 1));
        remaining -= 1;
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (remaining <= 0) {
        out[JSON_CUT_MARKER] = JSON_CUT_MARKER;
        break;
      }
      const normalized = normalizeKey(key);
      if (ignored.has(normalized)) continue;
      remaining -= key.length + 4;
      if (
        CARD_CONTAINER_KEY.test(normalized) &&
        child !== null &&
        typeof child === "object"
      ) {
        out[key] = REDACTED;
        continue;
      }
      if (
        isSensitiveKey(key) &&
        (typeof child === "number" ||
          (typeof child === "string" && !isPlaceholder(child)))
      ) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(child, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
};
