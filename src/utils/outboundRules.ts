/**
 * Targeting and publish rules for every outbound type, through the same
 * routes the dashboard uses (/engagement/<type>, PUT {status} to publish or
 * pause). Pure: no I/O, so the guards are unit-testable. Email-only rules
 * live in emailAutomationRules; the shapes here mirror the dashboard's
 * OutboundTriggerConfiguration and the Server's matchOutboundRule:
 *  - triggered (frequencyType 'dynamic'): the trigger event fires per
 *    contact; with trigger `pageView`, `pageRules` limit the pages ("show on"
 *    rules are OR'd, "not on" rules AND'd). `pageFilterDelay` = seconds the
 *    person is on the page before an in-app message shows;
 *  - one-off (frequencyType 'fixed'): recipients are picked at publish and
 *    cannot be recalled. Email/push/WhatsApp go out at the start; in-app
 *    one-offs show on each person's next visit until stopSendingAfter;
 *  - news is audience-only (the Server sets its trigger), tooltips have no
 *    trigger (their pageRules go to the SDK as is, without a delay),
 *    checklists and tooltips have no frequency.
 */

import {
  buildTrigger, conditionProblems, frequencyFields, hasCsvUpload, isContactField, storedCondition, triggerEventProblem,
  type Frequency, type TriggerInput,
} from "./emailAutomationRules.js";

type Doc = Record<string, any>;

export interface OutboundTypeInfo {
  type: string;
  path: string;
  /** Dashboard route segment: /projects/<id>/engagement/<page>/<id>/edit */
  page: string;
  label: string;
  /** batch = email/push/WhatsApp, sent by a worker; in_app = shown in the widget/SDK; feed = news. */
  channel: "batch" | "in_app" | "feed";
  trigger: "event" | "none";
  oneOff: boolean;
  frequency: boolean;
  pageRules: boolean;
}

export const OUTBOUND_TYPES: Record<string, OutboundTypeInfo> = {
  survey: { type: "SURVEY", path: "/engagement/surveys", page: "surveys", label: "survey", channel: "in_app", trigger: "event", oneOff: true, frequency: true, pageRules: true },
  chat_message: { type: "MESSAGE", path: "/engagement/chat-messages", page: "chat-messages", label: "chat message", channel: "in_app", trigger: "event", oneOff: true, frequency: true, pageRules: true },
  banner: { type: "BANNER", path: "/engagement/banners", page: "banners", label: "banner", channel: "in_app", trigger: "event", oneOff: true, frequency: true, pageRules: true },
  modal: { type: "MODAL", path: "/engagement/modals", page: "modals", label: "info card (modal)", channel: "in_app", trigger: "event", oneOff: true, frequency: true, pageRules: true },
  checklist: { type: "CHECKLIST", path: "/engagement/checklists", page: "checklists", label: "checklist", channel: "in_app", trigger: "event", oneOff: false, frequency: false, pageRules: true },
  product_tour: { type: "TOUR", path: "/engagement/product-tours", page: "product-tours", label: "product tour", channel: "in_app", trigger: "event", oneOff: false, frequency: true, pageRules: true },
  tooltip: { type: "TOOLTIP", path: "/engagement/tooltips", page: "tooltips", label: "tooltip", channel: "in_app", trigger: "none", oneOff: false, frequency: false, pageRules: true },
  news: { type: "NEWS", path: "/engagement/news", page: "news", label: "news / changelog", channel: "feed", trigger: "none", oneOff: false, frequency: false, pageRules: false },
  email: { type: "EMAIL", path: "/engagement/emails", page: "emails", label: "email", channel: "batch", trigger: "event", oneOff: true, frequency: true, pageRules: false },
  push: { type: "PUSH", path: "/engagement/push-notifications", page: "push-notifications", label: "push notification", channel: "batch", trigger: "event", oneOff: true, frequency: true, pageRules: false },
  whatsapp: { type: "WHATSAPP", path: "/engagement/whatsapp-messages", page: "whatsapp-messages", label: "WhatsApp message", channel: "batch", trigger: "event", oneOff: true, frequency: true, pageRules: false },
};

