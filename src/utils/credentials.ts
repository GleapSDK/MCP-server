import express from "express";
import { decodeJwt } from "jose";
import { AsyncLocalStorage } from "node:async_hooks";
import { Creds, ProjectCreds } from "../types/index.js";

// -------- Per-request context for creds --------
const requestContext = new AsyncLocalStorage<Creds>();

/**
 * The ticket a Kai Code turn's key is pinned to: the `ticketPin` claim the
 * Gleap API writes into the delegate key it mints for the turn (Server
 * delegateApiKey.ts, read there by kaiRunTicketPin.ts). Read from a verified
 * Bearer token only, whose signature covers the key it carries; a header key
 * is never read, since nothing here can check it. The API checks the key's
 * own signature and the pin again on every call.
 */
const ticketPinOfKey = (apiKey: unknown): string | undefined => {
  if (typeof apiKey !== "string" || !apiKey) return undefined;
  try {
    const pin = decodeJwt(apiKey).ticketPin;
    return typeof pin === "string" && /^[a-f0-9]{24}$/i.test(pin) ? pin : undefined;
  } catch {
    // Not a JWT (a project's secret API key): no pin.
    return undefined;
  }
};

/** A Gleap coding-session id: 24 hex characters, nothing else. */
export const AGENT_SESSION_ID_RE = /^[a-f0-9]{24}$/i;

/** `value` as a coding-session id, or undefined when it is not one. */
export const agentSessionIdOf = (value: unknown): string | undefined => {
  const id = typeof value === "string" ? value.trim() : "";
  return AGENT_SESSION_ID_RE.test(id) ? id : undefined;
};

/**
 * Extract credentials from a request.
 * 1. OAuth path: read from req.auth.extra (set by requireBearerAuth middleware)
 * 2. Legacy path: read from custom headers
 */
export const readCreds = (req: express.Request): Creds | null => {
  // Customer-session scope: a trusted server-side caller running a
  // customer-facing agent narrows this request to one customer's data.
  // Whoever holds the bearer credentials could simply omit the header, so it
  // only ever RESTRICTS — it grants nothing.
  const sessionScope = req.header("x-gleap-scope-session")?.trim() || undefined;
  // The coding session the caller works for (`.gleap/session.json`, Kai Code's
  // MCP config). It grants nothing either: the API resolves it inside the
  // caller's project and only refuses more with it (utils/agentSession.ts).
  const agentSessionId = agentSessionIdOf(req.header("x-gleap-session-id"));

  // OAuth-derived credentials (set by SDK's requireBearerAuth)
  const auth = (req as any).auth;
  const authExtra = auth?.extra;
  if (authExtra?.projectId && authExtra?.apiKey) {
    const projects = authExtra.projects as ProjectCreds[] | undefined;
    const runTicketPin = ticketPinOfKey(authExtra.apiKey);
    return {
      apiKey: authExtra.apiKey as string,
      projectId: authExtra.projectId as string,
      // Multi-project grants only, even when down to one project (see utils/projectSelection.ts).
      ...(Array.isArray(projects) && projects.length > 0 ? { projects } : {}),
      scopes: auth?.scopes as string[] | undefined,
      sessionScope,
      ...(runTicketPin ? { runTicketPin } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    };
  }

  // Legacy header-based credentials
  const apiKey =
    (
      req.header("x-gleap-api-key") ||
      req.header("gleap-api-key") ||
      req.header("x-api-key") ||
      req.header("api-key")
    )?.trim() ?? "";

  const projectId =
    (
      req.header("x-gleap-project-id") ||
      req.header("gleap-project-id") ||
      req.header("project-id") ||
      req.header("projectid") ||
      req.header("project")
    )?.trim() ?? "";

  if (!apiKey || !projectId) return null;
  return { apiKey, projectId, sessionScope, ...(agentSessionId ? { agentSessionId } : {}) };
};

/** The customer-session scope of this request, or null for full access. */
export const getSessionScope = (): string | null =>
  requestContext.getStore()?.sessionScope ?? null;

/** The coding session this connection named (`x-gleap-session-id`), or null. */
export const getAgentSessionId = (): string | null =>
  requestContext.getStore()?.agentSessionId ?? null;

/** The ticket this request's Kai Code run key is pinned to, or null (every other caller). */
export const getRunTicketPin = (): string | null =>
  requestContext.getStore()?.runTicketPin ?? null;

export const getCredsOrThrow = (): Creds => {
  const ctx = requestContext.getStore();
  if (!ctx?.apiKey || !ctx?.projectId) {
    throw new Error(
      "Missing Gleap credentials. Authenticate via OAuth or send 'x-gleap-api-key' and 'x-gleap-project-id' headers."
    );
  }
  return ctx;
};

export const requireScope = (scope: string): void => {
  const ctx = requestContext.getStore();
  // Legacy (header-based) auth has no scopes — allow all operations
  if (!ctx?.scopes) return;
  if (!ctx.scopes.includes(scope)) {
    throw new Error(
      `Insufficient scope. Required: ${scope}. Granted: ${ctx.scopes.join(" ")}`
    );
  }
};

/** Runs `fn` against `project` of a multi-project grant: its key and id for every API call inside. */
export const runInProject = <T>(project: ProjectCreds, fn: () => Promise<T>): Promise<T> => {
  if (!project.apiKey) throw new Error(`Project ${project.projectId} has no key this hour.`);
  return requestContext.run(
    { ...(requestContext.getStore() as Creds), apiKey: project.apiKey, projectId: project.projectId },
    fn
  );
};

export const runWithCreds = <T>(
  creds: Creds | null,
  fn: () => Promise<T>
): Promise<T> => {
  return requestContext.run(creds ?? ({} as Creds), fn);
};
