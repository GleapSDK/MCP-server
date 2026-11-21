import { z } from "zod";
import { OUTBOUND_TYPE_KEYS, PAGE_MATCHES } from "../utils/outboundRules.js";

export const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);

export const outboundType = z.enum(OUTBOUND_TYPE_KEYS).describe(
  "survey, chat_message (in-app chat message), banner, modal (info card), checklist, product_tour, tooltip, news, email, push, whatsapp.",
);
export const outboundId = objectId.describe("The item's Gleap ID.");

const eventName = z.string().trim().min(1).max(200);
const value = z.union([z.string(), z.number(), z.boolean()]);

const countCondition = z.object({
  event: eventName,
  type: z.literal("count"),
  matchOperator: z.enum(["is", "isnot", "greaterthan", "lessthan"]),
  data: z.number().int().min(0),
}).strict();
const latestDataCondition = z.object({
  event: eventName,
  type: z.literal("latestdata"),
  dataKey: z.string().trim().min(1).optional(),
  matchOperator: z.enum(["is", "isnot", "contains", "notcontains", "startswith", "endswith", "greaterthan", "lessthan", "empty", "notempty", "in", "notin"]),
  data: value.optional(),
}).strict();
const occurredCondition = z.object({
  event: eventName,
  type: z.enum(["firstoccured", "lastoccured"]),
  dateOperator: z.enum(["relative", "absolute"]),
  matchOperator: z.enum(["greaterthan", "lessthan", "exactly", "on", "before", "after"]),
  data: z.union([z.number().int().min(0), z.string()]),
}).strict();
export const condition = z.union([countCondition, latestDataCondition, occurredCondition]);
const conditionGroup = z.object({
  logicalOperator: z.enum(["AND", "OR"]),
  conditions: z.array(condition).min(1).max(20),
}).strict();

export const audience = z.object({
  targetAudience: z.enum(["all", "users", "guests"]).optional().describe("users = identified contacts, guests = anonymous visitors/leads."),
  logicalOperator: z.enum(["AND", "OR"]).optional().describe("How the rules combine. Default AND."),
  conditions: z.array(z.union([condition, conditionGroup])).max(20).optional().describe(
    "Replaces all audience rules; [] clears them. A rule may be a group {logicalOperator, conditions} (one level; triggered items only). " +
    "Syntax and the project's event/attribute names: get_targeting_options. Examples: never did X {event:'checkout_completed', type:'count', matchOperator:'is', data:0}; " +
    "plan {event:'gleap-up-plan', type:'latestdata', matchOperator:'is', data:'pro'}; custom data {event:'gleap-up-customData.role', type:'latestdata', matchOperator:'is', data:'admin'}; " +
    "signed up >7 days ago {event:'gleap-up-createdAt', type:'firstoccured', dateOperator:'relative', matchOperator:'greaterthan', data:604800}; tag {event:'tags', type:'latestdata', matchOperator:'in', data:'beta'}.",
  ),
}).strict();

export const ListOutboundArgs = z.object({
  type: outboundType,
  status: z.enum(["draft", "live"]).optional().describe("draft also covers paused items."),
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const OutboundRefArgs = z.object({ type: outboundType, id: outboundId }).strict();

export const GetOutboundArgs = OutboundRefArgs.extend({
  includeStats: z.boolean().default(false).describe("Add delivery statistics (sent, opened, clicked, responses)."),
}).strict();

export const ConfigureTargetingArgs = z.object({
  type: outboundType,
  id: outboundId,
  delivery: z.enum(["triggered", "one_off"]).optional().describe(
    "triggered = shown/sent per person when the trigger fires (default). one_off = sent once to everyone in the audience at publish (email, push, WhatsApp, chat message, survey, banner, info card only).",
  ),
  trigger: z.object({
    event: eventName.describe('"sessionStarted" (person opens the app/site: audience-only targeting), "pageView" (with pages.rules) or a tracked event, e.g. "trial_started".'),
    type: z.enum(["firstoccured", "lastoccured"]).optional().describe("Measure the delay from the event's first or last occurrence. Default: firstoccured for once, lastoccured otherwise."),
    delaySeconds: z.number().int().min(0).max(365 * 86400).describe("Show/send this long after the event; 0 = right away. E.g. 604800 with sessionStarted = one week after the first visit."),
  }).strict().optional(),
  frequency: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("once") }).strict(),
    z.object({ mode: z.literal("every_time") }).strict(),
    z.object({ mode: z.literal("every_n_days"), days: z.number().int().min(1).max(365) }).strict(),
  ]).optional().describe("once per person, every time the trigger fires, or at most once every N days."),
  pages: z.object({
    rules: z.array(z.object({
      match: z.enum(PAGE_MATCHES).describe("is/contains/startswith/endswith = show on; isnot/notcontains = never on."),
      value: z.string().max(500).describe('URL or part of it, e.g. "/pricing".'),
    }).strict()).max(20).optional().describe("Replaces the page rules (in-app types with trigger pageView; tooltips need no trigger). Show-on rules are OR'd, never-on rules AND'd. [] clears."),
    showAfterSeconds: z.number().int().min(0).max(3600).optional().describe("Seconds on the page before an in-app item shows."),
  }).strict().optional(),
  audience: audience.optional(),
  schedule: z.object({
    startSendingAfter: z.string().nullable().optional().describe("ISO date; nothing goes out before it. null clears."),
    stopSendingAfter: z.string().nullable().optional().describe("ISO date; stops showing/sending after it. null clears."),
  }).strict().optional(),
}).strict();