export const OUTBOUND_TYPE_KEYS = Object.keys(OUTBOUND_TYPES) as [string, ...string[]];

/** Events every contact fires: as the trigger they reach everyone the audience allows. */
const EVERYONE_EVENTS = new Set(["sessionStarted", "pageView"]);

export const PAGE_MATCHES = ["is", "isnot", "contains", "notcontains", "startswith", "endswith"] as const;

export interface PageRuleInput { match: (typeof PAGE_MATCHES)[number]; value: string }

export interface TargetingArgs {
  delivery?: "triggered" | "one_off";
  trigger?: TriggerInput;
  frequency?: Frequency;
  pages?: { rules?: PageRuleInput[]; showAfterSeconds?: number };
  audience?: { targetAudience?: string; logicalOperator?: string; conditions?: Doc[] };
  schedule?: { startSendingAfter?: string | null; stopSendingAfter?: string | null };
}

const conditionList = (conditions: unknown): Doc[] => {
  if (Array.isArray(conditions)) return conditions;
  const nested = (conditions as Doc | null)?.conditions;
  return Array.isArray(nested) ? nested : [];
};

const isGroup = (condition: Doc | undefined) => Array.isArray(condition?.conditions);

/** Problems with a list of conditions incl. one level of groups, or []. */
export const audienceProblems = (conditions: Doc[], prefix = "conditions"): string[] =>
  conditions.flatMap((condition, index) => {
    if (!isGroup(condition)) {
      return conditionProblems(condition, index).map((problem) => problem.replace(/^conditions/, prefix));
    }
    if (condition.conditions.some(isGroup)) return [`${prefix}[${index}]: groups nest one level deep`];
    if (condition.conditions.length === 0) return [`${prefix}[${index}]: empty group`];
    return audienceProblems(condition.conditions, `${prefix}[${index}].conditions`);
  });

const storedAudience = (conditions: Doc[]): Doc[] => conditions.map((condition) => isGroup(condition)
  ? { logicalOperator: condition.logicalOperator ?? "AND", conditions: condition.conditions.map(storedCondition) }
  : storedCondition(condition));

const unfinished = (conditions: unknown): Doc[] => conditionList(conditions).flatMap((condition) => {
  if (isGroup(condition)) return unfinished(condition);
  const needsValue = !["empty", "notempty"].includes(condition?.matchOperator);
  const finished = condition?.event && condition?.type && condition?.matchOperator &&
    (!needsValue || (condition.data !== undefined && condition.data !== null && condition.data !== ""));
  return finished ? [] : [condition ?? {}];
});

const isOneOff = (doc: Doc) => doc.frequencyType === "fixed";
const isLive = (doc: Doc) => doc.status === "live";
const validDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** Why the trigger event cannot be used for this type, or null. */
export const triggerProblem = (info: OutboundTypeInfo, event: string): string | null => {
  if (info.trigger === "none") {
    return info.type === "NEWS"
      ? "News has no trigger: it shows in the news feed of everyone in its audience. Set audience only."
      : "Tooltips have no trigger: they show on their pages for everyone in the audience. Set audience only.";
  }
  if (info.channel === "batch") return triggerEventProblem(event);
  if (isContactField(event)) {
    return `"${event}" is a contact attribute. Triggers are events (e.g. "sessionStarted", "pageView" or a tracked event); put attribute rules in audience.conditions.`;
  }
  return null;
};

