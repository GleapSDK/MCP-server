import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONTENT_BLOCK_OF, CreateOutboundDraftArgs, UpdateOutboundContentArgs } from "../schemas/outbound.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGetData, gleapPost, gleapPut, validationErrorResponse, wrapResponse } from "../utils/api.js";
import {
  ActionInput, actionFields, actionProblem, checklistStep, localized, modalStep, questionProblem, richText,
  tooltipStep, tourStep, formItem,
} from "../utils/outboundContent.js";
import { OUTBOUND_TYPES, OutboundTypeInfo, targetingView } from "../utils/outboundRules.js";
import { loadOutbound, loadSurveyForm, reviewUrl } from "./outbound.tool.js";

type Doc = Record<string, any>;
type CreateArgs = z.infer<typeof CreateOutboundDraftArgs>;
type Blocks = Omit<CreateArgs, "type" | "name">;

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });
const apiFailed = (response: GleapApiResponse) => response.isError || response.structuredContent?.error === true;
const isObjectId = (value: string) => /^[a-fA-F0-9]{24}$/.test(value);

/** What the dashboard's "New <type>" writes, minus the trigger: targeting is a separate, explicit step. */
const baseDocument = (type: string, name: string): Doc => {
  const common = { name, status: "draft", trigger: null, frequencyType: "dynamic", frequency: "once", frequencyDays: 0, pageFilterDelay: 0 };
  switch (type) {
    case "chat_message": return { ...common, type: "MESSAGE", actionType: "message", sound: true };
    case "banner": return {
      ...common, type: "BANNER", actionType: "banner", sound: false, format: "inline", frequency: "continuously",
      config: { bannerColor: "#0066A8", showSender: true, canClose: true },
    };
    case "modal": return {
      ...common, type: "MODAL", actionType: "modal", sound: false,
      config: { steps: [], showCloseButton: true, nextButtonText: localized({ en: "Next" }), doneButtonText: localized({ en: "Done" }) },
    };
    case "checklist": return {
      ...common, type: "CHECKLIST", actionType: "notification", sound: true, format: "personal",
      config: { successTitle: localized({ en: "Success! 🎉" }), successMessage: localized({ en: "You completed the checklist!" }), confetti: true, steps: [] },
    };
    case "push": return { ...common, type: "PUSH", actionType: "notification", sound: true };
    case "product_tour": return {
      ...common, type: "TOUR", actionType: "tours", sound: false,
      config: { steps: [], type: "tour", playVoice: true, showUnmuteModal: true, voice: "nova" },
    };
    case "tooltip": return { ...common, type: "TOOLTIP", actionType: "tooltip", sound: false, config: { steps: [] } };
    case "survey": return { ...common, type: "SURVEY", format: "survey", data: { backgroundColor: "#444444", linkColor: "#00000099" } };
    default: throw new Error(`No draft defaults for ${type}`);
  }
};

const buttonsOf = (blocks: Blocks): { where: string; button?: ActionInput; allowSurvey: boolean }[] => [
  { where: "banner.button", button: blocks.banner?.button, allowSurvey: true },
  ...(blocks.modal?.steps ?? []).map((step, i) => ({ where: `modal.steps[${i}].button`, button: step.button, allowSurvey: false })),
  ...(blocks.checklist?.steps ?? []).map((step, i) => ({ where: `checklist.steps[${i}].button`, button: step.button, allowSurvey: false })),
];

/** Why these content blocks cannot be written for `type`, or null. */
const contentProblem = (type: string, blocks: Blocks): string | null => {
  const own = CONTENT_BLOCK_OF[type];
  const other = Object.keys(CONTENT_BLOCK_OF).map((key) => CONTENT_BLOCK_OF[key]).find((block) => block !== own && (blocks as Doc)[block] !== undefined);
  if (other) return `${other} content does not belong to a ${type}. Put the content in "${own}".`;
  for (const { where, button, allowSurvey } of buttonsOf(blocks)) {
    const problem = actionProblem(button, where, allowSurvey);
    if (problem) return problem;
  }
  for (const [index, question] of (blocks.survey?.questions ?? []).entries()) {
    const problem = questionProblem(question, index);
    if (problem) return problem;
  }
  const pointer = (blocks.productTour?.steps ?? []).findIndex((step) => step.kind === "pointer" && !step.selector);
  if (pointer >= 0) return `productTour.steps[${pointer}]: a pointer step needs selector.`;
  return null;
};

