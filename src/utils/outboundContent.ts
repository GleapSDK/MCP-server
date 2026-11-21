/**
 * Builds the stored content of in-app outbound items exactly as the
 * dashboard editors write it, from agent-friendly input. Pure: no I/O.
 *
 * Shapes (Frontend ProjectOutboundTemplates + the per-type editors; rendered
 * by BannerApp, Messenger-App and the JS SDK):
 *  - "localized" = { localized: { <lang>: value } };
 *  - rich text (banner message, chat message, push body, modal/checklist step
 *    descriptions, tour and tooltip messages) is a TipTap doc per locale;
 *    BannerApp runs generateHTML on banners, so plain strings do not render;
 *  - titles, button labels, checklist title/description and push title are
 *    plain localized strings;
 *  - tooltips also need `html` per locale: the Server sends html, not message;
 *  - survey questions live in a project action (`form`), not the outbound.
 */

type Doc = Record<string, any>;
export type LocalizedText = Record<string, string>;
export type LocalizedRich = Record<string, string | Doc>;

const randomId = (length: number) => {
  let id = "";
  while (id.length < length) id += Math.random().toString(36).slice(2);
  return id.slice(0, length);
};

export const localized = <T>(value: Record<string, T>) => ({ localized: value });

/** Plain text → TipTap doc: blank lines split paragraphs, single newlines become hard breaks. */
export const textToDoc = (text: string): Doc => ({
  type: "doc",
  content: text.split(/\n{2,}/).map((paragraph) => {
    const lines = paragraph.split("\n");
    const content = lines.flatMap((line, index) => [
      ...(index > 0 ? [{ type: "hardBreak" }] : []),
      ...(line.length > 0 ? [{ type: "text", text: line }] : []),
    ]);
    return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
  }),
});

const isDoc = (value: unknown): value is Doc =>
  !!value && typeof value === "object" && (value as Doc).type === "doc" && Array.isArray((value as Doc).content);

/** Localized rich text: each locale is plain text (converted) or a TipTap doc. */
export const richText = (value: LocalizedRich) =>
  localized(Object.fromEntries(Object.entries(value).map(([lang, text]) => [lang, isDoc(text) ? text : textToDoc(String(text))])));

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const nodeHtml = (node: Doc): string => {
  if (node.type === "text") {
    let html = escapeHtml(String(node.text ?? ""));
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") html = `<strong>${html}</strong>`;
      if (mark.type === "italic") html = `<em>${html}</em>`;
      if (mark.type === "link" && typeof mark.attrs?.href === "string") html = `<a href="${escapeHtml(mark.attrs.href)}" target="_blank">${html}</a>`;
    }
    return html;
  }
  if (node.type === "hardBreak") return "<br>";
  const inner = (node.content ?? []).map(nodeHtml).join("");
  if (node.type === "paragraph") return `<p>${inner}</p>`;
  if (node.type === "bulletList") return `<ul>${inner}</ul>`;
  if (node.type === "orderedList") return `<ol>${inner}</ol>`;
  if (node.type === "listItem") return `<li>${inner}</li>`;
  if (node.type === "heading") return `<h${node.attrs?.level ?? 3}>${inner}</h${node.attrs?.level ?? 3}>`;
  return inner;
};

/** The `html` the tooltip builder derives from a step's message, per locale. */
export const docToHtml = (doc: Doc): string => (doc.content ?? []).map(nodeHtml).join("");

// -------- Buttons / actions (banner, modal step, checklist step) --------

export interface ActionInput {
  action: "none" | "url" | "bot" | "survey" | "news" | "checklist" | "product_tour" | "custom";
  label?: LocalizedText;
  url?: string;
  openInNewTab?: boolean;
  /** Workflow (bot) ID, news ID, checklist ID, product tour ID or survey ID. */
  targetId?: string;
  surveyFormat?: "survey" | "survey_full";
  customAction?: string;
}

const ACTION_TYPES: Record<ActionInput["action"], string> = {
  none: "none", url: "REDIRECT_URL", bot: "BOT", survey: "SURVEY", news: "NEWS_ARTICLE",
  checklist: "CHECKLIST", product_tour: "PRODUCT_TOUR", custom: "CUSTOM_ACTION",
};

