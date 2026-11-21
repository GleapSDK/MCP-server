import { z } from "zod";

/**
 * One fix status (Kai Support drives, 2026-10-31): every runtime reports the
 * same snapshot, cloud and Kai Bridge runs and the coding agents on people's
 * own machines alike, and Kai Support answers "any update?" from it. `status`
 * + `step` replace `phase`; `phase` stays for the agents and workflows that
 * still send it (the Server maps it when `status` is missing). Plain objects,
 * enums and strings only: ChatGPT refuses the whole server over one tool
 * schema it does not take (a tuple did that in #227003).
 */
export const FIX_STATUSES = ["queued", "working", "needs_input", "completed", "failed", "cancelled"] as const;
export const FIX_STEPS = ["investigating", "reproduced", "fixing"] as const;
export const QUESTION_KINDS = ["question", "approval", "auth", "choice"] as const;
export const QUESTION_AUDIENCES = ["customer", "team"] as const;
export const AGENT_KINDS = ["claude_code", "codex", "cursor", "other"] as const;
export const AGENT_PHASES = ["investigating", "reproduced", "fixing", "pr_opened", "blocked", "done"] as const;

export const ReportProgressArgs = z.object({
  sessionId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, "must be the 24-char Gleap coding-session id")
    .optional()
    .describe(
      "The 24-char Gleap coding-session id from your kickoff prompt (\"tracked as Gleap coding session ...\"). Every report lands on that session — the ticket bubble, list glyphs and merge automation all render from it. Send the SAME value on every call. No session id in your kickoff? Pass ticketId instead: Gleap continues the ticket's session or starts one, and the result tells you its id for the next calls."
    ),
  ticketId: z
    .string()
    .optional()
    .describe(
      "The ticket you work on (24-char id or #number), when your prompt names no session id (you were started from your team's own tool, not Gleap's \"Open in …\" button). Ignored when sessionId is given. The ticket must be in the Gleap project you are signed in to."
    ),
  status: z
    .enum(FIX_STATUSES)
    .optional()
    .describe(
      "Where your fix stands. Every report is a full snapshot that replaces the last. queued (not started yet), working (pass step), needs_input (you wait on an answer: pass question), completed (your part is done; with prUrl when you opened a PR), failed (you could not fix it: say why in message), cancelled (you stopped before the end, e.g. your operator called it off). Wins over phase."
    ),
  step: z
    .enum(FIX_STEPS)
    .optional()
    .describe(
      "With status working: investigating (reading the ticket and code), reproduced (you confirmed the problem), fixing (writing the change). Report every step change."
    ),
  message: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "One line for your team on what is happening now (~10 words), shown live on the ticket, in the inbox and in the session view. Write it like a teammate in a chat: first person, plain words (\"Found it: the export reads dates in UTC.\", \"I'm adding a test.\"). On completed or failed say where the work is or why it stopped (up to 2000 chars). With a PR, the summary goes in problem and fix."
    ),
  question: z
    .object({
      kind: z
        .enum(QUESTION_KINDS)
        .describe("question (an open question), approval (a go-ahead, e.g. for your plan), auth (a sign-in, secret or access you lack), choice (pick one of options)."),
      prompt: z.string().min(1).max(500).describe("The question in one or two sentences, answerable without reading your session."),
      options: z
        .array(z.string().min(1).max(120))
        .max(6)
        .optional()
        .describe("The answers to pick from (choice, approval), your recommendation first."),
      audience: z
        .enum(QUESTION_AUDIENCES)
        .describe("team: your team decides; ask the person running you as well. customer: only the customer can answer; once your operator agrees, ask the customer with send_message yourself and report needs_input while you wait for the reply."),
    })
    .optional()
    .describe("With status needs_input: what you wait on, shown on the ticket instead of a silent wait."),
  customerLine: z
    .string()
    .max(300)
    .optional()
    .describe(
      "One sentence the customer may read, when the step matters to them (you reproduced the problem, a fix is being tested). In the customer's language, plain text, no internal details (file paths, code, branch names). It is status, not a message: Gleap shows it where the customer asks \"any update?\". To tell the customer something, ask your operator and send it with send_message. With a PR, customerUpdateMessage and customerShipMessage take its place."
    ),
  prUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Pull-request URL: pass it with status completed when you opened a PR. Registering it lets Gleap check the PR and send your customer messages (customerUpdateMessage right away, customerShipMessage once the fix is live). By default the ticket moves to Done when the PR merges to production (a project can switch this off; then it is done when the customer confirms the fix, or 24 hours after the last answer with no customer message). A customer reply reopens it. A feature request moves to Done at the merge."
    ),
  agentKind: z
    .enum(AGENT_KINDS)
    .optional()
    .describe("Which coding agent you are: claude_code, codex, cursor, or other (then name yourself in agentName). Tags the session and every message you write. Send it on every report."),
  agentName: z
    .string()
    .max(60)
    .optional()
    .describe('Your product name, e.g. "Claude Code" or "Codex" (shown on the ticket\'s activity badge)'),
  device: z
    .string()
    .max(100)
    .optional()
    .describe('The computer you run on, as your operator knows it (its computer name, e.g. "Sam\'s MacBook Pro"), shown with your agent name. Send it with agentKind.'),

  customerUpdateMessage: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Customer message sent right away when your PR is registered; pass it with your PR (status completed and prUrl), together with customerShipMessage (tickets only; feature requests pass neither, Gleap notifies the upvoters). Say the fix is built, is now being reviewed and deployed, and that we will update them. Write it in the customer's language: short, plain text (no markdown), no internal details, file paths or code. There is no approval step: Gleap sends it to the customer from the teammate who started this session (a project can switch this off; the result then says it was skipped). Do not also send it with send_message."
    ),
  customerShipMessage: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Customer message for when the fix is live, written now; pass it with your PR, together with customerUpdateMessage. Gleap keeps it on the ticket as a scheduled message the team can edit, and sends it when the fix is live by the project's post-merge setting: a set delay after the production merge, or when a teammate confirms it is live. Some projects send no 'it's live' message; the result says so. Write it in the customer's language: short, plain text (no markdown), no internal details; include any step they must take (refresh, update). For an SDK or app repository the fix reaches them in the next release: say that, and that they need to update. There is no approval step. Passing it again replaces the stored text until it is sent. Never send your own 'it's fixed' or 'it's live' message."
    ),
  problem: z
    .string()
    .max(500)
    .optional()
    .describe(
      "With your PR (status completed and prUrl): the root problem in one to three simple sentences, for the team's Merge card. Plain words, no file paths or code. Pass it together with fix."
    ),
  fix: z
    .string()
    .max(500)
    .optional()
    .describe(
      "With problem: what your change does, in one to three simple sentences, for the team's Merge card. Plain words, no file paths or code."
    ),
  howSolved: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "When the ticket is solved: one paragraph for your team on how it was solved: the cause, what you changed or what you answered, and how you checked it. Technical, without customer data (names, email addresses, account or order details). It feeds Kai Support's learning, so the next ticket like this one goes faster. Send it once, with your last report (status completed; failed when you hand the ticket back unsolved and know what you found)."
    ),
  phase: z
    .enum(AGENT_PHASES)
    .optional()
    .describe(
      "The older way to report, still accepted: investigating, reproduced and fixing (status working with that step), pr_opened (completed with prUrl), blocked (needs_input), done (completed). Send status and step instead; status wins when both are sent."
    ),
});