/** A banner's survey button stores the survey's actionId; accept the survey's own ID too. */
async function resolveSurveyTarget(button: ActionInput | undefined): Promise<ActionInput | undefined | { error: GleapApiResponse }> {
  if (button?.action !== "survey" || !button.targetId || !isObjectId(button.targetId)) return button;
  const survey = await loadOutbound(OUTBOUND_TYPES.survey, button.targetId);
  if ("error" in survey) return { error: survey.error };
  return { ...button, targetId: survey.doc.actionType };
}

/** The outbound fields these blocks change, merged over the stored config. */
const outboundChanges = (blocks: Blocks, current: Doc): Doc => {
  const config = { ...(current.config ?? {}) };
  const changes: Doc = {};
  const setConfig = (fields: Doc) => {
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) config[key] = value;
    changes.config = config;
  };

  if (blocks.chatMessage) {
    const c = blocks.chatMessage;
    if (c.message) changes.message = richText(c.message);
    if (c.sender) changes.sender = c.sender;
    if (c.opens) changes.actionType = c.opens === "notification" ? "notification" : "message";
    if (c.sound !== undefined) changes.sound = c.sound;
    if (c.botId) setConfig({ botId: c.botId });
  }
  if (blocks.banner) {
    const b = blocks.banner;
    if (b.message) changes.message = richText(b.message);
    if (b.sender) changes.sender = b.sender;
    if (b.style) changes.format = b.style;
    setConfig({ bannerColor: b.color, textAlign: b.textAlign, canClose: b.canClose, showSender: b.showSender, ...(b.button ? actionFields(b.button, "banner") : {}) });
  }
  if (blocks.modal) {
    const m = blocks.modal;
    setConfig({
      steps: m.steps?.map(modalStep), showCloseButton: m.showCloseButton,
      nextButtonText: m.nextButtonText ? localized(m.nextButtonText) : undefined,
      doneButtonText: m.doneButtonText ? localized(m.doneButtonText) : undefined,
    });
  }
  if (blocks.checklist) {
    const c = blocks.checklist;
    if (c.title) changes.subject = localized(c.title);
    if (c.description) changes.message = localized(c.description);
    setConfig({
      steps: c.steps?.map(checklistStep),
      successTitle: c.successTitle ? localized(c.successTitle) : undefined,
      successMessage: c.successMessage ? localized(c.successMessage) : undefined,
      confetti: c.confetti, popupType: c.display,
    });
  }
  if (blocks.push) {
    if (blocks.push.title) changes.subject = localized(blocks.push.title);
    if (blocks.push.message) changes.message = richText(blocks.push.message);
  }
  if (blocks.productTour) {
    const t = blocks.productTour;
    setConfig({ steps: t.steps?.map(tourStep), initialURL: t.startUrl, allowClose: t.allowClose, backButton: t.backButton });
    if (t.startUrl) changes.startURL = t.startUrl;
  }
  if (blocks.tooltip?.tooltips) setConfig({ steps: blocks.tooltip.tooltips.map(tooltipStep) });
  if (blocks.survey?.format) changes.format = blocks.survey.format === "full" ? "survey_full" : "survey";
  return changes;
};

/** The project action fields a survey block changes (questions and texts). */
const surveyFormChanges = (survey: NonNullable<Blocks["survey"]>): Doc => {
  const changes: Doc = {};
  if (survey.questions) changes.form = survey.questions.map(formItem);
  if (survey.introTitle) changes.introTitle = localized(survey.introTitle);
  if (survey.introMessage) changes.introMessage = localized(survey.introMessage);
  if (survey.thanksMessage) changes.thanksMessage = localized(survey.thanksMessage);
  if (survey.singlePage !== undefined) changes.singlePageForm = survey.singlePage;
  return changes;
};

/** Resolves banner survey buttons in place; returns the failed result, if any. */
async function resolveButtons(blocks: Blocks): Promise<GleapApiResponse | null> {
  if (!blocks.banner?.button) return null;
  const resolved = await resolveSurveyTarget(blocks.banner.button);
  if (resolved && "error" in resolved) return resolved.error as GleapApiResponse;
  blocks.banner.button = resolved as ActionInput | undefined;
  return null;
}

const result = async (info: OutboundTypeInfo, doc: Doc, nextStep: string) => {
  const survey = info.type === "SURVEY" ? await loadSurveyForm(doc) : {};
  return wrapResponse({
    id: String(doc.id ?? doc._id),
    type: Object.keys(OUTBOUND_TYPES).find((key) => OUTBOUND_TYPES[key] === info),
    name: doc.name ?? null,
    status: doc.status ?? null,
    content: {
      subject: doc.subject ?? null, message: doc.message ?? null, format: doc.format ?? null, config: doc.config ?? null,
      sender: doc.sender?._id ?? doc.sender ?? null,
      ...(survey.action ? { questions: survey.action.form ?? [] } : {}),
    },
    targeting: targetingView(doc),
    reviewUrl: reviewUrl(info, String(doc.id ?? doc._id)),
    nextStep,
  });
};

