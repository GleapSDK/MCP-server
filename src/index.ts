import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { createGleapOAuthProvider } from "./auth/gleapOAuthProvider.js";
import {
  CORS_ALLOWED_HEADERS,
  GLEAP_AUTH_ISSUER,
  GLEAP_SCOPES,
  LOOP_STALL_EXIT_MS,
  MCP_JSON_BODY_LIMIT,
  MCP_PATH,
  MCP_SERVER_URLS,
  OPENAI_APPS_CHALLENGE_TOKEN,
  PORT,
} from "./config/index.js";
import { registerCodeTools } from "./tools/code.tool.js";
import { registerCompanyTools } from "./tools/company.tool.js";
import { registerDatabaseTools } from "./tools/database.tool.js";
import { registerContactTools } from "./tools/contact.tool.js";
import { registerFeatureRequestTools } from "./tools/featurerequest.tool.js";
import { registerHelpCenterTools } from "./tools/helpcenter.tool.js";
import { registerImageTools } from "./tools/image.tool.js";
import { registerKnowledgeTools } from "./tools/knowledge.tool.js";
import { registerMessageTools } from "./tools/message.tool.js";
import { registerNewsTools } from "./tools/news.tool.js";
import { registerMarketingDraftTools } from "./tools/marketing-drafts.tool.js";
import { registerEmailAutomationTools } from "./tools/email-automation.tool.js";
import { registerOutboundContentTools } from "./tools/outbound-content.tool.js";
import { registerOutboundTools } from "./tools/outbound.tool.js";
import { registerTargetingTools } from "./tools/targeting.tool.js";
import { registerPipelineTools } from "./tools/pipeline.tool.js";
import { registerSequenceTools } from "./tools/sequence.tool.js";
import { registerProgressTools } from "./tools/progress.tool.js";
import { registerSessionTools } from "./tools/session.tool.js";
import { registerTicketPrompts } from "./prompts/ticket.prompts.js";
import { linkToolsToKaiSessionView, registerKaiSessionView } from "./ui/kaiSessionView.js";
import { registerStatisticsTools } from "./tools/statistics.tool.js";
import { registerSurveyTools } from "./tools/survey.tool.js";
import { registerTeamTools } from "./tools/team.tool.js";
import { registerSettingsTools } from "./tools/settings.tool.js";
import { registerTicketTools } from "./tools/ticket.tool.js";
import { registerTicketCardTools } from "./tools/ticketCard.tool.js";
import { registerWorkflowTools } from "./tools/workflow.tool.js";
import { registerWorkflowBuilderTools } from "./tools/workflowBuilder.tool.js";
import { registerSetupTools } from "./tools/setup.tool.js";
import { registerToolboxTools } from "./tools/toolbox.tool.js";
import { limitToolsForChatGpt, toolNamesRegisteredBy } from "./utils/chatgptTools.js";
import { loggableToolName, refuseOversizedBatch } from "./utils/rpcBatch.js";
import { readCreds, runWithCreds } from "./utils/credentials.js";
import type { Creds } from "./types/index.js";
import { startLoopWatchdog, trackToolCall } from "./utils/loopWatchdog.js";
import { applySessionScopePolicy } from "./utils/sessionScope.js";
import {
  applyProjectSelection,
  projectInstructions,
  registerProjectTools,
} from "./utils/projectSelection.js";
import { applyShareTokenRedaction } from "./utils/shareTokenRedaction.js";
import { applyAgentSessionSignals } from "./utils/agentSession.js";

// -------- OAuth setup --------
const provider = createGleapOAuthProvider();

