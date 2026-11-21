import { z } from "zod";
import { definitionIssues, SURVEY_LIMITS } from "../utils/surveyDefinition.js";
import { audienceInput, eventName, frequencyInput, MAX_DELAY_SECONDS } from "./targeting.schema.js";

// ---------------------------------------------------------------------------
// Survey definition (Surveys 2.0). Mirrors SurveyDefinition in
// SURVEYS_V2_SPEC.md §2; the Server's validateSurveyDefinition is the
// authority, these schemas catch shape mistakes before anything is written
// and teach agents the format through their descriptions.
// ---------------------------------------------------------------------------

export const SURVEY_FORMATS = ["card", "full"] as const;
export const BLOCK_TYPES = [
  "nps", "csat", "rating", "scale",
  "single", "multi", "yesno",
  "short", "long", "email", "number", "date",
  "upload", "statement", "consent",
] as const;

const LANG = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

// Factories, not shared instances: a schema instance reused inside one tool
// schema becomes an internal JSON-schema $ref, which several MCP clients and
// model providers do not resolve.
const LOCALIZED_HELP = 'Text: a plain string (stored under defaultLanguage) or a locale map like { "en": "How likely…", "de": "Wie wahrscheinlich…" }.';
export const localized = () => z.union([
  z.string().trim().min(1),
  z.record(z.string().regex(LANG, "Locale codes look like en, de, pt-BR"), z.string())
    .refine((value) => Object.keys(value).length > 0, "Provide at least one locale"),
]).describe(LOCALIZED_HELP);

