// Multi-project OAuth grants: one connection, a delegate key per project. Every
// tool call runs against one project's key; reads default to the main project,
// changes must name theirs. These tests drive the real SDK server over an
// in-memory transport, the way a client sees the tools.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios, { AxiosError } from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { readCreds, runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { applyShareTokenRedaction } = await import('../src/utils/shareTokenRedaction.js');
const { applyProjectSelection, registerProjectTools, resolveToolProject } = await import(
  '../src/utils/projectSelection.js'
);
const { registerTicketPrompts } = await import('../src/prompts/ticket.prompts.js');

const GLEAP = { projectId: '64a000000000000000000001', name: 'Gleap', apiKey: 'key-gleap' };
const ACME = { projectId: '64a000000000000000000002', name: 'Acme Web', apiKey: 'key-acme' };
const FREE = { projectId: '64a000000000000000000003', name: 'Side project', error: 'plan' };
const PROJECTS = [GLEAP, ACME];
const TICKET_ID = '6acd60b0e0cc20ae1f21ea10';

let requests = [];
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url, project: config.headers?.project, auth: config.headers?.Authorization });
    // Ticket #42 exists in Acme Web only.
    if (config.url.endsWith('/tickets/42') && config.headers?.project !== ACME.projectId) {
      throw new AxiosError('Not found', 'ERR_BAD_REQUEST', config, null, { status: 404, statusText: '', headers: {}, config, data: { message: 'Not found' } });
    }
    if (config.url.includes('agent-workflow')) return { data: { kind: 'fix', text: 'Fix it.' }, status: 200, statusText: 'OK', headers: {}, config };
    const data = config.url.endsWith('/projects/ticket-types')
      ? { ticketTypes: [{ type: 'BUG', name: 'Bugs', path: 'bugs', statuses: [{ key: 'DONE', title: 'Done' }], priorities: [] }] }
      : { _id: TICKET_ID, id: TICKET_ID, bugId: 7, type: 'BUG', title: 'Crash', status: 'DONE' };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

// Same order as buildServer in src/index.ts.
const connect = async (projects) => {
  const server = new McpServer({ name: 'gleap-mcp-test', version: '0.0.0' });
  applyShareTokenRedaction(server);
  if (projects) {
    applyProjectSelection(server, projects);
    registerProjectTools(server, projects);
  }
  applySessionScopePolicy(server);
  registerTicketTools(server);
  registerTicketPrompts(server, projects);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const multi = { apiKey: GLEAP.apiKey, projectId: GLEAP.projectId, projects: PROJECTS };
const call = async (name, args, { projects = PROJECTS, creds = multi } = {}) => {
  const client = await connect(projects);
  return runWithCreds(creds, () => client.callTool({ name, arguments: args }));
};
const ticketRequests = () => requests.filter((request) => request.url.includes(`/tickets/${TICKET_ID}`));
const lastText = (result) => result.content[result.content.length - 1].text;

describe('a connection with several projects', () => {
  test('every tool takes projectId, and list_projects names the projects, main first', async () => {
    const client = await connect(PROJECTS);
    const { tools } = await runWithCreds(multi, () => client.listTools());

    const getTicket = tools.find((tool) => tool.name === 'get_ticket');
    assert.ok(getTicket.inputSchema.properties.projectId);
    assert.equal(getTicket.inputSchema.required?.includes('projectId') ?? false, false);
    assert.equal(tools.every((tool) => tool.name === 'list_projects' || tool.inputSchema.properties.projectId), true);
    // Project names reach the model through list_projects and the instructions only.
    assert.equal(JSON.stringify(tools.filter((tool) => tool.name !== 'list_projects')).includes('Acme Web'), false);

    const listed = await runWithCreds(multi, () => client.callTool({ name: 'list_projects', arguments: {} }));
    assert.deepEqual(listed.structuredContent.projects, [
      { id: GLEAP.projectId, name: 'Gleap', main: true },
      { id: ACME.projectId, name: 'Acme Web', main: false },
    ]);
  });

  test('a read without projectId -> the main project, and the result says so', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID });

    assert.notEqual(result.isError, true);
    assert.deepEqual(ticketRequests().map(({ project, auth }) => [project, auth]), [[GLEAP.projectId, `Bearer ${GLEAP.apiKey}`]]);
    assert.equal(lastText(result), `Project: Gleap (${GLEAP.projectId})`);
    assert.equal(result.structuredContent.bugId, 7);
  });

  test('a read naming a project -> that project\'s key, the argument not sent to the API', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID, projectId: ACME.projectId });

    assert.deepEqual(ticketRequests().map(({ project, auth }) => [project, auth]), [[ACME.projectId, `Bearer ${ACME.apiKey}`]]);
    assert.equal(lastText(result), `Project: Acme Web (${ACME.projectId})`);
  });

  test('a change without projectId -> refused before any API call, naming the projects', async () => {
    const result = await call('close_ticket', { ticketId: TICKET_ID });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /needs projectId/);
    assert.match(result.content[0].text, /Acme Web/);
    assert.match(result.content[0].text, /ask them/);
    assert.equal(ticketRequests().length, 0);
  });

  test('a change naming a project -> runs there only', async () => {
    const result = await call('close_ticket', { ticketId: TICKET_ID, projectId: ACME.projectId });

    assert.notEqual(result.isError, true);
    assert.ok(ticketRequests().length > 0);
    assert.equal(ticketRequests().every(({ project, auth }) => project === ACME.projectId && auth === `Bearer ${ACME.apiKey}`), true);
  });

  test('a project that is not connected -> refused, no API call', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID, projectId: '64a0000000000000000000ff' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not one of the connected projects/);
    assert.equal(ticketRequests().length, 0);
  });
});

