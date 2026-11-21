// report_progress addresses the session from the kickoff, or — when an app
// Gleap did not open has no session id — the ticket. Exactly one of the two
// routes is called, and the ticket route names the session for later calls.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerProgressTools } = await import('../src/tools/progress.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');

const tools = new Map();
registerProgressTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } });

const call = (args) => {
  const { config, handler } = tools.get('report_progress');
  return runWithCreds({ apiKey: 'test-only', projectId: 'p1' }, async () => handler(z.object(config.inputSchema).parse(args)));
};

const SESSION = '64f0c0ffee0000000000abcd';
let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push({ url: config.url, data: JSON.parse(config.data || '{}') });
    return { data: { success: true, sessionId: SESSION, status: 'running' }, status: 200, statusText: 'OK', headers: {}, config };
  };
});

describe('report_progress', () => {
  test('reports on the session when the kickoff named one', async () => {
    await call({ sessionId: SESSION, ticketId: '#1', phase: 'investigating', message: 'Looking' });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, new RegExp(`/gleapcode/sessions/${SESSION}/agent-progress$`));
    assert.equal(requests[0].data.ticketId, undefined);
  });

  test('reports by ticket without a session id and names the session for later calls', async () => {
    const res = await call({ ticketId: ' #185900 ', phase: 'investigating', message: 'Looking', agentName: 'Claude Code' });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/gleapcode\/sessions\/agent-progress$/);
    assert.equal(requests[0].data.ticketId, '#185900');
    assert.ok(res.content.some((c) => c.text.includes(`sessionId "${SESSION}"`)));
  });

  test('refuses a report with neither id, without calling Gleap', async () => {
    const res = await call({ phase: 'investigating', message: 'Looking' });
    assert.equal(res.isError, true);
    assert.equal(requests.length, 0);
  });
});