/** Why the stored outbound cannot be configured as asked, or null. */
export const targetingProblem = (info: OutboundTypeInfo, doc: Doc, args: TargetingArgs): string | null => {
  if (doc.type !== info.type) return `This ID is not a ${info.label} of this project.`;
  if (isLive(doc)) {
    return `This ${info.label} is live; its targeting is locked. Pause it with pause_outbound first${info.oneOff ? " (a one-off that was already sent cannot change)" : ""}.`;
  }
  if (hasCsvUpload(doc)) return "This item sends to an uploaded CSV list. Change its audience in the Gleap dashboard.";
  if (!args.delivery && !args.trigger && !args.frequency && !args.pages && !args.audience && !args.schedule) {
    return "Provide delivery, trigger, frequency, pages, audience or schedule.";
  }
  if (args.delivery === "one_off" && !info.oneOff) {
    return `A ${info.label} cannot be a one-off; it is shown to people as they match. Use delivery "triggered".`;
  }
  const oneOff = args.delivery ? args.delivery === "one_off" : isOneOff(doc);
  if (oneOff && (args.trigger || args.frequency || args.pages)) {
    return "A one-off has no trigger, frequency or page rules: recipients are everyone in the audience at publish. Use schedule.startSendingAfter to delay it.";
  }
  if (args.trigger) {
    const problem = triggerProblem(info, args.trigger.event);
    if (problem) return problem;
  }
  if (args.frequency && !info.frequency) return `A ${info.label} has no frequency setting; it shows until completed or dismissed.`;
  if (args.pages) {
    if (!info.pageRules) return `Page rules do not apply to a ${info.label}.`;
    // Tooltips have no trigger: the SDK shows them on the pages their rules allow, with no delay.
    if (info.trigger === "none" && args.pages.showAfterSeconds !== undefined) {
      return `A ${info.label} shows as soon as its page matches; showAfterSeconds does not apply.`;
    }
    const trigger = args.trigger?.event ?? doc.trigger?.event;
    if (info.trigger === "event" && (args.pages.rules?.length ?? 0) > 0 && trigger !== "pageView") {
      return 'Page rules apply when the trigger is "pageView". Set trigger {event:"pageView", delaySeconds:0} in the same call.';
    }
    const empty = (args.pages.rules ?? []).findIndex((rule) => rule.value.trim() === "");
    if (empty >= 0) return `pages.rules[${empty}] needs a value (a URL part like "/pricing").`;
  }
  for (const key of ["startSendingAfter", "stopSendingAfter"] as const) {
    const value = args.schedule?.[key];
    if (value != null && !validDate(value)) return `schedule.${key} must be an ISO date.`;
  }
  const start = args.schedule?.startSendingAfter ?? doc.startSendingAfter;
  const stop = args.schedule?.stopSendingAfter ?? doc.stopSendingAfter;
  if (start && stop && Date.parse(stop) <= Date.parse(start)) return "schedule.stopSendingAfter must be after startSendingAfter.";
  const problems = audienceProblems(args.audience?.conditions ?? []);
  if (problems.length > 0) return `Invalid audience conditions: ${problems.join("; ")}.`;
  if (oneOff && (args.audience?.conditions ?? []).some(isGroup)) {
    return "One-off audiences are matched on top-level rules only; flatten the groups (use logicalOperator) or send it triggered.";
  }
  return null;
};