describe('a multi-project connection with a project the token has no key for', () => {
  const projects = [GLEAP, FREE];
  const creds = { apiKey: GLEAP.apiKey, projectId: GLEAP.projectId, projects };

  test('naming it -> refused with the reason, no API call', async () => {
    const result = await call('get_ticket', { ticketId: TICKET_ID, projectId: FREE.projectId }, { projects, creds });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no Gleap MCP on its plan/);
    assert.equal(ticketRequests().length, 0);
  });

  test('list_projects says it is unavailable', async () => {
    const result = await call('list_projects', {}, { projects, creds });
    assert.match(result.structuredContent.projects[1].unavailable, /no Gleap MCP/);
  });
});

describe('a multi-project connection down to one project', () => {
  const projects = [ACME];
  const creds = { apiKey: ACME.apiKey, projectId: ACME.projectId, projects };

  test('a change without projectId -> still refused', async () => {
    const result = await call('close_ticket', { ticketId: TICKET_ID }, { projects, creds });
    assert.equal(result.isError, true);
    assert.equal(ticketRequests().length, 0);
  });

  test('a change naming a project the connection lost -> refused, not run on the one left', async () => {
    const result = await call('close_ticket', { ticketId: TICKET_ID, projectId: GLEAP.projectId }, { projects, creds });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not one of the connected projects/);
    assert.equal(ticketRequests().length, 0);
  });
});

describe('ticket prompts on a multi-project connection', () => {
  const prompt = async (args) => {
    const client = await connect(PROJECTS);
    return runWithCreds(multi, () => client.getPrompt({ name: 'fix_ticket', arguments: args }));
  };

  test('a ticket in another project -> found there, and the prompt names that project', async () => {
    const result = await prompt({ ticket: '#42' });
    const text = result.messages[0].content.text;

    assert.match(text, new RegExp(`pass projectId "${ACME.projectId}"`));
    const workflowCall = requests.find((request) => request.url.includes('agent-workflow'));
    assert.equal(workflowCall.project, ACME.projectId);
  });

  test('a project named -> only that project is asked', async () => {
    await assert.rejects(prompt({ ticket: '#42', project: GLEAP.projectId }), /could not be loaded/);
    assert.equal(requests.every((request) => request.project === GLEAP.projectId), true);
  });
});

describe('a connection with one project', () => {
  test('the tools are as before: no projectId, no list_projects, no project line', async () => {
    const client = await connect(undefined);
    const creds = { apiKey: GLEAP.apiKey, projectId: GLEAP.projectId };
    const { tools } = await runWithCreds(creds, () => client.listTools());

    assert.equal(tools.some((tool) => tool.name === 'list_projects'), false);
    assert.equal(tools.some((tool) => tool.inputSchema.properties?.projectId), false);

    const result = await runWithCreds(creds, () => client.callTool({ name: 'close_ticket', arguments: { ticketId: TICKET_ID } }));
    assert.notEqual(result.isError, true);
    assert.equal(result.content.some((item) => item.text.startsWith('Project: ')), false);
  });
});

describe('resolveToolProject', () => {
  test('a project named by its name instead of its id -> refused, ids only', () => {
    assert.ok('error' in resolveToolProject({ projects: PROJECTS, requested: 'Acme Web', readOnly: true, toolName: 't' }));
  });
});

describe('readCreds (OAuth)', () => {
  const request = (extra) => ({ header: () => undefined, auth: { scopes: [], extra } });

  test('several projects -> all of them', () => {
    const creds = readCreds(request({ projectId: GLEAP.projectId, apiKey: GLEAP.apiKey, projects: PROJECTS }));
    assert.deepEqual(creds.projects, PROJECTS);
  });

  test('a multi-project grant down to one project -> still multi-project', () => {
    const creds = readCreds(request({ projectId: ACME.projectId, apiKey: ACME.apiKey, projects: [ACME] }));
    assert.deepEqual(creds.projects, [ACME]);
  });

  test('a token without a project list -> one project, as before', () => {
    const creds = readCreds(request({ projectId: GLEAP.projectId, apiKey: GLEAP.apiKey }));
    assert.equal(creds.projects, undefined);
    assert.equal(creds.apiKey, GLEAP.apiKey);
  });
});