/** Why this action cannot be stored for `where`, or null. */
export const actionProblem = (input: ActionInput | undefined, where: string, allowSurvey: boolean): string | null => {
  if (!input || input.action === "none") return null;
  if (input.action === "survey" && !allowSurvey) return `${where}: a survey action is only available on banners.`;
  if (input.action === "url" && !input.url) return `${where}: action url needs url.`;
  if (input.action === "custom" && !input.customAction) return `${where}: action custom needs customAction (the name your code handles).`;
  if (["bot", "survey", "news", "checklist", "product_tour"].includes(input.action) && !input.targetId) {
    return `${where}: action ${input.action} needs targetId.`;
  }
  if (!input.label || Object.values(input.label).every((label) => label.trim() === "")) return `${where}: a button needs label.`;
  return null;
};

/**
 * The action fields on a banner config (`actionType`) or a modal/checklist
 * step (`action`). Opening a checklist stores `checklistId` on banners and
 * modal steps (BannerApp), but `outboundId` on checklist steps (Messenger-App
 * ChecklistDetails and the JS SDK's GleapChecklist read step.outboundId).
 * `targetId` for a survey is its project action's actionId (the survey
 * outbound's `actionType`), resolved by the caller.
 */
export const actionFields = (input: ActionInput | undefined, on: "banner" | "step" | "checklist_step" = "step"): Doc => {
  const key = on === "banner" ? "actionType" : "action";
  if (!input || input.action === "none") return { [key]: "none" };
  const fields: Doc = { [key]: ACTION_TYPES[input.action], actionTitle: localized(input.label ?? {}) };
  if (input.action === "url") Object.assign(fields, { actionBody: input.url, actionOpenInNewTab: input.openInNewTab ?? true });
  if (input.action === "custom") fields.actionBody = input.customAction;
  if (input.action === "bot") fields.botId = input.targetId;
  if (input.action === "survey") Object.assign(fields, { formId: input.targetId, surveyFormat: input.surveyFormat ?? "survey" });
  if (input.action === "news") fields.articleId = input.targetId;
  if (input.action === "checklist") fields[on === "checklist_step" ? "outboundId" : "checklistId"] = input.targetId;
  if (input.action === "product_tour") fields.productTourId = input.targetId;
  if (input.action === "url" || input.action === "custom") fields.closeWidgetAfterAction = true;
  return fields;
};

// -------- Survey questions --------

export interface QuestionInput {
  type: "nps" | "rating" | "scale" | "single_choice" | "multi_choice" | "short_text" | "long_text";
  title: LocalizedText;
  description?: LocalizedText;
  required?: boolean;
  choices?: LocalizedText[];
  lowLabel?: LocalizedText;
  highLabel?: LocalizedText;
  from?: number;
  to?: number;
  placeholder?: LocalizedText;
}

const QUESTION_TYPES: Record<QuestionInput["type"], string> = {
  nps: "netpromoterscore", rating: "rating", scale: "onetofive", single_choice: "multiplechoice",
  multi_choice: "multiple-choice-multi-select", short_text: "text", long_text: "textarea",
};

export const questionProblem = (question: QuestionInput, index: number): string | null => {
  const choice = question.type === "single_choice" || question.type === "multi_choice";
  if (choice && (question.choices?.length ?? 0) < 2) return `questions[${index}]: ${question.type} needs at least 2 choices.`;
  if (!choice && question.choices) return `questions[${index}]: choices only apply to single_choice / multi_choice.`;
  if (question.type === "scale" && question.from !== undefined && question.to !== undefined && question.from >= question.to) {
    return `questions[${index}]: from must be lower than to.`;
  }
  return null;
};

/** One `form` item as the survey editor writes it. */
export const formItem = (question: QuestionInput): Doc => {
  const item: Doc = {
    type: QUESTION_TYPES[question.type],
    name: randomId(6),
    title: localized(question.title),
    required: question.required ?? question.type !== "long_text",
  };
  if (question.description) item.description = localized(question.description);
  if (question.lowLabel) item.lowestValueLabel = localized(question.lowLabel);
  if (question.highLabel) item.highestValueLabel = localized(question.highLabel);
  if (question.type === "scale") Object.assign(item, { fromNumber: question.from ?? 1, upToNumber: question.to ?? 5 });
  if (question.choices) item.choices = question.choices.map((label) => ({ id: randomId(8), label: localized(label) }));
  if (question.placeholder) item.placeholder = localized(question.placeholder);
  return item;
};