export function registerOutboundContentTools(server: McpServer) {
  server.registerTool("create_outbound_draft", {
    title: "Create Outbound Draft",
    description:
      "Create an unpublished chat message, banner, info card (modal), checklist, push notification, product tour or tooltip set, with its content, in the shape the dashboard editor writes. " +
      "Put the content in the block named after the type (survey, chatMessage, banner, modal, checklist, push, productTour, tooltip). Text fields take plain text per locale. " +
      "Nothing is shown to anyone: set who and when with configure_outbound_targeting, then publish_outbound after the operator approves. Returns reviewUrl. Surveys use create_survey / update_survey instead.",
    inputSchema: CreateOutboundDraftArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = CreateOutboundDraftArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, name, ...blocks } = parsed.data;
    if (type === "survey") return fail("Surveys are built with the Surveys 2.0 tools: create_survey / update_survey (questions, logic, endings, design), then configure_outbound_targeting, then publish_survey once the operator agreed.");
    const info = OUTBOUND_TYPES[type];
    const problem = contentProblem(type, blocks);
    if (problem) return fail(problem);
    const buttonError = await resolveButtons(blocks);
    if (buttonError) return buttonError;

    const base = baseDocument(type, name);
    const body = { ...base, ...outboundChanges(blocks, base) };

    const saved = await gleapPost(info.path, body);
    if (apiFailed(saved)) return { ...saved, isError: true };
    const doc = saved.structuredContent as Doc;
    if (!doc || doc.type !== info.type || doc.status === "live") {
      return { ...saved, isError: true, content: [...saved.content, { type: "text", text: "Could not verify the saved draft. Inspect it in Gleap before retrying." }] };
    }
    return result(info, doc, "Draft saved; nothing is shown yet. Set the audience with configure_outbound_targeting (names from get_targeting_options), check reach with preview_outbound_audience, then ask the operator to review it at reviewUrl before publish_outbound.");
  });

  server.registerTool("update_outbound_content", {
    title: "Update Outbound Content",
    description:
      "Change the content of a non-live chat message, banner, info card (modal), checklist, push notification, product tour or tooltip set. Fields you send replace the stored ones (steps, questions and tooltips as a whole list); others stay. " +
      "Refuses live items (pause_outbound first). Targeting is changed with configure_outbound_targeting.",
    inputSchema: UpdateOutboundContentArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = UpdateOutboundContentArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { type, id, name, ...blocks } = parsed.data;
    if (type === "survey") return fail("Surveys are built with the Surveys 2.0 tools: create_survey / update_survey (questions, logic, endings, design), then configure_outbound_targeting, then publish_survey once the operator agreed.");
    const info = OUTBOUND_TYPES[type];
    const problem = contentProblem(type, blocks);
    if (problem) return fail(problem);
    if (name === undefined && Object.values(blocks).every((block) => block === undefined)) return fail("Provide name or content to change.");
    const loaded = await loadOutbound(info, id);
    if ("error" in loaded) return loaded.error;
    if (loaded.doc.status === "live") return fail(`This ${info.label} is live. Pause it with pause_outbound before changing its content.`);
    const buttonError = await resolveButtons(blocks);
    if (buttonError) return buttonError;

    if (blocks.survey) {
      const formChanges = surveyFormChanges(blocks.survey);
      if (Object.keys(formChanges).length > 0) {
        const form = await loadSurveyForm(loaded.doc);
        if (form.error) return form.error;
        const actionId = form.action?._id ?? form.action?.id;
        if (!actionId) return fail("This survey's form was not found. Open it in the dashboard.");
        const savedForm = await gleapPut(`/project-actions/${actionId}`, formChanges);
        if (apiFailed(savedForm)) return { ...savedForm, isError: true };
      }
    }

    const changes = { ...outboundChanges(blocks, loaded.doc), ...(name ? { name } : {}) };
    let doc = loaded.doc;
    if (Object.keys(changes).length > 0) {
      const saved = await gleapPut(`${info.path}/${id}`, changes);
      if (apiFailed(saved)) return { ...saved, isError: true };
      doc = saved.structuredContent as Doc;
      if (!doc || doc.type !== info.type || doc.status === "live") {
        return { ...saved, isError: true, content: [...saved.content, { type: "text", text: "Could not verify the saved item. Read it with get_outbound_message before retrying." }] };
      }
    }
    return result(info, doc, "Not published. Review at reviewUrl; publish_outbound after the operator approves.");
  });
}
