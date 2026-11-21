// Hard tickets (SPEC §2, §8; API.md §4): a coding session's writes carry
// X-Gleap-Session-Id, and what Gleap says about the session (stop, a send
// written before the customer's newest message, new customer messages) reaches
// the agent whatever the tool. Without a session id nothing changes: no
// header, and a body field never reads as a stop.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { applyAgentSessionSignals } = await import('../src/utils/agentSession.js');
const { registerMessageTools } = await import('../src/tools/message.tool.js');
const { registerProgressTools } = await import('../src/tools/progress.tool.js');
const { registerToolboxTools } = await import('../src/tools/toolbox.tool.js');
const { registerSetupTools } = await import('../src/tools/setup.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applyAgentSessionSignals(registry);
registerMessageTools(registry);
registerProgressTools(registry);
registerToolboxTools(registry);
registerSetupTools(registry);

const SESSION = '64f0c0ffee0000000000abcd';
const CONNECTION_SESSION = '64f0c0ffee0000000000beef';
const header = (headers, name) => headers?.[name] ?? headers?.get?.(name);

let requests;
let answer;
beforeEach(() => {
  requests = [];
  answer = () => ({ status: 200, data: { _id: 'c1' } });
  axios.defaults.adapter = async (config) => {
    requests.push({ url: config.url, headers: config.headers });
    const { status, data, headers = {} } = answer(config);
    const response = { data, status, statusText: String(status), headers, config };
    if (status >= 400) throw new axios.AxiosError('refused', 'ERR_BAD_REQUEST', config, null, response);
    return response;
  };
});

const call = (name, args, creds = {}) =>
  runWithCreds({ apiKey: 'test-only', projectId: 'p1', ...creds }, async () => {
    const { config, handler } = tools.get(name);
    return handler(z.object(config.inputSchema).parse(args));
  });
const texts = (res) => res.content.map((c) => c.text).join('\n');

describe('X-Gleap-Session-Id', () => {
  test('a write sends the session its tool names; the connection header stands in when it names none', async () => {
    await call('send_message', { ticketId: 't1', text: 'Hi', sessionId: SESSION });
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), SESSION);
    await call('send_message', { ticketId: 't1', text: 'Hi' }, { agentSessionId: CONNECTION_SESSION });
    assert.equal(header(requests[1].headers, 'X-Gleap-Session-Id'), CONNECTION_SESSION);
  });

  test('X-Gleap-Session-Explicit: 1 only when the tool itself named the session', async () => {
    await call('send_message', { ticketId: 't1', text: 'Hi', sessionId: SESSION }, { agentSessionId: CONNECTION_SESSION });
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), SESSION);
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Explicit'), '1');
    await call('send_message', { ticketId: 't1', text: 'Hi' }, { agentSessionId: CONNECTION_SESSION });
    assert.equal(header(requests[1].headers, 'X-Gleap-Session-Id'), CONNECTION_SESSION);
    assert.equal(header(requests[1].headers, 'X-Gleap-Session-Explicit'), undefined);
  });

  test('reads go without it', async () => {
    answer = () => ({ status: 200, data: { agents: [] } });
    await call('get_agents', {}, { agentSessionId: CONNECTION_SESSION });
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), undefined);
  });

  test('without a session nothing changes: no header, and a stop field in the data is just data', async () => {
    answer = () => ({ status: 200, data: { stop: true, newCustomerMessages: [{ text: 'not a session signal' }] } });
    const res = await call('send_message', { ticketId: 't1', text: 'Hi' });
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), undefined);
    assert.equal(res.structuredContent.stop, true); // the API's own body, untouched
    assert.doesNotMatch(texts(res), /^STOP:/);
    assert.doesNotMatch(texts(res), /New customer messages/);
  });
});

