// Every tool, as an MCP client lists and calls it on the real endpoint (src/index.ts in this process, the Gleap API a
// stub): what it declares, that it refuses invalid input before calling Gleap, that its results are well-formed and
// carry no credentials, that a refused write reads as an error, and that a customer-scoped caller cannot write.
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { gleapApi, startApp } from './support/app.js';
import { sampleArgs, wronglyTypedArgs, type JsonSchema } from './support/sampleArgs.js';

const API_KEY = 'contract-test-key-4f1d9a';
const PROJECT_ID = 'contract-project';
const SCOPED_SESSION = '64f0c0ffee0000000000c0de';
// The two writes a customer-scoped run may make, with the customer arguments the policy pins (src/utils/sessionScope.ts,
// tests/feature-requests.test.mjs). Any other write under a scope is refused.
const PINNED_SCOPED_WRITES = new Set(['create_feature_request', 'subscribe_to_feature_request']);

const app = await startApp();
const connect = async (headers: Record<string, string>) => {
  const client = new Client({ name: 'tool-contract-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.mcpUrl), { requestInit: { headers } }));
  return client;
};
const credentials = { 'x-gleap-api-key': API_KEY, 'x-gleap-project-id': PROJECT_ID };
const client = await connect(credentials);
const scopedClient = await connect({ ...credentials, 'x-gleap-scope-session': SCOPED_SESSION });
const { tools } = await client.listTools();

after(async () => {
  await client.close();
  await scopedClient.close();
  await app.close();
});
beforeEach(() => gleapApi.reset());

const call = async (name: string, args: Record<string, unknown>, by = client): Promise<CallToolResult> =>
  CallToolResultSchema.parse(await by.callTool({ name, arguments: args }));
const textOf = (result: CallToolResult) => result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
const isInputValidationError = (result: CallToolResult) => result.isError === true && /Input validation error/.test(textOf(result));
const writes = () => gleapApi.requests.filter((request) => request.method !== 'GET');

const assertWellFormed = (result: CallToolResult) => {
  assert.ok(result.content.length > 0, 'a result has content');
  for (const item of result.content) {
    if (item.type === 'text') assert.ok(item.text.trim().length > 0, 'a text item is not empty');
  }
  if (result.structuredContent !== undefined) {
    assert.ok(typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent), 'structuredContent is an object');
  }
  assert.ok(!JSON.stringify(result).includes(API_KEY), 'the result carries no API key');
};

test('tools/list names every tool once', () => {
  assert.ok(tools.length > 0);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
});

describe('every tool declares what a client needs to choose it', () => {
  for (const tool of tools) {
    test(tool.name, () => {
      assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/, 'snake_case, at most 64 characters (OpenAI refuses longer function names)');
      assert.ok(tool.title?.trim(), 'a title');
      assert.equal(tool.annotations?.title, tool.title, 'annotations.title repeats the title for the connector directory');
      assert.ok(tool.description?.trim(), 'a description');
      assert.equal(tool.inputSchema.type, 'object');
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${hint} is set: its default assumes the worst`);
      }
      if (tool.annotations?.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, 'a read-only tool destroys nothing');
    });
  }
});

describe('every tool refuses invalid input before calling Gleap', () => {
  for (const tool of tools) {
    const schema = tool.inputSchema as JsonSchema;
    if (schema.required?.length) {
      test(`${tool.name}: without its required arguments`, async () => {
        assert.ok(isInputValidationError(await call(tool.name, {})));
        assert.deepEqual(gleapApi.requests, []);
      });
    }
    const wrong = wronglyTypedArgs(schema);
    if (wrong) {
      test(`${tool.name}: with arguments of the wrong type`, async () => {
        assert.ok(isInputValidationError(await call(tool.name, wrong)));
        assert.deepEqual(gleapApi.requests, []);
      });
    }
  }
});

describe('every tool answers with a well-formed result', () => {
  for (const tool of tools) {
    const args = sampleArgs(tool.inputSchema as JsonSchema, tool.name);

    test(`${tool.name}: when Gleap answers`, async () => {
      const result = await call(tool.name, args);
      assert.ok(!isInputValidationError(result), `the sample arguments are valid: ${textOf(result)}`);
      assertWellFormed(result);
      for (const request of gleapApi.requests) {
        assert.ok(request.url.startsWith(`${process.env.GLEAP_API_BASE}/`), `${request.url} is the Gleap API`);
        assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
        assert.equal(request.headers.project, PROJECT_ID);
      }
    });

    test(`${tool.name}: when Gleap refuses`, async () => {
      gleapApi.answerWith(() => ({ status: 400, data: { message: 'Refused by the test stub' } }));
      const result = await call(tool.name, args);
      assertWellFormed(result);
      if (!tool.annotations?.readOnlyHint) assert.equal(result.isError, true, 'a refused write never reads as done');
    });
  }
});

describe('a customer-scoped caller writes nothing beyond the pinned roadmap writes', () => {
  for (const tool of tools.filter(({ name, annotations }) => !annotations?.readOnlyHint && !PINNED_SCOPED_WRITES.has(name))) {
    test(tool.name, async () => {
      // Every ticket belongs to another customer.
      gleapApi.answerWith(() => ({ status: 200, data: { session: { _id: '64f0c0ffee0000000000f00d' } } }));
      const result = await call(tool.name, sampleArgs(tool.inputSchema as JsonSchema, tool.name), scopedClient);
      assert.equal(result.isError, true);
      assert.deepEqual(writes(), []);
    });
  }
});
