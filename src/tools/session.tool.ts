import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import axios from "axios";
import {
  GetSessionBriefArgs,
  GetTicketScreenshotArgs,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_SHARE_BASE64_BYTES,
  PublishArtifactArgs,
  ShareScreenshotArgs,
  UpdatePlanArgs,
  WrapUpArgs,
} from "../schemas/session.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGetData, gleapPost } from "../utils/api.js";
import { isGleapHostedUrl, sniffImageType } from "../utils/images.js";
import {
  baseName,
  checkInlineImages,
  failure,
  htmlSizeProblem,
  imageExtension,
  mimeFromPath,
  missingTargetResponse,
  normalizePlan,
  operatorFeedbackLine,
  sessionIdLine,
  sessionRoute,
  shellQuote,
  hookLine,
  stoppedOrFailed,
  withLines,
  wrapUpProblem,
} from "../utils/kaiSession.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * Text-first result: lines for every client, `view` for MCP Apps hosts. The
 * session file (`hook`) comes with report_progress and the workflow prompts
 * only: repeating it on every plan, wrap-up, share and page call was the same
 * block (and token) again and again.
 */
const viewResult = (
  lines: Array<string | null | undefined>,
  response: Record<string, any> | undefined,
  view: Record<string, unknown>,
): GleapApiResponse => {
  const { hook: _hook, ...rest } = response ?? {};
  return {
    content: lines.filter((l): l is string => typeof l === "string" && l.length > 0).map((text) => ({ type: "text" as const, text })),
    structuredContent: { ...rest, view },
  };
};

/** Hosted copies of the workflows (fallback while a Server without agent-workflow is live). */
const HOSTED_WORKFLOW: Record<string, string> = {
  fix: "https://www.gleap.ai/agent-setup/prompt.md",
  feature: "https://www.gleap.ai/agent-setup/prompt-feature.md",
  answer: "https://www.gleap.ai/agent-setup/prompt-answer.md",
};

/** Ticket screenshots the tool returns inline (MCP image content). */
export const MAX_TICKET_SCREENSHOT_BYTES = 2_000_000;

