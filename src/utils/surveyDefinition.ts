/**
 * Survey definition helpers (Surveys 2.0, SURVEYS_V2_SPEC.md §2). Pure: no
 * I/O, so the guards are unit-testable.
 *
 * The Server's validateSurveyDefinition is the authority (it also checks
 * reachability and runs on every draft save and publish). These checks catch
 * the mistakes agents make most — dangling or backward jump targets,
 * duplicate ids/keys, conditions that cannot match the block type — before
 * anything is written, with messages that say how to fix them.
 */

type Doc = Record<string, any>;
export type DefinitionIssue = { path: (string | number)[]; message: string };

export const SURVEY_LIMITS = { blocks: 60, endings: 10, choices: 25, jumps: 20, fields: 30 };

const SCALE_TYPES = new Set(["nps", "csat", "rating", "scale"]);
const NUMERIC_TYPES = new Set([...SCALE_TYPES, "number"]);
const TEXT_TYPES = new Set(["short", "long", "email", "date"]);

/** The fixed or configured numeric range of a block, or null when unknown. */
export const blockRange = (block: Doc): [number, number] | null => {
  if (block.type === "nps") return [0, 10];
  if (block.type === "csat") return [1, 5];
  if ((block.type === "rating" || block.type === "scale") &&
    typeof block.scaleMin === "number" && typeof block.scaleMax === "number") {
    return [block.scaleMin, block.scaleMax];
  }
  return null;
};

/**
 * A contact question asks for a contact property (Server knownContact.ts
 * contactFieldOf): every email question, and short questions with a
 * contactField. Only these can skip when the contact is known.
 */
export const isContactQuestion = (block: Doc): boolean =>
  block.type === "email" || (block.type === "short" && (block.contactField === "name" || block.contactField === "phone"));

const list = (ids: string[]) => {
  const shown = ids.slice(0, 12).join(", ");
  return ids.length > 12 ? `${shown}, …` : shown;
};

/** Problems with an answer condition on `block`, or null. */
const answerConditionProblem = (block: Doc, cond: Doc): string | null => {
  const type = block.type;
  if (type === "statement") return "statement blocks have no answer; use a person condition (contact/field/url) or `next`";
  if (cond.op === "answered" || cond.op === "skipped") return null;
  if (cond.op === "between") {
    if (!NUMERIC_TYPES.has(type)) return `between needs a numeric block (nps/csat/rating/scale/number), not ${type}`;
    const [min, max] = cond.value as [number, number];
    if (min > max) return `between [${min}, ${max}]: min is greater than max`;
    const range = blockRange(block);
    if (range && (min < range[0] || max > range[1])) {
      return `between [${min}, ${max}] is outside the ${type} range ${range[0]}-${range[1]}`;
    }
    return null;
  }
  const choiceIds = (block.choices ?? []).map((choice: Doc) => choice.id);
  if (cond.op === "includes") {
    if (type !== "multi") return `includes is for multi blocks; use { op: 'eq', value: <choice id> } for ${type}`;
    return choiceIds.includes(cond.value) ? null
      : `"${cond.value}" is not a choice id of this block (choice ids: ${list(choiceIds)}); conditions use choice ids, not labels`;
  }
  // eq / neq
  if (type === "multi") return "multi answers are lists; use { op: 'includes', value: <choice id> }";
  if (type === "single") {
    if (cond.value === "other" && block.allowOther) return null;
    return typeof cond.value === "string" && choiceIds.includes(cond.value) ? null
      : `"${String(cond.value)}" is not a choice id of this block (choice ids: ${list(choiceIds)}); conditions use choice ids, not labels`;
  }
  if (type === "yesno") return typeof cond.value === "boolean" ? null : "yesno answers are true or false";
  if (NUMERIC_TYPES.has(type)) {
    if (typeof cond.value !== "number") return `${type} answers are numbers; use a number or { op: 'between', value: [min, max] }`;
    const range = blockRange(block);
    return range && (cond.value < range[0] || cond.value > range[1])
      ? `${cond.value} is outside the ${type} range ${range[0]}-${range[1]}` : null;
  }
  if (TEXT_TYPES.has(type)) return typeof cond.value === "string" ? null : `${type} answers are text`;
  return `${type} answers can only be checked with answered/skipped`;
};

/**
 * Structural problems of a definition (shape already checked by Zod), each
 * with the path to fix. Empty when the definition is fine as far as the MCP
 * can tell.
 */
