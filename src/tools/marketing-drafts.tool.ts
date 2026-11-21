import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapGet, gleapGetData, gleapPost, gleapPut, validationErrorResponse, wrapResponse } from "../utils/api.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import {
  DEFAULT_STYLE_BY_KIND, EMAIL_KINDS, EMAIL_STYLES, EmailKind, EmailStyle, KAI_DEFAULTS, KAI_SOURCES, KaiInput,
  defaultTracking, emailKind, kaiProblem, lookView, mergeKai, storedEmailStyle, templateIdOf, trackingForStyleChange,
} from "../utils/emailKinds.js";
import { IMAGE_NODE_HELP, localizedImageNodeProblems, resolveImageUrl } from "../utils/images.js";
import { projectList, slimNews } from "../utils/projections.js";

// -------- Shared help text (tool and field descriptions) --------

export const EMAIL_KINDS_HELP =
  "Gleap has three kinds of email. newsletter: written once, sent once to an audience (a fixed one-off). " +
  "automated: written once, sent to each contact when an event trigger fires, optionally after a delay (set the trigger with configure_email_automation). " +
  "kai (Kai-written): Kai writes a separate email for every recipient from your instructions and the data sources you allow; it can go out once or on a trigger, and teammates review the first emails before they are sent.";

export const EMAIL_LOOKS_HELP =
  "emailStyle is the look. plain: looks like a message typed in Gmail (no layout, no tracking pixel), best for personal notes, check-ins and Kai-written emails. " +
  "personal: a clean white page with buttons and images, signed by the sender with a photo card, best for onboarding and lifecycle emails. " +
  "company: logo header, content card and a footer with links and postal address in the brand color, best for newsletters and product updates. " +
  "custom: one of the project's HTML email templates (pass emailTemplate). " +
  "Defaults: newsletter → company, automated → personal, kai → plain.";

const localizedSubject = z.record(z.string(), z.string().trim().min(1))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale")
  .describe('Localized titles, e.g. { "en": "Weekly update" }.');
const localizedMessage = z.record(z.string(), z.object({
  type: z.literal("doc"),
  content: z.array(z.record(z.string(), z.unknown())).min(1),
}).passthrough())
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale")
  .describe(`Localized TipTap documents keyed by locale, without a localized wrapper. ${IMAGE_NODE_HELP}`);
const contentFields = {
  name: z.string().trim().min(1).describe("Internal name for this draft."),
  subject: localizedSubject,
  message: localizedMessage,
  sender: z.string().min(1).optional().describe("Sender user ID; review the sender in Gleap before publishing."),
};
const CreateDraftArgs = z.object(contentFields).strict();
const coverImageUrl = z.string().trim().min(1).describe(
  "Cover image shown on the news card, changelog page and push/email: a fileUrl from upload_image / create_image_upload_link, or any public http(s) image URL (copied onto Gleap's CDN first). PNG, JPEG, GIF or WebP; 16:9 works best.",
);
const CreateNewsDraftArgs = CreateDraftArgs.extend({
  subType: z.enum(["CHANGELOG", "NEWS"]).default("CHANGELOG"),
  coverImageUrl: coverImageUrl.optional(),
});
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
const draftId = objectId.describe("The draft's Gleap ID.");
const emailId = objectId.describe("The email's Gleap ID.");

// -------- Look fields (emails only) --------

const emailStyle = z.enum(EMAIL_STYLES).describe(EMAIL_LOOKS_HELP);
const emailTemplate = objectId.describe(
  "HTML email template ID, only for emailStyle custom (passing it alone selects custom). Must be one of the project's templates.",
);
const preheader = z.record(z.string(), z.string().trim().min(1).max(250))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale")
  .describe('Localized preview text the inbox shows after the subject, e.g. { "en": "Three things we shipped this week" }. Ignored by plain, which previews with its first line.');
const tracking = z.object({
  opens: z.boolean().describe("Open tracking pixel."),
  links: z.boolean().describe("Click tracking (links are redirected through Postmark)."),
}).strict().describe(
  "Open and link tracking. Default off for plain, on for the other looks. Changing emailStyle without tracking moves tracking that is still at the old look's default to the new look's default.",
);
const lookFields = { emailStyle: emailStyle.optional(), emailTemplate: emailTemplate.optional(), tracking: tracking.optional() };

