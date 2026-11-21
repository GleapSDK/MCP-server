/**
 * Sequences (Outreach › Sequences): the pure half of the MCP tools — step
 * validation, settings merges, compact views and the reference text the tool
 * descriptions and get_sequence_templates share. No I/O, so it is unit-testable.
 *
 * Mirrors the Server (api/sequences): sequence.steps.ts (tree, limits,
 * go-live checks), sequence.input.ts (settings normalisation) and the round-3
 * contract (waitUntil step, goal, draft/publish, plain-text content). The
 * Server stays the authority: its 400 messages reach the agent verbatim.
 */
import { audienceProblems } from "./outboundRules.js";
import { storedCondition } from "./emailAutomationRules.js";

type Doc = Record<string, any>;

export const STEP_TYPES = ["email", "message", "survey", "push", "whatsapp", "wait", "waitUntil", "branch", "tag", "attribute", "pipeline", "sequence", "exit"] as const;

const ENGAGEMENT_ACTIONS = ["opened", "clicked", "replied"];
const WAIT_UNITS_ONLINE = ["minutes", "hours", "days", "businessDays", "weeks"];

/** "Send when they're online" of a message or survey step: {enabled, amount, unit, fallback: email|skip, subject?, content?}. */
const onlineProblem = (online: unknown, at: string): string | null => {
  if (online === undefined) return null;
  if (!online || typeof online !== "object" || Array.isArray(online)) return `${at}.online must be {enabled, amount, unit, fallback, subject?, content?}`;
  const value = online as Doc;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return `${at}.online.enabled must be true or false`;
  if (value.unit !== undefined && !WAIT_UNITS_ONLINE.includes(value.unit)) return `${at}.online.unit must be one of ${WAIT_UNITS_ONLINE.join(", ")}`;
  if (value.amount !== undefined && !(Number(value.amount) > 0)) return `${at}.online.amount must be a positive number`;
  if (value.fallback !== undefined && !["email", "skip"].includes(value.fallback)) return `${at}.online.fallback must be email or skip`;
  if (value.subject !== undefined && typeof value.subject !== "string") return `${at}.online.subject must be text`;
  return null;
};
export const WAIT_UNITS = ["minutes", "hours", "days", "businessDays", "weeks"] as const;
export const EMAIL_LOOKS = ["plain", "personal", "company"] as const;
export const SEQUENCE_TEMPLATES = ["blank", "onboarding", "trial", "reengage"] as const;
/** Mirrors MAX_STEPS / MAX_BRANCH_DEPTH / MAX_WAIT_MS in sequence.steps.ts. */
export const MAX_STEPS = 100;
export const MAX_BRANCH_DEPTH = 5;
export const MAX_WAIT_DAYS = 365;
export const MAX_ENROLL = 500;
export const MAX_TEST_RECIPIENTS = 5;

const UNIT_DAYS: Record<string, number> = { minutes: 1 / 1440, hours: 1 / 24, days: 1, businessDays: 1, weeks: 7 };
const OBJECT_ID = /^[a-fA-F0-9]{24}$/;
const hasPaths = (step: Doc | null | undefined) => step?.type === "branch" || step?.type === "waitUntil";
const isObject = (value: unknown): value is Doc => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;

// ------------------------------------------------------------ tree

/** Depth-first walk in reading order; a branch / waitUntil is followed by its yes then no path. */
export const walkSteps = (steps: unknown, visit: (step: Doc, depth: number, path: string) => void, depth = 0, prefix = "steps") => {
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    const path = `${prefix}[${index}]`;
    visit(step, depth, path);
    if (hasPaths(step)) {
      walkSteps(step.yes, visit, depth + 1, `${path}.yes`);
      walkSteps(step.no, visit, depth + 1, `${path}.no`);
    }
  });
};

// ------------------------------------------------------------ conditions

/** Conditions as the tools accept them (a list = AND, or a group) → the stored group. */
export const storedConditions = (conditions: unknown): Doc | [] => {
  if (conditions === undefined || conditions === null) return [];
  const group = Array.isArray(conditions)
    ? { logicalOperator: "AND", conditions }
    : isObject(conditions) ? { logicalOperator: conditions.logicalOperator ?? "AND", conditions: conditions.conditions ?? [] } : null;
  if (!group || !Array.isArray(group.conditions) || group.conditions.length === 0) return [];
  return {
    logicalOperator: group.logicalOperator,
    conditions: group.conditions.map((rule: Doc) => Array.isArray(rule?.conditions)
      ? { logicalOperator: rule.logicalOperator ?? "AND", conditions: rule.conditions.map(storedCondition) }
      : storedCondition(rule)),
  };
};

