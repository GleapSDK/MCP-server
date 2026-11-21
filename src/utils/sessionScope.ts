import axios, { AxiosError } from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLEAP_API_BASE } from "../config/index.js";
import { GleapApiResponse } from "../types/index.js";
import { defaultHeaders, withRetry } from "./api.js";
import { getCredsOrThrow, getRunTicketPin, getSessionScope } from "./credentials.js";

/**
 * Session-scope policy: when a request carries `x-gleap-scope-session`
 * (a trusted server-side caller running a CUSTOMER-facing agent, e.g. Kai
 * Resolve), tool access is restricted to that customer's own data.
 *
 * Enforced centrally at registration time, so every tool — current and
 * future — falls under exactly one of three rules, DEFAULT-DENY last:
 *
 *  1. ALLOWED: knowledge/help-center/roadmap surfaces (feature requests
 *     are roadmap items, read and subscribed by id) and
 *     `search_similar_tickets` (its cross-ticket summaries are the tool's
 *     purpose; the consuming agent's prompt governs what may be said).
 *     The two roadmap WRITES are allowed with their customer arguments
 *     pinned (SCOPED_ARG_RULES): `create_feature_request` links only the
 *     scoped customer's own tickets, and it and `subscribe_to_feature_request`
 *     record the scoped contact's email, never one the model supplied.
 *  2. TICKET-ASSERTED: any tool whose args carry a string `ticketId` runs
 *     only after the target ticket is confirmed to belong to the scoped
 *     session ("my other ticket" works; other customers' tickets do not).
 *  3. Everything else is refused — contacts, companies, pipelines, surveys,
 *     statistics, ticket searches, multi-ticket operations, and any tool
 *     added later that nobody classified.
 *
 * No header = no policy: behavior is byte-identical to before this module
 * existed, for every other MCP consumer.
 *
 * One group is classified with or without the header: the database tools
 * (PINNED_RUN_ONLY) run only for a coding-agent session with a pinned
 * ticket, see pinnedRunCall.
 */

const ALLOWED_UNDER_SCOPE = new Set<string>([
  // Cross-ticket by design; results are internal material for the agent.
  "search_similar_tickets",
  // Knowledge & help center (project content, nothing customer-private).
  "search_knowledgebase",
  "get_help_center_collections",
  "get_help_center_collections_tree",
  "get_help_center_articles",
  "get_help_center_article",
  // Product knowledge from connected repositories (explanations, no code).
  "ask_code",
  // Roadmap triage (the feature-request flow Kai Resolve owns). Feature
  // requests are roadmap items, not a customer's conversation: the Server
  // resolves only FEATURE_REQUEST tickets of the project for these, and
  // get_feature_request returns no voter identities.
  "search_feature_requests",
  "get_feature_request",
  // Writes: their customer arguments are pinned, see SCOPED_ARG_RULES.
  "subscribe_to_feature_request",
  "create_feature_request",
  // News is published content.
  "get_news",
  "get_news_item",
  // Ticket-type metadata carries no customer data.
  "get_ticket_types",
]);

/**
 * The team's own databases (kai-db-access, Lukas 2026-10-31): Kai Code reads
 * them for the customer of the ticket it works on, so these run only for a
 * coding-agent session with a pinned ticket, a Kai Code turn whose key the
 * Gleap API pinned to that ticket (credentials.ts getRunTicketPin). Everyone
 * else is refused before any call: a person's own connection, an unpinned
 * Kai run, a header API key. The API refuses an unpinned key on these routes
 * too; this is the MCP's own line, not the only one.
 */
const PINNED_RUN_ONLY = new Set<string>(["describe_database", "query_database", "get_query_result"]);

const pinRequired = (toolName: string): GleapApiResponse => {
  const message =
    `${toolName} works only in a Kai Code run on a ticket: Kai Code reads the team's database for that ticket's customer. ` +
    "This connection is not one. This is a boundary, not a transient error: do not retry.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: true, sessionScope: true, message },
  };
};

const scopeDenied = (toolName: string): GleapApiResponse => {
  const message =
    `${toolName} is not available in customer-scoped runs: this run serves one customer ` +
    "and may only touch that customer's own conversations plus knowledge/roadmap surfaces. " +
    "If a teammate should look this up, raise it via ask_human.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: true, sessionScope: true, message },
  };
};

const wrongCustomer = (toolName: string): GleapApiResponse => {
  const message =
    `${toolName}: that ticket belongs to a different customer than this run serves. ` +
    "Customer-scoped runs can only access the current customer's own conversations. " +
    "This is a boundary, not a transient error — do not retry; use ask_human if a teammate should check.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: true, sessionScope: true, message },
  };
};

// Still a refusal (fail closed), but an honest one: the ownership lookup
// itself failed, which says nothing about whose ticket it is.
const ownershipUnverified = (toolName: string): GleapApiResponse => {
  const message =
    `${toolName}: could not verify that this ticket belongs to the customer this run serves ` +
    "(the Gleap API is temporarily unavailable). Retry once; if it fails again, continue without it.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: true, sessionScope: true, transient: true, message },
  };
};

