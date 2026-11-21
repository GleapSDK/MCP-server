import { z } from "zod";

export const GetWorkflowsArgs = z.object({});

export const GetWorkflowsAvailableForTicketArgs = z.object({
  ticketId: z
    .string()
    .describe(
      "The Gleap ticket ID (24-char ObjectId) to list startable workflows for.",
    ),
});

export const RunTicketWorkflowArgs = z.object({
  ticketId: z
    .string()
    .describe("The Gleap ticket ID (24-char ObjectId) to run the workflow on."),
  workflowId: z
    .string()
    .describe(
      "The workflow (bot) ID to start on the ticket. Must be a live workflow that is available for the ticket — call get_workflows_available_for_ticket to find valid IDs.",
    ),
});

// -------- The workflow builder (create_workflow_draft and friends) --------
// The Server checks every step again (api/bots/workflowSpec.logic), nested ones too.

const CHANNELS = ["widget", "email", "whatsapp", "instagram", "facebook", "telegram", "slack"] as const;
const TRIGGERS = ["none", "conversation_started", "ticket_created", "ticket_reopened", "conversation_closed", "customer_replied"] as const;
const AUDIENCE_OPERATORS = ["is", "is_not", "contains", "not_contains", "greater_than", "less_than", "is_empty", "not_empty", "more_than_days_ago", "less_than_days_ago"] as const;
const CONDITION_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "greater_than", "less_than", "is_empty", "not_empty", "is_true", "is_false", "includes"] as const;

const StepCondition = z.object({
  kind: z
    .enum(["tag", "office_hours", "customer_tag", "contact_field", "channel", "ai", "api_response", "forwarded_by"])
    .describe(
      'tag: the conversation has a ticket tag. office_hours: during or outside the support hours (optionally a team\'s). customer_tag: the contact has a tag (e.g. "VIP"). contact_field: a contact attribute (plan, country, a custom field) compared with a value. channel: the conversation came in on a channel. ai: a plain sentence AI decides yes/no on the customer\'s messages. api_response: a field of the answer of an api_call step before it (`step` = that step\'s name, `field` e.g. "status"). forwarded_by: a teammate forwarded the customer\'s email in (`person` = that teammate\'s email, or none for any teammate; operator not_equals = not forwarded by them).',
    ),
  step: z.string().optional().describe("api_response: the name of the api_call step whose answer it reads."),
  tag: z.string().optional(),
  person: z.string().optional().describe("forwarded_by: the teammate's email (none = any teammate)."),
  during: z.boolean().optional().describe("office_hours: true = during, false = outside."),
  team: z.string().optional().describe("office_hours: a team name, to use its hours."),
  field: z.string().optional().describe('contact_field: the attribute ("plan", "country", or a field name). api_response: the field of the answer ("status", "order.status").'),
  operator: z.enum(CONDITION_OPERATORS).optional().describe("contact_field / api_response / forwarded_by: how to compare (default equals)."),
  value: z.union([z.string(), z.number()]).optional().describe("contact_field / api_response: the value, spelled as stored."),
  channel: z.enum(CHANNELS).optional(),
  text: z.string().optional().describe('ai: the sentence, like "The customer asks about an invoice or a refund".'),
});

