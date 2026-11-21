// A customer-scoped run (x-gleap-scope-session: a customer-facing Kai agent) serves one customer.
// It must not name a coding session (sessionId: report_progress, send_message, the session tools act
// as that session) and must not read other customers' tickets through search_similar_tickets.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerProgressTools } = await import('../src/tools/progress.tool.js');
const { registerMessageTools } = await import('../src/tools/message.tool.js');
const { registerKnowledgeTools } = await import('../src/tools/knowledge.tool.js');
const { readCreds, runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const API = 'https://gleap-api.invalid/v3';
const OWN_TICKET = '0123456789abcdef01234567';
const CUSTOMER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SESSION = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const headersOf = (headers) => (name) => headers[name.toLowerCase()];
const keyRequest = (extra = {}) => ({ header: headersOf({ 'x-gleap-api-key': 'k', 'x-gleap-project-id': 'p1', ...extra }) });
const scoped = () => keyRequest({ 'x-gleap-scope-session': CUSTOMER });

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerProgressTools(registry);
registerMessageTools(registry);
registerKnowledgeTools(registry);

let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url });
    const data = config.url === `${API}/tickets/${OWN_TICKET}` ? { _id: OWN_TICKET, session: CUSTOMER } : { results: [], ok: true };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

const call = (name, args, request) =>
  runWithCreds(readCreds(request), async () => {
    const { config, handler } = tools.get(name);
    return handler(z.object(config.inputSchema).parse(args));
  });
const writes = () => requests.filter((r) => r.method !== 'get');

describe('a customer-scoped run cannot name a coding session', () => {
  test('report_progress with another sessionId on the own ticket -> refused, nothing written', async () => {
    const result = await call('report_progress', { ticketId: OWN_TICKET, sessionId: OTHER_SESSION, status: 'completed', message: 'done' }, scoped());
    assert.equal(result.isError, true);
    assert.deepEqual(writes(), []);
  });

  test('send_message with a sessionId -> refused, nothing written', async () => {
    const result = await call('send_message', { ticketId: OWN_TICKET, text: 'hi', sessionId: OTHER_SESSION }, scoped());
    assert.equal(result.isError, true);
    assert.deepEqual(writes(), []);
  });

  test('send_message on the own ticket without a sessionId -> still sent', async () => {
    const result = await call('send_message', { ticketId: OWN_TICKET, text: 'hi' }, scoped());
    assert.notEqual(result.isError, true);
    assert.equal(writes().length, 1);
  });

  test('an unscoped coding agent still passes its sessionId', async () => {
    const result = await call('send_message', { ticketId: OWN_TICKET, text: 'hi', sessionId: OTHER_SESSION }, keyRequest());
    assert.notEqual(result.isError, true);
    assert.equal(writes().length, 1);
  });
});

describe('a customer-scoped run cannot read other customers\' tickets', () => {
  test('search_similar_tickets -> refused before any call', async () => {
    const result = await call('search_similar_tickets', { query: 'refund' }, scoped());
    assert.equal(result.isError, true);
    assert.deepEqual(requests, []);
  });

  test('unscoped -> still searches', async () => {
    const result = await call('search_similar_tickets', { query: 'refund' }, keyRequest());
    assert.notEqual(result.isError, true);
    assert.equal(requests.length, 1);
  });
});
