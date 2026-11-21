import type { RequestHandler } from "express";

/**
 * JSON-RPC batches are limited before auth: the request log and the loop
 * watchdog look at every message of a batch, so one unauthenticated batch of
 * thousands of tool calls could stall the process. MCP clients send single
 * messages (the `2025-06-18` spec dropped batching), so a real batch stays small.
 */
export const MAX_BATCH_MESSAGES = 32;

/** Refuses a POST body that is a JSON-RPC batch of more than MAX_BATCH_MESSAGES messages. */
export const refuseOversizedBatch: RequestHandler = (req, res, next) => {
  if (!Array.isArray(req.body) || req.body.length <= MAX_BATCH_MESSAGES) return next();
  res.status(400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: `A JSON-RPC batch holds at most ${MAX_BATCH_MESSAGES} messages.` },
  });
};

/** A client-sent tool name as it may appear in a log line: no spaces, quotes or line breaks. */
export const loggableToolName = (name: unknown): string =>
  String(name ?? "?").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "?";
