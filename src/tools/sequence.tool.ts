import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import {
  CreateSequenceArgs, EnrollInSequenceArgs, EnrollmentRefArgs, GetSequenceTemplatesArgs, ListSequenceEnrollmentsArgs,
  ListSequencesArgs, ManageSequenceEnrollmentArgs, PreviewSequenceArgs, SendSequenceTestEmailArgs, SequenceRefArgs,
  SetSequenceStatusArgs, UpdateSequenceArgs,
} from "../schemas/sequence.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapDelete, gleapGetData, gleapPost, gleapPut, validationErrorResponse, wrapResponse } from "../utils/api.js";
import { getCredsOrThrow } from "../utils/credentials.js";
import {
  CONDITIONS_HELP, ENROLL_SKIP_REASONS, MAX_ENROLL, ONBOARDING_EXAMPLE, SETTINGS_HELP, STEPS_HELP, TEMPLATE_INFO, VARIABLES_HELP,
  applyStepChanges, conditionsProblems, goLiveWarnings, mergeSettings, normalizeSteps, outline, stepLabel, stepLabels, stepView, stepsProblems,
  triggerSummary, walkSteps,
} from "../utils/sequenceRules.js";

// Outreach › Sequences (Server api/sequences, `/v3/sequences`): the same routes
// the dashboard editor uses, so project scoping, role permission
// (engagement.email.*), the plan gate and the go-live checks all run there.
const PATH = "/sequences";
const SETTING_KEYS = ["enrollment", "exit", "goal", "sending", "steps"] as const;

type Doc = Record<string, any>;

const fail = (message: string): GleapApiResponse => ({ ...validationErrorResponse(message), isError: true });
const apiFailed = (response: GleapApiResponse) => response.isError || response.structuredContent?.error === true;
const idOf = (doc: Doc) => String(doc?.id ?? doc?._id ?? "");
const at = (sequenceId: string, suffix = "") => `${PATH}/${encodeURIComponent(sequenceId)}${suffix}`;

const reviewUrl = (sequenceId: string) =>
  `${GLEAP_DASHBOARD_BASE}/projects/${encodeURIComponent(getCredsOrThrow().projectId)}/engagement/sequences/${encodeURIComponent(sequenceId)}`;

/** The definition the next publish would make live: unpublished changes over the published fields. */
const effective = (sequence: Doc): Doc => {
  const draft = sequence.draft ?? {};
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, draft[key] !== undefined ? draft[key] : sequence[key]]));
};

const hasDraft = (sequence: Doc) => !!sequence.draft && SETTING_KEYS.some((key) => sequence.draft[key] !== undefined);

async function loadSequence(sequenceId: string): Promise<{ sequence: Doc } | { error: GleapApiResponse }> {
  const current = await gleapGetData(at(sequenceId));
  if ("error" in current) return { error: { ...current.error, isError: true } };
  const sequence = current.data as Doc | null;
  if (!sequence || typeof sequence !== "object") return { error: fail("No sequence with this ID in this project.") };
  return { sequence };
}

const listRow = (sequence: Doc) => ({
  id: idOf(sequence),
  name: sequence.name ?? null,
  status: sequence.status ?? null,
  trigger: triggerSummary(sequence.enrollment),
  goal: sequence.goal?.event ?? null,
  steps: (() => { let count = 0; walkSteps(sequence.steps, () => { count += 1; }); return count; })(),
  counts: sequence.counts ?? null,
  summary: sequence.summary ?? null,
  hasUnpublishedChanges: hasDraft(sequence),
  updatedAt: sequence.updatedAt ?? null,
  reviewUrl: reviewUrl(idOf(sequence)),
});

const definitionView = (definition: Doc) => ({
  trigger: triggerSummary(definition.enrollment),
  enrollment: definition.enrollment ?? null,
  exit: definition.exit ?? null,
  goal: definition.goal ?? null,
  sending: definition.sending ?? null,
  outline: outline(definition.steps),
  steps: (definition.steps ?? []).map(stepView),
});

