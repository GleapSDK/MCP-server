/**
 * Email kinds, looks and Kai-written config, as the MCP creates and edits
 * them. Pure: no I/O, so the guards are unit-testable.
 *
 * Stored shapes follow the shared email data contract (Server outbound model,
 * dashboard editor):
 *  - emailStyle: 'plain' | 'personal' | 'company' | 'custom'. Legacy emails
 *    without it render as 'custom' when they have an emailTemplate, else
 *    'personal'. 'custom' renders through the email's emailTemplate.
 *  - preheader: { localized: { <locale>: string } } (plain ignores it).
 *  - tracking: { opens, links }; when missing, plain = off, other looks = on.
 *  - kai: per-recipient AI-written email config (see KAI_DEFAULTS).
 *
 * The UI "kind" is derived, never stored: kai.enabled → 'kai' (Kai-written),
 * frequencyType 'fixed' → 'newsletter', otherwise 'automated'.
 */

export const EMAIL_STYLES = ["plain", "personal", "company", "custom"] as const;
export type EmailStyle = (typeof EMAIL_STYLES)[number];
export const EMAIL_KINDS = ["newsletter", "automated", "kai"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
export const KAI_SOURCES = ["contact", "company", "events", "tickets", "helpcenter", "customData", "website"] as const;
export type KaiSource = (typeof KAI_SOURCES)[number];

type Doc = Record<string, any>;

/** The look a new email of each kind starts in (the dashboard's create flow uses the same). */
export const DEFAULT_STYLE_BY_KIND: Record<EmailKind, Exclude<EmailStyle, "custom">> = {
  newsletter: "company",
  automated: "personal",
  kai: "plain",
};

export interface Tracking { opens: boolean; links: boolean }

/** Plain looks hand-typed: no open pixel, no redirected links. Every other look tracks both. */
export const defaultTracking = (style: EmailStyle): Tracking =>
  style === "plain" ? { opens: false, links: false } : { opens: true, links: true };

export const templateIdOf = (value: unknown): string | undefined => {
  const id = value && typeof value === "object"
    ? (value as Doc)._id ?? (value as Doc).id
    : value;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

/** The look a stored email renders in, including legacy emails saved before emailStyle existed. */
export const storedEmailStyle = (email: Doc): EmailStyle =>
  (EMAIL_STYLES as readonly string[]).includes(email?.emailStyle)
    ? email.emailStyle
    : templateIdOf(email?.emailTemplate) ? "custom" : "personal";

export const emailKind = (email: Doc): EmailKind =>
  email?.kai?.enabled === true ? "kai" : email?.frequencyType === "fixed" ? "newsletter" : "automated";

export const storedTracking = (email: Doc): Tracking => {
  const tracking = email?.tracking;
  if (tracking && typeof tracking.opens === "boolean" && typeof tracking.links === "boolean") {
    return { opens: tracking.opens, links: tracking.links };
  }
  return defaultTracking(storedEmailStyle(email));
};

const sameTracking = (a: Tracking, b: Tracking) => a.opens === b.opens && a.links === b.links;

/**
 * The tracking to store when an update changes the look without passing
 * tracking: tracking that still sits at the old look's default follows the new
 * look's default (switching to plain turns the pixel off); tracking somebody
 * set on purpose stays. Undefined = leave the stored value alone.
 */
export const trackingForStyleChange = (email: Doc, nextStyle: EmailStyle): Tracking | undefined => {
  const previousStyle = storedEmailStyle(email);
  if (previousStyle === nextStyle) return undefined;
  const current = storedTracking(email);
  const next = defaultTracking(nextStyle);
  if (!sameTracking(current, defaultTracking(previousStyle)) || sameTracking(current, next)) return undefined;
  return next;
};

// -------- Kai-written emails --------

export type KaiReviewMode = "all" | "firstN" | "none";

export interface KaiConfig {
  enabled: boolean;
  prompt: string;
  sources: KaiSource[];
  rules: { maxWords: number; linkAllowlist: string[]; forbidden: string[] };
  review: { mode: KaiReviewMode; n: number };
  onNothingToSay: "skip" | "fallback";
  caps: { perDay: number; costPerDayUsd: number };
}

/** What the MCP may set. Review 'none' (send without any review) stays a dashboard decision. */
export interface KaiInput {
  enabled?: boolean;
  prompt?: string;
  sources?: KaiSource[];
  rules?: Partial<KaiConfig["rules"]>;
  review?: { mode?: "all" | "firstN"; n?: number };
  onNothingToSay?: "skip" | "fallback";
  caps?: Partial<KaiConfig["caps"]>;
}

/** Defaults of a new Kai-written email: review the first 20, skip people Kai has nothing specific for. */
export const KAI_DEFAULTS: Omit<KaiConfig, "enabled" | "prompt"> = {
  sources: ["contact", "company", "events", "tickets", "helpcenter", "website"],
  rules: { maxWords: 120, linkAllowlist: [], forbidden: [] },
  review: { mode: "firstN", n: 20 },
  onNothingToSay: "skip",
  caps: { perDay: 500, costPerDayUsd: 25 },
};

const objectOr = (value: unknown): Doc => (value && typeof value === "object" && !Array.isArray(value) ? value as Doc : {});
const defined = (value: Doc): Doc => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

/**
 * The full kai object to store: defaults, then what is stored, then the
 * input. Nested groups merge per field; arrays replace. A new Kai-written
 * email (nothing stored) is enabled unless the input says otherwise.
 */
export const mergeKai = (stored: unknown, input: KaiInput): KaiConfig => {
  const current = objectOr(stored);
  const merged: KaiConfig = {
    enabled: input.enabled ?? (typeof current.enabled === "boolean" ? current.enabled : true),
    prompt: input.prompt ?? (typeof current.prompt === "string" ? current.prompt : ""),
    sources: input.sources ?? (Array.isArray(current.sources) ? current.sources : KAI_DEFAULTS.sources),
    rules: { ...KAI_DEFAULTS.rules, ...defined(objectOr(current.rules)), ...defined(objectOr(input.rules)) } as KaiConfig["rules"],
    review: { ...KAI_DEFAULTS.review, ...defined(objectOr(current.review)), ...defined(objectOr(input.review)) } as KaiConfig["review"],
    onNothingToSay: input.onNothingToSay ?? current.onNothingToSay ?? KAI_DEFAULTS.onNothingToSay,
    caps: { ...KAI_DEFAULTS.caps, ...defined(objectOr(current.caps)), ...defined(objectOr(input.caps)) } as KaiConfig["caps"],
  };
  merged.sources = [...new Set(merged.sources)];
  return merged;
};

const hasLocalized = (value: unknown): boolean => {
  const localized = objectOr(objectOr(value).localized);
  return Object.values(localized).some((entry) => entry !== undefined && entry !== null && entry !== "");
};

/** Does the stored/merged email carry the written-once subject and message a fallback email sends? */
export const hasFallbackContent = (email: Doc): boolean => hasLocalized(email.subject) && hasLocalized(email.message);

/**
 * Why this Kai config cannot be saved or published, or null. `email` is the
 * email as it will be stored (subject/message decide whether a fallback exists).
 */
export const kaiProblem = (kai: Doc | undefined | null, email: Doc): string | null => {
  if (!kai || kai.enabled !== true) return null;
  if (typeof kai.prompt !== "string" || kai.prompt.trim().length === 0) {
    return "A Kai-written email needs instructions: pass kai.prompt (what Kai should write, for whom, and why).";
  }
  if (!Array.isArray(kai.sources) || kai.sources.length === 0) {
    return "A Kai-written email needs at least one source in kai.sources.";
  }
  if (kai.onNothingToSay === "fallback" && !hasFallbackContent(email)) {
    return 'kai.onNothingToSay "fallback" sends the email\'s own subject and message to people Kai has nothing specific for. Pass subject and message too, or use "skip".';
  }
  return null;
};

/** Why the MCP refuses to publish this stored Kai-written email, or null. */
export const kaiPublishProblem = (email: Doc): string | null => {
  if (emailKind(email) !== "kai") return null;
  const problem = kaiProblem(email.kai, email);
  if (problem) return problem;
  if (email.kai.review?.mode === "none") {
    return "Review is turned off for this Kai-written email, so it would send without any teammate seeing it. The MCP publishes Kai-written emails only with review (all or firstN): set kai.review with update_email, or publish it in the Gleap dashboard.";
  }
  return null;
};

/** The look-related fields of a stored email, for tool results. */
export const lookView = (email: Doc) => ({
  kind: emailKind(email),
  emailStyle: storedEmailStyle(email),
  emailTemplate: templateIdOf(email.emailTemplate) ?? null,
  preheader: email.preheader ?? null,
  tracking: storedTracking(email),
  // One-off emails are always marketing; triggered ones default to conversational.
  emailCategory: email.frequencyType === "fixed" || email.emailCategory === "marketing" ? "marketing" : "conversational",
  kai: email.kai ?? null,
});
