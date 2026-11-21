// Ticket share tokens never leave the MCP server. `shareToken` opens a ticket
// without a login (GET /v3/shared/tickets/{shareToken}, the public /share page),
// `secretShareToken` does the same through the `secret-share-token` header. The
// REST API answers ticket calls with both, and the ticket tools passed them to
// every MCP client (live E2E 2026-10-12: Kai Copilot's close_ticket on #185343
// stored both in the agent's conversation). These tests drive the real SDK
// server over an in-memory transport, the way a client sees the results.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios, { AxiosError } from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { registerFeatureRequestTools } = await import('../src/tools/featurerequest.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { applyShareTokenRedaction, stripShareTokensFromText, stripShareTokensFromResult } = await import(
  '../src/utils/shareTokenRedaction.js'
);

const SHARE = 'S'.repeat(70);
const SECRET = 'X'.repeat(70);
const LINKED_SHARE = 'L'.repeat(70);
const TICKET_ID = '6acd60b0e0cc20ae1f21ea10';
const SESSION_ID = '6acd609dbadbf99395c76a7f';
const FR_ID = '0123456789abcdef01234567';
const FR_SHARE_URL = `https://feedback.acme.test/en/feature-requests?id=${FR_ID}`;

const ticket = () => ({
  _id: TICKET_ID,
  id: TICKET_ID,
  bugId: 185343,
  type: 'BUG',
  title: 'Refund request',
  status: 'DONE',
  shareToken: SHARE,
  secretShareToken: SECRET,
  session: { _id: SESSION_ID, email: 'qa@acme.test' },
  linkedTickets: [{ _id: '6acd60fe9c85082a4c155514', bugId: 185344, shareToken: LINKED_SHARE }],
});

const leaks = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(SHARE) || text.includes(SECRET) || text.includes(LINKED_SHARE);
};
const assertNoTokens = (result) => {
  assert.equal(leaks(result.content), false, 'text content carries a share token');
  assert.equal(leaks(result.structuredContent ?? {}), false, 'structuredContent carries a share token');
  assert.equal(/sharetoken/i.test(JSON.stringify(result)), false, 'a share-token key survived');
};

const respondTo = (config) => {
  const url = config.url;
  if (url.endsWith('/projects/ticket-types')) {
    return { ticketTypes: [{ type: 'BUG', name: 'Bugs', path: 'bugs', statuses: [{ key: 'DONE', title: 'Done' }], priorities: [] }] };
  }
  if (url.endsWith('/tickets/search')) {
    return [{ _id: TICKET_ID, _score: 3, document: { ...ticket(), plainContent: 'refund please' }, _source: ticket() }];
  }
  if (url.endsWith(`/tickets/${FR_ID}/feature-request`)) {
    return { id: FR_ID, type: 'FEATURE_REQUEST', title: 'Dark mode', public: true, status: 'Planned', shareUrl: FR_SHARE_URL, shareToken: SHARE };
  }
  if (url.endsWith('/tickets/broken')) {
    throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, null, {
      status: 400,
      statusText: '',
      headers: {},
      config,
      data: { message: 'Ticket is locked', ticket: ticket() },
    });
  }
  if (url.endsWith(`/tickets/${TICKET_ID}`)) return ticket();
  throw new Error(`unexpected request ${config.method} ${url}`);
};

beforeEach(() => {
  axios.defaults.adapter = async (config) => ({ data: await respondTo(config), status: 200, statusText: 'OK', headers: {}, config });
});