const sequenceView = (sequence: Doc) => {
  const draft = hasDraft(sequence) ? sequence.draft : null;
  const next = effective(sequence);
  const problems = goLiveWarnings(next);
  return {
    id: idOf(sequence),
    name: sequence.name ?? null,
    status: sequence.status ?? null,
    liveAt: sequence.liveAt ?? null,
    reviewUrl: reviewUrl(idOf(sequence)),
    ...definitionView(sequence),
    unpublishedChanges: draft ? {
      changed: SETTING_KEYS.filter((key) => draft[key] !== undefined),
      updatedAt: draft.updatedAt ?? null,
      ...Object.fromEntries(SETTING_KEYS.filter((key) => key !== "steps" && draft[key] !== undefined).map((key) => [key, draft[key]])),
      ...(draft.steps !== undefined ? { outline: outline(draft.steps), steps: draft.steps.map(stepView) } : {}),
    } : null,
    ...(problems.length > 0 ? { goLiveProblems: problems } : {}),
  };
};

const contentNote = "Step content is shown as plain text where it has no formatting (send it back as text and it stays the same); formatted content stays TipTap JSON.";

/** Refusals before any write: steps, conditions, and nothing to change. */
const definitionProblems = (input: Doc): string[] => [
  ...(input.steps !== undefined ? stepsProblems(input.steps) : []),
  ...(input.enrollment?.conditions !== undefined ? conditionsProblems(input.enrollment.conditions, "enrollment.conditions") : []),
  ...(input.exit?.conditions !== undefined ? conditionsProblems(input.exit.conditions, "exit.conditions") : []),
];

const refuse = (problems: string[]) => fail(`Invalid sequence definition: ${problems.join("; ")}.`);

/** The PUT body for the settings and steps passed, merged onto `base` (the Server replaces each setting whole). */
const putBody = (base: Doc, input: Doc): Doc => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...mergeSettings(base, input),
  ...(input.steps !== undefined ? { steps: normalizeSteps(input.steps) } : {}),
});

const nextStepAfterSave = (sequence: Doc) => {
  if (sequence.status === "draft") {
    return "Not live. Check every message with preview_sequence (and send_sequence_test_email for emails), then set_sequence_status live once the operator approves.";
  }
  return hasDraft(sequence)
    ? "Saved as unpublished changes: the live sequence keeps running the published version. Check them with preview_sequence, then publish_sequence_changes after the operator approves (discard_sequence_changes drops them)."
    : "Applied to the sequence.";
};

const enrollmentView = (enrollment: Doc, labels: Map<string, string>) => {
  const session = enrollment.session && typeof enrollment.session === "object" ? enrollment.session : null;
  const last = Array.isArray(enrollment.history) && enrollment.history.length > 0 ? enrollment.history[enrollment.history.length - 1] : null;
  return {
    id: idOf(enrollment),
    contact: session
      ? { id: idOf(session), name: session.name ?? null, email: session.email ?? null, userId: session.userId ?? null }
      : { id: enrollment.session ?? null },
    status: enrollment.status ?? null,
    currentStep: enrollment.currentStepId ? { id: enrollment.currentStepId, label: labels.get(enrollment.currentStepId) ?? null } : null,
    nextRunAt: enrollment.nextRunAt ?? null,
    waitingFor: enrollment.waitingFor?.event ?? null,
    enrolledAt: enrollment.enrolledAt ?? null,
    enrolledBy: enrollment.enrolledBy ?? null,
    finishedAt: enrollment.finishedAt ?? null,
    exitReason: enrollment.exitReason ?? null,
    goalReachedAt: enrollment.goalReachedAt ?? null,
    ...(last ? { lastEvent: { ...last, label: labels.get(last.stepId) ?? null } } : {}),
  };
};

const EXAMPLE = JSON.stringify(ONBOARDING_EXAMPLE);

