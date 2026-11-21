import assert from "node:assert/strict";
import { test } from "node:test";
import { loggableToolName } from "./rpcBatch.js";

test("a tool name cannot forge or break a log line", () => {
  assert.equal(loggableToolName("get_ticket"), "get_ticket");
  assert.equal(loggableToolName("x status=200\n[gleap-mcp] POST /mcp auth=oauth"), "xstatus200gleap-mcpPOSTmcpauthoauth");
  assert.equal(loggableToolName('a"b c'), "abc");
  assert.equal(loggableToolName(undefined), "?");
  assert.equal(loggableToolName("\n\n"), "?");
  assert.equal(loggableToolName("t".repeat(200)).length, 80);
});