const sessionIdOf = (session: unknown): string | null => {
  if (!session) return null;
  if (typeof session === "string") return session;
  if (typeof session === "object") {
    const candidate =
      (session as any)._id ?? (session as any).id ?? (session as any).gleapId;
    return typeof candidate === "string" ? candidate : (candidate?.toString?.() ?? null);
  }
  return (session as any).toString?.() ?? null;
};

/**
 * Does `ticketId` belong to the scoped session? Fails CLOSED: an id that
 * doesn't resolve, a ticket without a session (dashboard-created), or an API
 * error all refuse the call. A transient API error (retried first) comes back
 * as "unverified" rather than "another customer's", so the agent is not told
 * its own customer's ticket is off limits for good.
 */
const ticketOwnership = async (
  ticketId: string,
  sessionScope: string,
): Promise<"own" | "other" | "unverified"> => {
  try {
    const { apiKey, projectId } = getCredsOrThrow();
    const resp = await withRetry("read", (timeout) =>
      axios.get(`${GLEAP_API_BASE}/tickets/${encodeURIComponent(ticketId)}`, {
        headers: defaultHeaders(apiKey, projectId),
        timeout,
      }),
    );
    const sessionId = sessionIdOf(resp.data?.session);
    return !!sessionId && sessionId === sessionScope ? "own" : "other";
  } catch (err) {
    // No answer, or a server-side failure: nothing was learned about the owner.
    const isTransient =
      err instanceof AxiosError &&
      (!err.response || err.response.status >= 500 || err.response.status === 429);
    return isTransient ? "unverified" : "other";
  }
};

const noContact = (toolName: string, reason: "unknown" | "unverified" | "no-email"): GleapApiResponse => {
  const message =
    reason === "unverified"
      ? `${toolName}: could not look up the customer this run serves (the Gleap API is temporarily unavailable). ` +
        "Retry once; if it fails again, continue without it."
      : reason === "no-email"
        ? `${toolName}: the customer this run serves has no email address on their contact, and only their own ` +
          "email can be subscribed in a customer-scoped run. This is a boundary, not a transient error — do not " +
          "retry with another address; use ask_human if a teammate should follow up."
        : `${toolName}: could not find the customer this run serves, so nothing was recorded for them. ` +
          "This is a boundary, not a transient error — do not retry; use ask_human if a teammate should check.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      error: true,
      sessionScope: true,
      ...(reason === "unverified" ? { transient: true } : {}),
      message,
    },
  };
};

type ScopedContact = { email: string | null; name: string | null };

/**
 * The scoped session's contact (email + name), the only identity a scoped
 * run may record. Fails closed like ticketOwnership: a lookup error refuses
 * the call, a transient one honestly as "unverified".
 */
const scopedContact = async (
  sessionScope: string,
): Promise<ScopedContact | "unknown" | "unverified"> => {
  try {
    const { apiKey, projectId } = getCredsOrThrow();
    const resp = await withRetry("read", (timeout) =>
      axios.get(`${GLEAP_API_BASE}/sessions/${encodeURIComponent(sessionScope)}`, {
        headers: defaultHeaders(apiKey, projectId),
        timeout,
      }),
    );
    const session = resp.data;
    if (!session || typeof session !== "object") return "unknown";
    const id = sessionIdOf(session);
    if (id && id !== sessionScope) return "unknown";
    const email = typeof session.email === "string" ? session.email.trim() : "";
    const name = typeof session.name === "string" ? session.name.trim() : "";
    return { email: email || null, name: name || null };
  } catch (err) {
    const isTransient =
      err instanceof AxiosError &&
      (!err.response || err.response.status >= 500 || err.response.status === 429);
    return isTransient ? "unverified" : "unknown";
  }
};

const sameEmail = (a: unknown, b: string): boolean =>
  typeof a === "string" && a.trim().toLowerCase() === b.toLowerCase();

/**
 * The customer arguments of a roadmap write, pinned to the scoped contact.
 * A different email the model passed (prompt injection, or a name it read
 * in another customer's ticket) is replaced, never recorded; so is the name
 * that came with it.
 */
const pinnedCustomer = (
  args: any,
  contact: ScopedContact,
): { customerEmail: string | undefined; customerName: string | undefined } => {
  const keepsModelName = !!contact.email && sameEmail(args?.customerEmail, contact.email);
  const modelName =
    keepsModelName && typeof args?.customerName === "string" && args.customerName.trim()
      ? args.customerName
      : undefined;
  return {
    customerEmail: contact.email ?? undefined,
    customerName: contact.name ?? modelName,
  };
};

type ScopedArgOutcome = { args: any } | { refusal: GleapApiResponse };

/**
 * Allowed tools whose arguments name customers or tickets: in a scoped run
 * these run with the arguments the rule returns, or not at all.
 */
