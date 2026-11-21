// A contact's widget credentials never leave the MCP server. `gleapId` + `gleapHash`
// are the widget session's identity pair: whoever holds them reads and answers that
// customer's conversations. `fileAccessToken` opens their files. Live E2E 2026-10-13
// (B3): `get_ticket` answered with `session: { gleapId, gleapHash }`; the share-token
// redaction of 10-12 did not cover them. Drives the real SDK server over an in-memory
// transport, the way a client sees the results.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { applyShareTokenRedaction, stripShareTokens, stripShareTokensFromText } = await import('../src/utils/shareTokenRedaction.js');

const HASH = 'e8a6'.repeat(16);
const GLEAP_ID = '5b7b'.repeat(8);
const FILE_TOKEN = 'F'.repeat(48);
const TICKET_ID = '6acd60b0e0cc20ae1f21ea10';
const SESSION_ID = '6acd609dbadbf99395c76a7f';

const ticket = () => ({
  _id: TICKET_ID,
  id: TICKET_ID,
  bugId: 185533,
  type: 'BUG',
  title: 'Agents sidebar closes',
  status: 'DONE',
  session: { _id: SESSION_ID, email: 'qa@acme.test', gleapId: GLEAP_ID, gleapHash: HASH, fileAccessToken: FILE_TOKEN },
});

const leaks = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(HASH) || text.includes(GLEAP_ID) || text.includes(FILE_TOKEN);
};

beforeEach(() => {
  axios.defaults.adapter = async (config) => {
    const url = config.url;
    let data;
    if (url.endsWith('/projects/ticket-types')) data = { ticketTypes: [{ type: 'BUG', name: 'Bugs', path: 'bugs', statuses: [{ key: 'DONE', title: 'Done' }], priorities: [] }] };
    else if (url.endsWith(`/tickets/${TICKET_ID}`)) data = ticket();
    else throw new Error(`unexpected request ${config.method} ${url}`);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

const call = async (name, args) => {
  const server = new McpServer({ name: 'gleap-mcp-test', version: '0.0.0' });
  applyShareTokenRedaction(server);
  applySessionScopePolicy(server);
  registerTicketTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return runWithCreds({ apiKey: 'test-only', projectId: 'p1' }, () => client.callTool({ name, arguments: args }));
};

describe('widget credentials never reach an MCP client', () => {
  test('get_ticket -> no gleapHash, gleapId or fileAccessToken; the contact stays', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID });
    assert.equal(leaks(result.content), false, 'text content carries a widget credential');
    assert.equal(leaks(result.structuredContent ?? {}), false, 'structuredContent carries a widget credential');
    assert.equal(/gleaphash|fileaccesstoken/i.test(JSON.stringify(result)), false);
    assert.equal(result.structuredContent.session.email, 'qa@acme.test');
    assert.equal(result.structuredContent.bugId, 185533);
  });

  test('credentials in prose and escaped JSON -> removed', () => {
    assert.equal(leaks(stripShareTokensFromText(`Ticket:\n${JSON.stringify(ticket())}`)), false);
    assert.equal(leaks(stripShareTokensFromText(JSON.stringify({ result: JSON.stringify(ticket()) }))), false);
  });
});

describe('a contact\'s signed record leaves as its head only', () => {
  const contact = () => ({
    _id: SESSION_ID,
    userId: 'u1',
    signed: { userId: 'u1', kind: 'jwt', kid: 'k1', at: '2026-11-05T09:30:00.000Z', exp: '2026-11-05T10:30:00.000Z', claims: { plan: 'pro', stripeCustomerId: 'cus_SECRET' } },
    authTokens: [{ token: 'tok_SECRET' }],
  });

  test('claims, exp and authTokens -> removed, head and contact stay', () => {
    const out = stripShareTokens(contact());
    assert.deepEqual(out.signed, { userId: 'u1', kind: 'jwt', kid: 'k1', at: '2026-11-05T09:30:00.000Z' });
    assert.equal(out.userId, 'u1');
    assert.equal('authTokens' in out, false);
    const text = stripShareTokensFromText(JSON.stringify(contact(), null, 2));
    assert.equal(/cus_SECRET|tok_SECRET/.test(text), false);
    assert.equal(JSON.parse(text).signed.kid, 'k1');
  });
});