/** The project action a new survey's questions are stored in (dashboard createSurvey). */
export const surveyProjectAction = (args: {
  name: string; questions: QuestionInput[]; introTitle?: LocalizedText; introMessage?: LocalizedText; thanksMessage?: LocalizedText; singlePage?: boolean;
}): Doc => ({
  title: args.name,
  description: {},
  thanksMessage: localized(args.thanksMessage ?? { en: "Thanks for your feedback." }),
  feedbackType: "surveys",
  disableUserScreenshot: true,
  enableUserScreenRecording: false,
  ...(args.introTitle ? { introTitle: localized(args.introTitle) } : {}),
  ...(args.introMessage ? { introMessage: localized(args.introMessage) } : {}),
  ...(args.singlePage !== undefined ? { singlePageForm: args.singlePage } : {}),
  form: args.questions.map(formItem),
  excludeData: { customData: false, metaData: false, consoleLog: true, networkLogs: true, customEventLog: true, screenshot: true, replays: true },
  // The Server's default is true, which would make this the project's default form.
  default: false,
});

// -------- Steps --------

export interface ModalStepInput {
  title: LocalizedText;
  description?: LocalizedRich;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  button?: ActionInput;
}

export const modalStep = (step: ModalStepInput): Doc => ({
  id: randomId(8),
  title: localized(step.title),
  description: step.description ? richText(step.description) : localized({}),
  ...(step.mediaUrl ? { mediaUrl: step.mediaUrl, mediaType: step.mediaType ?? "image" } : {}),
  ...actionFields(step.button),
});

export interface ChecklistStepInput {
  title: LocalizedText;
  description?: LocalizedRich;
  durationMinutes?: number;
  allowMarkDone?: boolean;
  completeOnEvent?: string;
  button?: ActionInput;
}

export const checklistStep = (step: ChecklistStepInput): Doc => ({
  id: randomId(8),
  title: localized(step.title),
  description: step.description ? richText(step.description) : localized({}),
  allowMarkDone: step.allowMarkDone ?? !step.completeOnEvent,
  duration: step.durationMinutes ?? 2,
  ...(step.completeOnEvent ? { automaticallyResolve: true, trigger: step.completeOnEvent } : {}),
  ...actionFields(step.button, "checklist_step"),
  closeWidgetAfterAction: step.button?.action === "product_tour",
});

export interface TourStepInput {
  kind: "post" | "pointer";
  selector?: string;
  message: LocalizedRich;
  advance?: "BUTTON" | "CLICK" | "INTERACTION";
  url?: string;
}

export const tourStep = (step: TourStepInput): Doc => ({
  type: step.kind,
  selector: step.kind === "post" ? "" : step.selector ?? "",
  message: richText(step.message),
  ...(step.kind === "pointer" ? { mode: step.advance ?? "BUTTON" } : {}),
  ...(step.url ? { url: step.url } : {}),
});

export interface TooltipInput {
  selector: string;
  message: LocalizedRich;
  mode?: "hotspot" | "element";
  icon?: "circle-dot" | "circle-question" | "circle-info" | "circle-exclamation" | "circle-up" | "circle-right";
  color?: string;
  posX?: "left" | "right";
  posY?: "top" | "center" | "bottom";
}

export const tooltipStep = (tooltip: TooltipInput): Doc => {
  const message = richText(tooltip.message);
  return {
    type: "tooltip",
    selector: tooltip.selector,
    message,
    html: localized(Object.fromEntries(Object.entries(message.localized).map(([lang, doc]) => [lang, docToHtml(doc as Doc)]))),
    mode: tooltip.mode ?? "hotspot",
    animated: true,
    color: tooltip.color ?? "#000000",
    icon: tooltip.icon ?? "circle-dot",
    posX: tooltip.posX ?? "right",
    posY: tooltip.posY ?? "center",
  };
};