const oauthMetadata: OAuthMetadata = {
  issuer: GLEAP_AUTH_ISSUER,
  authorization_endpoint: `${GLEAP_AUTH_ISSUER}/oauth/authorize`,
  token_endpoint: `${GLEAP_AUTH_ISSUER}/oauth/token`,
  registration_endpoint: `${GLEAP_AUTH_ISSUER}/oauth/register`,
  revocation_endpoint: `${GLEAP_AUTH_ISSUER}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: GLEAP_SCOPES,
};

// One entry per public URL (primary first). A client signs in through the host
// it connected to and asks for a token for the resource that host names, so
// metadata and the 401 challenge must name the same host.
const publicUrls = MCP_SERVER_URLS.map((url) => {
  const serverUrl = new URL(url);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
  return {
    url: serverUrl.href,
    host: serverUrl.host,
    resourceMetadataUrl,
    metadataRouter: mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: serverUrl,
      scopesSupported: GLEAP_SCOPES,
      resourceName: "Gleap MCP Server",
    }),
    bearerAuth: requireBearerAuth({ verifier: provider, resourceMetadataUrl }),
  };
});
const publicUrlFor = (req: express.Request) =>
  publicUrls.find((entry) => entry.host === req.host) ?? publicUrls[0];

// -------- MCP server factory --------
// Stateless mode REQUIRES a fresh server + transport per request. The transport
// keys its request->response stream map by the client's JSON-RPC request id
// (almost always 0/1 for `initialize`) and holds the single standalone SSE
// stream under one fixed key. A single shared instance therefore lets
// concurrent clients collide: one client's response can be routed to another's
// connection (-> hang until the client's connect timeout), and a second
// client's SSE stream is rejected with 409 (-> the client reports that the
// server returned an error when connecting). Building per request gives every
// connection fully isolated state.
// Server-level instructions, returned in the `initialize` result. The ONE
// canonical statement of the ticket rules for coding agents: the hosted
// agent-setup docs and the per-tool descriptions repeat them, but every
// client that surfaces instructions gets the policy without fetching a doc.
const SERVER_INSTRUCTIONS = `Gleap workspace tools. If you are working a ticket or feature request as a coding agent (a Gleap kickoff, workflow or the Gleap plugin brought you here), these rules apply:
1. When a kickoff names a Gleap coding session, call get_session_brief with it first. A session started from a ticket's code fix owns the ticket until its pull request is open, then Operator has it again; otherwise your session owns it until it is solved. You work for the person who runs you: when a teammate replies on the ticket or takes it over, tell your operator in one line and follow their call. Results list new customer messages you have not seen yet: read them before you go on. Close, archive or snooze the ticket, or change its assignee, only when your operator tells you to: Gleap marks it done when the customer confirms the fix, or 24 hours after the last answer without a reply.
2. Customer messages: a session started from a ticket's code fix never sends anything to the customer (Gleap refuses its send_message): it reports with report_progress, drafts in customerLine, customerUpdateMessage and customerShipMessage, and Kai tells the customer. Otherwise (your own AI client on a ticket): ask your operator in your own conversation, then send what they approved with send_message (isNote: false, with your sessionId) and tell them in one line what you sent. When your operator tells you to answer, tell, reply to or update the customer, that is the approval. A coding session never stages a reply in the ticket composer (Gleap refuses it). If a send_message result lists new customer messages, they came in before your reply went out: read them, and if your reply no longer fits, tell your operator and follow up.
3. Report with report_progress on every step change: status working with step investigating, reproduced or fixing and a one-line message, plus customerLine (one sentence the customer may read) when the step matters to them. When you need an answer, report needs_input with the question instead of waiting silently; when you cannot fix it, report failed with the reason. Status, findings and PR links belong in report_progress, not in internal notes and not in the customer thread.
4. When you open a PR, report completed with prUrl and the customer messages (normally both): customerUpdateMessage (sent right away: the fix is built, it is being reviewed and deployed, and we will update them) and customerShipMessage (sent when the fix is live, following the project's settings; for SDK or app repositories say it ships in the next release). Write them in the customer's language as plain text, following the fix-message rules and the team's instructions for customer messages that every report_progress result gives you for this project. Feature requests pass neither: Gleap notifies the upvoters when the request ships. Never send your own "it's fixed" or "it's live" message. With the PR also pass problem and fix (one to three simple sentences each) for the team's Merge card. By default the ticket moves to Done when the PR merges to production; a customer reply reopens it.
5. When the ticket is solved, end with report_progress and howSolved: one paragraph on how it was solved (the cause, what changed or what you answered, how you checked it), with no customer data; it feeds Kai Support's learning. Work visibly in the Gleap session: keep a plan with update_plan for any task with more than two steps; after you checked a user-visible change, share_screenshot 1-3 screenshots with a one-line caption; use publish_artifact for reports, mockups or anything easier to read as a page; end EVERY turn with wrap_up (recap first, then at most one question with one or two actions, recommended first). When a result gives you the .gleap/session.json content, write it and add .gleap/ to .git/info/exclude.
Outside agent workflows (an operator driving these tools directly), follow the operator's instructions as given. When they want to review a reply in the ticket before it goes out, stage it with draft_reply_to_composer.

Outbound messages (surveys, emails, chat messages, banners, info cards, checklists, product tours, tooltips, news, push, WhatsApp): find targetable events and contact attributes with get_targeting_options. If the audience needs something the project does not track, get_event_tracking_guide gives the tracking code; never invent event names, because rules on an untracked event match nobody. Then create or edit a draft, configure_outbound_targeting, preview_outbound_audience, and publish_outbound only after the operator approved that item going live (one-offs: with the approved recipient count).`;

const buildServer = (creds: Creds | null): McpServer => {
  // A multi-project OAuth grant (see utils/projectSelection.ts); none for one project.
  const projects = creds?.projects;
  const server = new McpServer(
    { name: "gleap-mcp", version: "0.1.0" },
    {
      instructions: projects
        ? `${SERVER_INSTRUCTIONS}\n\n${projectInstructions(projects)}`
        : SERVER_INSTRUCTIONS,
    },
  );

  // The connector directory reads a tool's display name from
  // annotations.title; every registrar sets `title`, so copy it there.
  const registerTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, meta: any, handler: any) =>
    registerTool(name, { ...meta, annotations: { title: meta.title, ...meta.annotations } }, handler);

  // MUST come first: patches registerTool so no tool result (scope refusals
  // included) carries a ticket share token.
  applyShareTokenRedaction(server);

  // MUST come right after: every tool call of a coding session sends its
  // X-Gleap-Session-Id and surfaces the session's stop and new customer
  // messages, whatever the tool (utils/agentSession.ts).
  applyAgentSessionSignals(server);

  // MUST come before the session-scope policy and every registrar: picks the
  // project (and its key) each tool call runs against.
  if (projects) {
    applyProjectSelection(server, projects);
    registerProjectTools(server, projects);
  }

  // MUST come before every registrar: patches registerTool so requests
  // carrying a customer-session scope are policy-checked per tool.
  applySessionScopePolicy(server);

  registerTicketTools(server);
  registerTicketCardTools(server);
  registerContactTools(server);
  registerCompanyTools(server);
  registerPipelineTools(server);
  registerHelpCenterTools(server);
  registerStatisticsTools(server);
  registerNewsTools(server);
  registerMessageTools(server);
  registerKnowledgeTools(server);
  registerCodeTools(server);
  registerSurveyTools(server);
  registerTeamTools(server);
  registerFeatureRequestTools(server);
  registerWorkflowTools(server);

  // Kai's operator and coding-agent tools. ChatGPT does not list them: its
  // list has to stay under OpenAI's 128 tools (see utils/chatgptTools.ts).
  const notForChatGpt = toolNamesRegisteredBy(server, () => {
    registerMarketingDraftTools(server);
    registerEmailAutomationTools(server);
    registerSequenceTools(server);
    registerOutboundTools(server);
    registerOutboundContentTools(server);
    registerTargetingTools(server);
    registerImageTools(server);
    registerProgressTools(server);
    registerSessionTools(server);
    // The team's databases: Kai Code runs on a ticket only (utils/sessionScope.ts).
    registerDatabaseTools(server);
    registerSetupTools(server);
    registerWorkflowBuilderTools(server);
    registerToolboxTools(server);
    registerSettingsTools(server);
  });

  registerTicketPrompts(server, projects);
  registerKaiSessionView(server);
  // MUST come after every tool registrar: they wrap the tools/list handler.
  linkToolsToKaiSessionView(server);
  limitToolsForChatGpt(server, notForChatGpt);

  return server;
};

// -------- HTTP wiring --------
const app = express();
app.set("trust proxy", true);

// CORS + preflight
app.use(
  cors({
    origin: true, // restrict in production via CORS_ORIGINS env var
    credentials: false,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: ["mcp-session-id"],
    maxAge: 600,
  }),
);
app.options(MCP_PATH, (_req, res) => res.sendStatus(204));

// Parse JSON for POST bodies. body-parser defaults to 100 KB, which large
// multi-locale help center article updates exceed (-> HTTP 413 before the
// request ever reaches the MCP transport).
app.use(express.json({ limit: MCP_JSON_BODY_LIMIT }));

// -------- OAuth discovery endpoints --------
// Serves /.well-known/oauth-protected-resource
// and /.well-known/oauth-authorization-server
app.use((req, res, next) => publicUrlFor(req).metadataRouter(req, res, next));

// -------- OpenAI plugin directory domain verification --------
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  res.type("text").send(OPENAI_APPS_CHALLENGE_TOKEN);
});

// Per-request handler: a fresh, fully isolated MCP server + transport for this
// single HTTP request (see the buildServer note above for why this must not be
// shared). Stateless mode (sessionIdGenerator: undefined) means each request is
// self-contained — the SDK skips session/initialization validation — so
// initialize, tools/list and tool calls each work on their own transport.
const handleMcpRequest = async (
  req: express.Request,
  res: express.Response,
) => {
  // A stateless server has no stream to offer on GET (and no session to end on
  // DELETE). Answering GET opened an SSE stream that never sent or ended, and
  // each one pinned a full server with every tool registered until the client
  // left. Connectors that kept theirs open leaked ~160 MB/day until the heap
  // filled and the EU process spun in GC (2026-10-21). 405 is what the spec
  // prescribes when a server offers no GET stream.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }

  const creds = readCreds(req);
  const server = buildServer(creds);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Tear down the per-request instances once the connection closes.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await runWithCreds(creds, async () => {
      await transport.handleRequest(
        req,
        res,
        req.method === "POST" ? req.body : undefined,
      );
    });
  } catch (err: any) {
    console.error(
      `[gleap-mcp] error handling ${req.method} ${MCP_PATH}:`,
      err?.stack ?? err,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? "Internal error" });
    }
  }
};

// Classify the auth method for logging — never logs the credential itself.
const describeAuth = (req: express.Request): string => {
  if (req.headers.authorization?.toLowerCase().startsWith("bearer ")) {
    return "oauth";
  }
  if (
    req.header("x-gleap-api-key") ||
    req.header("gleap-api-key") ||
    req.header("x-api-key") ||
    req.header("api-key")
  ) {
    return "apikey";
  }
  return "none";
};

// -------- Request logging for the MCP endpoint --------
// The endpoint used to be silent on every non-crash response: 401 / 409 / 500
// produced no log line at all, which made connection failures impossible to
// diagnose from production logs. Log the outcome (and the 401 reason from the
// WWW-Authenticate header) of every MCP request.
// Tool calls also log when they start and carry the tool name: a call that
// never finishes (the 2026-10-21 EU hang) otherwise leaves no line at all.
app.post(MCP_PATH, refuseOversizedBatch);
app.all(MCP_PATH, (req, res, next) => {
  const startedAt = Date.now();
  const rpcMethod =
    req.method === "POST" && req.body && typeof req.body === "object"
      ? Array.isArray(req.body)
        ? "batch"
        : req.body.method
      : undefined;
  const auth = describeAuth(req);
  const toolCalls = (Array.isArray(req.body) ? req.body : [req.body]).filter(
    (msg: any) => msg?.method === "tools/call",
  );
  const toolNames = toolCalls
    .map((msg: any) => loggableToolName(msg?.params?.name))
    .join(",");
  const tool = toolNames ? ` tool=${toolNames}` : "";
  const untrack = toolCalls.map((msg: any) =>
    trackToolCall(loggableToolName(msg?.params?.name), auth, msg?.params?.arguments),
  );
  if (tool) console.log(`[gleap-mcp] start rpc=${rpcMethod}${tool} auth=${auth}`);

  res.on("close", () => untrack.forEach((done) => done()));
  res.on("finish", () => {
    const reason =
      res.statusCode === 401
        ? ` reason=${JSON.stringify(res.getHeader("WWW-Authenticate") ?? "")}`
        : "";
    const line = `[gleap-mcp] ${req.method} ${MCP_PATH} rpc=${
      rpcMethod ?? "-"
    }${tool} auth=${auth} status=${res.statusCode} ${
      Date.now() - startedAt
    }ms${reason}`;
    if (res.statusCode >= 500) console.error(line);
    else if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });

  next();
});

// -------- MCP endpoint with dual auth --------
app.all(MCP_PATH, async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    // OAuth path: validate Bearer token via SDK middleware
    publicUrlFor(req).bearerAuth(req, res, (err?: any) => {
      if (err) return next(err);
      handleMcpRequest(req, res);
    });
  } else {
    if (readCreds(req)) {
      // Legacy header-based auth path
      handleMcpRequest(req, res);
    } else {
      // No credentials → return 401 to trigger OAuth discovery
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${publicUrlFor(req).resourceMetadataUrl}"`,
      );
      res.status(401).json({ error: "Authentication required" });
    }
  }
});