export const definitionIssues = (definition: Doc): DefinitionIssue[] => {
  const issues: DefinitionIssue[] = [];
  const blocks: Doc[] = Array.isArray(definition.blocks) ? definition.blocks : [];
  const endings: Doc[] = Array.isArray(definition.endings) ? definition.endings : [];
  const fieldKeys = new Set((definition.fields ?? []).map((field: Doc) => field.key));

  const seenIds = new Map<string, string>();
  const claim = (id: string, path: (string | number)[]) => {
    const where = path.join(".");
    if (seenIds.has(id)) issues.push({ path: [...path, "id"], message: `id "${id}" is already used by ${seenIds.get(id)}; ids must be unique across blocks and endings` });
    else seenIds.set(id, where);
  };
  blocks.forEach((block, i) => claim(block.id, ["blocks", i]));
  endings.forEach((ending, i) => claim(ending.id, ["endings", i]));

  const welcome: Doc | undefined = definition.welcome;
  if (welcome?.enabled && !textOf(welcome.title)?.trim()) {
    issues.push({ path: ["welcome", "title"], message: "the welcome screen needs a title when enabled" });
  }

  const seenKeys = new Set<string>();
  blocks.forEach((block, i) => {
    if (seenKeys.has(block.key)) issues.push({ path: ["blocks", i, "key"], message: `key "${block.key}" is used twice; answer keys must be unique` });
    seenKeys.add(block.key);
  });
  const seenFields = new Set<string>();
  (definition.fields ?? []).forEach((field: Doc, i: number) => {
    if (seenFields.has(field.key)) issues.push({ path: ["fields", i, "key"], message: `hidden field "${field.key}" is listed twice` });
    seenFields.add(field.key);
  });

  const blockIndex = new Map(blocks.map((block, i) => [block.id, i]));
  const endingIds = new Set(endings.map((ending) => ending.id));
  const allTargets = [...blocks.map((block) => block.id), ...endings.map((ending) => ending.id)];
  const targetProblem = (from: number, target: string): string | null => {
    if (endingIds.has(target)) return null;
    const index = blockIndex.get(target);
    if (index === undefined) return `"${target}" is not a block or ending id (ids: ${list(allTargets)})`;
    if (index <= from) return `"${target}" is not after this block; jumps only go forward (no loops). Reorder the blocks or jump to an ending`;
    return null;
  };

  blocks.forEach((block, i) => {
    const at = ["blocks", i];
    if (block.type === "single" || block.type === "multi") {
      const choices: Doc[] = block.choices ?? [];
      if (choices.length === 0) issues.push({ path: [...at, "choices"], message: `${block.type} blocks need choices: [{ id, label }]` });
      const seen = new Set<string>();
      choices.forEach((choice, c) => {
        if (seen.has(choice.id)) issues.push({ path: [...at, "choices", c, "id"], message: `choice id "${choice.id}" is used twice in this block` });
        seen.add(choice.id);
      });
      if (block.type === "multi" && typeof block.maxSelect === "number" && typeof block.minSelect === "number" && block.minSelect > block.maxSelect) {
        issues.push({ path: [...at, "minSelect"], message: "minSelect is greater than maxSelect" });
      }
    } else if (Array.isArray(block.choices) && block.choices.length > 0) {
      issues.push({ path: [...at, "choices"], message: `choices only apply to single/multi blocks, not ${block.type}` });
    }
    if ((block.type === "rating" || block.type === "scale") &&
      typeof block.scaleMin === "number" && typeof block.scaleMax === "number" && block.scaleMin >= block.scaleMax) {
      issues.push({ path: [...at, "scaleMax"], message: "scaleMax must be greater than scaleMin" });
    }
    if (block.type === "statement" && block.required === true) {
      issues.push({ path: [...at, "required"], message: "statement blocks have no answer and cannot be required" });
    }
    if (block.contactField !== undefined && block.type !== "short") {
      issues.push({ path: [...at, "contactField"], message: `contactField only applies to short questions, not ${block.type}; an email question already asks for the email` });
    }
    if (block.skipWhenKnown === true && !isContactQuestion(block)) {
      issues.push({ path: [...at, "skipWhenKnown"], message: "skipWhenKnown applies to email questions and short questions with contactField 'name' or 'phone'" });
    }
    (block.jumps ?? []).forEach((jump: Doc, j: number) => {
      const target = targetProblem(i, jump.go);
      if (target) issues.push({ path: [...at, "jumps", j, "go"], message: target });
      const cond = jump.if ?? {};
      if (cond.src === "answer") {
        const problem = answerConditionProblem(block, cond);
        if (problem) issues.push({ path: [...at, "jumps", j, "if"], message: problem });
      } else if (cond.src === "field" && !fieldKeys.has(cond.key)) {
        issues.push({ path: [...at, "jumps", j, "if", "key"], message: `"${cond.key}" is not a hidden field; add { key: "${cond.key}" } to definition.fields` });
      } else if ((cond.src === "contact" || cond.src === "field") && cond.op !== "exists" && cond.value === undefined) {
        issues.push({ path: [...at, "jumps", j, "if", "value"], message: `${cond.op} needs a value` });
      }
    });
    if (block.next !== undefined && block.next !== null) {
      const target = targetProblem(i, block.next);
      if (target) issues.push({ path: [...at, "next"], message: target });
    }
  });
  return issues;
};

