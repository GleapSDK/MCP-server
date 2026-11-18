// get_session_brief: the kickoff of a Gleap coding session, fetched from the
// Server instead of carried in the deep link. The link names only the session;
// the brief (ticket, rules, findings, repository) comes from
// GET /gleapcode/sessions/{id}/agent-workflow without a kind: the Server picks
// the session's own kind and returns the brief as Markdown in `markdown`
// (`brief` is its structured form).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSessionTools } = await import('../src/tools/session.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { applyProjectSelection, registerProjectTools } = await import('../src/utils/projectSelection.js');
const { STOP_TEXT } = await import('../src/utils/agentSession.js');

const tools = new Map();
const registry = {
  registerTool(name, config, handler) { tools.set(name, { config, handler }); },
  registerPrompt() {},
};
applySessionScopePolicy(registry);
registerSessionTools(registry);

const PROJECT = '613b5dd730aed737108f87ab';
const SESSION = '64f0c0ffee0000000000abcd';
const STOPPED = '64f0c0ffee0000000000dead';
const BRIEF_FIELDS = { ticket: { bugId: 7 }, repository: 'GleapSDK/Frontend', skill: 'fix-ticket' };
const BRIEF = '# Fix ticket #7\nYour session owns ticket #7. Repository: GleapSDK/Frontend. Load the Gleap plugin skill fix-ticket.';
const HOOK = { sessionId: SESSION, token: 'hook-jwt-secret', apiBase: 'https://api.gleap.io/v3', expiresAt: '2026-11-14T12:00:00Z' };

let requests;
const header = (headers, name) => headers?.[name] ?? headers?.get?.(name);
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url, params: config.params, headers: config.headers });
    const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (config.url.endsWith(`/gleapcode/sessions/${STOPPED}/agent-workflow`)) {
      return ok({ success: true, sessionId: STOPPED, stop: true, kind: 'fix', brief: BRIEF_FIELDS, markdown: BRIEF });
    }
    if (config.url.endsWith(`/gleapcode/sessions/${SESSION}/agent-workflow`)) {
      return ok({
        success: true,
        sessionId: SESSION,
        stop: false,
        hook: HOOK,
        kind: 'fix',
        brief: BRIEF_FIELDS,
        markdown: BRIEF,
        operatorFeedback: { message: 'Your operator asked for changes: keep the old button label.' },
      });
    }
    throw new axios.AxiosError('Not found', 'ERR_BAD_REQUEST', config, null, { data: { message: 'Not found' }, status: 404, statusText: 'Not Found', headers: {}, config });
  };
});

const call = (args) => runWithCreds({ apiKey: 'test-only', projectId: PROJECT }, async () => {
  const { config, handler } = tools.get('get_session_brief');
  return handler(z.object(config.inputSchema).strict().parse(args));
});

describe('get_session_brief', () => {
  test('is registered with the get_agent_workflow annotations and a description under 1024 chars', () => {
    const { config } = tools.get('get_session_brief');
    assert.deepEqual(config.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true });
    assert.ok(config.description.length <= 1024, `description is ${config.description.length} chars`);
    assert.match(config.description, /get_session_brief|kickoff/);
  });

  test('GETs the session\'s agent-workflow without a kind, with the caller\'s project', async () => {
    await call({ sessionId: SESSION });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'get');
    assert.equal(new URL(requests[0].url).pathname, `/v3/gleapcode/sessions/${SESSION}/agent-workflow`);
    assert.equal(requests[0].params?.kind, undefined);
    assert.equal(new URL(requests[0].url).searchParams.has('kind'), false);
    assert.equal(header(requests[0].headers, 'project'), PROJECT);
  });

  test('the brief comes first, then the operator feedback and the session file', async () => {
    const res = await call({ sessionId: SESSION });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, BRIEF);
    assert.ok(!res.content[0].text.includes(HOOK.token), 'the token is not in the brief block');
    const texts = res.content.map((c) => c.text);
    assert.ok(texts.includes('Your operator asked for changes: keep the old button label.'));
    const hook = texts.find((t) => t.includes('.gleap/session.json'));
    assert.ok(hook, 'hook line present');
    assert.ok(hook.includes(HOOK.token));
    assert.ok(texts.indexOf(hook) > 0);
    assert.equal(res.structuredContent.sessionId, SESSION);
    assert.equal(res.structuredContent.kind, 'fix');
  });

  test('a stopped session gets only the STOP instruction', async () => {
    const res = await call({ sessionId: STOPPED });
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].text, STOP_TEXT);
    assert.equal(res.structuredContent.stop, true);
  });

  test('another project\'s session comes back as an error', async () => {
    const res = await call({ sessionId: '64f0c0ffee0000000000ffff' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /404/);
  });

  test('sessionId is required and must be a session id: refused before any request', async () => {
    const schema = z.object(tools.get('get_session_brief').config.inputSchema).strict();
    assert.throws(() => schema.parse({}));
    assert.throws(() => schema.parse({ sessionId: '../../tickets/x' }));
    assert.throws(() => schema.parse({ sessionId: `${SESSION}/../x` }));
    // The handler itself refuses too (a client that skips the schema).
    const res = await runWithCreds({ apiKey: 'test-only', projectId: PROJECT }, () =>
      tools.get('get_session_brief').handler({ sessionId: '../x' }));
    assert.equal(res.isError, true);
    assert.equal(requests.length, 0);
  });
});

describe('get_session_brief on a multi-project connection', () => {
  const GLEAP = { projectId: '64a000000000000000000001', name: 'Gleap', apiKey: 'key-gleap' };
  const ACME = { projectId: '64a000000000000000000002', name: 'Acme Web', apiKey: 'key-acme' };
  const PROJECTS = [GLEAP, ACME];
  const multi = { apiKey: GLEAP.apiKey, projectId: GLEAP.projectId, projects: PROJECTS };

  const connect = async () => {
    const server = new McpServer({ name: 'gleap-mcp-test', version: '0.0.0' });
    applyProjectSelection(server, PROJECTS);
    registerProjectTools(server, PROJECTS);
    applySessionScopePolicy(server);
    registerSessionTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  };

  test('without projectId -> refused before any request (the call consumes operator words)', async () => {
    const client = await connect();
    const res = await runWithCreds(multi, () => client.callTool({ name: 'get_session_brief', arguments: { sessionId: SESSION } }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /needs projectId/);
    assert.equal(requests.length, 0);
  });

  test('naming a project -> that project\'s key', async () => {
    const client = await connect();
    const res = await runWithCreds(multi, () =>
      client.callTool({ name: 'get_session_brief', arguments: { sessionId: SESSION, projectId: ACME.projectId } }));
    assert.notEqual(res.isError, true);
    assert.equal(res.content[0].text, BRIEF);
    assert.equal(requests.length, 1);
    assert.equal(header(requests[0].headers, 'project'), ACME.projectId);
    assert.equal(header(requests[0].headers, 'Authorization'), `Bearer ${ACME.apiKey}`);
  });
});
