export const PORT = parseInt(process.env.PORT ?? "3000", 10);
export const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

// Max JSON body size accepted on the MCP endpoint (body-parser size string).
// Article updates carry localized title/description plus a TipTap doc for every
// locale in one request, which easily exceeds body-parser's 100 KB default.
// The Gleap API itself accepts up to 100 MB.
export const MCP_JSON_BODY_LIMIT = process.env.MCP_JSON_BODY_LIMIT ?? "10mb";

// Kill the process when the event loop has been blocked this long, so the
// platform restarts it (see utils/loopWatchdog.ts). 0 turns the watchdog off.
export const LOOP_STALL_EXIT_MS = parseInt(process.env.LOOP_STALL_EXIT_MS ?? "30000", 10);

// Gleap API
export const GLEAP_API_BASE = process.env.GLEAP_API_BASE;
export const API_TIMEOUT = 15_000;
if (!GLEAP_API_BASE) {
  throw new Error("GLEAP_API_BASE environment variable is required");
}

// Dashboard base URL — used to build deep links back into the Gleap dashboard
// (`/projects/{projectId}/{boardPath}/{ticketId}`).
export const GLEAP_DASHBOARD_BASE = (
  process.env.GLEAP_DASHBOARD_BASE ?? "https://app.gleap.io"
).replace(/\/+$/, "");

// OAuth / JWKS
export const GLEAP_AUTH_ISSUER =
  process.env.GLEAP_AUTH_ISSUER ?? "https://api.gleap.io";
export const GLEAP_JWKS_URI =
  process.env.GLEAP_JWKS_URI ?? `${GLEAP_AUTH_ISSUER}/.well-known/jwks.json`;
export const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}${MCP_PATH}`;

// Other public URLs this server also answers on, comma-separated (e.g. the
// legacy https://mcp.gleap.io/mcp after the move to mcp.gleap.ai). Each host
// serves its own OAuth metadata, and tokens issued for any of them verify.
export const MCP_SERVER_URLS: string[] = [
  MCP_SERVER_URL,
  ...(process.env.MCP_SERVER_URL_ALIASES ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
];

export const GLEAP_SCOPES: string[] = [];

// Domain verification for the OpenAI plugin directory. OpenAI shows this token
// in the plugin submission form and fetches it from
// /.well-known/openai-apps-challenge to prove we own the MCP hostname.
export const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN ??
  "mEWz19T-Rf2Ll95bafvPKYQgPKW1GL-i1qolJUS0K5E";

export const CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "x-session-id",
  "mcp-session-id",
  "x-gleap-api-key",
  "x-gleap-project-id",
  "gleap-api-key",
  "gleap-project-id",
  "api-key",
  "projectid",
  "project-id",
  "x-api-key",
  "project",
  "x-gleap-scope-session",
  "x-gleap-session-id",
];