const WorkflowStep = z.object({
  type: z
    .enum(["message", "kai_answers", "ai_tag", "assign", "tag", "priority", "note", "close", "wait", "hand_to_agent", "rate", "end", "branch", "buttons", "api_call", "webhook", "sequence"])
    .describe(
      "message: send the customer `text` ({{session.name}}, {{session.email}}, or {{<api step name in camelCase>.<field>}} after an api_call step are filled in). kai_answers: Kai Support answers (ends the path; optional `text` is its first line). ai_tag: AI picks from `tags` (each \"tag\" or {tag, when}). assign: to a `team` or a `person` (email). tag: add `tags`. priority: set `priority` (High, Medium, Low). note: internal note `text`. close: close the conversation (ends the path). wait: `amount` + `unit`. hand_to_agent: hand to the customer agent `agent` (ends the path). rate: ask for a rating. end: end the workflow. branch: `branches` (each: name, match all|any, when: conditions, steps) and `otherwise` steps; steps after a branch run after whichever path ran. buttons: clickable choices for the customer: optional question `text`, `choices` (each: label, steps); ends the path like a branch, steps after it run after whichever choice ran. api_call: call an EXISTING Your API `endpoint` by its name (get_workflow_build_options), `inputs` maps each of its inputs to a value or a {{variable}}, optional `name`; its answer feeds later messages and api_response conditions. webhook: send the ticket out: an existing `webhook` or `integration` by name, or a new `url` the person gave you (https; it stays a placeholder until they confirm it in the editor). sequence: enroll the contact in the email sequence `sequence` (by name).",
    ),
  text: z.string().optional(),
  tags: z.array(z.union([z.string(), z.object({ tag: z.string(), when: z.string().optional() })])).optional(),
  team: z.string().optional(),
  person: z.string().optional(),
  priority: z.string().optional(),
  agent: z.string().optional(),
  amount: z.number().optional(),
  unit: z.enum(["minutes", "hours", "days"]).optional(),
  choices: z
    .array(
      z.object({
        label: z.string().describe('The button text, short ("Billing").'),
        steps: z.array(z.record(z.string(), z.any())).describe("What happens after this click (same shape as these steps)."),
      }),
    )
    .optional()
    .describe("buttons: the choices, 2 to 6 is usual."),
  endpoint: z.string().optional().describe("api_call: the Your API endpoint, by its name."),
  inputs: z.record(z.string(), z.string()).optional().describe("api_call: input name → value or {{variable}}."),
  name: z.string().optional().describe("api_call: a name for the step (its answer is {{<name in camelCase>.<field>}}). webhook with url: a name for the new webhook."),
  webhook: z.string().optional().describe("webhook: an existing webhook of Settings › Webhooks, by name."),
  integration: z.string().optional().describe('webhook: an integration that takes tickets (e.g. "Jira", "Slack · #support").'),
  url: z.string().optional().describe("webhook: a NEW https address the person gave you (never invent one). It is a placeholder they confirm in the editor."),
  sequence: z.string().optional().describe("sequence: the email sequence, by name."),
  branches: z
    .array(
      z.object({
        name: z.string().optional().describe('A short name for the path, like "Billing in office hours".'),
        match: z.enum(["all", "any"]).optional(),
        when: z.array(StepCondition).min(1),
        steps: z.array(z.record(z.string(), z.any())).describe("The steps of this path (same shape as these steps; a branch may hold another branch)."),
      }),
    )
    .optional(),
  otherwise: z.array(z.record(z.string(), z.any())).optional().describe("branch: the steps when no branch matches."),
});

const WorkflowSettings = {
  trigger: z
    .enum(TRIGGERS)
    .optional()
    .describe("When it starts: conversation_started (a new conversation; competes with Kai Support where Kai answers first), ticket_created, ticket_reopened, conversation_closed, customer_replied, or none (started by a button, another workflow or by hand). Default conversation_started."),
  channels: z.array(z.enum(CHANNELS)).optional().describe("Where it runs (default: widget for conversation_started, else widget and email)."),
  audience: z.enum(["all", "users", "guests"]).optional().describe("all (default), users (identified contacts) or guests."),
  audience_rules: z
    .array(
      z.object({
        field: z.string().describe('plan, country, email, language, company, a contact field, a custom data key, "customer tag", "signed up", "last seen".'),
        operator: z.enum(AUDIENCE_OPERATORS).optional().describe("Default is. Dates: more_than_days_ago / less_than_days_ago with days as value. customer tag: is / is_not."),
        value: z.union([z.string(), z.number()]).optional().describe('Spelled as contacts store it (look at a contact first when unsure, e.g. "pro" not "Pro").'),
      }),
    )
    .max(10)
    .optional()
    .describe("Who the workflow applies to at all, on top of `audience`. change_workflow_draft: [] removes every rule."),
  audience_match: z.enum(["all", "any"]).optional().describe("audience_rules: all must match (default) or any."),
};

export const CreateWorkflowDraftArgs = z.object({
  name: z.string().min(2).max(80).describe('The workflow name, like "Billing routing".'),
  ...WorkflowSettings,
  steps: z.array(WorkflowStep).min(1).max(30),
});

export const ChangeWorkflowDraftArgs = z.object({
  workflowId: z.string().describe("The workflow id from get_workflows."),
  name: z.string().min(2).max(80).optional(),
  ...WorkflowSettings,
  edits: z
    .array(
      z.object({
        op: z.enum(["add", "remove", "replace"]).describe("add: insert `steps` into `path` (at step `at`, default: before the step that ends the path). remove: delete step `step`. replace: replace step `step` with `steps`."),
        path: z.string().optional().describe('The path id ("af0" is the start, "af-2" …) or title, as get_workflow_steps lists them. Default: the start path.'),
        step: z.number().int().min(1).optional().describe("remove / replace: the step number in that path (1 = first)."),
        at: z.number().int().min(1).optional().describe("add: the new steps become step number `at`."),
        steps: z.array(WorkflowStep).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const GetWorkflowStepsArgs = z.object({
  workflowId: z.string().describe("The workflow id from get_workflows."),
});

export const GetWorkflowBuildOptionsArgs = z.object({});

export const PublishWorkflowDraftArgs = z.object({
  workflowId: z.string().describe("The workflow id: the draft, or the live workflow a change waits on."),
  draftHash: z.string().describe("draftHash from create_workflow_draft, change_workflow_draft or get_workflow_steps: the version the person agreed to."),
  liveHash: z.string().optional().describe("With a change to a live workflow: liveHash from the same answer."),
});
