import { Worker } from "node:worker_threads";

// Event-loop watchdog. On 2026-10-21 the EU instance spun at 100% CPU inside
// one request for 80 minutes: no log line, no crash, and App Platform kept
// routing to it because the process never exited. A worker thread watches a
// heartbeat the main thread bumps; when it stops for `stallMs`, the worker
// writes the in-flight tool calls straight to stderr (worker console output is
// relayed through the stuck main thread, so it would never appear) and kills
// the process so the platform restarts it.

const SUMMARY_BYTES = 4096;
const HEARTBEAT_MS = 250;

// [0] heartbeat counter, [1] summary length in bytes; the summary follows.
const shared = new SharedArrayBuffer(8 + SUMMARY_BYTES);
const header = new Int32Array(shared, 0, 2);
const summary = new Uint8Array(shared, 8, SUMMARY_BYTES);
const encoder = new TextEncoder();

type InFlight = { tool: string; auth: string; startedAt: number; args: string };
const inFlight = new Map<number, InFlight>();
let nextId = 0;

const publish = () => {
  const text = [...inFlight.values()]
    .map((c) => `tool=${c.tool} auth=${c.auth} started=${new Date(c.startedAt).toISOString()} args=${c.args}`)
    .join("\n");
  const bytes = encoder.encode(text).subarray(0, SUMMARY_BYTES);
  summary.fill(0);
  summary.set(bytes);
  Atomics.store(header, 1, bytes.length);
};

// Argument names and sizes only: values can carry customer data or secrets.
const describeArgs = (args: unknown): string => {
  if (!args || typeof args !== "object") return "-";
  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => {
      if (typeof value === "string") return `${key}(${value.length}ch)`;
      if (Array.isArray(value)) return `${key}[${value.length}]`;
      return key;
    })
    .join(",") || "-";
};

/** Records a tool call as running until the returned function is called. */
export const trackToolCall = (tool: string, auth: string, args: unknown): (() => void) => {
  const id = nextId++;
  inFlight.set(id, { tool, auth, startedAt: Date.now(), args: describeArgs(args) });
  publish();
  return () => {
    if (inFlight.delete(id)) publish();
  };
};

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const header = new Int32Array(workerData.shared, 0, 2);
const summary = new Uint8Array(workerData.shared, 8);
let last = Atomics.load(header, 0);
let lastChange = Date.now();
setInterval(() => {
  const beat = Atomics.load(header, 0);
  if (beat !== last) { last = beat; lastChange = Date.now(); return; }
  const stalled = Date.now() - lastChange;
  if (stalled < workerData.stallMs) return;
  const length = Atomics.load(header, 1);
  const calls = Buffer.from(summary.slice(0, length)).toString("utf8") || "(no tool call in flight)";
  writeSync(2, "[gleap-mcp] event loop stalled " + stalled + "ms, exiting so the platform restarts it. In-flight tool calls:\\n" + calls + "\\n");
  process.kill(process.pid, "SIGKILL");
}, 1000);
`;

export const startLoopWatchdog = (stallMs: number) => {
  if (!(stallMs > 0)) return;
  setInterval(() => Atomics.add(header, 0, 1), HEARTBEAT_MS).unref();
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { shared, stallMs } });
  worker.unref();
  worker.on("error", (err) => console.error("[gleap-mcp] loop watchdog failed:", err));
};