const RULE_KEYS = new Set(["event", "type", "matchOperator", "data", "dataKey", "dateOperator", "ti"]);
const RULE_TYPES = new Set(["count", "latestdata", "firstoccured", "lastoccured"]);

/** Shape + semantic problems of conditions (list or group, one level of nested groups), or []. */
export const conditionsProblems = (conditions: unknown, at: string): string[] => {
  if (conditions === undefined || conditions === null) return [];
  const list = Array.isArray(conditions) ? conditions : isObject(conditions) ? conditions.conditions : undefined;
  if (!Array.isArray(list)) return [`${at}: conditions must be a list of rules or {logicalOperator, conditions:[...]}`];
  if (isObject(conditions) && conditions.logicalOperator !== undefined && !["AND", "OR"].includes(conditions.logicalOperator)) {
    return [`${at}.logicalOperator must be AND or OR`];
  }
  const shape: string[] = [];
  const check = (rule: unknown, path: string) => {
    if (!isObject(rule)) return shape.push(`${path}: a rule must be an object`);
    if (Array.isArray(rule.conditions)) return; // a group: audienceProblems checks its rules and depth
    if (!nonEmpty(rule.event)) shape.push(`${path}: event is required`);
    if (!RULE_TYPES.has(rule.type)) shape.push(`${path}: type must be count, latestdata, firstoccured or lastoccured`);
    if (!nonEmpty(rule.matchOperator)) shape.push(`${path}: matchOperator is required`);
    const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
    if (unknown.length > 0) shape.push(`${path}: unknown field ${unknown.join(", ")}`);
    if (rule.type === "count" && (typeof rule.data !== "number" || rule.data < 0)) shape.push(`${path}: count rules take data: <number of times>`);
  };
  list.forEach((rule, index) => {
    check(rule, `${at}[${index}]`);
    if (isObject(rule) && Array.isArray(rule.conditions)) rule.conditions.forEach((inner: unknown, j: number) => check(inner, `${at}[${index}].conditions[${j}]`));
  });
  if (shape.length > 0) return shape;
  return audienceProblems(list as Doc[], at);
};

// ------------------------------------------------------------ steps

const waitProblem = (step: Doc, at: string, required: boolean): string | null => {
  if (step.unit !== undefined && !(WAIT_UNITS as readonly string[]).includes(step.unit)) {
    return `${at}.unit must be one of ${WAIT_UNITS.join(", ")}`;
  }
  if (step.amount !== undefined && (typeof step.amount !== "number" || !Number.isFinite(step.amount) || step.amount <= 0)) {
    return `${at}.amount must be a positive number`;
  }
  if (typeof step.amount === "number" && step.unit && step.amount * UNIT_DAYS[step.unit] > MAX_WAIT_DAYS) {
    return `${at}: a wait is at most ${MAX_WAIT_DAYS} days`;
  }
  if (required && (step.amount === undefined || step.unit === undefined)) return `${at} needs amount and unit`;
  return null;
};

const contentProblem = (content: unknown, at: string): string | null =>
  content === undefined || typeof content === "string" || (isObject(content) && content.type === "doc")
    ? null
    : `${at}.content must be plain text or a TipTap doc {type:'doc', content:[...]}`;

/**
 * Problems that make a steps payload wrong (refused before any write): shape,
 * types, ids, limits, enum values and conditions. Missing content (an email
 * without subject…) is not here: drafts may be unfinished; see goLiveWarnings.
 */
