import { GLEAP_DASHBOARD_BASE } from "../config/index.js";
import { gleapGet } from "./api.js";
import { getCredsOrThrow } from "./credentials.js";

// ── Board metadata (status lanes + dashboard path) ─────────────────────────
// A ticket's `status` is a lane *key*, and custom lanes are created with
// `Math.random().toString(36).substring(7)` in the dashboard — so a ticket on a
// custom board reports `status: "38jd9"`. Only the built-in lanes (OPEN,
// SNOOZED, DONE, …) are readable.
//
// `GET /projects/ticket-types` returns, per board, the lane list
// (`statuses: [{ key, title, hidden }]`), the board's priorities
// (`priorities: [{ key, title, color, archived, isDefault }]` — custom ones
// have generated `p_…` keys) and the dashboard URL segment (`path`). This
// module fetches that once per project and caches it, so every ticket the
// tools return can carry a readable `statusLabel` / `priorityLabel` and a
// working `dashboardUrl` without the agent having to look anything up.

const CACHE_TTL_MS = 5 * 60 * 1000;
// Failures are cached briefly too — a project whose config call is failing
// shouldn't get one extra request per ticket tool call.
const CACHE_TTL_ERROR_MS = 30 * 1000;
// One server process serves many projects, so expired entries are swept once
// the cache grows past this — otherwise every project ever touched stays
// resident for the life of the process.
const CACHE_SWEEP_THRESHOLD = 500;

interface StatusLane {
  key: string;
  title: string;
  hidden: boolean;
}

export interface PriorityOption {
  key: string;
  title: string;
  archived: boolean;
  isDefault: boolean;
}

interface Board {
  name: string | null;
  /** Dashboard URL segment, e.g. "bugs". Null for boards without one. */
  path: string | null;
  statuses: StatusLane[];
  priorities: PriorityOption[];
}

export interface BoardContext {
  projectId: string;
  /** Keyed by ticket type, e.g. "BUG" → Board. */
  boards: Map<string, Board>;
}

const cache = new Map<
  string,
  { expiresAt: number; ctx: Promise<BoardContext> }
>();

const sweepCache = (now: number): void => {
  if (cache.size < CACHE_SWEEP_THRESHOLD) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
};

/** A board's priorities as agents need them (valid values + their names); color dropped. */
export const parsePriorities = (entry: any): PriorityOption[] =>
  Array.isArray(entry?.priorities)
    ? entry.priorities
        .map((priority: any) => ({
          key: String(priority?.key ?? "").trim(),
          title: String(priority?.title ?? priority?.key ?? "").trim(),
          archived: priority?.archived === true,
          isDefault: priority?.isDefault === true,
        }))
        .filter((priority: PriorityOption) => priority.key.length > 0)
    : [];

const parseBoards = (payload: any): Map<string, Board> => {
  const boards = new Map<string, Board>();
  const types = payload?.ticketTypes;
  if (!Array.isArray(types)) return boards;

  for (const entry of types) {
    const type = String(entry?.type ?? "").trim();
    if (!type) continue;

    boards.set(type, {
      name: entry?.name ?? null,
      path: typeof entry?.path === "string" && entry.path ? entry.path : null,
      statuses: Array.isArray(entry?.statuses)
        ? entry.statuses.map((lane: any) => ({
            key: String(lane?.key ?? "").trim(),
            title: String(lane?.title ?? lane?.key ?? "").trim(),
            hidden: lane?.hidden === true,
          }))
        : [],
      priorities: parsePriorities(entry),
    });
  }
  return boards;
};

const fetchBoardContext = async (projectId: string): Promise<BoardContext> => {
  try {
    const response = await gleapGet("/projects/ticket-types");
    const sc = response.structuredContent as any;
    // gleapGet reports API failures as an `{ error: true }` envelope rather
    // than throwing — an empty context degrades to today's raw-key behavior.
    if (!sc || sc.error) return { projectId, boards: new Map() };
    return { projectId, boards: parseBoards(sc) };
  } catch {
    return { projectId, boards: new Map() };
  }
};

/**
 * Board config for the current request's project. Never rejects and never
 * throws on API failure — callers get an empty context and skip enrichment,
 * so a broken config call degrades tickets to raw keys instead of failing.
 */
export const getBoardContext = async (): Promise<BoardContext> => {
  const { projectId } = getCredsOrThrow();

  const now = Date.now();
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt > now) return cached.ctx;

  sweepCache(now);

  // Cache the promise, not the result, so concurrent tool calls in one request
  // share a single fetch instead of stampeding the config endpoint.
  const ctx = fetchBoardContext(projectId);
  cache.set(projectId, { expiresAt: now + CACHE_TTL_MS, ctx });

  const resolved = await ctx;
  if (resolved.boards.size === 0) {
    cache.set(projectId, { expiresAt: now + CACHE_TTL_ERROR_MS, ctx });
  }
  return resolved;
};

const BUILT_IN_PRIORITY_KEYS = ["LOW", "MEDIUM", "HIGH"];

/**
 * find_tickets' priority filter → stored keys. The REST filter matches the raw
 * key, so "high" or a title like "Urgent" would silently match nothing. Per
 * comma-separated part: built-in keys are upper-cased, and every priority on
 * any board whose title matches (case-insensitive) adds its key; a part that
 * matches neither passes through as-is (a custom `p_…` key).
 */
export const resolvePriorityFilter = (
  ctx: BoardContext,
  input: string | undefined,
): string | undefined => {
  if (!input) return input;
  const allPriorities = [...ctx.boards.values()].flatMap(
    (board) => board.priorities,
  );
  const keys = new Set<string>();
  for (const raw of input.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const before = keys.size;
    const upper = part.toUpperCase();
    if (BUILT_IN_PRIORITY_KEYS.includes(upper)) keys.add(upper);
    const title = part.toLowerCase();
    for (const priority of allPriorities) {
      if (priority.title.toLowerCase() === title) keys.add(priority.key);
    }
    if (keys.size === before) keys.add(part);
  }
  return keys.size > 0 ? [...keys].join(",") : undefined;
};

/**
 * Adds `statusLabel` (human-readable lane title), `priorityLabel` (the board's
 * priority title) and `dashboardUrl` (deep link into the dashboard) to a
 * ticket record. All keys are always present — null when unresolvable — so
 * their absence never reads as "this ticket has no status label" to the model.
 */
export const decorateTicket = (
  ctx: BoardContext,
  ticket: any,
): Record<string, unknown> => {
  if (!ticket || typeof ticket !== "object") return ticket;

  const board = ctx.boards.get(String(ticket.type ?? ""));
  // Bot conversations live on the INQUIRY board, priorities included.
  const priorityBoard =
    ticket.type === "BOT" ? ctx.boards.get("INQUIRY") : board;
  const status = ticket.status;
  const priority = ticket.priority;
  const ticketId = ticket.id ?? ticket._id;

  return {
    ...ticket,
    statusLabel:
      (typeof status === "string" && status
        ? board?.statuses.find((lane) => lane.key === status)?.title
        : null) ?? null,
    priorityLabel:
      (typeof priority === "string" && priority
        ? priorityBoard?.priorities.find((option) => option.key === priority)
            ?.title
        : null) ?? null,
    dashboardUrl:
      board?.path && ticketId
        ? `${GLEAP_DASHBOARD_BASE}/projects/${ctx.projectId}/${board.path}/${ticketId}`
        : null,
  };
};
