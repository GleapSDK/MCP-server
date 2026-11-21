// Custom ticket priorities are per board: LOW / MEDIUM / HIGH plus generated
// `p_…` keys. The ticket tools must accept any key or title (the server
// validates against the board), get_ticket_types must list each board's
// priorities, and tickets must carry a readable `priorityLabel`.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { decorateTicket, parsePriorities } = await import('../src/utils/boardMeta.js');

const tools = new Map();
registerTicketTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } });

const call = (name, args) => {
  const { config, handler } = tools.get(name);
  return runWithCreds({ apiKey: 'test-only', projectId: 'prio-project' }, async () =>
    handler(z.object(config.inputSchema).parse(args)),
  );
};

const priorities = [
  { key: 'p_urgent', title: 'Urgent', color: '#ff0000', rank: 0.5 },
  { key: 'HIGH', title: 'High', color: '#e50d00', rank: 1, archived: true },
  { key: 'MEDIUM', title: 'Medium', color: '#ffb606', rank: 2, isDefault: true },
];

let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url, data: config.data, params: config.params });
    const data = config.url.endsWith('/projects/ticket-types')
      ? { projectId: 'prio-project', ticketTypes: [{ type: 'BUG', name: 'Bugs', path: 'bugs', statuses: [], priorities }] }
      : config.url.endsWith('/tickets')
        ? []
        : { id: 't1' };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

describe('ticket priorities', () => {
  test('write tools accept custom keys and titles', async () => {
    await call('update_ticket', { ticketId: 't1', priority: 'p_urgent' });
    await call('update_ticket', { ticketId: 't1', priority: 'Urgent' });
    const puts = requests.filter((r) => r.method === 'put');
    assert.deepEqual(puts.map((r) => JSON.parse(r.data).priority), ['p_urgent', 'Urgent']);
  });

  test('find_tickets resolves lowercase built-ins and titles to stored keys', async () => {
    await call('find_tickets', { priority: 'high, urgent,p_custom' });
    const find = requests.find((r) => r.url.endsWith('/tickets'));
    assert.equal(find.params.priority, 'HIGH,p_urgent,p_custom');
  });

  test('get_ticket_types lists each board\'s priorities without colors', async () => {
    const response = await call('get_ticket_types', {});
    assert.deepEqual(response.structuredContent.ticketTypes[0].priorities, [
      { key: 'p_urgent', title: 'Urgent', archived: false, isDefault: false },
      { key: 'HIGH', title: 'High', archived: true, isDefault: false },
      { key: 'MEDIUM', title: 'Medium', archived: false, isDefault: true },
    ]);
  });

  test('tickets carry the board\'s priority title (BOT conversations use INQUIRY)', () => {
    const boards = new Map([
      ['BUG', { name: 'Bugs', path: 'bugs', statuses: [], priorities: parsePriorities({ priorities }) }],
      ['INQUIRY', { name: 'Inbox', path: 'inbox', statuses: [], priorities: parsePriorities({ priorities: [{ key: 'LOW', title: 'Later' }] }) }],
    ]);
    const ctx = { projectId: 'prio-project', boards };
    assert.equal(decorateTicket(ctx, { id: 'a', type: 'BUG', priority: 'p_urgent' }).priorityLabel, 'Urgent');
    assert.equal(decorateTicket(ctx, { id: 'b', type: 'BOT', priority: 'LOW' }).priorityLabel, 'Later');
    assert.equal(decorateTicket(ctx, { id: 'c', type: 'BUG', priority: 'p_gone' }).priorityLabel, null);
  });
});
