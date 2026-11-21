import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReportProgressArgs } from "../schemas/progress.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapPost } from "../utils/api.js";
import { hookLine, operatorFeedbackLine } from "../utils/kaiSession.js";

type ReportProgressQuestion = NonNullable<z.infer<typeof ReportProgressArgs>["question"]>;

const NO_OWN_LIVE_MESSAGE = `Never send your own "it's fixed" or "it's live" message.`;

/**
 * One line per customer-message outcome (`fixMessages` in the
 * agent-progress response), appended to the tool result so the reporting
 * agent knows what became of its customerUpdateMessage / customerShipMessage
 * without digging through the response JSON. 'none' (nothing passed) gets
 * no line: feature-request runs deliberately pass neither message.
 */
const UPDATE_MESSAGE_STEER: Record<string, string> = {
  sent: "customerUpdateMessage: sent to the customer. Don't send another update yourself.",
  pending:
    "customerUpdateMessage: stored, not sent yet. Gleap sends it once a PR is registered for this session (status completed with prUrl).",
  skipped:
    "customerUpdateMessage: not sent, because this project doesn't tell customers when a PR opens. Don't send it yourself unless your operator tells you to.",
};

const SHIP_MESSAGE_STEER: Record<string, string> = {
  scheduled: `customerShipMessage: scheduled on the ticket. Gleap sends it when the fix is live, following the project's post-merge setting. ${NO_OWN_LIVE_MESSAGE}`,
  mode_none:
    "customerShipMessage: not used, because this project sends no \"it's live\" message after the merge. Don't send one yourself; if your update message promised one, tell your operator.",
  error:
    "customerShipMessage: could not be stored (see the response). Tell your operator so the follow-up isn't lost; don't send it yourself.",
};

/**
 * The project's fix-message rules and the team's instructions for customer
 * messages, as the server words them (`fixMessageRulesText` +
 * `customerReplyInstructions` on every agent-progress result: the same text
 * Kai Code's own prompt carries). The first report (working, investigating)
 * hands them to the agent before it writes the messages for its PR.
 */
const fixMessageRulesLines = (result: Record<string, any> | undefined): string[] => {
  const lines: string[] = [];
  const rules = typeof result?.fixMessageRulesText === "string" ? result.fixMessageRulesText.trim() : "";
  if (rules) lines.push(`Fix-message rules for tickets in this project (feature requests pass neither):\n${rules}`);
  const team = typeof result?.customerReplyInstructions === "string" ? result.customerReplyInstructions.trim() : "";
  if (team) lines.push(`Your team's instructions for customer messages (follow them in both):\n${team}`);
  return lines;
};

const DRAFTING_STEER = `No customer message passed for this PR: Gleap writes the missing ones from the conversation and sends them by the project's rules. ${NO_OWN_LIVE_MESSAGE}`;

const fixMessageSteers = (result: Record<string, any> | undefined): string[] => {
  const fixMessages = result?.fixMessages;
  const lines =
    fixMessages && typeof fixMessages === "object"
      ? [UPDATE_MESSAGE_STEER[fixMessages.onTheWay], SHIP_MESSAGE_STEER[fixMessages.whenLive]]
      : [];
  if (result?.draftingFixMessages === true) lines.push(DRAFTING_STEER);
  return lines.filter((line): line is string => typeof line === "string");
};

/**
 * The phase every report carries: the agent's own, or the one its `status`
 * stands for. The Server takes `status` over `phase` (one fix status, SPEC
 * kai-support-drives); a Server from before the fix status requires a phase
 * and still files the report by it, so the two can deploy in either order.
 */
const reportedPhase = (args: { phase?: string; status?: string; step?: string; prUrl?: string }): string | undefined => {
  if (args.phase || !args.status) return args.phase;
  if (args.status === "working") return args.step ?? "investigating";
  if (args.status === "queued") return "investigating";
  if (args.status === "needs_input") return "blocked";
  if (args.status === "completed" && args.prUrl) return "pr_opened";
  return "done"; // completed without a PR, failed, cancelled
};

/** Trimmed question with its blank options dropped; none when the prompt is blank. */
const cleanQuestion = (question: ReportProgressQuestion | undefined): ReportProgressQuestion | undefined => {
  const prompt = question?.prompt.trim();
  if (!question || !prompt) return undefined;
  const options = (question.options ?? []).map((option) => option.trim()).filter(Boolean);
  return { kind: question.kind, prompt, audience: question.audience, ...(options.length ? { options } : {}) };
};

const trimmedOrUndefined = (text: string | undefined): string | undefined => text?.trim() || undefined;

const refusal = (text: string, error: string): GleapApiResponse => ({
  isError: true,
  content: [{ type: "text", text }],
  structuredContent: { error },
});

