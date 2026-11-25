import { z } from "zod";

/**
 * Kai Code native turns for external sessions (deeplink / an agent your team
 * runs itself): plan, wrap-up, screenshots, pages and the hosted workflow.
 * Every tool addresses the Gleap coding session exactly like report_progress:
 * sessionId from the kickoff prompt, or ticketId when there is none.
 */

export const SESSION_ID = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, "must be the 24-char Gleap coding-session id")
  .optional()
  .describe(
    "The 24-char Gleap coding-session id from your kickoff prompt or from a report_progress result. Send the same value on every call. No session id? Pass ticketId instead.",
  );

export const TICKET_REF = z
  .string()
  .max(40)
  .optional()
  .describe(
    "The ticket you work on (24-char id or #number), when you have no session id. Gleap continues that ticket's coding session or starts one; the result names the session id to pass from then on. Ignored when sessionId is given.",
  );

const sessionTarget = { sessionId: SESSION_ID, ticketId: TICKET_REF };

export const PLAN_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export const UpdatePlanArgs = z.object({
  ...sessionTarget,
  items: z
    .array(
      z.object({
        content: z.string().min(1).max(300).describe("One step, imperative and short (\"Reproduce the 403 on the widget\")."),
        status: z
          .string()
          .describe("pending | in_progress | completed | cancelled (inProgress, active, done and canceled are accepted too)."),
      }),
    )
    .min(1)
    .max(50)
    .describe("The WHOLE plan in order, every call (it replaces the previous list). Keep exactly one step in_progress while you work."),
  explanation: z.string().max(500).optional().describe("Optional one line on why the plan changed."),
});

// send_customer_update is removed (it staged a composer draft) and refused (kaiSession.ts
// wrapUpProblem); it stays listed for one release so older workflows get that answer.
export const WRAP_UP_ACTIONS = ["merge_pr", "open_pr", "review_changes", "open_preview", "send_customer_update"] as const;

export const WrapUpArgs = z.object({
  ...sessionTarget,
  recap: z
    .string()
    .min(1)
    .max(600)
    .describe("Two or three sentences: what is now true, then what is not done or not verified. No recommendation here."),
  ask: z
    .string()
    .max(120)
    .optional()
    .describe("ONE question, only when the next move is your operator's (a go-ahead, a choice). Omit when nothing waits on them."),
  actions: z
    .array(
      z.object({
        label: z.string().min(1).max(24).describe("Button text, 1-3 words (\"Merge PR\", \"Open preview\")."),
        action: z
          .enum(WRAP_UP_ACTIONS)
          .optional()
          .describe(
            "merge_pr | open_pr | review_changes (need the session's open PR), open_preview (needs a running preview). send_customer_update is removed: ask your operator in your own conversation and send the reply with send_message.",
          ),
        message: z
          .string()
          .max(300)
          .optional()
          .describe("Unused (it carried send_customer_update's draft, which is removed)."),
      }),
    )
    .max(2)
    .optional()
    .describe("0-2 buttons answering your ask, recommended first. Every action needs `action`."),
});

export const MAX_SHARE_BASE64_BYTES = 1_500_000;

export const ShareScreenshotArgs = z.object({
  ...sessionTarget,
  caption: z.string().min(1).max(300).describe("One line saying what the screenshot shows (\"Checkout button now stays enabled after a failed card\")."),
  label: z.string().max(40).optional().describe("Short tag on the image (\"After\", \"Mobile\", \"Dark mode\")."),
  path: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Local path of the screenshot (png, jpeg, webp or gif, at most 5 MB). You upload it yourself with the command the result gives you."),
  compare_with: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Local path of a BEFORE screenshot; Gleap shows the two as a before/after comparison."),
  imageBase64: z
    .array(z.string().min(1))
    .min(1)
    .max(2)
    .optional()
    .describe(
      "Only when you cannot run a shell command: the image(s) as base64, [after, before?], at most 1.5 MB each. Otherwise pass path and run the upload command.",
    ),
});

export const MAX_ARTIFACT_HTML_BYTES = 1_000_000;

export const PublishArtifactArgs = z.object({
  ...sessionTarget,
  title: z.string().min(1).max(120).describe("Page title, a few words (\"Root cause: duplicate webhooks\")."),
  html: z
    .string()
    .min(1)
    .describe("One self-contained HTML page (inline CSS and JS, no external loads), at most 1 MB. It renders sandboxed in the session thread."),
  description: z.string().max(300).optional().describe("One sentence shown under the title."),
  artifactId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, "must be an artifactId from an earlier publish_artifact result")
    .optional()
    .describe("Pass the artifactId from an earlier result to publish a new version of the same page instead of a new one."),
});

export const GetSessionBriefArgs = z.object({
  sessionId: SESSION_ID.unwrap().describe("The 24-char Gleap coding-session id your kickoff names."),
});

export const GetTicketScreenshotArgs = z.object({
  ticketId: z
    .string()
    .min(1)
    .max(40)
    .describe("The ticket (24-char id or #number) whose SDK screenshot you want to see."),
});