/** The PUT body for a targeting call that passed targetingProblem. */
export const targetingBody = (info: OutboundTypeInfo, doc: Doc, args: TargetingArgs): Doc => {
  const body: Doc = {};
  if (args.delivery === "one_off") {
    Object.assign(body, { frequencyType: "fixed", trigger: null });
  }
  if (args.delivery === "triggered" && isOneOff(doc)) body.frequencyType = "dynamic";
  if (args.frequency) Object.assign(body, frequencyFields(args.frequency));
  if (args.trigger) {
    body.trigger = buildTrigger(args.trigger, body.frequency ?? doc.frequency);
    body.frequencyType = "dynamic";
    if (doc.csvContacts != null && typeof doc.csvContacts === "object") body.csvContacts = null;
  }
  if (args.pages?.rules) {
    body.pageRules = args.pages.rules.map((rule) => ({ pageFilter: rule.value.trim(), pageFilterType: rule.match }));
    // The legacy scalar mirrors the first rule, as the dashboard writes it.
    body.pageFilter = body.pageRules[0]?.pageFilter ?? "";
    body.pageFilterType = body.pageRules[0]?.pageFilterType ?? "contains";
  }
  if (args.pages?.showAfterSeconds !== undefined) body.pageFilterDelay = args.pages.showAfterSeconds;
  if (args.audience?.targetAudience) body.targetAudience = args.audience.targetAudience;
  if (args.audience?.conditions) {
    body.conditions = { logicalOperator: args.audience.logicalOperator ?? "AND", conditions: storedAudience(args.audience.conditions) };
  }
  if (args.schedule) {
    for (const key of ["startSendingAfter", "stopSendingAfter"] as const) {
      const value = args.schedule[key];
      if (value !== undefined) body[key] = value === null ? null : new Date(value).toISOString();
    }
  }
  return body;
};

/** Content a type needs before it can show anything, or null when it is complete. */
export const contentProblem = (info: OutboundTypeInfo, doc: Doc, surveyQuestions?: number): string | null => {
  const steps = doc.config?.steps;
  if (["CHECKLIST", "MODAL", "TOUR"].includes(info.type) && !(Array.isArray(steps) && steps.length > 0)) {
    return `This ${info.label} has no steps, so it would show nothing. Add them with update_outbound_content${info.type === "TOUR" ? " or record them in the Gleap tour builder" : ""}.`;
  }
  // The editor, the Server and the SDK read tooltips from config.steps (the dashboard template's `tooltips: []` is unused).
  if (info.type === "TOOLTIP" && !(Array.isArray(steps) && steps.length > 0)) {
    return "This tooltip set has no tooltips. Add them with update_outbound_content or the Gleap tooltip builder.";
  }
  // The Server builds no delivery payload without a sender (outboundactions createOutboundAction).
  if (["BANNER", "MESSAGE", "NEWS"].includes(info.type) && !doc.sender) {
    return `This ${info.label} has no sender, so it would not render. Set sender (a teammate's user ID from get_users).`;
  }
  if (info.type === "SURVEY" && surveyQuestions === 0) return "This survey has no questions.";
  if (["MESSAGE", "BANNER", "PUSH", "EMAIL", "NEWS"].includes(info.type)) {
    const message = doc.message?.localized ?? doc.message;
    const hasMessage = message && typeof message === "object" ? Object.keys(message).length > 0 : typeof message === "string" && message.trim() !== "";
    if (!hasMessage) return `This ${info.label} has no message.`;
  }
  return null;
};

export interface PublishCheck {
  /** Recipients the operator approved (from preview_outbound_audience), for sends that cannot be recalled. */
  confirmedReach?: number;
  /** The current audience count, when one was taken. */
  currentReach?: number;
}

/** Does publishing this send to a picked audience at once (and so need a confirmed count)? */
export const needsReachConfirmation = (info: OutboundTypeInfo, doc: Doc): boolean =>
  (info.oneOff && isOneOff(doc)) || (info.type === "NEWS" && !!doc.config?.push);

/** Reach may grow a little between the preview and the publish. */
export const reachTolerance = (confirmed: number) => Math.ceil(confirmed * 1.1) + 5;