const hexColor = () => z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Colours are hex like #485bff");
// https only, no quotes/parentheses/whitespace/backslashes/angle brackets (the
// Server's isSafeSurveyImageUrl rejects anything that could escape CSS url()).
const imageUrl = () => z.string().url().max(2048)
  .regex(/^https:\/\/[^\s"'()<>\\`]+$/, "Image URLs must be https with no quotes, parentheses or whitespace");
const blockId = () => z.string().regex(ID_PATTERN, "ids use letters, digits, _ or - (max 40)");
const answerValue = () => z.union([z.string(), z.number(), z.boolean()]);

const choice = z.object({
  id: blockId().describe("Stable choice id, unique within the block, e.g. \"too_expensive\". Answers and conditions use this id, never the label."),
  label: localized(),
}).strict();

const condition = z.union([
  z.object({
    src: z.literal("answer"),
    op: z.enum(["eq", "neq"]),
    value: answerValue(),
  }).strict().describe("This block's answer equals / differs: single → choice id, yesno → true/false, nps/csat/rating/scale/number → number."),
  z.object({
    src: z.literal("answer"),
    op: z.literal("between"),
    // Not z.tuple: its JSON Schema (`items: [...]`) makes ChatGPT refuse the whole server (#227003).
    value: z.array(z.number()).length(2),
  }).strict().describe("Numeric answer in [min, max], inclusive (nps/csat/rating/scale/number)."),
  z.object({
    src: z.literal("answer"),
    op: z.literal("includes"),
    value: z.string(),
  }).strict().describe("multi only: the selected choice ids include this choice id."),
  z.object({
    src: z.literal("answer"),
    op: z.enum(["answered", "skipped"]),
  }).strict().describe("The block was answered / skipped (optional blocks)."),
  z.object({
    src: z.enum(["contact", "field"]),
    key: z.string().trim().min(1).max(80),
    op: z.enum(["eq", "neq", "contains", "exists"]),
    value: answerValue().optional(),
  }).strict().describe("Condition on the person: a contact property (e.g. key \"plan\") or a hidden field (key must be listed in definition.fields)."),
  z.object({
    src: z.literal("url"),
    op: z.enum(["contains", "eq"]),
    value: z.string().min(1),
  }).strict().describe("Condition on the page URL the survey is shown on."),
]);

const jump = z.object({
  if: condition,
  go: blockId().describe("Target: a LATER block id or an ending id (jumps only go forward)."),
}).strict();

const block = z.object({
  id: blockId().describe("Stable block id, unique across blocks AND endings, e.g. \"q_reason\". Jumps reference it."),
  key: z.string().regex(KEY_PATTERN, "key must match /^[a-z][a-z0-9_]{1,40}$/").describe(
    "Stable answer key used by the API, webhooks, exports and filters, e.g. \"nps_score\". Lowercase snake_case, unique. Never rename it on a live survey (it splits the results).",
  ),
  type: z.enum(BLOCK_TYPES).describe(
    "Question type. Scales: nps (fixed 0-10), csat (fixed 1-5), rating (stars, scaleMin..scaleMax, e.g. 1-5), scale (scaleMin..scaleMax). " +
    "Choices: single (one choice id), multi (array of choice ids), yesno (true/false). " +
    "Inputs: short, long, email, number, date (YYYY-MM-DD). Other: upload (files), statement (text only, no answer — intros, notes), " +
    "consent (a checkbox the respondent ticks, e.g. the privacy policy: title = the checkbox text, empty = the widget's \"I have read and accept the privacy policy.\"; linkUrl = the policy; answer true; required = must be ticked).",
  ),
  title: localized().describe("The question. May use {{contact.first_name}}, {{field.<hidden field key>}} or {{answer.<earlier key>}} tokens."),
  description: localized().optional(),
  required: z.boolean().optional().describe("Default false. statement blocks are never required."),
  choices: z.array(choice).max(SURVEY_LIMITS.choices).optional().describe("single/multi only (required there)."),
  allowOther: z.boolean().optional().describe("single/multi: adds an \"Other\" option with a text box; its answer is { other: \"…\" }."),
  randomize: z.boolean().optional().describe("Shuffle choice order per respondent."),
  minSelect: z.number().int().min(0).optional().describe("multi: minimum choices."),
  maxSelect: z.number().int().min(1).optional().describe("multi: maximum choices."),
  scaleStyle: z.enum(["numbers", "emoji", "stars", "compact"]).optional().describe(
    "nps/csat/rating/scale look. compact = NPS only: six buttons 0–5 that answer 0, 2, 4, 6, 8, 10 (NPS groups and logic stay on 0–10).",
  ),
  scaleMin: z.number().int().min(0).max(10).optional().describe("rating/scale lower bound (ignored for nps 0-10 and csat 1-5)."),
  scaleMax: z.number().int().min(1).max(10).optional().describe("rating/scale upper bound."),
  lowLabel: localized().optional().describe("Label under the lowest value, e.g. \"Not likely\"."),
  highLabel: localized().optional().describe("Label under the highest value, e.g. \"Very likely\"."),
  placeholder: localized().optional().describe("Inputs: placeholder text."),
  maxLength: z.number().int().min(1).max(10000).optional().describe("short/long: maximum characters."),
  media: z.object({
    type: z.enum(["image", "video"]),
    url: z.string().url(),
  }).strict().optional(),
  defaultValue: z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.string().max(100)).max(SURVEY_LIMITS.choices)]).optional().describe(
    "Preselected answer the question starts with (choice id, choice ids for multi, a scale value, true/false, text). The respondent still confirms it; nothing is saved before.",
  ),
  accept: z.string().max(500).regex(/^[A-Za-z0-9.,/*+_ -]*$/).optional().describe("upload: accepted file types, e.g. \".png,.jpg,application/pdf\" or \"image/*\"."),
  linkUrl: z.string().url().optional().describe("consent: https link to the policy the checkbox refers to."),
  linkLabel: localized().optional().describe("consent: the link's text (default \"privacy policy\")."),
  contactField: z.enum(["name", "phone"]).optional().describe(
    "short only: this question asks for the contact's name or phone number (an email question always asks for the email). Set it on every name or phone question, so known contacts skip it (see skipWhenKnown).",
  ),
  skipWhenKnown: z.boolean().optional().describe(
    "Contact questions only (email, short with contactField). Unset = on: an identified contact (Gleap.identify) whose email/name/phone is already known is not asked, and the Server saves that value as the answer. false = always ask (e.g. a work email that may differ). Omit it on other questions.",
  ),
  jumps: z.array(jump).max(SURVEY_LIMITS.jumps).optional().describe(
    "Logic, evaluated top to bottom, first match wins; put person conditions (contact/field/url) first. Omit or [] for none.",
  ),
  next: blockId().nullable().optional().describe(
    "\"All other cases go to\": a later block id or an ending id. null/omitted = the next block in order (after the last block: the first ending).",
  ),
}).strict();

const ending = z.object({
  id: blockId().describe("Ending id, unique across blocks and endings, e.g. \"end_thanks\"."),
  title: localized(),
  description: localized().optional(),
  button: z.object({ label: localized(), url: z.string().url() }).strict().optional(),
  redirectUrl: z.string().url().optional().describe("Survey page/link only: redirect after this ending."),
  autoCloseSeconds: z.number().int().min(0).max(600).optional().describe("In-app: close automatically after N seconds."),
  tagContact: z.string().trim().min(1).max(80).optional().describe("Tag added to the contact when they reach this ending."),
}).strict();

const welcome = z.object({
  enabled: z.boolean().describe("true shows the welcome screen before the first question (people who come back to finish skip it)."),
  title: localized().describe("Large heading, e.g. \"Help shape Acme\". Required when enabled."),
  description: localized().optional().describe("One or two sentences under the title: why you ask, what happens with the answers."),
  buttonLabel: localized().optional().describe("Start button text. Default \"Start\"."),
  media: z.object({ type: z.literal("image"), url: imageUrl() }).strict().optional()
    .describe("Image above the title (full screen and survey page; the card stays compact): a public https URL."),
  showTimeToComplete: z.boolean().optional().describe("\"Takes about N minutes\" from the question count. Default true."),
}).strict();

const hiddenField = z.object({
  key: z.string().regex(KEY_PATTERN, "key must match /^[a-z][a-z0-9_]{1,40}$/").describe("Hidden field key, filled by showSurvey({ fields }), URL params or personal links."),
  label: z.string().max(80).optional(),
}).strict();

const definitionShape = z.object({
  schemaVersion: z.literal(2).optional(),
  format: z.enum(SURVEY_FORMATS).optional().describe("Overridden by the tool's format argument when that is given."),
  defaultLanguage: z.string().regex(LANG).optional().describe("Default \"en\". Plain-string texts are stored under this locale."),
  welcome: welcome.optional().describe("Optional welcome screen (Typeform-style intro) before the first question. Not a block: no key, no answer, no logic. Prefer it over a leading statement block."),
  blocks: z.array(block).min(1).max(SURVEY_LIMITS.blocks).describe("Questions in display order (max 60)."),
  endings: z.array(ending).min(1).max(SURVEY_LIMITS.endings).describe("At least one ending (thank-you screen). Max 10."),
  fields: z.array(hiddenField).max(SURVEY_LIMITS.fields).optional().describe("Hidden fields (not shown; recorded with the response and usable in conditions as src \"field\")."),
  theme: z.object({
    brandColor: hexColor().optional().describe("Buttons, selected choices, progress bar. Default: the widget colour."),
    buttonTextColor: hexColor().optional().describe("Text on brand-filled buttons and selected choices. Default: black or white, picked for contrast."),
    appearance: z.enum(["auto", "light", "dark"]).optional().describe("\"auto\" (default) follows the widget's light/dark setting."),
    background: z.enum(["tint", "plain", "color", "image"]).optional().describe(
      "Full-screen format and survey page only (the card/bottom sheet stays a solid light/dark surface). \"tint\" (default) = light brand tint, \"plain\" = no tint, \"color\" needs backgroundColor, \"image\" needs backgroundImage.",
    ),
    backgroundColor: hexColor().optional().describe("Backdrop colour for background \"color\"."),
    backgroundImage: imageUrl().optional().describe("Backdrop image for background \"image\": a public https URL."),
    backgroundOverlay: z.number().min(0).max(0.8).optional().describe(
      "0–0.8: black darkening over a colour/image background so text stays legible. Default 0.3 for images, 0 for colours.",
    ),
    textColor: hexColor().optional().describe("Text on the full-screen/page backdrop. Default: picked by contrast (light text on dark colours/images)."),
    corners: z.enum(["sharp", "rounded", "pill"]).optional().describe("Radius of choices, buttons and inputs. Default \"rounded\"."),
    logoUrl: imageUrl().optional().describe("Logo (https URL), top-left in full screen and in the survey page header. Default: the widget logo."),
    showLogo: z.boolean().optional().describe("false hides the logo everywhere. Default true (shown on the survey page)."),
    logoInApp: z.boolean().optional().describe("true also shows the logo in in-app full-screen surveys. Default false (survey page only)."),
  }).strict().optional().describe(
    "Design. Every field is optional; unset fields use the project's widget defaults (widget colour, logo, light/dark setting). Omit theme entirely to match the widget.",
  ),
  showProgress: z.boolean().optional().describe("Default true."),
  allowSkipBack: z.boolean().optional().describe("Full screen: allow going back. Default true."),
  sender: z.object({
    userId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
    show: z.boolean().optional().describe("false hides the \"Lukas from Acme\" row above the question."),
  }).strict().optional()
    .describe("Card format sender row; default is the project's default sender, shown unless show is false."),
}).strict();

export const DEFINITION_HELP = [
  "A survey definition is { blocks, endings, welcome?, fields?, defaultLanguage?, showProgress?, allowSkipBack?, theme? }.",
  "welcome is an optional intro screen before question 1: { enabled: true, title, description?, buttonLabel? (default 'Start'), media? { type: 'image', url: https }, showTimeToComplete? (default true) } — use it instead of a leading statement block.",
  "theme is optional design (brandColor, appearance, background tint/plain/color/image with https backgroundImage and backgroundOverlay 0–0.8, corners sharp/rounded/pill, logoUrl/showLogo); unset fields use the widget defaults.",
  "Each block: { id, key, type, title, required?, choices? (single/multi), scaleMin/scaleMax (rating/scale), defaultValue? (preselected answer), accept? (upload file types), jumps?, next? }.",
  "Asking for contact details: use type 'email' for the email, and type 'short' with contactField 'name' or 'phone' for the name or phone number, e.g. { id: 'q_name', key: 'full_name', type: 'short', title: 'Your name?', contactField: 'name' }. Identified contacts whose value is already known skip these questions and the Server fills the answer in (skipWhenKnown, unset = on); guests are asked. Set skipWhenKnown: false only to always ask.",
  "Privacy consent: { id: 'q_privacy', key: 'privacy_consent', type: 'consent', title: {}, required: true, linkUrl: 'https://example.com/privacy' } — a required checkbox; it can only branch on answered/skipped.",
  "id: stable id that jumps point to (unique across blocks and endings). key: snake_case answer key for API/webhooks/exports.",
  "Logic: jumps [{ if: condition, go: <later block id or ending id> }] are checked top to bottom, first match wins; otherwise `next`, otherwise the next block in order, after the last block the first ending. Jumps only go forward (no loops).",
  "Conditions on this block's answer: { src: 'answer', op: 'eq'|'neq', value } (single → choice id, yesno → true/false, numbers → number), { src: 'answer', op: 'between', value: [min, max] } (inclusive), { src: 'answer', op: 'includes', value: choiceId } (multi), { src: 'answer', op: 'answered'|'skipped' }.",
  "Conditions on the person: { src: 'contact', key: 'plan', op: 'eq', value: 'pro' }, { src: 'field', key: <hidden field key>, op, value }, { src: 'url', op: 'contains', value: '/billing' }.",
  "Example NPS with follow-ups by group: blocks [",
  "{ id: 'q_nps', key: 'nps_score', type: 'nps', title: 'How likely are you to recommend us?', required: true, jumps: [",
  "{ if: { src: 'answer', op: 'between', value: [0, 6] }, go: 'q_detractor' }, { if: { src: 'answer', op: 'between', value: [7, 8] }, go: 'q_passive' }, { if: { src: 'answer', op: 'between', value: [9, 10] }, go: 'q_promoter' } ] },",
  "{ id: 'q_detractor', key: 'detractor_reason', type: 'long', title: 'What disappointed you?', next: 'end_thanks' },",
  "{ id: 'q_passive', key: 'passive_improve', type: 'long', title: 'What would make it a 10?', next: 'end_thanks' },",
  "{ id: 'q_promoter', key: 'promoter_love', type: 'long', title: 'What do you love most?', next: 'end_thanks' } ],",
  "endings [{ id: 'end_thanks', title: 'Thanks for your feedback!' }].",
  "Choice example: { id: 'q_reason', key: 'cancel_reason', type: 'single', title: 'Main reason?', choices: [{ id: 'too_expensive', label: 'Too expensive' }, { id: 'missing_features', label: 'Missing features' }], jumps: [{ if: { src: 'answer', op: 'eq', value: 'too_expensive' }, go: 'q_price' }], next: 'q_better' }.",
].join(" ");

export const SurveyDefinitionInput = definitionShape.superRefine((definition, ctx) => {
  for (const issue of definitionIssues(definition)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
}).describe("Survey definition { blocks, endings, fields?, … }; the tool description explains the format with an NPS example.");

export type SurveyDefinitionInputType = z.infer<typeof definitionShape>;

// ---------------------------------------------------------------------------
// Tool arguments
// ---------------------------------------------------------------------------

export const surveyId = z.string().regex(/^[a-fA-F0-9]{24}$/, "Use the survey's 24-character Gleap id (`id` from list_surveys)")
  .describe("The survey's Gleap id (`id` from list_surveys, 24 hex chars) — not the SDK id passed to Gleap.showSurvey.");
export const responseId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Response id (`id` from get_survey_responses, e.g. \"rsp_…\").");

const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum items (default ${fallback}, max ${max}).`);

export const ListSurveysArgs = z.object({
  status: z.enum(["live", "draft"]).optional().describe("Only live (delivering) or draft/paused surveys."),
  limit: limit(100, 20),
  skip: z.number().int().min(0).optional().describe("Surveys to skip for pagination (default 0)."),
});
/** Kept for the legacy `get_surveys` tool. */
export const GetSurveysArgs = ListSurveysArgs;

export const GetSurveyArgs = z.object({
  surveyId,
  version: z.enum(["draft", "published"]).optional().describe("Which definition to return (default draft — the one update_survey edits)."),
});

const triggerInput = z.object({
  event: eventName().describe("Streamed event that shows the survey, e.g. \"subscription_cancelled\". Contact attributes and pageView are set in the dashboard."),
  delaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS).optional().describe("Show this long after the event; default 0 (immediately)."),
  frequency: frequencyInput.optional().describe("once per contact (default), every time the event fires, or at most once every N days."),
}).strict();

export const CreateSurveyArgs = z.object({
  name: z.string().trim().min(1).max(200).describe("Internal survey name, e.g. \"Cancellation survey\"."),
  format: z.enum(SURVEY_FORMATS).describe("card = small Intercom-style card in the corner (bottom sheet on phones); full = Typeform-style full screen, one question at a time."),
  definition: SurveyDefinitionInput,
  trigger: triggerInput.optional().describe("Optional in-app trigger. Without one the survey is shown only via Gleap.showSurvey, the survey page, links or emails."),
  audience: audienceInput.optional().describe("Optional audience for the in-app trigger."),
});

export const UpdateSurveyArgs = z.object({
  surveyId,
  definition: SurveyDefinitionInput.describe(
    `The COMPLETE new draft definition (replaces the draft; read it first with get_survey and send it back changed). Keep ids and keys of existing questions so results stay comparable.`,
  ),
  format: z.enum(SURVEY_FORMATS).optional().describe("Change the format (default: keep the draft's)."),
  name: z.string().trim().min(1).max(200).optional().describe("Rename the survey (only while it is not live)."),
});

export const ValidateSurveyArgs = z.object({
  surveyId,
  definition: SurveyDefinitionInput.optional().describe("Definition to check without saving. Omit to check the stored draft."),
});

export const SurveyIdArgs = z.object({ surveyId });

export const PublishSurveyArgs = z.object({
  surveyId,
  goLive: z.boolean().optional().describe("Also start showing it in the app (the Share → In the app switch) to the audience set with configure_outbound_targeting. Omit to only publish the new version: the survey page, emails and an already-live in-app survey then serve it."),
});

export const GetSurveyResultsArgs = z.object({
  surveyId,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start day YYYY-MM-DD (default: all time)."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End day YYYY-MM-DD, inclusive."),
  version: z.number().int().min(1).optional().describe("Only this published version (default: all versions)."),
  includeDaily: z.boolean().optional().describe("Also return the per-day series (max 92 days). Default false."),
});

export const SURVEY_ANALYTICS_CHANNELS = ["web", "ios", "android", "page", "email", "embed"] as const;
export const SURVEY_ANALYTICS_DEVICES = ["phone", "tablet", "desktop"] as const;

export const GetSurveyAnalyticsArgs = z.object({
  surveyId,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start day YYYY-MM-DD, UTC (default: 30 days before `to`; at most 400 days)."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End day YYYY-MM-DD, UTC, inclusive (default: today)."),
  version: z.number().int().min(1).optional().describe("Only this published version (default: all versions)."),
  channel: z.enum(SURVEY_ANALYTICS_CHANNELS).optional().describe("Only views from this channel."),
  device: z.enum(SURVEY_ANALYTICS_DEVICES).optional().describe("Only views on this device class."),
  interval: z.enum(["day", "week"]).optional().describe("Bucket size of the time series (default day)."),
  tz: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).max(64).optional().describe("IANA time zone for the busiest day/hour slots (default UTC)."),
});

