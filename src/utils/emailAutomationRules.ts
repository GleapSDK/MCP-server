/**
 * Rules for configuring and publishing event-triggered (lifecycle) emails
 * through the MCP. Pure: no I/O, so the guards are unit-testable.
 *
 * Stored shapes mirror what the dashboard writes (OutboundTriggerConfiguration
 * + ConditionPicker) and what the Server evaluates (outboundactions
 * conditionChecked / outboundRuleMatchesTrigger):
 *  - trigger: { event, type: firstoccured|lastoccured, dateOperator: 'relative',
 *    matchOperator: 'greaterthan', data: <delay seconds>, ti: <display unit> }
 *  - conditions: { logicalOperator: AND|OR, conditions: [...] }; a contact
 *    attribute is the event `gleap-up-<attribute>`.
 *  - frequency: 'once' | 'continuously' (+ frequencyDays > 0 = at most once
 *    every N days); frequencyType 'dynamic' (trigger) | 'fixed' (one-off).
 *
 * Publishing a one-off email (frequencyType 'fixed') mails everyone who
 * matches at once and cannot be recalled; an email with `targetAudience: 'all'`
 * and no conditions is the whole contact list. The MCP therefore only
 * publishes emails that are triggered by a streamed event, or one-offs whose
 * caller named a non-"all" audience that has at least one rule. A Kai-written
 * email also needs instructions and review (all or firstN) to be published.
 */

import { kaiPublishProblem, lookView } from "./emailKinds.js";

export type Frequency = { mode: "once" } | { mode: "every_time" } | { mode: "every_n_days"; days: number };

export interface TriggerInput {
  event: string;
  type?: "firstoccured" | "lastoccured";
  delaySeconds: number;
}

type Doc = Record<string, any>;

/** Events that every contact fires: a trigger on them reaches everyone the audience allows. */
const EVERYONE_EVENTS = new Set(["sessionStarted"]);

/** A condition/trigger event that addresses a contact property, not a streamed event. */
export const isContactField = (event: unknown): boolean =>
  typeof event === "string" && (event.startsWith("gleap-up-") || event === "tags");

/**
 * Why `event` cannot be an MCP-set email trigger, or null. Contact-property
 * triggers ("signed up more than 3 days ago") match every existing contact the
 * moment they go live, and pageView needs page rules the email editor does
 * not offer; both stay dashboard-only.
 */
export const triggerEventProblem = (event: string): string | null => {
  if (isContactField(event)) {
    return `"${event}" is a contact attribute, not an event. Email triggers set through the MCP must be streamed events (e.g. "trial_started"); use audience conditions for attributes.`;
  }
  if (event === "pageView") return "pageView triggers need page rules; configure them in the Gleap dashboard.";
  return null;
};

const UNITS: [string, number][] = [["day", 86400], ["hour", 3600], ["minute", 60]];

/** The dashboard's display unit for a delay in seconds (it shows days when `ti` is missing). */
export const intervalUnit = (seconds: number): string =>
  UNITS.find(([, size]) => seconds > 0 && seconds % size === 0)?.[0] ?? (seconds === 0 ? "day" : "second");

export const buildTrigger = (input: TriggerInput, frequency: string | undefined) => ({
  event: input.event,
  type: input.type ?? (frequency === "continuously" ? "lastoccured" : "firstoccured"),
  dateOperator: "relative",
  matchOperator: "greaterthan",
  data: input.delaySeconds,
  ti: intervalUnit(input.delaySeconds),
});

export const frequencyFields = (frequency: Frequency) => {
  if (frequency.mode === "once") return { frequency: "once", frequencyDays: 0 };
  if (frequency.mode === "every_time") return { frequency: "continuously", frequencyDays: 0 };
  return { frequency: "continuously", frequencyDays: frequency.days };
};

const NO_VALUE_OPERATORS = new Set(["empty", "notempty"]);
const RELATIVE_OPERATORS = new Set(["greaterthan", "lessthan", "exactly"]);
const ABSOLUTE_OPERATORS = new Set(["on", "before", "after"]);