export const registerProgressTools = (server: McpServer) => {
  server.registerTool(
    "report_progress",
    {
      title: "Report Progress",
      description:
        "Report the status of your work on its Gleap coding session. It shows live on the ticket, in the inbox and in the session view; your session owns the ticket until it is solved. Each call is a full snapshot that replaces the last. Report every step change: status working with step investigating, reproduced or fixing, and a one-line message; add customerLine when the step matters to the customer. When you need an answer, report needs_input with question instead of waiting silently. When you open a PR, report completed with prUrl and the customer messages: customerUpdateMessage goes to the customer right away and customerShipMessage when the fix is live, following the project's fix-message settings (left out, Gleap drafts them; feature requests use neither, as upvoters are notified on release). Once a PR is registered, Gleap checks it and sends these messages; by default the ticket moves to Done when the PR merges to production (a project can switch this off; then it is done when the customer confirms it, or 24 hours after the last answer without a reply). With your PR also pass problem and fix: one to three simple sentences each for the team's Merge card. When the ticket is solved, send howSolved (one paragraph on how). If you cannot fix it, report failed with the reason. Name yourself with agentKind, agentName and device. Address the session with sessionId, or with ticketId to continue or start that ticket's session (the result names the session id). The older phase field still works (status wins). The result says what happened to each customer message, lists the project's fix-message settings and message guidelines, new customer messages, and carries the session file the Gleap plugin reads.",
      inputSchema: ReportProgressArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      sessionId,
      ticketId,
      status,
      step,
      phase,
      message,
      question,
      customerLine,
      prUrl,
      agentKind,
      agentName,
      device,
      customerUpdateMessage,
      customerShipMessage,
      howSolved,
      problem,
      fix,
    }): Promise<GleapApiResponse> => {
      // Session-scoped since 2026-08: the retired /tickets/{id}/agent-progress
      // side-table is gone. Reports land on the CloudCodingSession that the
      // deeplink hand-off minted, so external work renders exactly like
      // cloud/bridge sessions (and the merge webhook closes the loop).
      // Without a session id (an app Gleap's button did not open), the
      // ticket addresses the report: the server continues the ticket's
      // external session or mints one, scoped to this MCP grant's project.
      const ticketRef = typeof ticketId === "string" ? ticketId.trim() : "";
      if (!sessionId && !ticketRef) {
        return refusal(
          "Pass sessionId (from your kickoff prompt) or, when your prompt names no session, the ticketId you are working on.",
          "sessionId or ticketId is required",
        );
      }
      if (!status && !phase) {
        return refusal(
          "Pass status: queued, working (with step investigating, reproduced or fixing), needs_input (with question), completed (with prUrl when you opened a PR), failed or cancelled.",
          "status is required",
        );
      }
      // needs_input without its question is the silent wait the fix status
      // ends: the team would see that the agent waits, not on what.
      const asked = cleanQuestion(question);
      if (status === "needs_input" && !asked) {
        return refusal(
          "status needs_input needs question: what you wait on ({ kind, prompt, audience, options }).",
          "question is required with status needs_input",
        );
      }
      // The Server keeps the fix status. Each report is a full snapshot, so
      // every field goes along (blank texts dropped); repeats change nothing.
      const report = {
        status,
        step,
        phase: reportedPhase({ phase, status, step, prUrl }),
        message,
        question: asked,
        customerLine: trimmedOrUndefined(customerLine),
        prUrl,
        agentKind,
        agentName,
        device: trimmedOrUndefined(device),
        customerUpdateMessage,
        customerShipMessage,
        howSolved: trimmedOrUndefined(howSolved),
        problem: trimmedOrUndefined(problem),
        fix: trimmedOrUndefined(fix),
      };
      const res = sessionId
        ? await gleapPost(`/gleapcode/sessions/${sessionId}/agent-progress`, report)
        : await gleapPost(`/gleapcode/sessions/agent-progress`, { ...report, ticketId: ticketRef });
      if (res.isError) return res;
      const result = res.structuredContent as Record<string, any> | undefined;
      const steers = [...fixMessageSteers(result), ...fixMessageRulesLines(result)];
      if (!sessionId && typeof result?.sessionId === "string") {
        steers.unshift(`Reported on Gleap coding session ${result.sessionId}. Pass sessionId "${result.sessionId}" on your next report_progress calls.`);
      }
      // What the team asked for in Gleap leads; `hook` is the session file
      // for the Gleap plugin's hooks (contract §8). `stop` and the new
      // customer messages are every tool's (utils/agentSession.ts).
      const feedback = operatorFeedbackLine(result);
      if (feedback) steers.unshift(feedback);
      const hook = hookLine(result);
      if (hook) {
        steers.push(hook);
        // The session file is the hook line: the JSON above does not repeat it (or its token).
        const { hook: _hook, ...rest } = result ?? {};
        res.content[0] = { type: "text", text: JSON.stringify(rest, null, 2) };
      }
      for (const text of steers) res.content.push({ type: "text", text });
      return res;
    },
  );
};