export const AskSurveyResultsArgs = z.object({
  surveyId,
  question: z.string().trim().min(3).max(500).describe("Plain-language question, e.g. \"Why did detractors leave this week?\""),
});

export const GetSurveyResponsesArgs = z.object({
  surveyId,
  status: z.enum(["completed", "partial", "in_progress"]).optional().describe("completed = reached an ending; partial = stopped answering for 30+ minutes."),
  answers: z.record(z.string().regex(KEY_PATTERN), z.union([z.string().max(200), z.number(), z.boolean()])).optional().describe(
    "Filter by answer, keyed by block key: exact value (choice id, number, true/false) or a numeric range \"min..max\", e.g. { \"nps_score\": \"0..6\" } for detractors.",
  ),
  theme: z.string().max(80).optional().describe("Only responses tagged with this AI theme id (from get_survey_insights)."),
  channel: z.enum(["web", "ios", "android", "page", "email", "embed", "conversation", "api"]).optional(),
  contactUserId: z.string().max(200).optional().describe("Only this contact's responses (their userId)."),
  q: z.string().trim().min(2).max(200).optional().describe("Text search in text answers and the respondent's name or email (where response search is set up)."),
  limit: limit(50, 20),
  cursor: z.string().max(200).optional().describe("nextCursor from the previous page."),
  skip: z.number().int().min(0).optional().describe("Legacy (pre-2.0) surveys only: responses to skip."),
});