/** Problems with one condition as the MCP accepts it, or []. */
export const conditionProblems = (condition: Doc, index: number): string[] => {
  const at = `conditions[${index}]`;
  const problems: string[] = [];
  if (condition.type === "latestdata") {
    // The Server keeps only `page` of an event's data (admin createStreamedEvents),
    // so any other dataKey compares against nothing and never matches.
    if (!isContactField(condition.event) && condition.dataKey !== "page") {
      problems.push(`${at}: event data is only stored for dataKey "page". To target a value such as a plan or role, store it on the contact (identify customData) and use {event:'gleap-up-customData.<key>', type:'latestdata', ...}; get_event_tracking_guide shows how`);
    }
    if (condition.event === "tags" && !["in", "notin"].includes(condition.matchOperator)) {
      problems.push(`${at}: tags take matchOperator in / notin`);
    }
    if (!NO_VALUE_OPERATORS.has(condition.matchOperator) && (condition.data === undefined || condition.data === "")) {
      problems.push(`${at}: ${condition.matchOperator} needs data`);
    }
  }
  if (condition.type === "firstoccured" || condition.type === "lastoccured") {
    const relative = condition.dateOperator === "relative";
    const operators = relative ? RELATIVE_OPERATORS : ABSOLUTE_OPERATORS;
    if (!operators.has(condition.matchOperator)) {
      problems.push(`${at}: ${condition.dateOperator} dates take ${[...operators].join("/")}`);
    }
    if (relative ? typeof condition.data !== "number" : (typeof condition.data !== "string" || Number.isNaN(Date.parse(condition.data)))) {
      problems.push(`${at}: data must be ${relative ? "seconds (number)" : "an ISO date"}`);
    }
  }
  return problems;
};

/** The stored form of an accepted condition (adds the dashboard's display unit to relative dates). */
export const storedCondition = (condition: Doc): Doc =>
  condition.dateOperator === "relative" && typeof condition.data === "number"
    ? { ...condition, ti: intervalUnit(condition.data) }
    : condition;

const conditionList = (conditions: unknown): Doc[] => {
  if (Array.isArray(conditions)) return conditions;
  const nested = (conditions as Doc | null)?.conditions;
  return Array.isArray(nested) ? nested : [];
};

/** Stored rules (any depth) without the parts the Server needs to evaluate them. */
const unfinishedRules = (conditions: unknown): Doc[] =>
  conditionList(conditions).flatMap((condition) => {
    if (condition && Array.isArray(condition.conditions)) return unfinishedRules(condition);
    const needsValue = !NO_VALUE_OPERATORS.has(condition?.matchOperator);
    const finished = condition?.event && condition?.type && condition?.matchOperator &&
      (!needsValue || (condition.data !== undefined && condition.data !== null && condition.data !== ""));
    return finished ? [] : [condition ?? {}];
  });

export const hasCsvUpload = (email: Doc): boolean => (email.csvContacts?.sessionIds?.length ?? 0) > 0;
const isCsvMode = (email: Doc): boolean => email.csvContacts != null && typeof email.csvContacts === "object";

export interface ConfigureArgs {
  trigger?: TriggerInput;
  frequency?: Frequency;
  audience?: { targetAudience?: string; logicalOperator?: string; conditions?: Doc[] };
  /** Drop a due send whose audience conditions no longer match, instead of keeping it pending (up to 30 days). */
  dropIfConditionsFail?: boolean;
}

/** Only the skip switch: a sending policy, not targeting, so the Server takes it on a live email too. */
const onlySkipSwitch = (args: ConfigureArgs): boolean =>
  args.dropIfConditionsFail !== undefined && !args.trigger && !args.frequency && !args.audience;

/** Why the email cannot be configured as asked, or null. `email` is the stored document. */
export const configureProblem = (email: Doc, args: ConfigureArgs): string | null => {
  if (email.type !== "EMAIL") return "This ID is not an email of this project.";
  if (onlySkipSwitch(args)) return null;
  if (email.status === "live") {
    return "This email is live; its trigger, audience and frequency are locked. Changing them needs pause_email first, which drops every queued send for good, so only with the operator's approval (a one-off email that was already sent cannot be changed). Content edits need no pause: update_email.";
  }
  if (hasCsvUpload(email)) {
    return "This email sends to an uploaded CSV contact list. Change its audience in the Gleap dashboard; the MCP does not discard uploaded lists.";
  }
  if (!args.trigger && !args.frequency && !args.audience && args.dropIfConditionsFail === undefined) {
    return "Provide trigger, frequency, audience or dropIfConditionsFail.";
  }
  if (args.trigger) {
    const problem = triggerEventProblem(args.trigger.event);
    if (problem) return problem;
  }
  const willBeTriggered = args.trigger !== undefined || (email.frequencyType !== "fixed" && !!email.trigger?.event);
  if (args.frequency && !willBeTriggered) {
    return "Frequency applies to triggered emails. Set a trigger in the same call.";
  }
  const problems = (args.audience?.conditions ?? []).flatMap(conditionProblems);
  return problems.length > 0 ? `Invalid audience conditions: ${problems.join("; ")}.` : null;
};

