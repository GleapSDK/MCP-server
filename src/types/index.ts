/**
 * One project of a multi-project OAuth grant (see utils/projectSelection.ts):
 * its delegate key, or why it has none this hour (`plan`: its workspace has
 * no Gleap MCP; `unavailable`: Gleap could not check it).
 */
export type ProjectCreds = {
  projectId: string;
  name: string;
  apiKey?: string;
  error?: "plan" | "unavailable";
};

export type Creds = {
  apiKey: string;
  projectId: string;
  /**
   * Every project of a multi-project OAuth grant, main project first (the
   * main one is also `apiKey` / `projectId`). Absent for one-project grants.
   */
  projects?: ProjectCreds[];
  scopes?: string[];
  /**
   * Customer-session scope (`x-gleap-scope-session`): set by trusted
   * server-side callers running a CUSTOMER-facing agent. When present, tool
   * access is restricted to that customer's own data (see
   * utils/sessionScope.ts). Absent = full project access, exactly as before.
   */
  sessionScope?: string;
  /**
   * The ticket a Kai Code turn's key is pinned to (the delegate key's
   * `ticketPin` claim, from a verified Bearer token only: utils/credentials.ts).
   * Absent for every other caller. The database tools need it
   * (utils/sessionScope.ts).
   */
  runTicketPin?: string;
  /**
   * The coding session this connection works for (`x-gleap-session-id`): the
   * client sets it from `.gleap/session.json` (the Gleap plugin), a Kai Code
   * sandbox from its MCP config. It only names the session: the API checks it
   * against the caller's project and books the writes to that session's
   * agent (utils/agentSession.ts). Absent for every other caller.
   */
  agentSessionId?: string;
};

export interface GleapApiResponse<T = any> {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
}