// -------- Kai-written config --------

const kaiFields = {
  prompt: z.string().trim().min(1).max(8000).describe(
    "Instructions for Kai: who the email is for, what it should achieve, and what to mention (e.g. one concrete thing the contact did, one feature that fits their company, a calendar link). Kai writes in the recipient's language and signs as the sender.",
  ),
  sources: z.array(z.enum(KAI_SOURCES)).min(1).max(KAI_SOURCES.length).describe(
    `What Kai may read per recipient, read-only and limited to this project: contact (profile), company, events (last 30 days), tickets (recent conversations, no internal notes), helpcenter, customData, website (the company's public site only). Default ${JSON.stringify(KAI_DEFAULTS.sources)}.`,
  ),
  rules: z.object({
    maxWords: z.number().int().min(20).max(1000).describe(`Word limit per email. Default ${KAI_DEFAULTS.rules.maxWords}.`),
    linkAllowlist: z.array(z.string().trim().min(1).max(500)).max(50).describe(
      "Extra domains or URLs Kai may link to, on top of the project's own domains and links in the prompt. Default [].",
    ),
    forbidden: z.array(z.string().trim().min(1).max(200)).max(50).describe(
      'Topics Kai must never mention, e.g. ["prices", "discounts", "roadmap dates"]. Default [].',
    ),
  }).partial().strict().describe("Checks every email must pass; an email that fails one waits for review."),
  review: z.object({
    mode: z.enum(["all", "firstN"]).describe("all: a teammate approves every email. firstN: the first n wait for approval, later ones send on their own. Flagged emails always wait. Turning review off is only possible in the Gleap dashboard."),
    n: z.number().int().min(1).max(500).describe(`How many emails firstN holds for review. Default ${KAI_DEFAULTS.review.n}.`),
  }).partial().strict().describe(`Review before sending. Default ${JSON.stringify(KAI_DEFAULTS.review)}.`),
  onNothingToSay: z.enum(["skip", "fallback"]).describe(
    "When Kai finds nothing specific for a person: skip (default, better no email than a generic one) or fallback (send the email's own subject and message, which must then be set).",
  ),
  caps: z.object({
    perDay: z.number().int().min(1).max(10000).describe(`Most emails Kai writes per day. Default ${KAI_DEFAULTS.caps.perDay}.`),
    costPerDayUsd: z.number().positive().max(1000).describe(`Most AI cost per day in USD (billed as AI usage). Default ${KAI_DEFAULTS.caps.costPerDayUsd}.`),
  }).partial().strict().describe("Daily limits; when one is reached the rest waits until the next day."),
};
const kaiCreate = z.object(kaiFields).partial().strict().describe(
  "Kai-written config, only for kind kai (prompt required there). Omitted fields take the defaults.",
);
const kaiUpdate = z.object({
  ...kaiFields,
  enabled: z.boolean().describe("true makes this a Kai-written email (needs a prompt); false turns it back into an email written once (its subject and message)."),
}).partial().strict().describe("Changes to the Kai-written config; fields you omit keep their stored value. Passing kai on an email that is not Kai-written turns Kai on.");

// -------- Schemas --------