/** The PUT body for a configure call that passed configureProblem. */
export const configureBody = (email: Doc, args: ConfigureArgs): Doc => {
  const body: Doc = {};
  if (args.frequency) Object.assign(body, frequencyFields(args.frequency));
  if (args.trigger) {
    body.trigger = buildTrigger(args.trigger, body.frequency ?? email.frequency);
    body.frequencyType = "dynamic";
    // Leaving CSV mode (nothing uploaded) as the dashboard does when switching to Dynamic.
    if (isCsvMode(email)) body.csvContacts = null;
  }
  if (args.audience?.targetAudience) body.targetAudience = args.audience.targetAudience;
  if (args.audience?.conditions) {
    body.conditions = {
      logicalOperator: args.audience.logicalOperator ?? "AND",
      conditions: args.audience.conditions.map(storedCondition),
    };
  }
  if (args.dropIfConditionsFail !== undefined) body.dropIfConditionsFail = args.dropIfConditionsFail;
  return body;
};

/**
 * Why the MCP refuses to publish this stored email, or null when it may go
 * live. `oneOffAudience` is the caller's explicit confirmation of a one-off
 * email's audience.
 */
export const publishProblem = (email: Doc, oneOffAudience?: string): string | null => {
  if (email.type !== "EMAIL") return "This ID is not an email of this project.";
  if (isCsvMode(email)) return "Emails to an uploaded CSV list are sent from the Gleap dashboard, not the MCP.";
  const kaiProblem = kaiPublishProblem(email);
  if (kaiProblem) return kaiProblem;
  const rules = conditionList(email.conditions);
  const unfinished = unfinishedRules(email.conditions);
  if (unfinished.length > 0) {
    return `The audience has ${unfinished.length} unfinished rule(s) (${unfinished.map((rule) => rule.event ?? "empty").join(", ")}); an unfinished rule widens the audience. Fix them with configure_email_automation.`;
  }

  if (email.frequencyType !== "fixed") {
    const event = email.trigger?.event;
    if (!event) {
      return "This email has no trigger. Set an event trigger with configure_email_automation before publishing.";
    }
    const problem = triggerEventProblem(event);
    if (problem) return `${problem} Publish it in the Gleap dashboard instead.`;
    if (EVERYONE_EVENTS.has(event) && rules.length === 0) {
      return `"${event}" fires for every contact, and this email has no audience conditions, so it would reach every contact. Add audience conditions first.`;
    }
    return null;
  }

  // One-off: sends now to everyone who matches, and cannot be recalled.
  if (email.sentAt || email.sent === true) return "This one-off email was already sent.";
  if (!oneOffAudience) {
    return "This is a one-off email without a trigger: publishing sends it now to everyone who matches. The MCP refuses that unless you pass oneOffAudience matching the email's audience (users or guests, never all). Set an event trigger instead for a lifecycle email.";
  }
  if (email.targetAudience === "all" || !email.targetAudience) {
    return 'This one-off email targets "all" people. The MCP never sends a one-off to all; narrow the audience with configure_email_automation.';
  }
  if (email.targetAudience !== oneOffAudience) {
    return `oneOffAudience "${oneOffAudience}" does not match the email's audience "${email.targetAudience}". Read it with get_email_automation and confirm the stored audience.`;
  }
  if (rules.length === 0) {
    return "This one-off email has no audience conditions, so it would reach every contact of that type. Add audience conditions first.";
  }
  return null;
};

/** Why the MCP cannot pause this stored email, or null. */
export const pauseProblem = (email: Doc): string | null => {
  if (email.type !== "EMAIL") return "This ID is not an email of this project.";
  if (email.status === "live" && email.frequencyType === "fixed") {
    return "This one-off email was already sent; it cannot be paused.";
  }
  return null;
};

/** What the caller needs to verify an email's automation. */
export const automationView = (email: Doc) => ({
  id: email.id ?? email._id,
  name: email.name ?? null,
  status: email.status ?? null,
  ...lookView(email),
  frequencyType: email.frequencyType ?? null,
  frequency: email.frequency ?? null,
  frequencyDays: email.frequencyDays ?? 0,
  trigger: email.trigger ?? null,
  targetAudience: email.targetAudience ?? null,
  conditions: email.conditions ?? null,
  dropIfConditionsFail: email.dropIfConditionsFail === true,
  csvContactCount: email.csvContacts?.sessionIds?.length ?? null,
  startSendingAfter: email.startSendingAfter ?? null,
  stopSendingAfter: email.stopSendingAfter ?? null,
  sentAt: email.sentAt ?? null,
  updatedAt: email.updatedAt ?? null,
});

/** Did the saved document take the fields this call wrote? */
export const writeMatches = (saved: Doc, body: Doc): boolean =>
  Object.entries(body).every(([key, value]) => JSON.stringify(saved[key] ?? null) === JSON.stringify(value ?? null));