export const registerSessionTools = (server: McpServer) => {
  server.registerTool(
    "get_session_brief",
    {
      title: "Get Session Brief",
      description:
        "The kickoff of a Gleap coding session: the first call when a kickoff names a Gleap coding session (its sessionId). The result is the agent's kickoff: the ticket, the ownership rules, Kai Support's findings, what an earlier session left, the repository and the setup steps. The workflow itself comes from the Gleap plugin skill the brief names. The result also carries the operator's newest feedback and the session file the Gleap plugin reads. A stopped session returns only the STOP instruction.",
      inputSchema: GetSessionBriefArgs.shape,
      // Not read-only: Gleap hands out operator feedback once, and a
      // multi-project grant must name the session's project.
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ sessionId }): Promise<GleapApiResponse> => getSessionBrief(sessionId),
  );

  server.registerTool(
    "update_plan",
    {
      title: "Update Plan",
      description:
        "Show your plan as a live checklist on the Gleap coding session (ticket bar, session view, mobile app). Use it for any task with more than two steps: send the whole list when you start, then again whenever a step starts, finishes or the plan changes (each call replaces the list). Keep exactly one step in_progress. Not a status report: step changes still go to report_progress. Address the session like report_progress (sessionId, or ticketId when you have none).",
      inputSchema: UpdatePlanArgs.shape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ sessionId, ticketId, items, explanation }): Promise<GleapApiResponse> => {
      const route = sessionRoute({ sessionId, ticketId }, "agent-plan");
      if (!route) return missingTargetResponse();
      const plan = normalizePlan(items);
      if ("error" in plan) return failure(plan.error);
      const res = await gleapPost(route.path, { ...(route.ticketId ? { ticketId: route.ticketId } : {}), items: plan.items, explanation }, { idempotent: true });
      if (res.isError) return res;
      const result = res.structuredContent as Record<string, any> | undefined;
      const early = stoppedOrFailed(result);
      if (early) return early;
      const done = plan.items.filter((i) => i.status === "completed").length;
      return viewResult(
        [`Plan updated in Gleap (${done} of ${plan.items.length} done).`, operatorFeedbackLine(result), sessionIdLine({ sessionId, ticketId }, result)],
        result,
        { kind: "plan", items: plan.items, explanation },
      );
    },
  );

  server.registerTool(
    "wrap_up",
    {
      title: "Wrap Up",
      description:
        "Post the end-of-turn summary of a Gleap coding session, shown as the session's next-step card: a short recap (what is now true, then what is not done or not verified) and at most one question for the operator with one or two actions, recommended first. Actions: merge_pr, open_pr or review_changes (the session has an open PR), open_preview (a preview is running). Customer replies are not a wrap-up action: ask your operator in your own conversation and send the approved text with send_message. Reply-only buttons are not supported: Gleap cannot send a reply to an agent on the operator's machine. Address the session like report_progress (sessionId, or ticketId).",
      inputSchema: WrapUpArgs.shape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ sessionId, ticketId, recap, ask, actions }): Promise<GleapApiResponse> => {
      const route = sessionRoute({ sessionId, ticketId }, "agent-wrap-up");
      if (!route) return missingTargetResponse();
      const problem = wrapUpProblem(actions);
      if (problem) return failure(problem);
      const trimmedActions = (actions ?? []).map((a) => ({ label: a.label.trim(), action: a.action, message: a.message?.trim() || undefined }));
      const res = await gleapPost(route.path, {
        ...(route.ticketId ? { ticketId: route.ticketId } : {}),
        recap: recap.trim(),
        ask: ask?.trim() || undefined,
        actions: trimmedActions,
        source: "agent",
      });
      if (res.isError) return res;
      const result = res.structuredContent as Record<string, any> | undefined;
      const early = stoppedOrFailed(result);
      if (early) return early;
      const url = typeof result?.sessionUrl === "string" ? result.sessionUrl : undefined;
      return viewResult(
        [
          `Wrap-up shown in Gleap as the session's next step${url ? `: ${url}` : "."}`,
          operatorFeedbackLine(result),
          sessionIdLine({ sessionId, ticketId }, result),
        ],
        result,
        // No actions in the view: only Gleap can run them, so this host would show dead buttons. It links there instead.
        { kind: "wrap_up", recap: recap.trim(), ask: ask?.trim() || undefined, url },
      );
    },
  );

  server.registerTool(
    "share_screenshot",
    {
      title: "Share Screenshot",
      description:
        "Post a screenshot into the Gleap coding session thread with a one-line caption, so the operator sees what was checked (1 to 3 per turn). compare_with adds a before shot for a before/after view. This server cannot read local files: with path, the result holds a single-use upload URL and the curl command that uploads that file (valid 15 minutes), and the share appears once the upload lands. Without a shell, pass imageBase64 instead (at most 1.5 MB each). Address the session like report_progress (sessionId, or ticketId).",
      inputSchema: ShareScreenshotArgs.shape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ sessionId, ticketId, caption, label, path, compare_with, imageBase64 }): Promise<GleapApiResponse> => {
      const route = sessionRoute({ sessionId, ticketId }, "agent-share");
      if (!route) return missingTargetResponse();
      const target = route.ticketId ? { ticketId: route.ticketId } : {};
      const common = { caption: caption.trim(), label: label?.trim() || undefined };

      if (imageBase64?.length) {
        const checked = checkInlineImages(imageBase64, MAX_SHARE_BASE64_BYTES);
        if ("error" in checked) return failure(checked.error);
        const names = ["after", "before"];
        const files = checked.images.map((img, i) => ({ name: `${names[i]}.${imageExtension(img.mimeType)}`, mimeType: img.mimeType }));
        const res = await gleapPost(route.path, { ...target, ...common, files, imageBase64: checked.images.map((img) => img.base64) });
        if (res.isError) return res;
        const result = res.structuredContent as Record<string, any> | undefined;
        const early = stoppedOrFailed(result);
        if (early) return early;
        return viewResult(
          ["Shared with your operator in Gleap.", operatorFeedbackLine(result), sessionIdLine({ sessionId, ticketId }, result)],
          result,
          { kind: "share", ...common, compare: checked.images.length > 1, status: "shared" },
        );
      }

      const paths = [path, compare_with].filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim());
      if (!path?.trim()) return failure("Pass path (the screenshot file; compare_with for a before shot), or imageBase64 when you cannot run a shell command.");
      for (const p of paths) {
        if (!mimeFromPath(p)) return failure(`${p} is not a png, jpeg, webp or gif file.`);
      }
      const files = paths.map((p) => ({ name: baseName(p), mimeType: mimeFromPath(p) }));
      const res = await gleapPost(route.path, { ...target, ...common, files });
      if (res.isError) return res;
      const result = res.structuredContent as Record<string, any> | undefined;
      const early = stoppedOrFailed(result);
      if (early) return early;
      const uploads: Array<{ name?: string; url?: string; command?: string }> = Array.isArray(result?.uploads) ? result!.uploads : [];
      if (uploads.length !== paths.length || uploads.some((u) => typeof u?.url !== "string")) {
        return failure("Gleap returned no upload link for every file. Try again once; if it fails again, describe what you checked in wrap_up instead.");
      }
      // Our own commands with the real (quoted) local paths; the URL is the
      // Server's single-use upload link for that file, in [after, before] order.
      const commands = uploads.map((u, i) => `curl -sS --fail -T ${shellQuote(paths[i])} ${shellQuote(u.url!)}`);
      // The Server's own `uploads[].command` is built from the file name we
      // sent, not the local path: `commands` is the one set of commands.
      const shared = { ...result, uploads: uploads.map(({ name, url }) => ({ name, url })), commands };
      return viewResult(
        [
          `Run ${commands.length > 1 ? "these commands" : "this command"} now (the link${commands.length > 1 ? "s expire" : " expires"}${result?.expiresAt ? ` at ${result.expiresAt}` : " in 15 minutes"}); the screenshot appears in the Gleap session once the upload${commands.length > 1 ? "s land" : " lands"}:`,
          commands.join("\n"),
          operatorFeedbackLine(result),
          sessionIdLine({ sessionId, ticketId }, result),
        ],
        shared,
        { kind: "share", ...common, compare: paths.length > 1, status: "upload_pending" },
      );
    },
  );

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish Artifact",
      description:
        "Publish a self-contained HTML page into the Gleap session thread: reports, root-cause write-ups, mockups, comparisons, anything easier to read as a page than as chat text. Inline all CSS/JS, no external loads, at most 1 MB. Pass the artifactId from an earlier result to publish a new version of the same page. Returns the dashboard link. Address the session like report_progress (sessionId, or ticketId).",
      inputSchema: PublishArtifactArgs.shape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ sessionId, ticketId, title, html, description, artifactId }): Promise<GleapApiResponse> => {
      const route = sessionRoute({ sessionId, ticketId }, "agent-artifacts");
      if (!route) return missingTargetResponse();
      const tooBig = htmlSizeProblem(html, MAX_ARTIFACT_HTML_BYTES);
      if (tooBig) return failure(tooBig);
      const res = await gleapPost(route.path, {
        ...(route.ticketId ? { ticketId: route.ticketId } : {}),
        title: title.trim(),
        html,
        description: description?.trim() || undefined,
        artifactId,
      });
      if (res.isError) return res;
      const result = res.structuredContent as Record<string, any> | undefined;
      const early = stoppedOrFailed(result);
      if (early) return early;
      const url = typeof result?.url === "string" ? result.url : undefined;
      return viewResult(
        [
          `Published "${title.trim()}"${result?.version ? ` (version ${result.version})` : ""} in the Gleap session${url ? `: ${url}` : "."}${result?.artifactId ? ` Pass artifactId "${result.artifactId}" to publish a new version.` : ""}`,
          operatorFeedbackLine(result),
          sessionIdLine({ sessionId, ticketId }, result),
        ],
        result,
        { kind: "artifact", title: title.trim(), description: description?.trim() || undefined, url, artifactId: result?.artifactId, version: result?.version },
      );
    },
  );

  server.registerTool(
    "get_ticket_screenshot",
    {
      title: "Get Ticket Screenshot",
      description:
        "See the screenshot the Gleap SDK captured with a ticket (bug reports), as an image. Use it before reproducing a visual bug. Returns an error sentence when the ticket has no screenshot or it is larger than 2 MB.",
      inputSchema: GetTicketScreenshotArgs.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ ticketId }): Promise<GleapApiResponse> => getTicketScreenshot(ticketId),
  );
};