const asLocalized = (value: unknown, language: string): unknown =>
  typeof value === "string" ? { [language]: value } : value;

/**
 * The stored form (SurveyDefinition) of an accepted input definition:
 * plain-string texts become `{ [defaultLanguage]: text }`, omitted defaults
 * are filled in, `format` comes from the tool argument when given.
 */
export const normalizeDefinition = (input: Doc, format?: string): Doc => {
  const language = typeof input.defaultLanguage === "string" ? input.defaultLanguage : "en";
  const loc = (value: unknown) => (value === undefined ? undefined : asLocalized(value, language));
  const drop = (doc: Doc) => Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined));
  return drop({
    schemaVersion: 2,
    format: format ?? input.format ?? "card",
    defaultLanguage: language,
    welcome: input.welcome
      ? drop({
        ...input.welcome,
        enabled: input.welcome.enabled === true,
        title: loc(input.welcome.title) ?? {},
        description: loc(input.welcome.description),
        buttonLabel: loc(input.welcome.buttonLabel),
      })
      : undefined,
    blocks: (input.blocks ?? []).map((block: Doc) => drop({
      ...block,
      title: loc(block.title),
      description: loc(block.description),
      lowLabel: loc(block.lowLabel),
      highLabel: loc(block.highLabel),
      placeholder: loc(block.placeholder),
      choices: block.choices?.map((choice: Doc) => ({ id: choice.id, label: loc(choice.label) })),
      required: block.type === "statement" ? false : block.required === true,
      jumps: block.jumps ?? [],
      next: block.next ?? null,
    })),
    endings: (input.endings ?? []).map((ending: Doc) => drop({
      ...ending,
      title: loc(ending.title),
      description: loc(ending.description),
      button: ending.button ? { label: loc(ending.button.label), url: ending.button.url } : undefined,
    })),
    fields: input.fields ?? [],
    theme: input.theme,
    showProgress: input.showProgress ?? true,
    allowSkipBack: input.allowSkipBack ?? true,
    sender: input.sender,
  });
};

/**
 * A stored definition without database bookkeeping (`_id`, `__v`) and null
 * placeholders (except `next`, where null means "next block in order"), safe
 * to hand back to update_survey.
 */
export const cleanDefinition = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cleanDefinition);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Doc)
      .filter(([key, inner]) => key !== "_id" && key !== "__v" && (inner !== null || key === "next"))
      .map(([key, inner]) => [key, cleanDefinition(inner)]));
  }
  return value;
};

/** One display string of a localized text. */
export const textOf = (value: unknown, language = "en"): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const map = value as Record<string, unknown>;
  const pick = map[language] ?? map.en ?? Object.values(map)[0];
  return typeof pick === "string" ? pick : null;
};

/** Legacy outbound `format` → 2.0 format. */
export const formatOf = (survey: Doc): string | null => {
  const v2 = survey?.survey?.draft?.format ?? survey?.survey?.published?.format;
  if (v2) return v2;
  if (survey?.format === "survey_full" || survey?.format === "survey_web") return "full";
  if (survey?.format === "survey") return "card";
  return survey?.format ?? null;
};

const stable = (value: unknown): string => JSON.stringify(cleanDefinition(value), (_key, inner) =>
  inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    : inner);

/** Whether the draft differs from the published definition (true when never published). */
export const hasUnpublishedChanges = (survey: Doc): boolean => {
  const v2 = survey?.survey;
  if (!v2?.draft) return false;
  if (!v2.published) return true;
  return stable(v2.draft) !== stable(v2.published);
};