export const stepsProblems = (steps: unknown): string[] => {
  if (!Array.isArray(steps)) return ["steps must be a list"];
  const problems: string[] = [];
  const ids = new Set<string>();
  let count = 0;
  walkSteps(steps, (step, depth, at) => {
    count += 1;
    if (!isObject(step)) return void problems.push(`${at}: a step must be an object`);
    if (!nonEmpty(step.id) || step.id.length > 64) problems.push(`${at}.id must be a non-empty string of at most 64 characters`);
    else if (ids.has(step.id)) problems.push(`${at}.id "${step.id}" is used twice; step ids must be unique`);
    else ids.add(step.id);
    if (depth > MAX_BRANCH_DEPTH) problems.push(`${at}: branches nest at most ${MAX_BRANCH_DEPTH} levels deep`);
    if (!(STEP_TYPES as readonly string[]).includes(step.type)) {
      return void problems.push(`${at}.type "${step.type}" is unknown; use ${STEP_TYPES.join(", ")}`);
    }
    if (hasPaths(step)) {
      for (const key of ["yes", "no"]) {
        if (step[key] !== undefined && !Array.isArray(step[key])) problems.push(`${at}.${key} must be a list of steps`);
      }
    } else if (step.yes !== undefined || step.no !== undefined) {
      problems.push(`${at}: only branch and waitUntil steps have yes/no paths`);
    }
    let problem: string | null = null;
    switch (step.type) {
      case "email":
        if (step.subject !== undefined && typeof step.subject !== "string") problem = `${at}.subject must be text`;
        else if (step.preheader !== undefined && typeof step.preheader !== "string") problem = `${at}.preheader must be text`;
        else if (step.look !== undefined && !(EMAIL_LOOKS as readonly string[]).includes(step.look)) problem = `${at}.look must be plain, personal or company`;
        else if (step.threadWithPrevious !== undefined && typeof step.threadWithPrevious !== "boolean") problem = `${at}.threadWithPrevious must be true or false`;
        else if (step.kai !== undefined && (typeof step.kai !== "object" || step.kai === null || Array.isArray(step.kai))) problem = `${at}.kai must be {enabled, prompt}`;
        else if (step.kai !== undefined && step.kai.enabled !== undefined && typeof step.kai.enabled !== "boolean") problem = `${at}.kai.enabled must be true or false`;
        else if (step.kai !== undefined && step.kai.prompt !== undefined && (typeof step.kai.prompt !== "string" || step.kai.prompt.length > 8000)) problem = `${at}.kai.prompt must be text of at most 8000 characters`;
        // A Kai-written email may leave out content: it is only the fallback.
        else if (step.kai?.enabled === true && step.content === undefined) problem = null;
        else problem = contentProblem(step.content, at);
        break;
      case "message":
        problem = contentProblem(step.content, at) ?? onlineProblem(step.online, at);
        break;
      case "survey":
      case "push":
      case "whatsapp":
        if (step.outboundId !== undefined && !OBJECT_ID.test(`${step.outboundId}`)) problem = `${at}.outboundId must be an outbound id (list_outbound_messages / list_surveys)`;
        else if (step.type === "survey") problem = onlineProblem(step.online, at);
        else if (step.online !== undefined) problem = `${at}.online only applies to message and survey steps`;
        break;
      case "wait":
        if (step.mode !== undefined && !["duration", "event"].includes(step.mode)) problem = `${at}.mode must be duration (use a waitUntil step to wait for an event)`;
        else problem = waitProblem(step, at, false);
        break;
      case "waitUntil":
        if (step.event !== undefined && typeof step.event !== "string") problem = `${at}.event must be an event name`;
        else problem = waitProblem(step, at, false);
        break;
      case "branch":
        if (step.mode !== undefined && !["conditions", "engagement"].includes(step.mode)) problem = `${at}.mode must be conditions or engagement`;
        else if (step.mode === "engagement") {
          if (!step.engagement || !ENGAGEMENT_ACTIONS.includes(step.engagement.action)) problem = `${at}.engagement must be {action: opened|clicked|replied, stepId?: an email step id}`;
          else if (step.engagement.stepId != null && typeof step.engagement.stepId !== "string") problem = `${at}.engagement.stepId must be an email step id`;
        } else problems.push(...conditionsProblems(step.conditions, `${at}.conditions`));
        break;
      case "tag":
        if (step.op !== undefined && !["add", "remove"].includes(step.op)) problem = `${at}.op must be add or remove`;
        else if (step.tag !== undefined && typeof step.tag !== "string") problem = `${at}.tag must be text`;
        break;
      case "attribute":
        if (step.key !== undefined && typeof step.key !== "string") problem = `${at}.key must be text`;
        else if (step.value !== undefined && typeof step.value !== "string") problem = `${at}.value must be text (variables allowed)`;
        break;
      case "pipeline":
        if (step.pipelineId !== undefined && !OBJECT_ID.test(`${step.pipelineId}`)) problem = `${at}.pipelineId must be a pipeline id (get_pipelines)`;
        break;
      case "sequence":
        if (step.sequenceId !== undefined && !OBJECT_ID.test(`${step.sequenceId}`)) problem = `${at}.sequenceId must be a sequence id (list_sequences)`;
        break;
    }
    if (problem) problems.push(problem);
  });
  if (count > MAX_STEPS) problems.push(`A sequence holds at most ${MAX_STEPS} steps (branches included); this one has ${count}`);
  return problems;
};

