// A teammate's dashboard user record never reaches an MCP client. The Gleap API populates tickets and messages with the
// assignee's or sender's whole user document (`processingUser`, a message's `user`): notification settings, analytics
// ids, onboarding state and `token`, a leftover signup token. Every result carries a teammate as a public user only:
// id, name, email and picture. Drives the real endpoint, the way a client sees the results.
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { gleapApi, startApp, type ApiReply, type ApiRequest } from './support/app.js';
import { sampleArgs, type JsonSchema } from './support/sampleArgs.js';

const TICKET_ID = '6acd60b0e0cc20ae1f21ea10';
const USER_ID = '6acd609dbadbf99395c76a01';
const TOKEN = `03AFcWeA${'x'.repeat(64)}`;
const GA_CLIENT_ID = 'GA1.1.123456789.1700000000';

const fullUser = () => ({
  _id: USER_ID,
  id: USER_ID,
  email: 'agent@gleap.test',
  firstName: 'Ada',
  lastName: 'Agent',
  profileImageUrl: 'https://cdn.gleap.test/ada.png',
  token: TOKEN,
  gaClientId: GA_CLIENT_ID,
  notificationSettings: { assigned: { email: true, push: true } },
  notificationPreferences: { digest: 'daily' },
  onboardingFlow: 'support',
  lastAutoAssign: '2026-11-20T08:00:00.000Z',
  userType: 'DEFAULT',
  unavailableProjects: [],
  availableFor: 'CHATS',
});

const PUBLIC_USER = {
  _id: USER_ID,
  id: USER_ID,
  email: 'agent@gleap.test',
  firstName: 'Ada',
  lastName: 'Agent',
  profileImageUrl: 'https://cdn.gleap.test/ada.png',
};

const ticket = () => ({
  _id: TICKET_ID,
  id: TICKET_ID,
  bugId: 229600,
  type: 'INQUIRY',
  title: 'Where is my invoice?',
  status: 'OPEN',
  processingUser: fullUser(),
  session: { _id: '6acd609dbadbf99395c76a7f', name: 'Casey Customer', email: 'casey@acme.test' },
});

const comment = () => ({
  _id: '6acd60b0e0cc20ae1f21eb01',
  ticket: TICKET_ID,
  type: 'TEXT',
  user: fullUser(),
  data: { content: 'On it.' },
  createdAt: '2026-11-20T08:01:00.000Z',
});

const TICKET_TYPES = {
  ticketTypes: [{ type: 'INQUIRY', name: 'Inquiries', path: 'inquiries', statuses: [{ key: 'OPEN', title: 'Open' }], priorities: [] }],
};

const app = await startApp();
const client = new Client({ name: 'user-record-redaction-test', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(app.mcpUrl), {
    requestInit: { headers: { 'x-gleap-api-key': 'user-record-test-key', 'x-gleap-project-id': 'p1' } },
  }),
);
const { tools } = await client.listTools();

after(async () => {
  await client.close();
  await app.close();
});
beforeEach(() => gleapApi.reset());

const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));

const ok = (data: unknown): ApiReply => ({ status: 200, data });

/** The secrets and private fields of a user record anywhere in a result: text blocks or structured content. */
const leaksOf = (result: CallToolResult): string[] => {
  const text = JSON.stringify(result);
  return [
    text.includes(TOKEN) && 'token',
    text.includes(GA_CLIENT_ID) && 'gaClientId',
    /notificationSettings|notificationPreferences|onboardingFlow|lastAutoAssign|unavailableProjects/.test(text) &&
      'notification / onboarding / assignment fields',
  ].filter((leak): leak is string => typeof leak === 'string');
};

const answerTicketCalls = (request: ApiRequest): ApiReply => {
  if (request.url.endsWith('/projects/ticket-types')) return ok(TICKET_TYPES);
  if (request.url.includes('/messages')) return ok(request.method === 'GET' ? [comment()] : comment());
  return ok(ticket());
};

describe('ticket and message tools return a teammate as a public user', () => {
  for (const [name, args] of [
    ['assign_ticket', { ticketId: TICKET_ID, processingUser: USER_ID }],
    ['close_ticket', { ticketId: TICKET_ID }],
    ['get_ticket', { ticketId: TICKET_ID }],
  ] as const) {
    test(`${name} -> the assignee is id, name, email and picture`, async () => {
      gleapApi.answerWith(answerTicketCalls);
      const result = await call(name, args);
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.deepEqual(leaksOf(result), []);
      const structured = result.structuredContent as { processingUser?: unknown };
      assert.deepEqual(structured.processingUser, PUBLIC_USER);
      assert.equal(JSON.parse((result.content[0] as { text: string }).text).processingUser.firstName, 'Ada');
    });
  }

  test('send_message -> the sender is id, name, email and picture', async () => {
    gleapApi.answerWith(answerTicketCalls);
    const result = await call('send_message', { ticketId: TICKET_ID, text: 'On it.' });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.deepEqual(leaksOf(result), []);
    assert.deepEqual((result.structuredContent as { user?: unknown }).user, PUBLIC_USER);
  });

  test('a contact on the ticket is not taken for a teammate', async () => {
    gleapApi.answerWith(answerTicketCalls);
    const result = await call('get_ticket', { ticketId: TICKET_ID });
    const session = (result.structuredContent as { session?: Record<string, unknown> }).session;
    assert.equal(session?.name, 'Casey Customer');
    assert.equal(session?.email, 'casey@acme.test');
  });

  test('get_users still returns role and availability', async () => {
    gleapApi.answerWith(() => ok([{ ...fullUser(), role: 'admin', type: 'project', available: true, lastSeen: '2026-11-20T08:00:00.000Z' }]));
    const result = await call('get_users', {});
    assert.deepEqual(leaksOf(result), []);
    const text = JSON.stringify(result.structuredContent);
    assert.match(text, /"role":"admin"/);
    assert.match(text, /"available":true/);
  });
});

describe('no tool passes on a user record', () => {
  // Every shape a tool may pass on: the record itself, a document holding it, and lists of those.
  const everywhere = () => ({
    ...ticket(),
    user: fullUser(),
    createdBy: fullUser(),
    results: [{ ...ticket(), latestComment: comment() }],
    tickets: [ticket()],
    data: [comment()],
    items: [{ owner: fullUser() }],
    users: [fullUser()],
    ticketTypes: TICKET_TYPES.ticketTypes,
  });

  for (const tool of tools) {
    test(`${tool.name} -> no token, analytics id or notification settings`, async () => {
      gleapApi.answerWith(() => ok(everywhere()));
      const result = await call(tool.name, sampleArgs(tool.inputSchema as JsonSchema, tool.name));
      assert.deepEqual(leaksOf(result), []);
    });
  }
});
