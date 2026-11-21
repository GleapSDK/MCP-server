// merge_tickets must speak the API's merge contract (PUT /tickets/merge with
// ticketsToMergeIds): it used to POST sourceTicketIds and got a 404. The API
// does not exclude the target from the sources, so the tool refuses that.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');

const tools = new Map();
registerTicketTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } });
const { config, handler } = tools.get('merge_tickets');
const parse = (args) => z.object(config.inputSchema).parse(args);
const merge = (args) => runWithCreds({ apiKey: 'test-only', projectId: 'p1' }, async () => handler(parse(args)));

let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (cfg) => {
    requests.push({ method: cfg.method, url: cfg.url, body: JSON.parse(cfg.data) });
    return { data: { _id: 'target' }, status: 200, statusText: 'OK', headers: {}, config: cfg };
  };
});

test('merge_tickets sends PUT /tickets/merge with ticketsToMergeIds', async () => {
  const res = await merge({ targetTicketId: 'target', sourceTicketIds: ['a', 'b'] });

  assert.equal(res.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'put');
  assert.match(requests[0].url, /\/tickets\/merge$/);
  assert.deepEqual(requests[0].body, {
    targetTicketId: 'target',
    ticketsToMergeIds: ['a', 'b'],
    shouldCreateNewTicket: false,
    shouldMergeTasks: true,
    shouldMergeContacts: false,
  });
});

test('merge_tickets refuses the target as a source without calling Gleap', async () => {
  const res = await merge({ targetTicketId: 'target', sourceTicketIds: ['a', 'target'] });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /target ticket can't also be a source/);
  assert.equal(requests.length, 0);
});

test('merge_tickets needs at least one source', () => {
  assert.throws(() => parse({ targetTicketId: 'target', sourceTicketIds: [] }));
});
