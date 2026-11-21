import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLEAP_AUTH_ISSUER } from "../config/index.js";

/**
 * ChatGPT connections list fewer tools. OpenAI refuses a request with more
 * than 128 tools ("Invalid 'tools': array too long"), and a ChatGPT connector
 * whose tools/list is longer loads with no tools at all: refreshing it fails
 * with "Could not update the app" (#227003; the list passed 128 on
 * 2026-10-18). ChatGPT lists every tool except Kai's operator and
 * coding-agent tools (src/index.ts). Every tool stays registered, so a call
 * by name still works: the ChatGPT directory app keeps the tool list it was
 * reviewed with.
 */

/** ChatGPT's connector callback (Gleap Server, src/api/oauth/services/knownOAuthClients.ts). */
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const CLIENT_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CACHED_CLIENTS = 10_000;

// A client's redirect URIs never change, so one lookup per client and process.
const chatGptClients = new Map<string, boolean>();

/** Whether an OAuth client is ChatGPT: it sends its codes to ChatGPT's connector callback. */
export const isChatGptClient = async (clientId: unknown): Promise<boolean> => {
  if (typeof clientId !== "string" || !clientId) return false;
  const known = chatGptClients.get(clientId);
  if (known !== undefined) return known;
  try {
    const resp = await fetch(`${GLEAP_AUTH_ISSUER}/oauth/register/${encodeURIComponent(clientId)}`, {
      signal: AbortSignal.timeout(CLIENT_LOOKUP_TIMEOUT_MS),
    });
    if (!resp.ok) return false;
    const client: any = await resp.json();
    const chatGpt =
      Array.isArray(client?.redirect_uris) &&
      client.redirect_uris.some((uri: unknown) => typeof uri === "string" && CHATGPT_CALLBACK.test(uri));
    if (chatGptClients.size >= MAX_CACHED_CLIENTS) chatGptClients.clear();
    chatGptClients.set(clientId, chatGpt);
    return chatGpt;
  } catch {
    // Gleap could not say: the full list, as before. The next request asks again.
    return false;
  }
};

/** Runs `register` and returns the names of the tools it registered on `server`. */
export const toolNamesRegisteredBy = (server: McpServer, register: () => void): Set<string> => {
  const names = new Set<string>();
  const registerTool = server.registerTool;
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    names.add(name);
    return (registerTool as any).call(server, name, ...rest);
  };
  try {
    register();
  } finally {
    (server as any).registerTool = registerTool;
  }
  return names;
};

/**
 * Tools ChatGPT does not list because OpenAI's directory scan cannot approve
 * them: the workflow tools run steps a team configured (the scan wants each
 * step as its own tool), and reading a survey's AI summary or insights may
 * regenerate them. Other clients list them, and a call by name still works.
 */
export const NOT_IN_CHATGPT_DIRECTORY = [
  "get_workflows",
  "get_workflows_available_for_ticket",
  "run_ticket_workflow",
  "get_survey_summary",
  "get_survey_insights",
] as const;

/**
 * Leaves `hidden` and NOT_IN_CHATGPT_DIRECTORY out of tools/list for ChatGPT connections. Call AFTER every
 * tool is registered (the SDK installs the tools/list handler on the first
 * registerTool).
 */
export const limitToolsForChatGpt = (server: McpServer, hidden: ReadonlySet<string>): void => {
  const handlers = (server.server as any)?._requestHandlers as Map<string, (req: any, extra: any) => Promise<any>> | undefined;
  const inner = handlers?.get("tools/list");
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (req, extra) => {
    const res = await inner(req, extra);
    if (!(await isChatGptClient(extra?.authInfo?.clientId))) return res;
    const unlisted = new Set<string>([...hidden, ...NOT_IN_CHATGPT_DIRECTORY]);
    return { ...res, tools: (res?.tools ?? []).filter((tool: any) => !unlisted.has(tool?.name)) };
  });
};
