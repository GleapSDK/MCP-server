// The database tools (kai-db-access) are a coding-agent session's only: a Kai
// Code turn whose key the Gleap API pinned to a ticket. Every other caller is
// refused before any API call, and a customer-scoped request narrows them
// further. The pin is read from a verified Bearer token's key only.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerDatabaseTools } = await import('../src/tools/database.tool.js');
const { readCreds, runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const API = 'https://gleap-api.invalid/v3';
const TICKET = '0123456789abcdef01234567';
const QUERY_ID = 'fedcba9876543210fedcba98';

// The delegate key inside a Kai run's Bearer token; the MCP reads its claims, the API checks its signature.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const delegateKey = (claims = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: 'kai-delegate', projectId: 'p1', userType: 'service_account', ...claims })}.signature`;
const headersOf = (headers) => (name) => headers[name.toLowerCase()];
/** A request the Bearer middleware verified (req.auth), optionally customer-scoped. */
const bearerRequest = (apiKey, headers = {}) => ({ auth: { clientId: 'gleap-kai', scopes: [], extra: { projectId: 'p1', apiKey } }, header: headersOf(headers) });
const headerKeyRequest = (apiKey) => ({ header: headersOf({ 'x-gleap-api-key': apiKey, 'x-gleap-project-id': 'p1' }) });

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerDatabaseTools(registry);

let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url, body: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : undefined });
    const data = config.url === `${API}/tickets/${TICKET}` ? { _id: TICKET, session: 'customer-session' } : { status: 'ran', queryId: QUERY_ID, rows: [], note: 'ok' };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

const call = (name, args, request) =>
  runWithCreds(readCreds(request), async () => {
    const { config, handler } = tools.get(name);
    return handler(z.object(config.inputSchema).parse(args));
  });

const CALLS = [
  ['describe_database', {}],
  ['query_database', { query: 'SELECT id FROM public.orders', purpose: 'the last order' }],
  ['get_query_result', { queryId: QUERY_ID }],
];

describe('database tools: session scope', () => {
  test('a Kai Code run on a ticket -> each tool reaches its pinned route', async () => {
    const pinned = bearerRequest(delegateKey({ ticketPin: TICKET }));
    for (const [name, args] of CALLS) {
      const result = await call(name, args, pinned);
      assert.ok(!result.isError, name);
    }
    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url}`),
      [`post ${API}/kai-databases/agent/describe`, `post ${API}/kai-databases/agent/query`, `get ${API}/kai-databases/agent/queries/${QUERY_ID}`],
    );
    assert.deepEqual(requests[1].body, { query: 'SELECT id FROM public.orders', purpose: 'the last order' });
  });

  test('no pinned ticket -> refused before any call', async () => {
    const callers = {
      'a person or an unpinned Kai run': bearerRequest(delegateKey()),
      'a malformed pin': bearerRequest(delegateKey({ ticketPin: '../tickets' })),
      'a key that is no JWT': bearerRequest('gleap-secret-api-key'),
      // Nothing here can verify a header key, so its claims never count.
      'a header API key claiming a pin': headerKeyRequest(delegateKey({ ticketPin: TICKET })),
    };
    for (const [who, request] of Object.entries(callers)) {
      for (const [name, args] of CALLS) {
        const result = await call(name, args, request);
        assert.equal(result.isError, true, `${who}: ${name}`);
        assert.equal(result.structuredContent.sessionScope, true, `${who}: ${name}`);
      }
    }
    assert.deepEqual(requests, []);
  });

  test('a customer-scoped run -> only its own ticket, never across customers', async () => {
    const pin = delegateKey({ ticketPin: TICKET });
    const own = await call('query_database', CALLS[1][1], bearerRequest(pin, { 'x-gleap-scope-session': 'customer-session' }));
    assert.ok(!own.isError);
    assert.equal(requests.at(-1).url, `${API}/kai-databases/agent/query`);

    requests = [];
    const other = await call('describe_database', {}, bearerRequest(pin, { 'x-gleap-scope-session': 'another-customer' }));
    assert.equal(other.isError, true);
    const team = await call('query_database', { ...CALLS[1][1], scope: 'team' }, bearerRequest(pin, { 'x-gleap-scope-session': 'customer-session' }));
    assert.equal(team.isError, true);
    // Only the ownership lookup ran; no database route was called.
    assert.deepEqual(requests.map((r) => r.url), [`${API}/tickets/${TICKET}`]);
  });
});