/** The workflow Markdown (+ hook block), with the hosted file as fallback on an older Server. */
export const fetchWorkflow = async (
  route: { path: string; ticketId?: string },
  kind: string,
  target: { sessionId?: string; ticketId?: string },
): Promise<GleapApiResponse> => {
  const fetched = await gleapGetData(route.path, { params: { kind, ...(route.ticketId ? { ticketId: route.ticketId } : {}) } });
  if ("error" in fetched) {
    const status = (fetched.error.structuredContent as any)?.status;
    const hosted = HOSTED_WORKFLOW[kind];
    if (status === 404 && hosted) {
      try {
        const resp = await axios.get(hosted, { timeout: 10_000, responseType: "text", maxContentLength: 500_000 });
        if (typeof resp.data === "string" && resp.data.trim()) {
          // A 404 is either an older Server without the route or a session /
          // ticket this project does not have; the hosted copy is public, so
          // serve it, but say that nothing was tied to a session.
          return {
            content: [
              { type: "text", text: resp.data },
              { type: "text", text: "This is Gleap's public copy of the workflow: Gleap could not load it for that session or ticket (404), so no session file came with it. Check the id; report_progress tells you the session." },
            ],
            structuredContent: { markdown: resp.data, source: hosted },
          };
        }
      } catch {
        // Fall through to the API error.
      }
    }
    return fetched.error;
  }
  const result = (fetched.data ?? {}) as Record<string, any>;
  const early = stoppedOrFailed(result);
  if (early) return early;
  const markdown = typeof result.markdown === "string" ? result.markdown : "";
  if (!markdown.trim()) return failure("Gleap returned no workflow text.");
  return withLines(
    { content: [{ type: "text", text: markdown }], structuredContent: result },
    [operatorFeedbackLine(result), sessionIdLine(target, result), hookLine(result)],
  );
};