const CreateNewsletterDraftArgs = CreateDraftArgs.extend({ ...lookFields, preheader: preheader.optional() }).strict();
const GetDraftArgs = z.object({ draftId }).strict();
const UpdateDraftArgs = CreateDraftArgs.partial().extend({ draftId }).strict();
const UpdateNewsletterDraftArgs = UpdateDraftArgs.extend({
  ...lookFields,
  preheader: preheader.nullable().optional().describe(`${preheader.description} null removes it.`),
}).strict();
const UpdateNewsDraftArgs = UpdateDraftArgs.extend({
  coverImageUrl: coverImageUrl.nullable().optional().describe(`${coverImageUrl.description} null removes the cover.`),
}).strict();
const ListNewslettersArgs = z.object({
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
const emailCategory = z.enum(["conversational", "marketing"]).describe(
  "How a triggered email is sent. conversational (default for automated and Kai-written triggered emails): like a personal email, with no unsubscribe link, for onboarding, account and follow-up emails. marketing: with a one-click unsubscribe link, for promotions, offers and announcements. One-off emails (newsletters, one-off Kai-written) are always marketing. Contacts who unsubscribed never get either.",
);
const CreateEmailArgs = z.object({
  kind: z.enum(EMAIL_KINDS).describe(EMAIL_KINDS_HELP),
  name: contentFields.name,
  subject: localizedSubject.optional().describe('Localized subject, e.g. { "en": "Weekly update" }. Required for newsletter and automated; for kai only the fallback email uses it.'),
  message: localizedMessage.optional().describe(`Localized TipTap body. Required for newsletter and automated; for kai only the fallback email uses it. ${IMAGE_NODE_HELP}`),
  sender: contentFields.sender,
  delivery: z.enum(["one_off", "triggered"]).optional().describe(
    "Only matters for kind kai: one_off sends once to the audience when published, triggered (default) sends per contact on a trigger set with configure_email_automation. newsletter is always one_off, automated always triggered.",
  ),
  ...lookFields,
  preheader: preheader.optional(),
  emailCategory: emailCategory.optional(),
  kai: kaiCreate.optional(),
}).strict();
const UpdateEmailArgs = z.object({
  emailId,
  name: contentFields.name.optional(),
  subject: localizedSubject.optional(),
  message: localizedMessage.optional(),
  sender: contentFields.sender,
  ...lookFields,
  preheader: preheader.nullable().optional().describe(`${preheader.description} null removes it.`),
  emailCategory: emailCategory.optional(),
  kai: kaiUpdate.optional(),
}).strict();

// -------- Helpers --------

const fail = (message: string): GleapApiResponse => ({
  ...validationErrorResponse(message), isError: true,
});
const apiFailed = (response: GleapApiResponse) =>
  response.isError || response.structuredContent?.error === true;
const isNewsletter = (data: Record<string, unknown> | undefined) =>
  data?.type === "EMAIL" && data.frequencyType === "fixed" && data.frequency === "once";
const hasExpectedType = (data: Record<string, unknown> | undefined, email: boolean) =>
  email ? isNewsletter(data) : data?.type === "NEWS";
const isUnsentDraft = (data: Record<string, any>) => data.status === "draft" && !data.sentAt && data.sent !== true;

/**
 * Why update_email cannot revise this published email (live, or paused after
 * it went live), or null when it can. Content of a live triggered (dynamic)
 * email is editable in place: the server keeps its queued sends, which read
 * the email when they go out. A sent one-off is locked by the server.
 */
const publishedEditProblem = (data: Record<string, any>, hasKaiChange: boolean): string | null => {
  if (data.frequencyType !== "dynamic") {
    return "This one-off email was already sent; its content cannot be changed. Create a new email instead.";
  }
  if (data.status !== "live" && data.status !== "draft") {
    return `This email is ${String(data.status)}; only drafts and live or paused automated emails can be revised.`;
  }
  if (hasKaiChange) {
    return "The Kai-written config (kai) of a published email cannot be changed here: emails Kai already wrote or holds for review would keep the old instructions. Change it in the Gleap dashboard. Subject, message, preheader, sender, name, look and emailCategory can be edited here without pausing.";
  }
  return null;
};

const publishedNextStep = (data: Record<string, any>): string => data.status === "live"
  ? "Saved on the live email; it stays live. Queued sends keep their send time and go out with the new content, and so do new triggers. Trigger, audience and frequency did not change."
  : "Saved. The email is still paused (its queued sends were dropped when it was paused); publishing it again (publish_email) needs the operator's approval.";

const editUrl = (section: "emails" | "news", id: string) =>
  `${GLEAP_DASHBOARD_BASE}/projects/${encodeURIComponent(getCredsOrThrow().projectId)}/engagement/${section}/${encodeURIComponent(id)}/edit`;

const NEWSLETTER_NEXT_STEP = "Review content in Gleap. Human approval of the completed draft is required before publishing or sending; confirm sender, audience, and delivery settings there.";

const nextStepFor = (data: Record<string, any>): string => {
  const kind = emailKind(data);
  if (kind === "automated") {
    return "Review content in Gleap. Set the trigger and audience with configure_email_automation; publishing (publish_email) needs the operator's approval.";
  }
  if (kind === "kai") {
    const review = data.kai?.review ?? KAI_DEFAULTS.review;
    const held = review.mode === "all" ? "every email" : `the first ${review.n ?? KAI_DEFAULTS.review.n} emails`;
    const when = data.frequencyType === "fixed"
      ? "Set the audience with configure_email_automation"
      : "Set the trigger and audience with configure_email_automation";
    return `Kai writes nothing until the email is live. Check the instructions in Gleap and use "Preview on sample recipients" there. ${when}; publishing (publish_email) needs the operator's approval. Once live, ${held} wait in the email's Review tab for a teammate's approval.`;
  }
  return NEWSLETTER_NEXT_STEP;
};

/**
 * Verifies a write and adds reviewUrl. `matches` checks the saved record is
 * what the call meant to store (type, kind, look); a string is a specific
 * problem to report instead of the generic one. The saved status must be
 * `published.status` for an edit of a published email, else draft.
 */
function reviewResponse(
  response: GleapApiResponse,
  email: boolean,
  matches: (data: Record<string, any>) => boolean | string,
  published?: { status: string; nextStep: string },
): GleapApiResponse {
  if (apiFailed(response)) return { ...response, isError: true };
  const data = response.structuredContent;
  const id = data?.id ?? data?._id;
  const match = data ? matches(data) : false;
  if (!data || data.status !== (published?.status ?? "draft") || match !== true || typeof id !== "string") {
    return { ...response, isError: true, content: [...response.content, {
      type: "text", text: typeof match === "string" ? match : "Could not verify the saved draft. Inspect Gleap before retrying; the write may have succeeded.",
    }] };
  }
  return wrapResponse({ ...data,
    ...(email ? { look: lookView(data) } : {}),
    reviewUrl: editUrl(email ? "emails" : "news", id),
    nextStep: published?.nextStep ?? (email ? nextStepFor(data) : NEWSLETTER_NEXT_STEP),
  });
}

// Email endpoints do not canonicalize bare locale maps, unlike the news endpoint.
// `keepStatus` leaves status out: an edit of a published email never changes it
// (status draft would unpublish a live email and drop its queued sends).
function draftBody(args: { name?: string; subject?: unknown; message?: unknown; sender?: string; preheader?: unknown }, keepStatus = false) {
  return {
    ...buildParams({
      name: args.name,
      subject: args.subject ? { localized: args.subject } : undefined,
      message: args.message ? { localized: args.message } : undefined,
      sender: args.sender,
      status: keepStatus ? undefined : "draft",
    }),
    ...(args.preheader === null ? { preheader: null } : args.preheader ? { preheader: { localized: args.preheader } } : {}),
  };
}

/** A requested template must be one of the project's. */
async function checkEmailTemplate(requested: string | undefined, why: string):
  Promise<{ id: string } | { error: GleapApiResponse }> {
  const list = await gleapGetData("/email-templates");
  if ("error" in list) return { error: { ...list.error, isError: true } };
  const templates = (Array.isArray(list.data) ? list.data : [])
    .map((template) => ({ id: templateIdOf(template), title: (template as any)?.title }))
    .filter((template): template is { id: string; title: unknown } => template.id !== undefined);
  const match = requested && templates.find((template) => template.id.toLowerCase() === requested.toLowerCase());
  if (match) return { id: match.id };
  const available = templates.map((template) => `${template.id} (${String(template.title ?? "untitled")})`).join(", ");
  const problem = requested ? `Email template ${requested} is not one of this project's templates.` : why;
  return { error: fail(`${problem} Available: ${available || "none"}.`) };
}

interface LookArgs { emailStyle?: EmailStyle; emailTemplate?: string; tracking?: { opens: boolean; links: boolean } }

/**
 * The look fields to write. On create (`stored` undefined) emailStyle and
 * tracking are always set. On update only what changes: an update that passes
 * no look field writes none, so the stored look (e.g. custom + its template)
 * stays exactly as it is; the kind's default look applies to new emails only.
 * emailTemplate alone selects custom, and custom needs a template of the project's.
 */
async function lookBody(args: LookArgs, defaultStyle: EmailStyle, stored?: Record<string, any>):
  Promise<{ fields: Record<string, unknown> } | { error: GleapApiResponse }> {
  if (stored && !args.emailStyle && !args.emailTemplate && !args.tracking) return { fields: {} };
  if (args.emailTemplate && args.emailStyle && args.emailStyle !== "custom") {
    return { error: fail(`emailTemplate only applies to emailStyle custom; ${args.emailStyle} is rendered by Gleap without a template. Drop one of the two.`) };
  }
  const style: EmailStyle | undefined = args.emailStyle ?? (args.emailTemplate ? "custom" : stored ? undefined : defaultStyle);
  const fields: Record<string, unknown> = {};
  if (style) fields.emailStyle = style;
  if (style === "custom" && (args.emailTemplate || !templateIdOf(stored?.emailTemplate))) {
    const template = await checkEmailTemplate(args.emailTemplate, "emailStyle custom needs emailTemplate, one of the project's HTML templates.");
    if ("error" in template) return template;
    fields.emailTemplate = template.id;
  }
  const nextTracking = args.tracking
    ?? (!stored ? defaultTracking(style ?? defaultStyle) : style ? trackingForStyleChange(stored, style) : undefined);
  if (nextTracking) fields.tracking = nextTracking;
  return { fields };
}

/** The saved record took the look this call wrote (a server that dropped emailStyle fails this). */
const lookSaved = (data: Record<string, any>, body: Record<string, any>) =>
  (body.emailStyle === undefined || data.emailStyle === body.emailStyle) &&
  (body.kai === undefined || data.kai?.enabled === body.kai.enabled);

/**
 * Why the saved email no longer has the look it had before an update that
 * did not ask to change it (e.g. custom + template saved as personal), or
 * null. The message names the values that restore it.
 */
const lookDrift = (saved: Record<string, any>, stored: Record<string, any>, body: Record<string, any>): string | null => {
  const before = { emailStyle: storedEmailStyle(stored), emailTemplate: templateIdOf(stored.emailTemplate) ?? null };
  const after = { emailStyle: storedEmailStyle(saved), emailTemplate: templateIdOf(saved.emailTemplate) ?? null };
  const styleDrift = body.emailStyle === undefined && after.emailStyle !== before.emailStyle;
  const templateDrift = body.emailStyle === undefined && body.emailTemplate === undefined && after.emailTemplate !== before.emailTemplate;
  if (!styleDrift && !templateDrift) return null;
  const restore = before.emailStyle === "custom"
    ? `emailStyle "custom" and emailTemplate "${before.emailTemplate}"`
    : `emailStyle "${before.emailStyle}"`;
  return `The saved email changed its look although this update did not pass one: it was ${JSON.stringify(before)}, it is now ${JSON.stringify(after)}. Restore it with update_email passing ${restore}.`;
};

/**
 * Checks the message's image nodes and turns `coverImageUrl` into a stored
 * Gleap CDN URL (importing an external one). Returns the extra body fields,
 * or a failed result that must stop the write.
 */
async function imageFields(args: { message?: unknown; coverImageUrl?: string | null }):
  Promise<{ fields: Record<string, unknown> } | { error: GleapApiResponse }> {
  const problems = localizedImageNodeProblems(args.message, "message");
  if (problems.length > 0) return { error: fail(`${problems.join("; ")}. ${IMAGE_NODE_HELP}`) };
  if (args.coverImageUrl === undefined) return { fields: {} };
  if (args.coverImageUrl === null) return { fields: { coverImageUrl: null } };
  const cover = await resolveImageUrl(args.coverImageUrl);
  if ("error" in cover) return { error: { ...cover.error, isError: true } };
  return { fields: { coverImageUrl: cover.url } };
}

const DRAFT_ONLY = "Never publishes, schedules or sends; publishing needs the operator's approval of the finished email.";

const slimEmail = (email: any): Record<string, unknown> => {
  const slim = slimNews(email);
  if (!slim || typeof slim !== "object") return slim;
  return { ...slim, kind: emailKind(email), emailStyle: storedEmailStyle(email) };
};

export function registerMarketingDraftTools(server: McpServer) {
  for (const email of [false, true]) {
    const kind = email ? "newsletter" : "news";
    const path = email ? "/engagement/emails" : "/engagement/news";
    const createSchema = email ? CreateNewsletterDraftArgs : CreateNewsDraftArgs;
    const updateSchema = email ? UpdateNewsletterDraftArgs : UpdateNewsDraftArgs;
    const coverHelp = email ? "" : " Optional coverImageUrl sets the cover image.";
    const createLookHelp = email
      ? ` A newsletter is a fixed one-off email; for automated or Kai-written emails use create_email. Optional emailStyle (look, default company), preheader and tracking. ${EMAIL_LOOKS_HELP}`
      : "";
    const updateLookHelp = email
      ? " emailStyle, emailTemplate, preheader and tracking change the look; tracking still at the old look's default follows a look change."
      : "";
    server.registerTool(`create_${kind}_draft`, {
      title: `Create ${email ? "Newsletter" : "News / Changelog"} Draft`,
      description: `Save an unpublished ${kind} draft in Gleap and return its reviewUrl. Does not publish, schedule, or send. After human approval of the plan, prepare the draft; obtain a separate approval of the completed content before publication in the dashboard. Requires name, localized subject, and localized TipTap message.${coverHelp}${createLookHelp}`,
      inputSchema: createSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    }, async (input: unknown) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return fail(parsed.error.message);
      const args = parsed.data;
      let look: Record<string, unknown> = {};
      if (email) {
        const resolved = await lookBody(args as LookArgs, DEFAULT_STYLE_BY_KIND.newsletter);
        if ("error" in resolved) return resolved.error;
        look = resolved.fields;
      }
      const images = await imageFields(args);
      if ("error" in images) return images.error;
      const body: Record<string, any> = {
        ...draftBody(args as Parameters<typeof draftBody>[0]),
        ...images.fields,
        ...(email ? {
          ...look,
          type: "EMAIL", actionType: "email", format: "personal",
          frequencyType: "fixed", frequency: "once", frequencyDays: 0, trigger: null, emailCategory: "marketing",
        } : {
          type: "NEWS", subType: "subType" in args ? args.subType : "CHANGELOG",
          config: { push: false, sendEmailToSubscribers: false },
        }),
      };
      return reviewResponse(await gleapPost(path, body), email,
        (data) => hasExpectedType(data, email) && (!email || lookSaved(data, body)));
    });

    server.registerTool(`update_${kind}_draft`, {
      title: `Update ${email ? "Newsletter" : "News / Changelog"} Draft`,
      description: `Revise an existing unpublished ${kind} draft. Checks its type and draft status before writing; refuses live, paused, or sent items. Cannot publish, schedule, or send. Returns reviewUrl for human review.${coverHelp}${updateLookHelp}`,
      inputSchema: updateSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (input: unknown) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) return fail(parsed.error.message);
      const { draftId, emailStyle: style, emailTemplate: template, tracking: requestedTracking, ...changes } =
        parsed.data as z.infer<typeof UpdateNewsDraftArgs> & LookArgs & { preheader?: unknown };
      const lookArgs: LookArgs = { emailStyle: style, emailTemplate: template, tracking: requestedTracking };
      const hasChanges = [...Object.values(changes), ...Object.values(lookArgs)].some((value) => value !== undefined);
      if (!hasChanges) return fail("Provide at least one field to update.");
      const current = await gleapGet(`${path}/${draftId}`);
      if (apiFailed(current)) return { ...current, isError: true };
      const data = current.structuredContent;
      if (!data || !hasExpectedType(data, email) || !isUnsentDraft(data)) {
        return fail("Only an unsent draft of the requested type can be revised. Create a new draft instead.");
      }
      let look: Record<string, unknown> = {};
      if (email) {
        const resolved = await lookBody(lookArgs, storedEmailStyle(data), data);
        if ("error" in resolved) return resolved.error;
        look = resolved.fields;
      }
      // Images are resolved only after the draft checks: an import stores a file.
      const images = await imageFields(changes);
      if ("error" in images) return images.error;
      const body = { ...draftBody(changes as Parameters<typeof draftBody>[0]), ...look, ...images.fields };
      return reviewResponse(await gleapPut(`${path}/${draftId}`, body), email,
        (saved) => hasExpectedType(saved, email) && (!email || (lookSaved(saved, body) && (lookDrift(saved, data, body) ?? true))));
    });
  }

  server.registerTool("create_email", {
    title: "Create Email Draft",
    description: `Save an unpublished email of any kind (newsletter, automated or Kai-written) and return its reviewUrl. ${EMAIL_KINDS_HELP} ${EMAIL_LOOKS_HELP} ${DRAFT_ONLY} A Kai-written email starts in draft with review of the first ${KAI_DEFAULTS.review.n} emails; Kai writes nothing until it is published. Set trigger and audience afterwards with configure_email_automation.`,
    inputSchema: CreateEmailArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = CreateEmailArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { kind, delivery, kai: kaiInput, emailStyle: style, emailTemplate: template, tracking: requestedTracking, emailCategory: requestedCategory, ...content } = parsed.data;
    if (kind !== "kai" && kaiInput) return fail("kai config is only for kind kai (Kai-written emails).");
    if (kind === "newsletter" && delivery === "triggered") return fail("A newsletter is sent once; for a triggered email use kind automated.");
    if (kind === "automated" && delivery === "one_off") return fail("An automated email is sent on a trigger; for a one-off email use kind newsletter.");
    if (kind !== "kai" && (!content.subject || !content.message)) return fail(`A ${kind} email needs subject and message.`);
    const kai = kind === "kai" ? mergeKai(undefined, { ...(kaiInput as KaiInput | undefined), enabled: true }) : undefined;
    const fixed = kind === "newsletter" || (kind === "kai" && delivery === "one_off");
    if (fixed && requestedCategory === "conversational") return fail("One-off emails are always marketing emails with an unsubscribe link; conversational is only for triggered emails.");
    const draft = draftBody(content);
    const kaiIssue = kai ? kaiProblem(kai, draft) : null;
    if (kaiIssue) return fail(kaiIssue);
    const look = await lookBody({ emailStyle: style, emailTemplate: template, tracking: requestedTracking }, DEFAULT_STYLE_BY_KIND[kind]);
    if ("error" in look) return look.error;
    const images = await imageFields(content);
    if ("error" in images) return images.error;
    const body: Record<string, any> = {
      ...draft,
      ...look.fields,
      ...(kai ? { kai } : {}),
      type: "EMAIL", actionType: "email", format: "personal",
      frequencyType: fixed ? "fixed" : "dynamic", frequency: "once", frequencyDays: 0, trigger: null,
      emailCategory: fixed ? "marketing" : (requestedCategory ?? "conversational"),
    };
    return reviewResponse(await gleapPost("/engagement/emails", body), true,
      (data) => data.type === "EMAIL" && emailKind(data) === kind && lookSaved(data, body));
  });

  server.registerTool("update_email", {
    title: "Update Email",
    description: `Revise an email. Drafts of any kind: content, look (emailStyle, emailTemplate, preheader, tracking), emailCategory and the Kai-written config (kai, merged into what is stored). ` +
      "Live automated (triggered) emails, and paused ones that were live, are edited in place: subject, message, preheader, sender, name, emailStyle, emailTemplate, tracking and emailCategory. " +
      "A live email stays live, its queued sends keep going and go out with the new content; edits reach the next recipients right away, so change a live email only with the operator's approval of the change. " +
      "Never pause an email just to edit it: pausing drops every queued send for good. " +
      "Refused: kai on a published email (Gleap dashboard), and any change to a sent one-off email (newsletter). Only the fields you pass are written; trigger, audience, frequency and status never change here (trigger and audience: configure_email_automation). " +
      `${EMAIL_LOOKS_HELP} Never publishes, pauses, schedules or sends. Returns reviewUrl.`,
    inputSchema: UpdateEmailArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = UpdateEmailArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { emailId: id, kai: kaiInput, emailStyle: style, emailTemplate: template, tracking: requestedTracking, emailCategory: requestedCategory, ...content } = parsed.data;
    const lookArgs: LookArgs = { emailStyle: style, emailTemplate: template, tracking: requestedTracking };
    const hasChanges = [...Object.values(content), ...Object.values(lookArgs), kaiInput, requestedCategory].some((value) => value !== undefined);
    if (!hasChanges) return fail("Provide at least one field to update.");
    const current = await gleapGet(`/engagement/emails/${id}`);
    if (apiFailed(current)) return { ...current, isError: true };
    const data = current.structuredContent;
    if (!data || data.type !== "EMAIL") return fail("No email with this ID in this project.");
    const isDraft = isUnsentDraft(data);
    const problem = isDraft ? null : publishedEditProblem(data, kaiInput !== undefined);
    if (problem) return fail(problem);
    const draft = draftBody(content, !isDraft);
    const kai = kaiInput ? mergeKai(data.kai, kaiInput as KaiInput) : undefined;
    const kaiIssue = kai ? kaiProblem(kai, { ...data, ...draft }) : null;
    if (kaiIssue) return fail(kaiIssue);
    const look = await lookBody(lookArgs, storedEmailStyle(data), data);
    if ("error" in look) return look.error;
    const images = await imageFields(content);
    if ("error" in images) return images.error;
    if (requestedCategory === "conversational" && data.frequencyType === "fixed") {
      return fail("One-off emails are always marketing emails with an unsubscribe link; conversational is only for triggered emails.");
    }
    const body: Record<string, any> = { ...draft, ...look.fields, ...(kai ? { kai } : {}), ...(requestedCategory ? { emailCategory: requestedCategory } : {}) };
    const expectedKind = emailKind({ ...data, ...body });
    return reviewResponse(await gleapPut(`/engagement/emails/${id}`, body), true,
      (saved) => saved.type === "EMAIL" && emailKind(saved) === expectedKind && lookSaved(saved, body) && (lookDrift(saved, data, body) ?? true),
      isDraft ? undefined : { status: data.status, nextStep: publishedNextStep(data) });
  });

  server.registerTool("get_email", {
    title: "Get Email",
    description: "Read any email (newsletter, automated or Kai-written, draft or live): its localized content, kind, look (emailStyle, preheader, tracking), Kai-written config and dashboard reviewUrl. Trigger and audience: get_email_automation.",
    inputSchema: z.object({ emailId }).strict().shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ emailId: id }) => {
    const response = await gleapGet(`/engagement/emails/${id}`);
    if (apiFailed(response)) return { ...response, isError: true };
    const data = response.structuredContent;
    if (!data || data.type !== "EMAIL") return fail("No email with this ID in this project.");
    return wrapResponse({ ...data, look: lookView(data), reviewUrl: editUrl("emails", String(data.id ?? data._id ?? id)) });
  });

  server.registerTool("get_newsletter_drafts", {
    title: "Get Newsletter Drafts",
    description: "List unpublished, fixed, one-time email campaigns (newsletters and one-off Kai-written emails; kind says which). Returns summaries; use get_newsletter_draft or get_email for content and reviewUrl.",
    inputSchema: ListNewslettersArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ skip, limit }) => projectList(await gleapGet("/engagement/emails", {
    params: { status: "draft", frequencyType: "fixed", frequency: "once", skip, limit }, listType: "newsletter_drafts",
  }), slimEmail));

  server.registerTool("get_newsletter_draft", {
    title: "Get Newsletter Draft",
    description: "Read a newsletter draft's full localized content, look and dashboard reviewUrl.",
    inputSchema: GetDraftArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ draftId }) => reviewResponse(await gleapGet(`/engagement/emails/${draftId}`), true, isNewsletter));
}
