// update_office_hours and update_sla save through the project's settings registry (PUT /settings), one stored
// field per change, like update_settings: never PUT /projects, never the whole slaOptions object. The tools'
// inputs and results stay what AI clients know. Drives the real SDK server over an in-memory transport.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerToolboxTools } from "./toolbox.tool.js";
import { runWithCreds } from "../utils/credentials.js";

type Sent = { method: string; url: string; params: Record<string, unknown>; body: unknown };
type Change = { key: string; value: unknown };

const API = "https://gleap-api.invalid/v3";
const WEEK = [
  { day: "Weekdays", openingTime: "09:00", closingTime: "17:00" },
  { day: "Saturday", openingTime: "10:00", closingTime: "12:30" },
];

let sent: Sent[];
let stored: Record<string, unknown>;
let refusal: string | null;
let confirmation: string | null;

const isChange = (value: unknown): value is Change => !!value && typeof value === "object" && "key" in value && typeof value.key === "string";
const changesIn = (body: unknown): Change[] =>
  body && typeof body === "object" && "changes" in body && Array.isArray(body.changes) ? body.changes.filter(isChange) : [];

// The settings API as GET/PUT /settings answer: values by stored key; changed, refused and needsConfirmation lists.
const settingsAnswer = (method: string, params: Record<string, unknown>, body: unknown) => {
  if (method === "get") {
    const keys = `${params.keys ?? ""}`.split(",").filter(Boolean);
    return { settings: [{ page: "sla", name: "SLAs", values: Object.fromEntries(keys.map((key) => [key, stored[key] ?? null])) }] };
  }
  const changes = changesIn(body);
  if (refusal) return { changed: [], refused: changes.map((change) => ({ change: change.key, reason: refusal })) };
  if (confirmation) return { changed: [], refused: [], needsConfirmation: changes.map((change) => ({ change: change.key, why: confirmation })) };
  const changed = changes.map((change) => ({ page: "sla", key: change.key, before: stored[change.key] ?? null, after: change.value, line: change.key }));
  for (const change of changes) stored[change.key] = change.value;
  return { changed, refused: [] };
};

beforeEach(() => {
  sent = [];
  stored = { "slaOptions.enabled": true, "slaOptions.defaultSla": 3600 };
  refusal = null;
  confirmation = null;
  axios.defaults.adapter = async (config) => {
    const method = `${config.method ?? "get"}`;
    const url = `${config.url ?? ""}`;
    const params: Record<string, unknown> = { ...config.params };
    const body: unknown = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    sent.push({ method, url, params, body });
    if (url !== `${API}/settings`) throw new Error(`unexpected request ${method} ${url}`);
    return { data: settingsAnswer(method, params, body), status: 200, statusText: "OK", headers: {}, config };
  };
});

const call = async (name: string, args: Record<string, unknown>) => {
  const server = new McpServer({ name: "gleap-mcp-test", version: "0.0.0" });
  registerToolboxTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await runWithCreds({ apiKey: "test-only", projectId: "p1" }, () => client.callTool({ name, arguments: args }));
  const text = Array.isArray(result.content) ? result.content.map((part) => `${part?.text ?? ""}`).join("\n") : "";
  return { isError: result.isError === true, structured: result.structuredContent, text };
};

const writes = () => sent.filter((request) => request.method !== "get");