/**
 * The session's kickoff: GET agent-workflow without a kind, so the Server picks the session's own
 * kind and returns the brief as Markdown (`markdown`; `brief` is its structured form).
 */
export const getSessionBrief = async (sessionId: string): Promise<GleapApiResponse> => {
  const route = sessionRoute({ sessionId }, "agent-workflow");
  if (!route) return failure("Pass sessionId: the 24-char Gleap coding-session id your kickoff names.");
  const fetched = await gleapGetData(route.path);
  if ("error" in fetched) return fetched.error;
  const result = (fetched.data ?? {}) as Record<string, any>;
  const early = stoppedOrFailed(result);
  if (early) return early;
  const brief = typeof result.markdown === "string" ? result.markdown : "";
  if (!brief.trim()) return failure("Gleap returned no brief for this session.");
  return withLines(
    { content: [{ type: "text", text: brief }], structuredContent: result },
    [operatorFeedbackLine(result), hookLine(result)],
  );
};

const ticketRefPath = (ticketId: string): string => encodeURIComponent(ticketId.trim().replace(/^#/, ""));

/**
 * The ticket's SDK screenshot as MCP image content. The URL comes from the
 * caller's own project (GET /tickets/{id} with their credentials), and is
 * fetched only from Gleap's own https file hosts: screenshotUrl is set by the
 * SDK client, so another host could point the MCP server anywhere.
 */
export const getTicketScreenshot = async (ticketId: string): Promise<GleapApiResponse> => {
  const fetched = await gleapGetData(`/tickets/${ticketRefPath(ticketId)}`);
  if ("error" in fetched) return fetched.error;
  const ticket = fetched.data as Record<string, any> | undefined;
  const url = typeof ticket?.screenshotUrl === "string" ? ticket.screenshotUrl.trim() : "";
  if (!url) return failure("This ticket has no screenshot. Check its attachments or the activity log instead.");
  if (!isGleapHostedUrl(url)) {
    return failure(`The screenshot is not stored on Gleap's file hosts, so it is not loaded here. Open it yourself if you trust it: ${url}`);
  }
  try {
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxContentLength: MAX_TICKET_SCREENSHOT_BYTES,
      maxRedirects: 0,
    });
    const bytes = Buffer.from(resp.data);
    const mimeType = sniffImageType(bytes);
    if (!mimeType) return failure("The ticket's screenshot is not a png, jpeg, gif or webp image.");
    return {
      content: [
        { type: "image", data: bytes.toString("base64"), mimeType } as any,
        { type: "text", text: `Screenshot of ticket ${ticketId.trim()} (${Math.round(bytes.length / 1000)} KB).` },
      ],
      structuredContent: { ticketId: ticket?.id ?? ticket?._id ?? ticketId.trim(), screenshotUrl: url, mimeType, bytes: bytes.length },
    };
  } catch (err: any) {
    if (err?.code === "ERR_BAD_RESPONSE" && /maxContentLength/i.test(err?.message ?? "")) {
      return failure(`The screenshot is larger than 2 MB, too big to return as an image. Open it yourself: ${url}`);
    }
    const status = err?.response?.status;
    return failure(`Could not load the ticket's screenshot${status ? ` (${status})` : ""}. Open it yourself: ${url}`);
  }
};