export function registerSequenceTools(server: McpServer) {
  server.registerTool("list_sequences", {
    title: "List Sequences",
    description: "List the project's sequences (Outreach › Sequences: multi-step sequences of emails, chat messages, surveys, push notifications and WhatsApp messages that contacts are enrolled in), most recently changed first: name, status (draft/live/paused), how contacts get enrolled, goal, step count, enrollment counts and summary (enrolled, active, reply rate, goal rate), whether unpublished changes wait, and the dashboard reviewUrl.",
    inputSchema: ListSequencesArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = ListSequencesArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const list = await gleapGetData(PATH);
    if ("error" in list) return list.error;
    const rows = (Array.isArray(list.data) ? list.data : [])
      .filter((sequence: Doc) => !parsed.data.status || sequence?.status === parsed.data.status)
      .map((sequence: Doc) => listRow(sequence));
    return wrapResponse({ results: rows, count: rows.length });
  });

  server.registerTool("get_sequence", {
    title: "Get Sequence",
    description:
      "Read one sequence in full: enrollment (triggers, audience, conditions, re-enrollment), exit rules, goal, sending (sender, email type/look, who gets replies, window), the step tree as an indented outline with step ids plus the editable steps JSON, " +
      "unpublished changes (a live/paused sequence's edits wait there until publish_sequence_changes) and goLiveProblems (what still blocks going live). " + contentNote,
    inputSchema: SequenceRefArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = SequenceRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadSequence(parsed.data.sequenceId);
    if ("error" in loaded) return loaded.error;
    return wrapResponse(sequenceView(loaded.sequence));
  });

  server.registerTool("get_sequence_templates", {
    title: "Get Sequence Templates",
    description: "The starter templates create_sequence accepts (blank, onboarding, trial, reengage) with their triggers, exit rules and steps, plus the full reference for building a sequence yourself: step types, settings, condition format, variables and a worked example. Static; reads nothing from the project.",
    inputSchema: GetSequenceTemplatesArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = GetSequenceTemplatesArgs.safeParse(input ?? {});
    if (!parsed.success) return fail(parsed.error.message);
    return wrapResponse({
      templates: TEMPLATE_INFO,
      reference: { steps: STEPS_HELP, settings: SETTINGS_HELP, conditions: CONDITIONS_HELP, variables: VARIABLES_HELP },
      example: ONBOARDING_EXAMPLE,
    });
  });

  server.registerTool("create_sequence", {
    title: "Create Sequence",
    description:
      "Create a sequence (always a draft: nothing is sent until set_sequence_status live). Start from a template and/or pass the whole definition in one call. " +
      "Workflow: get_targeting_options for real event/attribute names → create_sequence → preview_sequence (renders every message for a contact, lists missing variables) → send_sequence_test_email → set_sequence_status live after the operator approves. " +
      "The parameters document every step type, setting and the condition format. " +
      `${VARIABLES_HELP} ` +
      `Example (onboarding: welcome email → wait 2 business days → wait until invited_teammate up to 3 business days → yes: tag activated / no: nudge email; the nudge has no subject because it is sent as a reply in the welcome thread): ${EXAMPLE}. ` +
      "Invalid definitions are refused with the exact field; the server's own validation messages are returned verbatim. Returns the sequence, goLiveProblems (unfinished steps) and reviewUrl.",
    inputSchema: CreateSequenceArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = CreateSequenceArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { template, name, timezone, ...definition } = parsed.data;
    const problems = definitionProblems(definition);
    if (problems.length > 0) return refuse(problems);

    const created = await gleapPost(PATH, {
      template: template ?? "blank",
      ...(name ? { name } : {}),
      ...(timezone ? { timezone } : {}),
    });
    if (apiFailed(created)) return { ...created, isError: true };
    let sequence = created.structuredContent as Doc;
    const id = idOf(sequence);
    if (!id) return fail("The sequence was not created (no id returned).");

    if (SETTING_KEYS.some((key) => (definition as Doc)[key] !== undefined)) {
      const saved = await gleapPut(at(id), putBody(sequence, definition));
      if (apiFailed(saved)) {
        return {
          ...saved,
          isError: true,
          content: [...saved.content, {
            type: "text" as const,
            text: `The sequence was created as a draft (id ${id}, ${reviewUrl(id)}) but this definition was not saved. Fix it and call update_sequence with sequenceId ${id}; do not create it again.`,
          }],
        };
      }
      sequence = saved.structuredContent as Doc;
    }
    return wrapResponse({ ...sequenceView(sequence), nextStep: nextStepAfterSave(sequence), note: contentNote });
  });

  server.registerTool("update_sequence", {
    title: "Update Sequence",
    description:
      "Change a sequence: name, enrollment, exit, goal, sending (each merged: only the keys you pass change) and steps (steps replaces the whole list; stepChanges edits fields of existing steps by id). " +
      "Same step and settings format as create_sequence. On a draft sequence changes apply directly. On a live or paused sequence they are saved as unpublished changes: contacts keep getting the published version " +
      "until publish_sequence_changes (contacts sitting on a removed step move to the next remaining step then); discard_sequence_changes drops them. Edit on top of get_sequence (its unpublishedChanges when present). " +
      "Invalid definitions are refused with the exact field; the server's own validation messages are returned verbatim.",
    inputSchema: UpdateSequenceArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = UpdateSequenceArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, stepChanges, ...changes } = parsed.data;
    if (stepChanges && changes.steps) return fail("Pass either steps (the whole list) or stepChanges (edits by id), not both.");
    if (!stepChanges && Object.values(changes).every((value) => value === undefined)) {
      return fail("Nothing to change: pass name, enrollment, exit, goal, sending, steps or stepChanges.");
    }
    const problems = definitionProblems(changes);
    if (problems.length > 0) return refuse(problems);

    const loaded = await loadSequence(sequenceId);
    if ("error" in loaded) return loaded.error;
    const base = effective(loaded.sequence);
    let steps = changes.steps as Doc[] | undefined;
    if (stepChanges) {
      const applied = applyStepChanges(base.steps ?? [], stepChanges as Doc[]);
      if ("error" in applied) return fail(applied.error);
      const changedProblems = stepsProblems(applied.steps);
      if (changedProblems.length > 0) return refuse(changedProblems);
      steps = applied.steps;
    }
    const saved = await gleapPut(at(sequenceId), putBody(base, { ...changes, steps }));
    if (apiFailed(saved)) return { ...saved, isError: true };
    const sequence = saved.structuredContent as Doc;
    return wrapResponse({ ...sequenceView(sequence), nextStep: nextStepAfterSave(sequence) });
  });

  server.registerTool("publish_sequence_changes", {
    title: "Publish Sequence Changes",
    description: "Make a live or paused sequence's unpublished changes (from update_sequence) the version contacts get. The server validates them like going live (400 messages returned verbatim); contacts sitting on a step the changes removed move on to the next remaining step. Only after the operator approved the changes.",
    inputSchema: SequenceRefArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = SequenceRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadSequence(parsed.data.sequenceId);
    if ("error" in loaded) return loaded.error;
    if (!hasDraft(loaded.sequence)) return wrapResponse({ ...sequenceView(loaded.sequence), note: "No unpublished changes; nothing changed." });
    const published = await gleapPost(at(parsed.data.sequenceId, "/publish"), {});
    if (apiFailed(published)) return { ...published, isError: true };
    return wrapResponse(sequenceView(published.structuredContent as Doc));
  });

  server.registerTool("discard_sequence_changes", {
    title: "Discard Sequence Changes",
    description: "Drop a live or paused sequence's unpublished changes; the published version stays as it is. Cannot be undone.",
    inputSchema: SequenceRefArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = SequenceRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const loaded = await loadSequence(parsed.data.sequenceId);
    if ("error" in loaded) return loaded.error;
    if (!hasDraft(loaded.sequence)) return wrapResponse({ ...sequenceView(loaded.sequence), note: "No unpublished changes; nothing changed." });
    const discarded = await gleapDelete(at(parsed.data.sequenceId, "/draft"));
    if (apiFailed(discarded)) return { ...discarded, isError: true };
    const reloaded = await loadSequence(parsed.data.sequenceId);
    if ("error" in reloaded) return reloaded.error;
    return wrapResponse(sequenceView(reloaded.sequence));
  });

  server.registerTool("set_sequence_status", {
    title: "Set Sequence Status",
    description:
      "Turn a sequence live or pause it. live: its triggers start enrolling contacts automatically and enrolled contacts get real emails, chat messages, surveys, push notifications and WhatsApp messages (a paused sequence resumes where each contact stopped). " +
      "Going live is validated by the server: every step complete (emails need subject and content, survey/push/whatsapp an outboundId, waits a duration, branches a condition or an engagement action, waitUntil an event and duration, actions their tag/key/pipeline/sequence) and event triggers need their event; the 400 message names the problem verbatim. " +
      "Before going live: preview_sequence and send_sequence_test_email, then only with the operator's explicit approval. " +
      "paused: nothing is sent and nobody new is enrolled; enrolled contacts wait where they are. Unpublished changes are not part of going live: publish_sequence_changes for those.",
    inputSchema: SetSequenceStatusArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, async (input: unknown) => {
    const parsed = SetSequenceStatusArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, status } = parsed.data;
    const loaded = await loadSequence(sequenceId);
    if ("error" in loaded) return loaded.error;
    if (loaded.sequence.status === status) return wrapResponse({ ...sequenceView(loaded.sequence), note: `Already ${status}; nothing changed.` });
    const saved = await gleapPost(at(sequenceId, "/status"), { status });
    if (apiFailed(saved)) {
      const hints = status === "live" ? goLiveWarnings(loaded.sequence) : [];
      return hints.length > 0
        ? { ...saved, isError: true, content: [...saved.content, { type: "text" as const, text: `Unfinished: ${hints.join(" ")} Fix with update_sequence.` }] }
        : { ...saved, isError: true };
    }
    const sequence = saved.structuredContent as Doc;
    return wrapResponse({
      ...sequenceView(sequence),
      note: status === "live"
        ? `Live. ${triggerSummary(sequence.enrollment)}; enroll_in_sequence adds contacts by hand.${hasDraft(sequence) ? " Unpublished changes are still waiting (publish_sequence_changes)." : ""}`
        : "Paused: nothing is sent and nobody new is enrolled until it is live again.",
    });
  });

  server.registerTool("enroll_in_sequence", {
    title: "Enroll In Sequence",
    description:
      `Enroll contacts in a live sequence by email, userId or Gleap contact id (up to ${MAX_ENROLL} in total). This contacts customers: enrolled contacts start getting the sequence's real messages (emails, chat messages, surveys, push, WhatsApp) right away (within the sending window). ` +
      "Manual enrolling skips the enrollment audience and conditions, but not re-enrollment rules. Only for contacts the operator asked to enroll. " +
      "Returns how many were enrolled and the skipped ones with reasons (notFound, alreadyEnrolled, notLive, empty, …).",
    inputSchema: EnrollInSequenceArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = EnrollInSequenceArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, emails = [], userIds = [], contactIds = [] } = parsed.data;
    const total = emails.length + userIds.length + contactIds.length;
    if (total === 0) return fail("Pass at least one of emails, userIds or contactIds.");
    if (total > MAX_ENROLL) return fail(`Enroll at most ${MAX_ENROLL} contacts per call (got ${total}).`);
    const loaded = await loadSequence(sequenceId);
    if ("error" in loaded) return loaded.error;
    if (loaded.sequence.status !== "live") {
      return fail(`The sequence is ${loaded.sequence.status}: only a live sequence enrolls contacts. Turn it on with set_sequence_status live (after the operator approves).`);
    }
    const result = await gleapPost(at(sequenceId, "/enrollments"), {
      ...(contactIds.length > 0 ? { sessionIds: contactIds } : {}),
      ...(emails.length > 0 ? { emails } : {}),
      ...(userIds.length > 0 ? { userIds } : {}),
    });
    if (apiFailed(result)) return { ...result, isError: true };
    const data = result.structuredContent as Doc;
    const skipped = (Array.isArray(data?.skipped) ? data.skipped : []).map((entry: Doc) => ({
      ...entry,
      why: ENROLL_SKIP_REASONS[entry?.reason] ?? entry?.reason ?? null,
    }));
    return wrapResponse({ enrolled: data?.enrolled ?? 0, skipped, requested: total, reviewUrl: `${reviewUrl(sequenceId)}/recipients` });
  });

  server.registerTool("get_sequence_stats", {
    title: "Get Sequence Stats",
    description: "Performance of a sequence: enrollment counts by status, summary (enrolled, active, replied, reply rate, goal reached, goal rate, emails sent), exit reasons, and per step in outline order: reached, done, skipped, failed, yes/no splits, contacts waiting there and, for emails, sent/opened/clicked/replied.",
    inputSchema: SequenceRefArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = SequenceRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const [loaded, stats] = await Promise.all([loadSequence(parsed.data.sequenceId), gleapGetData(at(parsed.data.sequenceId, "/stats"))]);
    if ("error" in loaded) return loaded.error;
    if ("error" in stats) return stats.error;
    const data = (stats.data ?? {}) as Doc;
    const perStep = data.steps ?? {};
    const steps: Doc[] = [];
    walkSteps(loaded.sequence.steps, (step, depth) => {
      steps.push({ stepId: step.id, depth, label: stepLabel(step), ...(perStep[step.id] ?? { reached: 0 }) });
    });
    return wrapResponse({
      id: idOf(loaded.sequence),
      name: loaded.sequence.name ?? null,
      status: loaded.sequence.status ?? null,
      goal: loaded.sequence.goal ?? null,
      counts: data.counts ?? null,
      summary: data.summary ?? null,
      exitReasons: data.exitReasons ?? null,
      steps,
    });
  });

  server.registerTool("list_sequence_enrollments", {
    title: "List Sequence Enrollments",
    description: "The contacts in a sequence, newest first: contact (name, email), status, the step they are on and when it runs, what they wait for, how they were enrolled, exit reason, goal reached, last timeline event. Filter by status (active / completed / exited) or search a name or email.",
    inputSchema: ListSequenceEnrollmentsArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = ListSequenceEnrollmentsArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, status, search, skip, limit } = parsed.data;
    const [loaded, list] = await Promise.all([
      loadSequence(sequenceId),
      gleapGetData(at(sequenceId, "/enrollments"), { params: { skip, limit, ...(status ? { status } : {}), ...(search ? { search } : {}) } }),
    ]);
    if ("error" in loaded) return loaded.error;
    if ("error" in list) return list.error;
    const labels = stepLabels(loaded.sequence.steps);
    const data = (list.data ?? {}) as Doc;
    const items = (Array.isArray(data.items) ? data.items : []).map((enrollment: Doc) => enrollmentView(enrollment, labels));
    return wrapResponse({ results: items, count: items.length, total: data.total ?? items.length, skip, limit });
  });

  server.registerTool("get_sequence_enrollment", {
    title: "Get Sequence Enrollment",
    description: "One contact's run through a sequence: status, current step and when it runs, and the full timeline (each step done/skipped/failed with detail, branch and waitUntil paths taken, exit reason).",
    inputSchema: EnrollmentRefArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = EnrollmentRefArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, enrollmentId } = parsed.data;
    const [loaded, enrollment] = await Promise.all([
      loadSequence(sequenceId),
      gleapGetData(at(sequenceId, `/enrollments/${encodeURIComponent(enrollmentId)}`)),
    ]);
    if ("error" in loaded) return loaded.error;
    if ("error" in enrollment) return enrollment.error;
    const labels = stepLabels(loaded.sequence.steps);
    const doc = (enrollment.data ?? {}) as Doc;
    return wrapResponse({
      ...enrollmentView(doc, labels),
      timeline: (Array.isArray(doc.history) ? doc.history : []).map((entry: Doc) => ({ ...entry, label: labels.get(entry?.stepId) ?? null })),
      reviewUrl: `${reviewUrl(sequenceId)}/recipients/${encodeURIComponent(enrollmentId)}`,
    });
  });

  server.registerTool("manage_sequence_enrollment", {
    title: "Manage Sequence Enrollment",
    description: "Pause, resume or exit one contact's run through a sequence. pause holds them on their step (nothing is sent to them); resume continues (a step that came due runs right away); exit ends the sequence for them for good. Only when the operator asked.",
    inputSchema: ManageSequenceEnrollmentArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = ManageSequenceEnrollmentArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, enrollmentId, action } = parsed.data;
    const loaded = await loadSequence(sequenceId);
    if ("error" in loaded) return loaded.error;
    const result = await gleapPost(at(sequenceId, `/enrollments/${encodeURIComponent(enrollmentId)}/${action}`), {});
    if (apiFailed(result)) return { ...result, isError: true };
    return wrapResponse(enrollmentView(result.structuredContent as Doc, stepLabels(loaded.sequence.steps)));
  });

  server.registerTool("preview_sequence", {
    title: "Preview Sequence",
    description:
      "Render every email and chat message of a sequence as one contact would get it (by email or contact id; default a sample contact with your own name and email): subject and text per step, and the variables that resolve empty without a fallback. " +
      "Nothing is saved or sent. Use it to check your work before set_sequence_status live or publish_sequence_changes; fix missing variables with a fallback ({{session.firstName|there}}).",
    inputSchema: PreviewSequenceArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = PreviewSequenceArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, email, contactId, includeHtml } = parsed.data;
    if (email && contactId) return fail("Pass either email or contactId, not both.");
    const [loaded, preview] = await Promise.all([
      loadSequence(sequenceId),
      gleapPost(at(sequenceId, "/preview"), { ...(contactId ? { sessionId: contactId } : {}), ...(email ? { email } : {}) }, { idempotent: true }),
    ]);
    if ("error" in loaded) return loaded.error;
    if (apiFailed(preview)) return { ...preview, isError: true };
    const data = preview.structuredContent as Doc;
    const labels = stepLabels(loaded.sequence.steps);
    const steps = (Array.isArray(data?.steps) ? data.steps : []).map(({ html, ...step }: Doc) => ({
      ...step,
      label: labels.get(step.stepId) ?? null,
      ...(includeHtml ? { html } : {}),
    }));
    const missing = [...new Set(steps.flatMap((step: Doc) => (Array.isArray(step.missing) ? step.missing : [])))];
    return wrapResponse({
      contact: data?.contact ?? null,
      steps,
      missingVariables: missing,
      ...(missing.length > 0 ? { fix: "Give these variables a fallback ({{path|fallback}}) or make sure contacts carry them." } : {}),
    });
  });

  server.registerTool("send_sequence_test_email", {
    title: "Send Sequence Test Email",
    description: "Send one email step as a test, exactly as a contact would get it (look, sender, signature, \"Re:\" for follow-ups), to your own address or up to 5 given addresses; variables use your own name. A Kai-written step (kai.enabled) is written by Kai for contactId (default: the most recently active contact) and that email is sent to you. Only to addresses the operator gave or their own. Not counted in the stats.",
    inputSchema: SendSequenceTestEmailArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: unknown) => {
    const parsed = SendSequenceTestEmailArgs.safeParse(input);
    if (!parsed.success) return fail(parsed.error.message);
    const { sequenceId, stepId, emails, contactId } = parsed.data;
    const loaded = await loadSequence(sequenceId);
    if ("error" in loaded) return loaded.error;
    let step: Doc | undefined;
    walkSteps(effective(loaded.sequence).steps, (candidate) => { if (candidate?.id === stepId) step = candidate; });
    if (!step) return fail(`No step ${stepId} in this sequence (get_sequence lists the step ids).`);
    if (step.type !== "email") return fail(`Step ${stepId} is a ${step.type} step; only email steps can be test-sent (preview_sequence renders chat messages).`);
    const sent = await gleapPost(at(sequenceId, `/steps/${encodeURIComponent(stepId)}/test`), { ...(emails ? { emails } : {}), ...(contactId ? { sessionId: contactId } : {}) });
    if (apiFailed(sent)) return { ...sent, isError: true };
    return wrapResponse({ ...(sent.structuredContent as Doc), stepId });
  });
}