/** A deep copy in the stored form: wait mode filled in, branch conditions as a group with display units. */
export const normalizeSteps = (steps: Doc[]): Doc[] => steps.map((step) => {
  const copy: Doc = { ...step };
  if (copy.type === "wait" && copy.mode === undefined) copy.mode = "duration";
  if (copy.type === "tag" && copy.op === undefined) copy.op = "add";
  if (copy.type === "branch" && copy.mode !== "engagement") copy.conditions = storedConditions(copy.conditions);
  if (copy.type === "branch" && copy.mode === "engagement" && copy.conditions === undefined) copy.conditions = { logicalOperator: "AND", conditions: [] };
  if (hasPaths(copy)) {
    copy.yes = normalizeSteps(Array.isArray(copy.yes) ? copy.yes : []);
    copy.no = normalizeSteps(Array.isArray(copy.no) ? copy.no : []);
  }
  return copy;
});

const hasText = (content: unknown): boolean => {
  if (!content) return false;
  if (typeof content === "string") return content.trim().length > 0;
  const node = content as Doc;
  if (typeof node.text === "string" && node.text.trim().length > 0) return true;
  if (node.type === "serverVariable" || node.type === "image") return true;
  return Array.isArray(node.content) && node.content.some(hasText);
};

const ruleCount = (conditions: unknown) =>
  Array.isArray(conditions) ? conditions.length : Array.isArray((conditions as Doc)?.conditions) ? (conditions as Doc).conditions.length : 0;

/** What blocks going live (Server goLiveProblem, plus waitUntil and goal), as warnings on a saved draft. */
export const goLiveWarnings = (definition: { steps?: Doc[]; enrollment?: Doc; goal?: Doc | null }): string[] => {
  const warnings: string[] = [];
  const steps = definition.steps ?? [];
  if (steps.length === 0) warnings.push("The sequence has no steps.");
  let firstEmail: string | null = null;
  walkSteps(steps, (step) => {
    const name = `Step ${step.id} (${step.type})`;
    switch (step.type) {
      case "email": {
        const isFollowUp = firstEmail !== null && step.threadWithPrevious !== false;
        if (!firstEmail) firstEmail = step.id;
        if (step.kai?.enabled === true) {
          if (!nonEmpty(step.kai.prompt)) warnings.push(`${name} is written by Kai and needs kai.prompt (what Kai should write).`);
          break;
        }
        if (!isFollowUp && !nonEmpty(step.subject)) warnings.push(`${name} needs a subject.`);
        if (!hasText(step.content)) warnings.push(`${name} needs content.`);
        break;
      }
      case "message":
        if (!hasText(step.content)) warnings.push(`${name} needs content.`);
        if (step.online?.enabled === true && step.online.fallback === "email" && (!nonEmpty(step.online.subject) || !hasText(step.online.content))) warnings.push(`${name} needs online.subject and online.content for its fallback email.`);
        break;
      case "survey":
      case "push":
      case "whatsapp":
        if (!step.outboundId) warnings.push(`${name} needs an outboundId.`);
        if (step.online?.enabled === true && step.online.fallback === "email" && (!nonEmpty(step.online.subject) || !hasText(step.online.content))) warnings.push(`${name} needs online.subject and online.content for its fallback email.`);
        break;
      case "wait":
        if (!(step.amount > 0) || !step.unit) warnings.push(`${name} needs amount and unit.`);
        if (step.mode === "event" && !nonEmpty(step.event)) warnings.push(`${name} needs an event.`);
        break;
      case "waitUntil":
        if (!nonEmpty(step.event)) warnings.push(`${name} needs the event to wait for.`);
        if (!(step.amount > 0) || !step.unit) warnings.push(`${name} needs the longest wait (amount and unit).`);
        break;
      case "branch":
        if (step.mode === "engagement") {
          if (!ENGAGEMENT_ACTIONS.includes(step.engagement?.action)) warnings.push(`${name} needs engagement.action (opened, clicked or replied).`);
        } else if (ruleCount(step.conditions) === 0) warnings.push(`${name} needs a condition.`);
        break;
      case "tag":
        if (!nonEmpty(step.tag)) warnings.push(`${name} needs a tag.`);
        break;
      case "attribute":
        if (!nonEmpty(step.key)) warnings.push(`${name} needs a key.`);
        break;
      case "pipeline":
        if (!step.pipelineId) warnings.push(`${name} needs a pipelineId.`);
        break;
      case "sequence":
        if (!step.sequenceId) warnings.push(`${name} needs a sequenceId.`);
        break;
    }
  });
  for (const trigger of definition.enrollment?.triggers ?? []) {
    if (trigger?.type === "event" && !nonEmpty(trigger.event)) warnings.push("An event trigger has no event.");
  }
  if (definition.goal && !nonEmpty(definition.goal.event)) warnings.push("The goal has no event.");
  return warnings;
};