export const PreviewAudienceArgs = z.object({
  type: outboundType,
  id: outboundId,
  audience: audience.optional().describe("Preview these rules instead of the stored ones (nothing is saved)."),
}).strict();

export const PublishOutboundArgs = z.object({
  type: outboundType,
  id: outboundId,
  confirmedReach: z.number().int().min(0).optional().describe(
    "Required for sends that go to the whole audience at once (one-offs, news with push): the recipient count from preview_outbound_audience that the operator approved. Refused if the audience grew beyond it.",
  ),
}).strict();

// -------- Content --------

const localizedText = z.record(z.string(), z.string().trim().min(1))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale")
  .describe('Per locale, e.g. { "en": "Welcome" }.');
const tiptapDoc = z.object({ type: z.literal("doc"), content: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const localizedRich = z.record(z.string(), z.union([z.string().min(1), tiptapDoc]))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one locale")
  .describe('Per locale: plain text (blank line = new paragraph; {{name}} etc. variables allowed) or a TipTap doc, e.g. { "en": "Hi {{name}}, ..." }.');
const sender = objectId.describe("User ID of the teammate shown as the sender (get_users). Required for chat messages and banners to render.");

const action = z.object({
  action: z.enum(["none", "url", "bot", "survey", "news", "checklist", "product_tour", "custom"]).describe(
    "What the button does. url opens url; bot starts a workflow; survey (banners only) opens a survey; news opens a news item; checklist / product_tour start one; custom runs an action your code registered.",
  ),
  label: localizedText.optional().describe("Button text."),
  url: z.string().url().optional(),
  openInNewTab: z.boolean().optional().describe("Default true."),
  targetId: z.string().trim().min(1).optional().describe("ID of the workflow, survey, news item, checklist or product tour to open."),
  surveyFormat: z.enum(["survey", "survey_full"]).optional(),
  customAction: z.string().trim().min(1).optional(),
}).strict();

const question = z.object({
  type: z.enum(["nps", "rating", "scale", "single_choice", "multi_choice", "short_text", "long_text"]).describe(
    "nps = 0-10 Net Promoter Score; rating = emoji rating; scale = number scale (from/to); single_choice / multi_choice need choices; short_text / long_text = free text.",
  ),
  title: localizedText,
  description: localizedText.optional(),
  required: z.boolean().optional().describe("Default true, except long_text."),
  choices: z.array(localizedText).max(20).optional(),
  lowLabel: localizedText.optional().describe("nps/scale: label of the lowest value."),
  highLabel: localizedText.optional().describe("nps/scale: label of the highest value."),
  from: z.number().int().min(0).max(10).optional(),
  to: z.number().int().min(1).max(10).optional(),
  placeholder: localizedText.optional(),
}).strict();

export const surveyContent = z.object({
  questions: z.array(question).min(1).max(30).optional().describe("Replaces all questions."),
  format: z.enum(["popup", "full"]).optional().describe("popup = small survey in the corner (default); full = large centered survey."),
  introTitle: localizedText.optional().describe("Shown in the full format only."),
  introMessage: localizedText.optional(),
  thanksMessage: localizedText.optional(),
  singlePage: z.boolean().optional().describe("All questions on one page."),
}).strict();

export const chatMessageContent = z.object({
  message: localizedRich.optional(),
  sender: sender.optional(),
  opens: z.enum(["conversation", "notification"]).optional().describe("conversation (default) = the message lands in a chat the person can reply to; notification = only a short bubble that opens the messenger."),
  botId: z.string().trim().min(1).optional().describe("Start this workflow when the person opens the message (conversation mode)."),
  sound: z.boolean().optional(),
}).strict();

export const bannerContent = z.object({
  message: localizedRich.optional(),
  sender: sender.optional(),
  style: z.enum(["inline", "floating"]).optional().describe("inline = full-width bar at the top (default); floating = card over the page."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Background hex color."),
  textAlign: z.enum(["left", "center"]).optional(),
  canClose: z.boolean().optional(),
  showSender: z.boolean().optional(),
  button: action.optional(),
}).strict();

export const modalContent = z.object({
  steps: z.array(z.object({
    title: localizedText,
    description: localizedRich.optional(),
    mediaUrl: z.string().url().optional().describe("Image or video URL (upload_image gives a hosted one)."),
    mediaType: z.enum(["image", "video"]).optional(),
    button: action.optional(),
  }).strict()).min(1).max(10).optional().describe("Replaces all cards."),
  showCloseButton: z.boolean().optional(),
  nextButtonText: localizedText.optional(),
  doneButtonText: localizedText.optional(),
}).strict();

export const checklistContent = z.object({
  title: localizedText.optional(),
  description: localizedText.optional(),
  steps: z.array(z.object({
    title: localizedText,
    description: localizedRich.optional(),
    durationMinutes: z.number().int().min(1).max(600).optional(),
    allowMarkDone: z.boolean().optional().describe("Let people tick it off themselves. Default true unless completeOnEvent is set."),
    completeOnEvent: z.string().trim().min(1).optional().describe("Tracked event that completes the step automatically, e.g. \"teammate_invited\" (see get_targeting_options)."),
    button: action.optional(),
  }).strict()).min(1).max(20).optional().describe("Replaces all steps."),
  successTitle: localizedText.optional(),
  successMessage: localizedText.optional(),
  confetti: z.boolean().optional(),
  display: z.enum(["popup", "widget"]).optional(),
}).strict();

export const pushContent = z.object({
  title: localizedText.optional(),
  message: localizedRich.optional().describe("Sent as plain text."),
}).strict();

export const productTourContent = z.object({
  steps: z.array(z.object({
    kind: z.enum(["post", "pointer"]).describe("post = centered card; pointer = points at the element matching selector."),
    selector: z.string().trim().min(1).optional().describe("CSS selector of the element (pointer). Use stable ones (#id, [data-testid=...]); check them in the tour builder."),
    message: localizedRich,
    advance: z.enum(["BUTTON", "CLICK", "INTERACTION"]).optional().describe("pointer: Next button (default), click on the element, or any interaction."),
    url: z.string().optional().describe("Page the step's element is on."),
  }).strict()).min(1).max(30).optional().describe("Replaces all steps. Tours run in the JavaScript SDK only."),
  startUrl: z.string().optional().describe("Page the tour starts on."),
  allowClose: z.boolean().optional(),
  backButton: z.boolean().optional(),
}).strict();

export const tooltipContent = z.object({
  tooltips: z.array(z.object({
    selector: z.string().trim().min(1).describe("CSS selector of the element the tooltip belongs to."),
    message: localizedRich,
    mode: z.enum(["hotspot", "element"]).optional().describe("hotspot = small icon next to the element (default); element = shows on hovering the element."),
    icon: z.enum(["circle-dot", "circle-question", "circle-info", "circle-exclamation", "circle-up", "circle-right"]).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    posX: z.enum(["left", "right"]).optional(),
    posY: z.enum(["top", "center", "bottom"]).optional(),
  }).strict()).min(1).max(30).optional().describe("Replaces all tooltips. Limit their pages with configure_outbound_targeting pages."),
}).strict();

const contentBlocks = {
  survey: surveyContent.optional(),
  chatMessage: chatMessageContent.optional(),
  banner: bannerContent.optional(),
  modal: modalContent.optional(),
  checklist: checklistContent.optional(),
  push: pushContent.optional(),
  productTour: productTourContent.optional(),
  tooltip: tooltipContent.optional(),
};

export const CONTENT_BLOCK_OF: Record<string, keyof typeof contentBlocks> = {
  survey: "survey", chat_message: "chatMessage", banner: "banner", modal: "modal", checklist: "checklist",
  push: "push", product_tour: "productTour", tooltip: "tooltip",
};

export const CreateOutboundDraftArgs = z.object({
  type: z.enum(["survey", "chat_message", "banner", "modal", "checklist", "push", "product_tour", "tooltip"]).describe(
    "Emails and news have their own tools (create_newsletter_draft, create_news_draft).",
  ),
  name: z.string().trim().min(1).max(200).describe("Internal name."),
  ...contentBlocks,
}).strict();

export const UpdateOutboundContentArgs = z.object({
  type: z.enum(["survey", "chat_message", "banner", "modal", "checklist", "push", "product_tour", "tooltip"]),
  id: outboundId,
  name: z.string().trim().min(1).max(200).optional(),
  ...contentBlocks,
}).strict();