// -------- Health check --------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

app.get("/", (req, res) => {
  res
    .type("text")
    .send(`Gleap MCP server is running.\nMCP endpoint: ${publicUrlFor(req).url}`);
});

// -------- Body parser errors --------
// Oversized or malformed JSON is rejected by express.json() before the MCP
// transport and the request logger above run. Without this handler Express
// answers with an HTML error page and nothing is logged, which is how the 413
// on large article updates stayed invisible server-side.
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (
      typeof err?.type !== "string" ||
      !err.type.startsWith("entity.") ||
      typeof err.status !== "number"
    ) {
      return next(err);
    }
    const message =
      err.type === "entity.too.large"
        ? `Request body exceeds the ${MCP_JSON_BODY_LIMIT} limit`
        : (err.message ?? "Invalid request body");
    console.warn(
      `[gleap-mcp] ${req.method} ${req.path} status=${err.status} body-error=${
        err.type
      }${err.length != null ? ` length=${err.length}` : ""}`,
    );
    if (!res.headersSent) {
      res.status(err.status).json({
        jsonrpc: "2.0",
        error: { code: -32600, message },
        id: null,
      });
    }
  },
);

startLoopWatchdog(LOOP_STALL_EXIT_MS);

app.listen(PORT, () => {
  console.log(`[gleap-mcp] listening on http://localhost:${PORT}${MCP_PATH}`);
});