/** stepChanges: merge fields into existing steps by id (type and paths are not changed this way). */
export const applyStepChanges = (steps: Doc[], changes: Doc[]): { steps: Doc[] } | { error: string } => {
  const byId = new Map<string, Doc>();
  for (const change of changes) {
    if (!nonEmpty(change?.id)) return { error: "Every stepChanges entry needs the id of an existing step." };
    for (const key of ["type", "yes", "no"]) {
      if (key in change) return { error: `stepChanges cannot change ${key} (step ${change.id}); send the whole steps list instead.` };
    }
    byId.set(change.id, change);
  }
  const found = new Set<string>();
  const apply = (list: Doc[]): Doc[] => list.map((step) => {
    const change = byId.get(step.id);
    if (change) found.add(step.id);
    const merged = change ? { ...step, ...change } : { ...step };
    if (hasPaths(merged)) {
      merged.yes = apply(Array.isArray(merged.yes) ? merged.yes : []);
      merged.no = apply(Array.isArray(merged.no) ? merged.no : []);
    }
    return merged;
  });
  const result = apply(steps);
  const missing = [...byId.keys()].filter((id) => !found.has(id));
  if (missing.length > 0) return { error: `No step with id ${missing.join(", ")} in this sequence (get_sequence lists the ids).` };
  return { steps: result };
};

// ------------------------------------------------------------ settings

/**
 * The Server replaces a settings object whole (missing keys fall back to
 * defaults), so a partial update is merged onto the current value first:
 * changing only the triggers keeps the audience, conditions and re-enrollment.
 */
export const mergeSettings = (current: Doc, input: Doc): Doc => {
  const body: Doc = {};
  if (input.enrollment) {
    const merged = { ...(current.enrollment ?? {}), ...input.enrollment };
    if (input.enrollment.triggers) merged.triggers = [{ type: "manual" }, ...input.enrollment.triggers.filter((t: Doc) => t?.type !== "manual")];
    if ("conditions" in input.enrollment) merged.conditions = storedConditions(input.enrollment.conditions);
    body.enrollment = merged;
  }
  if (input.exit) {
    const merged = { ...(current.exit ?? {}), ...input.exit };
    if ("conditions" in input.exit) merged.conditions = storedConditions(input.exit.conditions);
    body.exit = merged;
  }
  if (input.sending) {
    const base = current.sending ?? {};
    body.sending = { ...base, ...input.sending, window: { ...(base.window ?? {}), ...(input.sending.window ?? {}) } };
  }
  if (input.goal !== undefined) {
    body.goal = input.goal === null ? null : { withinDays: 14, exitOnGoal: true, ...(current.goal ?? {}), ...input.goal };
  }
  return body;
};

// ------------------------------------------------------------ views

/**
 * A TipTap doc as plain text, when nothing is lost: only paragraphs of
 * unformatted text and variables ({{path|fallback}}), which the Server turns
 * back into the same doc. Formatted docs (bold, links, images, lists) stay JSON.
 */