const SCOPED_ARG_RULES: Record<
  string,
  (args: any, sessionScope: string, toolName: string) => Promise<ScopedArgOutcome>
> = {
  // Links tickets to the new request and records its creator + first upvoter:
  // only the scoped customer's own tickets, only the scoped contact.
  create_feature_request: async (args, sessionScope, toolName) => {
    const linkedTicketIds: string[] = Array.isArray(args?.linkedTicketIds)
      ? [
          ...new Set<string>(
            args.linkedTicketIds
              .map((id: unknown) => (typeof id === "string" ? id.trim() : ""))
              .filter((id: string) => id.length > 0),
          ),
        ]
      : [];
    for (const ticketId of linkedTicketIds) {
      const ownership = await ticketOwnership(ticketId, sessionScope);
      if (ownership !== "own") {
        return {
          refusal: ownership === "unverified" ? ownershipUnverified(toolName) : wrongCustomer(toolName),
        };
      }
    }
    const contact = await scopedContact(sessionScope);
    if (contact === "unknown" || contact === "unverified") {
      return { refusal: noContact(toolName, contact) };
    }
    // No email on file (anonymous widget user): the request is still filed;
    // its creator is the source ticket's session, resolved server-side.
    return {
      args: {
        ...args,
        ...pinnedCustomer(args, contact),
        linkedTicketIds: linkedTicketIds.length > 0 ? linkedTicketIds : undefined,
      },
    };
  },
  // The email is the upvote key: only the scoped contact's own.
  subscribe_to_feature_request: async (args, sessionScope, toolName) => {
    const contact = await scopedContact(sessionScope);
    if (contact === "unknown" || contact === "unverified") {
      return { refusal: noContact(toolName, contact) };
    }
    if (!contact.email) {
      return { refusal: noContact(toolName, "no-email") };
    }
    return { args: { ...args, ...pinnedCustomer(args, contact) } };
  },
};

/**
 * A PINNED_RUN_ONLY tool: refused without a ticket pin. A customer-scoped
 * request narrows it further, since the header only ever restricts: the
 * pinned ticket must be the scoped customer's own, and a query across
 * customers (`scope: "team"`) is refused.
 */
const pinnedRunCall = async (
  name: string,
  handlerArgs: any[],
  handler: (...handlerArgs: any[]) => any,
) => {
  const pin = getRunTicketPin();
  if (!pin) return pinRequired(name);
  const sessionScope = getSessionScope();
  if (sessionScope) {
    if (handlerArgs[0]?.scope === "team") return scopeDenied(name);
    const ownership = await ticketOwnership(pin, sessionScope);
    if (ownership !== "own") {
      return ownership === "unverified" ? ownershipUnverified(name) : wrongCustomer(name);
    }
  }
  return handler(...handlerArgs);
};

/**
 * Patch `server.registerTool` so every handler registered afterwards runs
 * through the policy above. Call once per server instance, BEFORE the tool
 * registrars.
 */
export const applySessionScopePolicy = (server: McpServer): void => {
  const originalRegisterTool = server.registerTool.bind(server);

  (server as any).registerTool = (
    name: string,
    meta: any,
    handler: (...handlerArgs: any[]) => any,
  ) => {
    const guarded = async (...handlerArgs: any[]) => {
      if (PINNED_RUN_ONLY.has(name)) return pinnedRunCall(name, handlerArgs, handler);
      const sessionScope = getSessionScope();
      if (!sessionScope) {
        return handler(...handlerArgs);
      }
      const args = handlerArgs[0];
      if (ALLOWED_UNDER_SCOPE.has(name)) {
        const argRule = SCOPED_ARG_RULES[name];
        if (!argRule) return handler(...handlerArgs);
        const outcome = await argRule(args, sessionScope, name);
        if ("refusal" in outcome) return outcome.refusal;
        return handler(outcome.args, ...handlerArgs.slice(1));
      }
      const ticketId =
        typeof args?.ticketId === "string" ? args.ticketId.trim() : null;
      if (!ticketId) {
        return scopeDenied(name);
      }
      const ownership = await ticketOwnership(ticketId, sessionScope);
      if (ownership !== "own") {
        return ownership === "unverified" ? ownershipUnverified(name) : wrongCustomer(name);
      }
      // Secondary ticket references must pass the same check: `link_tickets`
      // asserts only its `ticketId` otherwise, letting a scoped run attach
      // its conversation to another customer's ticket via `linkedTicketId`.
      const linkedTicketId =
        typeof args?.linkedTicketId === "string"
          ? args.linkedTicketId.trim()
          : null;
      if (linkedTicketId) {
        const linkedOwnership = await ticketOwnership(linkedTicketId, sessionScope);
        if (linkedOwnership !== "own") {
          return linkedOwnership === "unverified" ? ownershipUnverified(name) : wrongCustomer(name);
        }
      }
      return handler(...handlerArgs);
    };
    return originalRegisterTool(name, meta, guarded as any);
  };
};