export const GetSurveyResponseArgs = z.object({ surveyId, responseId });

export const SearchSurveyResponsesArgs = z.object({
  query: z.string().trim().min(2).max(100).describe("Words to find in the respondents' answers (free text and picked choices), e.g. \"pricing too high\", or a respondent's name or email. Typos and word forms are tolerated."),
  surveyId: surveyId.optional().describe("Only this survey (`id` from list_surveys). Omit to search every survey of the project."),
  status: z.enum(["completed", "partial", "in_progress"]).optional().describe("completed = reached an ending; partial = stopped answering for 30+ minutes."),
  limit: limit(50, 10),
});

export const ReachOutArgs = z.object({
  surveyId,
  responseId,
  message: z.string().trim().min(1).max(5000).describe("The message to the respondent (plain text / Markdown). Write it in the respondent's language."),
  channel: z.enum(["messenger", "email"]).optional().describe("messenger (default) = in-app conversation; email = email conversation."),
  subject: z.string().trim().min(1).max(200).optional().describe("Email subject (email channel)."),
  assignToMe: z.boolean().optional().describe("Assign the new conversation to the authenticated user. Default false."),
  send: z.boolean().optional().describe(
    "Default false: nothing is sent; returns the draft for the operator to approve. true sends it now — only after the operator explicitly approved this exact message.",
  ),
});

export const GetSurveySummaryArgs = z.object({
  surveyId: z.string().describe("The ID of the survey to get an AI-generated summary for"),
});