// Same order as buildServer in src/index.ts.
const connect = async () => {
  const server = new McpServer({ name: 'gleap-mcp-test', version: '0.0.0' });
  applyShareTokenRedaction(server);
  applySessionScopePolicy(server);
  registerTicketTools(server);
  registerFeatureRequestTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const call = async (name, args, creds = {}) => {
  const client = await connect();
  return runWithCreds({ apiKey: 'test-only', projectId: 'p1', ...creds }, () => client.callTool({ name, arguments: args }));
};

describe('share tokens never reach an MCP client', () => {
  test('get_ticket (the API ticket passed through) -> no token, every other field kept', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID });
    assertNoTokens(result);
    assert.equal(result.structuredContent.bugId, 185343);
    assert.equal(result.structuredContent.title, 'Refund request');
    assert.equal(result.structuredContent.linkedTickets[0].bugId, 185344);
    assert.equal(result.structuredContent.statusLabel, 'Done');
    assert.equal(result.structuredContent.dashboardUrl.endsWith(`/projects/p1/bugs/${TICKET_ID}`), true);
    assert.equal(JSON.parse(result.content[0].text).bugId, 185343);
  });

  test('close_ticket (a write answering with the whole ticket) -> no token', async () => {
    const result = await call('close_ticket', { ticketId: TICKET_ID });
    assertNoTokens(result);
    assert.equal(result.structuredContent.status, 'DONE');
  });

  test('search_tickets (the MCP server\'s own projection) -> no token', async () => {
    const result = await call('search_tickets', { searchTerm: 'refund' });
    assertNoTokens(result);
    assert.equal(result.structuredContent.results[0].bugId, 185343);
  });

  test('an API error whose body carries the ticket -> no token', async () => {
    const result = await call('get_ticket', { ticketId: 'broken' });
    assert.equal(result.isError, true);
    assertNoTokens(result);
    assert.equal(result.structuredContent.message, 'Ticket is locked');
  });

  test('a customer-scoped run (session-scope policy) -> no token', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID }, { sessionScope: SESSION_ID });
    assert.notEqual(result.isError, true);
    assertNoTokens(result);
  });

  test('a feature request\'s public roadmap link (not a token link) is kept', async () => {
    const result = await call('get_feature_request', { ticketId: FR_ID });
    assertNoTokens(result);
    assert.equal(result.structuredContent.shareUrl, FR_SHARE_URL);
  });
});

describe('stripShareTokensFromText / stripShareTokensFromResult', () => {
  test('JSON inside prose and JSON escaped in a string -> no token', () => {
    assert.equal(leaks(stripShareTokensFromText(`Ticket closed.\n${JSON.stringify(ticket(), null, 2)}`)), false);
    assert.equal(leaks(stripShareTokensFromText(JSON.stringify({ result: JSON.stringify(ticket()) }))), false);
  });

  test('any key spelling (ticketShareToken, SHARETOKEN) -> stripped', () => {
    const out = stripShareTokensFromResult({
      content: [{ type: 'text', text: JSON.stringify({ ticketShareToken: SHARE, SHARETOKEN: SECRET, id: 'a' }) }],
      structuredContent: { ticketShareToken: SHARE, nested: [{ SHARETOKEN: SECRET, id: 'b' }] },
    });
    assertNoTokens(out);
    assert.deepEqual(out.structuredContent, { nested: [{ id: 'b' }] });
  });

  test('text without a share token -> unchanged; the input result is not mutated', () => {
    const text = JSON.stringify({ _id: 'a', title: 'No secrets here' }, null, 2);
    assert.equal(stripShareTokensFromText(text), text);
    const input = { content: [{ type: 'text', text: JSON.stringify(ticket()) }], structuredContent: ticket() };
    stripShareTokensFromResult(input);
    assert.equal(input.structuredContent.shareToken, SHARE);
    assert.equal(leaks(input.content[0].text), true);
  });
  test('a long run of backslashes before a quote (customer text) is scanned in linear time', () => {
    // A ticket field the customer wrote: thousands of backslashes, then a quote and the word sharetoken.
    const text = `{"note":"${'\\\\'.repeat(40_000)}\\" sharetoken", x {\\"shareToken\\":\\"${SHARE}\\"}`;
    const started = performance.now();
    const out = stripShareTokensFromText(text);
    assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
    assert.equal(out.includes(SHARE), false);
  });
});