describe("update_office_hours saves through the settings registry", () => {
  test("the week, the timezone and always online -> one settings change each, nothing else written", async () => {
    const result = await call("update_office_hours", { openingTimes: WEEK, timezone: "Europe/Vienna", alwaysOnline: false });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(writes(), [
      {
        method: "put",
        url: `${API}/settings`,
        params: {},
        body: {
          changes: [
            { key: "flowConfig.openingTimes", value: WEEK },
            { key: "flowConfig.timezone", value: "Europe/Vienna" },
            { key: "flowConfig.alwaysOnline", value: false },
          ],
        },
      },
    ]);
    assert.deepEqual(result.structured, { changed: ["openingTimes", "timezone", "alwaysOnline"], message: "Office hours saved." });
  });

  test("only the timezone -> only flowConfig.timezone is sent", async () => {
    const result = await call("update_office_hours", { timezone: "America/New_York" });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(changesIn(writes()[0]?.body), [{ key: "flowConfig.timezone", value: "America/New_York" }]);
    assert.equal(writes().length, 1);
    assert.deepEqual(result.structured, { changed: ["timezone"], message: "Office hours saved." });
  });

  test("an empty week closes every day: the empty list is saved", async () => {
    const result = await call("update_office_hours", { openingTimes: [] });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(changesIn(writes()[0]?.body), [{ key: "flowConfig.openingTimes", value: [] }]);
    assert.deepEqual(result.structured, { changed: ["openingTimes"], message: "Office hours saved." });
  });

  test("a change the settings refuse -> an error with the reason, never 'saved'", async () => {
    refusal = "only project admins change this page";
    const result = await call("update_office_hours", { alwaysOnline: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /only project admins change this page/);
    assert.doesNotMatch(result.text, /Office hours saved/);
  });

  test("a change that waits for the person's yes ran nothing -> an error, never 'saved'", async () => {
    confirmation = "Customers see the team as online at night.";
    const result = await call("update_office_hours", { alwaysOnline: true });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.text, /Office hours saved/);
  });

  test("closing before opening -> refused before any request", async () => {
    const result = await call("update_office_hours", { openingTimes: [{ day: "Monday", openingTime: "17:00", closingTime: "09:00" }] });
    assert.equal(result.isError, true);
    assert.equal(sent.length, 0);
  });
});

describe("update_sla saves single slaOptions fields through the settings registry", () => {
  test("switching off sends only slaOptions.enabled and reports the stored deadline", async () => {
    const result = await call("update_sla", { enabled: false });
    assert.equal(result.isError, false, result.text);
    assert.equal(writes().length, 1);
    assert.equal(writes()[0]?.url, `${API}/settings`);
    assert.deepEqual(writes()[0]?.body, { changes: [{ key: "slaOptions.enabled", value: false }] });
    assert.deepEqual(result.structured, { sla: { enabled: false, minutes: 60 }, message: "SLA off." });
  });

  test("a deadline alone switches the SLA on and saves it in seconds", async () => {
    const result = await call("update_sla", { minutes: 240 });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(writes(), [
      {
        method: "put",
        url: `${API}/settings`,
        params: {},
        body: {
          changes: [
            { key: "slaOptions.enabled", value: true },
            { key: "slaOptions.defaultSla", value: 14400 },
          ],
        },
      },
    ]);
    assert.deepEqual(result.structured, { sla: { enabled: true, minutes: 240 }, message: "SLA saved." });
  });

  test("switched off with a new deadline -> both fields, reported off", async () => {
    const result = await call("update_sla", { enabled: false, minutes: 120 });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(changesIn(writes()[0]?.body), [
      { key: "slaOptions.enabled", value: false },
      { key: "slaOptions.defaultSla", value: 7200 },
    ]);
    assert.deepEqual(result.structured, { sla: { enabled: false, minutes: 120 }, message: "SLA off." });
  });

  test("no deadline stored -> minutes null", async () => {
    stored = {};
    const result = await call("update_sla", { enabled: true });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.structured, { sla: { enabled: true, minutes: null }, message: "SLA saved." });
  });

  test("a change the settings refuse (plan, role) -> an error with the reason, never 'saved'", async () => {
    refusal = "Ticket SLAs need the Pro plan.";
    const result = await call("update_sla", { minutes: 60 });
    assert.equal(result.isError, true);
    assert.match(result.text, /Ticket SLAs need the Pro plan\./);
    assert.doesNotMatch(result.text, /SLA saved/);
  });

  test("nothing to change -> refused before any request", async () => {
    const result = await call("update_sla", {});
    assert.equal(result.isError, true);
    assert.equal(sent.length, 0);
  });
});
