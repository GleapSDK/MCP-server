/**
 * A teammate leaves this MCP server as a public user: id, name, email and picture.
 *
 * The Gleap API populates tickets and messages with the whole dashboard user document of the
 * assignee (`processingUser`) or sender (a message's `user`), and the tools pass the API's answer
 * on. That document holds `token` (a signup token old accounts still store), analytics ids,
 * notification settings, onboarding and assignment state: nothing an MCP client needs, and all of
 * it would land in the model's context and its transcripts.
 *
 * A user record is told apart by the fields only dashboard users have (`USER_ONLY_KEYS`, from the
 * Server's `User` model): contacts carry `name` and none of them, and the slim `get_users` entries
 * keep their role and availability. Applied to every result by `applyShareTokenRedaction`.
 */

const PUBLIC_USER_KEYS = ["_id", "id", "email", "firstName", "lastName", "profileImageUrl"] as const;
const IDENTITY_KEYS = ["email", "firstName", "lastName"] as const;

const USER_ONLY_KEYS = new Set([
  "token",
  "password",
  "otp",
  "staticOtp",
  "serviceAccountApiToken",
  "signedOutSessions",
  "sessionsValidFrom",
  "twoFactorAuthentication",
  "fcmTokens",
  "pushDevices",
  "identityProvider",
  "oauthDelegate",
  "services",
  "confirmed",
  "userType",
  "userRole",
  "userUsage",
  "notificationSettings",
  "notificationPreferences",
  "onboardingFlow",
  "completedOnboarding",
  "lastAutoAssign",
  "unavailableProjects",
  "availableFor",
  "awayUntil",
  "sendOnEnter",
  "hideAgentHandled",
  "hardTicketStartWith",
  "gaClientId",
  "gaSessionId",
  "gaSessionIds",
  "marketingTracking",
  "adClickIds",
  "lastAdClickIds",
  "acquisitionTouch",
  "attributionRef",
  "landingPage",
  "referrer",
  "knewGleapFrom",
  "utm_source",
  "utm_medium",
  "utm_term",
  "utm_content",
  "utm_campaign",
  "referral",
  "signupTrialIdentity",
  "signupTrialDomain",
  "regionMigrationStub",
  "mastercardUser",
  "gameUsername",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Whether `value` is a dashboard user document: an identity plus a field only users have. */
export const isUserRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  IDENTITY_KEYS.some((key) => key in value) &&
  Object.keys(value).some((key) => USER_ONLY_KEYS.has(key));

/** The public shape of a user: the keys of `PUBLIC_USER_KEYS` it has, nothing else. */
export const toPublicUser = (user: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(PUBLIC_USER_KEYS.filter((key) => key in user).map((key) => [key, user[key]]));

/** A copy of `value` with every user record, at any depth, in its public shape; the input is not changed. */
export const stripUserRecords = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => stripUserRecords(item));
  if (!isPlainObject(value)) return value;
  if (isUserRecord(value)) return toPublicUser(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = stripUserRecords(child);
  return out;
};

/** Text that may hold a user record: a field only users have, as a JSON key. */
const MENTIONS_USER_RECORD =
  /\\*"(?:notificationSettings|notificationPreferences|onboardingFlow|lastAutoAssign|gaClientId|unavailableProjects|availableFor|userType)\\*"/;
/**
 * `"token": "value"` and `"gaClientId": "value"` in text that is not JSON as a whole (prose around
 * JSON, JSON escaped into a string): the quote form is captured and matched again.
 */
const USER_SECRET_PAIR = /(\\*")(token|gaClientId)\1(\s*:\s*)\1(?:(?!\1)[\s\S])*?\1/g;
const REMOVED = "[removed]";

/**
 * A text result with user records in their public shape. JSON (what the tools return) keeps its
 * formatting style; in anything else that holds a user record, `token` and `gaClientId` values
 * are replaced. Text without a user record comes back unchanged.
 */
export const stripUserRecordsFromText = (text: string): string => {
  if (typeof text !== "string" || !MENTIONS_USER_RECORD.test(text)) return text;
  let out = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      out = JSON.stringify(stripUserRecords(parsed), null, text.includes("\n") ? 2 : undefined);
    }
  } catch {
    // Not JSON as a whole: the pattern below handles it.
  }
  if (!MENTIONS_USER_RECORD.test(out)) return out;
  return out.replace(
    USER_SECRET_PAIR,
    (_match, quote: string, key: string, colon: string) => `${quote}${key}${quote}${colon}${quote}${REMOVED}${quote}`,
  );
};

/** A tool result (`content` text blocks + `structuredContent`) with user records in their public shape. */
export const stripUserRecordsFromResult = (result: unknown): unknown => {
  if (!isPlainObject(result)) return result;
  const out: Record<string, unknown> = { ...result };
  if (Array.isArray(result.content)) {
    out.content = result.content.map((block: unknown) =>
      isPlainObject(block) && typeof block.text === "string"
        ? { ...block, text: stripUserRecordsFromText(block.text) }
        : block,
    );
  }
  if ("structuredContent" in result) out.structuredContent = stripUserRecords(result.structuredContent);
  return out;
};