describe('what Gleap says about the session', () => {
  test('a write refused as stopped returns only the STOP instruction', async () => {
    for (const data of [{ message: 'The session was stopped', stop: true }, { message: 'Stopped', refusal: 'stopped' }]) {
      answer = () => ({ status: 409, data });
      const res = await call('send_message', { ticketId: 't1', text: 'Hi', sessionId: SESSION });
      assert.equal(res.content.length, 1);
      assert.match(res.content[0].text, /^STOP:/);
      assert.equal(res.structuredContent.stop, true);
      assert.equal(res.structuredContent.gleapStop, true);
    }
  });

  test('only a STOP carries gleapStop: a field of that name in API data is dropped', async () => {
    answer = () => ({ status: 200, data: { _id: 'c1', gleapStop: true, stop: false } });
    const res = await call('send_message', { ticketId: 't1', text: 'Hi', sessionId: SESSION });
    assert.equal(res.structuredContent?.gleapStop, undefined);
    assert.doesNotMatch(texts(res), /^STOP:/);
  });

  test('a send written before the customer\'s newest message lists it and asks for one retry', async () => {
    answer = () => ({ status: 409, data: { message: 'The customer wrote since', newCustomerMessages: [{ at: '2026-11-03T10:00:00Z', text: 'It works now, thanks' }] } });
    const res = await call('send_message', { ticketId: 't1', text: 'Try again?', sessionId: SESSION });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.staleThread, true);
    assert.match(texts(res), /Not sent/);
    assert.match(texts(res), /It works now, thanks/);
    assert.match(texts(res), /send it again once/);
  });

  test('report_progress on a stopped session returns only the STOP instruction', async () => {
    answer = () => ({ status: 200, data: { success: true, stop: true, sessionId: SESSION, fixMessages: { onTheWay: 'sent' } } });
    const res = await call('report_progress', { ticketId: '#7', status: 'working', step: 'fixing', message: 'Fixing' });
    assert.equal(res.content.length, 1);
    assert.match(res.content[0].text, /^STOP:/);
  });

  test('new customer messages are listed after the result of report_progress', async () => {
    answer = () => ({ status: 200, data: { success: true, stop: false, sessionId: SESSION, newCustomerMessages: [{ at: '2026-11-03T10:00:00Z', text: 'Still broken on Android' }] } });
    const res = await call('report_progress', { sessionId: SESSION, status: 'working', step: 'fixing', message: 'Fixing', howSolved: '  ' });
    assert.match(texts(res), /New customer messages[\s\S]*Still broken on Android/);
    assert.deepEqual(res.structuredContent.newCustomerMessages, [{ at: '2026-11-03T10:00:00Z', text: 'Still broken on Android' }]);
  });
});

describe('removed tools', () => {
  test('start_kai_resolve and set_ai_mode do nothing and say what to use', async () => {
    const ticketId = '650000000000000000000001';
    for (const [name, args, instead] of [
      ['start_kai_resolve', { ticketId }, /Work on it/],
      ['set_ai_mode', { mode: 'first' }, /Hard tickets/],
    ]) {
      const res = await call(name, args);
      assert.equal(res.structuredContent.removed, true, name);
      assert.match(texts(res), instead, name);
    }
    assert.equal(requests.length, 0);
  });
});

describe('draft_reply_to_composer', () => {
  const ticketId = '650000000000000000000001';

  test("a person's client stages the draft on the ticket", async () => {
    const res = await call('draft_reply_to_composer', { ticketId, text: 'Draft' });
    assert.ok(!res.isError);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, new RegExp(`/tickets/${ticketId}/draft-message$`));
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), undefined);
  });

  test('a coding session names itself, so the API can refuse it, and the refusal reaches the agent', async () => {
    answer = () => ({ status: 410, data: { message: 'Agents no longer stage composer drafts', type: 'agent_drafts_removed' } });
    const res = await call('draft_reply_to_composer', { ticketId, text: 'Draft' }, { agentSessionId: CONNECTION_SESSION });
    assert.equal(header(requests[0].headers, 'X-Gleap-Session-Id'), CONNECTION_SESSION);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.status, 410);
  });
});