export const docAsText = (doc: unknown): string | null => {
  if (typeof doc === "string") return doc;
  if (!isObject(doc) || doc.type !== "doc" || !Array.isArray(doc.content) || doc.content.length === 0) return null;
  const paragraphs: string[] = [];
  for (const block of doc.content) {
    if (block?.type !== "paragraph" || !Array.isArray(block.content) || block.content.length === 0) return null;
    let text = "";
    for (const node of block.content) {
      if (node?.type === "text" && typeof node.text === "string" && !(node.marks?.length) && !node.text.includes("\n")) text += node.text;
      else if (node?.type === "serverVariable" && nonEmpty(node.attrs?.variableName)) {
        const fallback = `${node.attrs.fallbackValue ?? ""}`.trim();
        text += `{{${node.attrs.variableName}${fallback ? `|${fallback}` : ""}}}`;
      } else return null;
    }
    paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
};

/** A step with plain-text content where that is lossless (see docAsText). */
export const stepView = (step: Doc): Doc => {
  const view: Doc = { ...step };
  if (step.content !== undefined) {
    const text = docAsText(step.content);
    if (text !== null) view.content = text;
  }
  if (hasPaths(step)) {
    view.yes = (step.yes ?? []).map(stepView);
    view.no = (step.no ?? []).map(stepView);
  }
  return view;
};

const short = (value: unknown, max = 60) => {
  const text = `${value ?? ""}`.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export const describeConditions = (conditions: unknown): string => {
  const list = Array.isArray(conditions) ? conditions : (conditions as Doc)?.conditions;
  if (!Array.isArray(list) || list.length === 0) return "no conditions";
  const operator = Array.isArray(conditions) ? "AND" : (conditions as Doc).logicalOperator ?? "AND";
  return list.map((rule: Doc) => Array.isArray(rule?.conditions)
    ? `(${describeConditions(rule)})`
    : `${rule?.event} ${rule?.type === "count" ? "count " : ""}${rule?.matchOperator}${rule?.data !== undefined ? ` ${rule.data}` : ""}`).join(` ${operator} `);
};

/** One line per step, e.g. `wait until invited_teammate (max 3 businessDays)`. */
export const stepLabel = (step: Doc): string => {
  switch (step?.type) {
    case "email": return step.kai?.enabled === true
      ? `email written by Kai ("${short(step.kai.prompt, 40) || "no instructions"}")`
      : `email "${short(step.subject) || "(no subject)"}"`;
    case "message": return `chat message "${short(docAsText(step.content) ?? "…", 40)}"${step.online?.enabled ? ` (when online, max ${step.online.amount} ${step.online.unit}, else ${step.online.fallback === "email" ? "email" : "skip"})` : ""}`;
    case "survey": return `survey ${step.outboundId || "(none picked)"}${step.online?.enabled ? ` (when online, max ${step.online.amount} ${step.online.unit}, else ${step.online.fallback === "email" ? "email" : "skip"})` : ""}`;
    case "push": return `push notification ${step.outboundId || "(none picked)"}`;
    case "whatsapp": return `WhatsApp message ${step.outboundId || "(none picked)"}`;
    case "wait": return step.mode === "event" ? `wait for ${step.event} (max ${step.amount} ${step.unit})` : `wait ${step.amount} ${step.unit}`;
    case "waitUntil": return `wait until ${step.event} (max ${step.amount} ${step.unit})`;
    case "branch": return step.mode === "engagement"
      ? `if ${step.name ? `"${short(step.name)}" ` : ""}[${step.engagement?.action ?? "?"} ${step.engagement?.stepId ? `email ${step.engagement.stepId}` : "any email"}]`
      : `if ${step.name ? `"${short(step.name)}" ` : ""}[${describeConditions(step.conditions)}]`;
    case "tag": return `${step.op === "remove" ? "remove" : "add"} tag ${step.tag}`;
    case "attribute": return `set attribute ${step.key} = "${short(step.value, 40)}"`;
    case "pipeline": return `add to pipeline ${step.pipelineId}${step.laneId ? ` (stage ${step.laneId})` : ""}`;
    case "sequence": return `enroll in sequence ${step.sequenceId}`;
    case "exit": return "end sequence";
    default: return `${step?.type ?? "unknown"} step`;
  }
};

/** The step tree as indented lines with ids; yes/no paths under their step (an empty path continues after it). */
export const outline = (steps: unknown, depth = 0): string[] => {
  const lines: string[] = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}[${step?.id}] ${stepLabel(step)}`);
    if (!hasPaths(step)) continue;
    const [yes, no] = step.type === "waitUntil" ? ["yes (did it)", "no (didn't in time)"] : ["yes (matches)", "no (doesn't match)"];
    for (const [name, list] of [[yes, step.yes], [no, step.no]] as const) {
      const empty = !Array.isArray(list) || list.length === 0;
      lines.push(`${indent}  ${name}:${empty ? " continue" : ""}`);
      lines.push(...outline(list, depth + 2));
    }
  }
  return lines;
};

/** id → label of every step, for stats and enrollment timelines. */
export const stepLabels = (steps: unknown): Map<string, string> => {
  const labels = new Map<string, string>();
  walkSteps(steps, (step) => labels.set(`${step?.id}`, stepLabel(step)));
  return labels;
};

/** "Enrolled manually, on event trial_started, when a contact is created". */
export const triggerSummary = (enrollment: Doc | undefined): string => {
  const parts = ["manually"];
  for (const trigger of enrollment?.triggers ?? []) {
    if (trigger?.type === "event") parts.push(`on event ${trigger.event || "(none picked)"}`);
    if (trigger?.type === "contactCreated") parts.push("when a contact is created");
  }
  return `Enrolled ${parts.join(", ")}`;
};

// ------------------------------------------------------------ reference text

export const VARIABLES_HELP =
  "Variables (subject, preheader, content, attribute value): {{path}} or {{path|fallback}}, e.g. {{session.firstName|there}}. " +
  "Paths: session.firstName (first word of the name), session.name, session.email, session.userId, session.phone, session.companyName, session.plan, session.lang, session.value, " +
  "custom contact data session.customData.<key> (the key as sent with identify customData, e.g. session.customData.role), project.name. " +
  "Give a fallback for anything a contact may lack; preview_sequence lists variables that resolve empty.";

export const CONDITIONS_HELP =
  "Conditions (branch, enrollment, exit): a list of rules (all must match) or {logicalOperator:'AND'|'OR', conditions:[...]}; a rule may be one nested group. Rules use the outbound format: " +
  "did event at least once {event:'booked_demo', type:'count', matchOperator:'greaterthan', data:0}; never did it {event:'booked_demo', type:'count', matchOperator:'is', data:0}; " +
  "contact attribute {event:'gleap-up-plan', type:'latestdata', matchOperator:'is', data:'pro'} (custom data: event 'gleap-up-customData.<key>'; operators is, isnot, contains, notcontains, startswith, endswith, greaterthan, lessthan, empty, notempty); " +
  "tag {event:'tags', type:'latestdata', matchOperator:'in'|'notin', data:'vip'}; event date {event, type:'firstoccured'|'lastoccured', dateOperator:'relative', matchOperator:'greaterthan'|'lessthan', data:<seconds ago>}. " +
  "Use event and attribute names from get_targeting_options; rules on untracked events match nobody.";

export const STEPS_HELP =
  "Steps: a list read top to bottom; every step has a unique string id (≤64 chars, e.g. 'welcome') and a type. " +
  "email {subject, content, preheader?, look?: plain|personal|company, threadWithPrevious?} — content is plain text (blank line = new paragraph, variables allowed; the server converts it) or a TipTap doc; " +
  "later emails are sent as \"Re: <first subject>\" in the same thread unless threadWithPrevious:false (then they need their own subject). " +
  "Kai-written email: add kai {enabled: true, prompt: \"what to write, e.g. a day-3 check-in that mentions one thing they set up and offers a call\"}: Kai writes each contact their own subject and message when the step is due, from their activity, company, conversations, help center and website (billed as AI usage); subject/content become the optional fallback for people Kai knows nothing specific about (without one the step is skipped for them). " +
  "message {content, online?}: in-app chat message (emailed if not seen). " +
  "survey {outboundId, online?}: shows an existing survey (list_surveys; a draft works, its own audience and schedule don't apply) in the app. " +
  "push {outboundId}: sends an existing push notification (list_outbound_messages type PUSH) to the contact's devices; contacts without your mobile app skip it. " +
  "whatsapp {outboundId}: sends an existing WhatsApp message (list_outbound_messages type WHATSAPP, an approved template) to the contact's phone; contacts without a phone number skip it. " +
  "online (message and survey): {enabled: true, amount, unit, fallback: 'email'|'skip', subject, content}: wait up to amount unit for the contact to be active in the app, else send the fallback email (subject + content, like an email step) or skip. " +
  "wait {amount, unit}: units minutes|hours|days|businessDays|weeks (businessDays skip Sat/Sun), max 365 days. " +
  "waitUntil {event, amount, unit, yes:[...], no:[...]}: waits until the contact does event (only while waiting) at most amount unit; did it → yes, timed out → no. " +
  "branch {name?, conditions, yes:[...], no:[...]}: if/else on the contact now. Or an engagement branch {mode:'engagement', engagement:{action:'opened'|'clicked'|'replied', stepId?: an email step's id (omit: any email so far)}, yes, no}: did they open / click / reply to the sequence's emails (put a wait before it). Empty yes/no paths continue after the step; paths nest ≤5 deep, ≤100 steps in total. " +
  "tag {op:'add'|'remove', tag}. attribute {key, value}: sets custom data key (value may use variables). pipeline {pipelineId, laneId?} (get_pipelines): add the contact to a CRM pipeline/stage. " +
  "sequence {sequenceId}: enroll in another sequence. exit {}: end here.";

export const SETTINGS_HELP =
  "enrollment {triggers:[{type:'event', event}|{type:'contactCreated'}] (manual enrolling always works; a workflow's 'Enroll in sequence' action enrolls too), " +
  "targetAudience: all|users|guests, conditions (checked for automatic triggers only), reenroll: never|always|after, reenrollAfterDays}. " +
  "exit {onReply (default false, like Intercom: a reply keeps the sequence going and is something to branch on; true: a reply to the sequence's own emails or chat message ends it; auto-replies always pause), onNewConversation (default false: also end on a message in any other conversation), events:['booked_demo'], conditions (checked before every step)}. " +
  "goal {event, withinDays 1-365 (default 14), exitOnGoal (default true)}: conversion = goal event tracked within withinDays of enrolling; null removes it. " +
  "sending {senderId (a teammate's user id, get_users), emailType: personal (1:1, no unsubscribe link) | marketing (unsubscribe link), emailLook: plain|personal|company, " +
  "repliesTo {type:'sender'} (default) | {type:'teammate', userId (get_users)} | {type:'team', teamId (get_teams)} | {type:'none'}: who gets the conversation when a contact replies, " +
  "window {enabled, days:[1,2,3,4,5] (0=Sun), startHour 0-23, endHour 1-24, timezone IANA e.g. 'Europe/Vienna'}}: messages wait for the window.";

/** The worked example from the tool descriptions, as a ready definition. */
export const ONBOARDING_EXAMPLE = {
  name: "Onboarding",
  enrollment: { triggers: [{ type: "contactCreated" }], targetAudience: "users" },
  goal: { event: "invited_teammate", withinDays: 14, exitOnGoal: false },
  steps: [
    { id: "welcome", type: "email", subject: "Welcome to {{project.name}}", content: "Hi {{session.firstName|there}},\n\nThanks for signing up! Reply to this email if you get stuck." },
    { id: "pause", type: "wait", amount: 2, unit: "businessDays" },
    {
      id: "invited", type: "waitUntil", event: "invited_teammate", amount: 3, unit: "businessDays",
      yes: [{ id: "tag_activated", type: "tag", op: "add", tag: "activated" }],
      no: [{ id: "nudge", type: "email", content: "Hi {{session.firstName|there}},\n\nTeams that invite a colleague get much more out of it. Want a hand?" }],
    },
  ],
};

/** What "New sequence" offers (Server sequence.templates.ts; round 3: day waits in business days). */
export const TEMPLATE_INFO = [
  {
    template: "blank",
    name: "Untitled sequence",
    enrollment: "manual only",
    exit: "replies keep it going",
    steps: [],
  },
  {
    template: "onboarding",
    name: "Onboarding",
    enrollment: "manual + when a contact is created",
    exit: "replies keep it going",
    steps: ["email \"Welcome to {{project.name}}\"", "wait 2 business days", "email \"Quick tip\" (invite a teammate)", "wait 4 business days", "email \"How is it going?\""],
  },
  {
    template: "trial",
    name: "Trial conversion",
    enrollment: "manual + on event trial_started",
    exit: "replies keep it going; goal: subscribed within 14 days (ends the sequence)",
    steps: ["email \"Your trial has started\"", "wait 3 business days", "if invited_teammate count > 0 → yes: email \"Nice work\" / no: email \"Need a hand?\"", "wait 3 business days", "email \"Your trial ends soon\""],
  },
  {
    template: "reengage",
    name: "Re-engagement",
    enrollment: "manual only",
    exit: "on reply (win back stops when they answer)",
    steps: ["email \"We miss you\"", "wait 5 business days", "email \"Anything we could do better?\""],
  },
];

export const ENROLL_SKIP_REASONS: Record<string, string> = {
  notFound: "no contact with this email / userId / id in the project",
  alreadyEnrolled: "already in the sequence, or finished it and re-enrollment does not allow another run",
  notLive: "the sequence is not live",
  empty: "the sequence has no steps",
  audience: "outside the sequence's audience or enrollment conditions",
  plan: "the project's plan does not include sequences",
  otherProject: "the contact belongs to another project",
  noEmail: "the contact has no email address",
};