/** Why the MCP refuses to publish this stored outbound, or null when it may go live. */
export const publishProblem = (info: OutboundTypeInfo, doc: Doc, check: PublishCheck = {}): string | null => {
  if (doc.type !== info.type) return `This ID is not a ${info.label} of this project.`;
  if (doc.csvContacts != null && typeof doc.csvContacts === "object") return "Items for an uploaded CSV list are sent from the Gleap dashboard.";
  const open = unfinished(doc.conditions);
  if (open.length > 0) {
    return `The audience has ${open.length} unfinished rule(s) (${open.map((rule) => rule.event ?? "empty").join(", ")}); an unfinished rule widens the audience. Fix them with configure_outbound_targeting.`;
  }
  const rules = conditionList(doc.conditions);

  if (isOneOff(doc)) {
    if (doc.sentAt || doc.sent === true) return "This one-off was already sent.";
    if (rules.some(isGroup)) return "One-off audiences are matched on top-level rules only; flatten the groups first.";
    if (info.channel === "batch" && (doc.targetAudience === "all" || !doc.targetAudience) && rules.length === 0) {
      return `This one-off ${info.label} targets everyone. The MCP never sends a one-off ${info.label} to the whole contact list; add audience conditions.`;
    }
  } else if (info.trigger === "event") {
    const event = doc.trigger?.event;
    if (!event) {
      return `This ${info.label} has no trigger, so it would never show. Set one with configure_outbound_targeting ("sessionStarted" to target by audience rules only)${info.oneOff ? ', or make it a one-off (delivery "one_off")' : ""}.`;
    }
    const problem = triggerProblem(info, event);
    if (problem) return `${problem} Publish it in the Gleap dashboard instead.`;
    if (info.channel === "batch" && EVERYONE_EVENTS.has(event) && rules.length === 0) {
      return `"${event}" fires for every contact and this ${info.label} has no audience conditions, so it would reach every contact. Add audience conditions first.`;
    }
  }

  if (needsReachConfirmation(info, doc)) {
    if (check.confirmedReach === undefined) {
      return `Publishing sends this ${info.label} to everyone in its audience at once and cannot be recalled. Run preview_outbound_audience, get the operator's approval of that recipient count, then pass it as confirmedReach.`;
    }
    if (check.currentReach !== undefined && check.currentReach > reachTolerance(check.confirmedReach)) {
      return `The audience is now ${check.currentReach} people, more than the confirmed ${check.confirmedReach}. Re-check it with preview_outbound_audience and confirm the new count.`;
    }
  }
  return null;
};

/** Why the MCP cannot pause this stored outbound, or null. */
export const pauseProblem = (info: OutboundTypeInfo, doc: Doc): string | null => {
  if (doc.type !== info.type) return `This ID is not a ${info.label} of this project.`;
  // The Server allows only renaming a live one-off (updateEngagement).
  if (isLive(doc) && isOneOff(doc)) return `This one-off ${info.label} was already sent; it cannot be paused.`;
  return null;
};

const withoutIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_id").map(([key, item]) => [key, withoutIds(item)]));
  }
  return value;
};

/**
 * Did the saved document take the fields this call wrote? Subdocument arrays
 * (pageRules) come back with Mongo `_id`s and dates as ISO strings.
 */
export const savedMatches = (saved: Doc, body: Doc): boolean =>
  Object.entries(body).every(([key, value]) =>
    JSON.stringify(withoutIds(saved[key] ?? null)) === JSON.stringify(withoutIds(value ?? null)));

/** What a caller needs to verify an outbound's targeting. */
export const targetingView = (doc: Doc) => ({
  status: doc.status ?? null,
  delivery: doc.frequencyType === "fixed" ? "one_off" : "triggered",
  trigger: doc.trigger ?? null,
  frequency: doc.frequency ?? null,
  frequencyDays: doc.frequencyDays ?? 0,
  pageRules: Array.isArray(doc.pageRules) && doc.pageRules.length > 0
    ? doc.pageRules
    : doc.pageFilter ? [{ pageFilter: doc.pageFilter, pageFilterType: doc.pageFilterType ?? "contains" }] : [],
  showAfterSeconds: doc.pageFilterDelay ?? 0,
  targetAudience: doc.targetAudience ?? "all",
  conditions: doc.conditions ?? null,
  startSendingAfter: doc.startSendingAfter ?? null,
  stopSendingAfter: doc.stopSendingAfter ?? null,
  sentAt: doc.sentAt ?? null,
  csvContactCount: doc.csvContacts?.sessionIds?.length ?? null,
});
