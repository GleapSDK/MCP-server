import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerEmailAutomationTools } = await import('../src/tools/email-automation.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { intervalUnit } = await import('../src/utils/emailAutomationRules.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerEmailAutomationTools(registry);

const id = '0123456789abcdef01234567';
const draftNewsletter = { _id: id, type: 'EMAIL', status: 'draft', frequencyType: 'fixed', frequency: 'once', frequencyDays: 0, trigger: null, targetAudience: 'all' };
const stopRules = [
  { event: 'checkout_completed', type: 'count', matchOperator: 'is', data: 0 },
  { event: 'gleap-up-plan', type: 'latestdata', matchOperator: 'is', data: 'team' },
  { event: 'gleap-up-email', type: 'latestdata', matchOperator: 'notcontains', data: 'gleap.io' },
];
const configured = {
  ...draftNewsletter, frequencyType: 'dynamic', targetAudience: 'users',
  trigger: { event: 'trial_started', type: 'firstoccured', dateOperator: 'relative', matchOperator: 'greaterthan', data: 259200, ti: 'day' },
  conditions: { logicalOperator: 'AND', conditions: stopRules },
};

let requests;
let stored;
let saveOverride;
beforeEach(() => {
  requests = [];
  stored = { ...draftNewsletter };
  saveOverride = undefined;
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body });
    const data = config.method === 'get' ? stored : { ...stored, ...body, ...saveOverride };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});
const writes = () => requests.filter(r => r.method !== 'get');

test('configure stores the dashboard trigger, frequency and audience shape and never publishes', async () => {
  const result = await call('configure_email_automation', {
    emailId: id,
    trigger: { event: 'trial_started', delaySeconds: 3 * 86400 },
    frequency: { mode: 'once' },
    audience: { targetAudience: 'users', conditions: stopRules },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['get', `https://gleap-api.invalid/v3/engagement/emails/${id}`], ['put', `https://gleap-api.invalid/v3/engagement/emails/${id}`]]);
  assert.deepEqual(writes()[0].body, {
    frequency: 'once', frequencyDays: 0,
    trigger: configured.trigger, frequencyType: 'dynamic',
    targetAudience: 'users', conditions: { logicalOperator: 'AND', conditions: stopRules },
  });
  assert.equal('status' in writes()[0].body, false);
  assert.deepEqual(result.structuredContent.trigger, configured.trigger);
  assert.equal(result.structuredContent.status, 'draft');
  assert.equal(result.structuredContent.reviewUrl, `https://app.gleap.io/projects/test-project/engagement/emails/${id}/edit`);
});

test('frequency modes map to the stored fields and recurring triggers measure from the last occurrence', async () => {
  for (const [frequency, fields, type] of [
    [{ mode: 'every_time' }, { frequency: 'continuously', frequencyDays: 0 }, 'lastoccured'],
    [{ mode: 'every_n_days', days: 7 }, { frequency: 'continuously', frequencyDays: 7 }, 'lastoccured'],
  ]) {
    requests = [];
    await call('configure_email_automation', { emailId: id, trigger: { event: 'invoice_paid', delaySeconds: 0 }, frequency });
    assert.deepEqual({ frequency: writes()[0].body.frequency, frequencyDays: writes()[0].body.frequencyDays }, fields);
    assert.equal(writes()[0].body.trigger.type, type);
  }
  requests = [];
  await call('configure_email_automation', { emailId: id, trigger: { event: 'invoice_paid', type: 'firstoccured', delaySeconds: 0 }, frequency: { mode: 'every_time' } });
  assert.equal(writes()[0].body.trigger.type, 'firstoccured');
});

test('delay display unit matches the dashboard intervals', () => {
  assert.equal(intervalUnit(0), 'day');
  assert.equal(intervalUnit(2 * 86400), 'day');
  assert.equal(intervalUnit(7200), 'hour');
  assert.equal(intervalUnit(300), 'minute');
  assert.equal(intervalUnit(90), 'second');
});

for (const [label, setup, args] of [
  ['a live email', { ...configured, status: 'live' }, { trigger: { event: 'x', delaySeconds: 0 } }],
  ['a contact-attribute trigger', {}, { trigger: { event: 'gleap-up-createdAt', delaySeconds: 0 } }],
  ['a tags trigger', {}, { trigger: { event: 'tags', delaySeconds: 0 } }],
  ['a pageView trigger', {}, { trigger: { event: 'pageView', delaySeconds: 0 } }],
  ['an uploaded CSV list', { csvContacts: { sessionIds: ['a'], contactCount: 1 } }, { trigger: { event: 'x', delaySeconds: 0 } }],
  ['frequency on a one-off without a trigger', {}, { frequency: { mode: 'every_time' } }],
  ['event data without dataKey', {}, { audience: { conditions: [{ event: 'trial_started', type: 'latestdata', matchOperator: 'is', data: 'team' }] } }],
  ['event data on a key the server never stores', {}, { audience: { conditions: [{ event: 'trial_started', type: 'latestdata', dataKey: 'plan', matchOperator: 'is', data: 'team' }] } }],
  ['a tag rule without in/notin', {}, { audience: { conditions: [{ event: 'tags', type: 'latestdata', matchOperator: 'is', data: 'vip' }] } }],
  ['a text rule without a value', {}, { audience: { conditions: [{ event: 'gleap-up-email', type: 'latestdata', matchOperator: 'notcontains' }] } }],
  ['a relative date with a calendar operator', {}, { audience: { conditions: [{ event: 'x', type: 'lastoccured', dateOperator: 'relative', matchOperator: 'on', data: 5 }] } }],
  ['nothing to change', {}, {}],
  ['a non-email', { type: 'NEWS' }, { trigger: { event: 'x', delaySeconds: 0 } }],
]) {
  test(`configure refuses ${label} without writing`, async () => {
    stored = { ...stored, ...setup };
    const result = await call('configure_email_automation', { emailId: id, ...args });
    assert.equal(result.isError, true);
    assert.equal(writes().length, 0);
  });
}

test('configure leaves an empty CSV mode like the dashboard switch to Dynamic', async () => {
  stored = { ...stored, csvContacts: {} };
  await call('configure_email_automation', { emailId: id, trigger: { event: 'trial_started', delaySeconds: 0 } });
  assert.equal(writes()[0].body.csvContacts, null);
});

test('configure flags a save it cannot verify', async () => {
  saveOverride = { trigger: null };
  const result = await call('configure_email_automation', { emailId: id, trigger: { event: 'trial_started', delaySeconds: 0 } });
  assert.equal(result.isError, true);
  assert.equal(writes().length, 1);
});

test('publish of an event-triggered email sends only status live through the email route', async () => {
  stored = { ...configured };
  const result = await call('publish_email', { emailId: id });
  assert.equal(result.isError, undefined);
  assert.deepEqual(writes().map(r => [r.url, r.body]), [[`https://gleap-api.invalid/v3/engagement/emails/${id}`, { status: 'live' }]]);
  assert.equal(result.structuredContent.status, 'live');
  assert.deepEqual(result.structuredContent.conditions, configured.conditions);
});

for (const [label, setup, args] of [
  ['a one-off to all without oneOffAudience', {}, {}],
  ['a one-off to all even with oneOffAudience', { conditions: { logicalOperator: 'AND', conditions: stopRules } }, { oneOffAudience: 'users' }],
  ['a one-off whose audience differs from oneOffAudience', { targetAudience: 'guests', conditions: { logicalOperator: 'AND', conditions: stopRules } }, { oneOffAudience: 'users' }],
  ['a one-off to users without conditions', { targetAudience: 'users' }, { oneOffAudience: 'users' }],
  ['a one-off already sent', { targetAudience: 'users', sentAt: '2026-10-01', conditions: { logicalOperator: 'AND', conditions: stopRules } }, { oneOffAudience: 'users' }],
  ['a dynamic email without a trigger', { frequencyType: 'dynamic', trigger: null }, {}],
  ['a contact-attribute trigger', { ...configured, trigger: { ...configured.trigger, event: 'gleap-up-createdAt' } }, {}],
  ['a session-start trigger without audience conditions', { ...configured, trigger: { ...configured.trigger, event: 'sessionStarted' }, conditions: { logicalOperator: 'AND', conditions: [] } }, {}],
  ['an unfinished audience rule', { ...configured, conditions: { logicalOperator: 'AND', conditions: [{ event: 'gleap-up-email', type: 'latestdata', matchOperator: 'notcontains' }] } }, {}],
  ['an unfinished nested rule', { ...configured, conditions: { logicalOperator: 'AND', conditions: [{ logicalOperator: 'OR', conditions: [{ event: 'gleap-up-plan' }] }] } }, {}],
  ['a CSV audience', { targetAudience: 'users', csvContacts: { sessionIds: ['a'] } }, { oneOffAudience: 'users' }],
  ['a non-email', { ...configured, type: 'NEWS' }, {}],
]) {
  test(`publish refuses ${label} without writing`, async () => {
    stored = { ...stored, ...setup };
    const result = await call('publish_email', { emailId: id, ...args });
    assert.equal(result.isError, true);
    assert.equal(writes().length, 0);
  });
}

test('publish accepts a narrowed one-off only with the matching oneOffAudience', async () => {
  stored = { ...stored, targetAudience: 'users', conditions: { logicalOperator: 'AND', conditions: stopRules } };
  const result = await call('publish_email', { emailId: id, oneOffAudience: 'users' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(writes()[0].body, { status: 'live' });
});

test('publish passes a server refusal through and never claims live', async () => {
  stored = { ...configured };
  axios.defaults.adapter = async config => {
    requests.push({ method: config.method });
    if (config.method === 'get') return { data: stored, status: 200, headers: {}, config };
    const { AxiosError } = await import('axios');
    throw new AxiosError('Plan', 'ERR_BAD_REQUEST', config, null, { status: 402, data: { message: 'Plan required' }, headers: {}, config });
  };
  const result = await call('publish_email', { emailId: id });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 402);
});

test('publish and pause are no-ops in the target state', async () => {
  stored = { ...configured, status: 'live' };
  assert.equal((await call('publish_email', { emailId: id })).isError, undefined);
  stored = { ...configured };
  assert.equal((await call('pause_email', { emailId: id })).isError, undefined);
  assert.equal(writes().length, 0);
});

test('pause takes a live triggered email off and refuses a sent one-off', async () => {
  stored = { ...configured, status: 'live' };
  const result = await call('pause_email', { emailId: id });
  assert.deepEqual(writes()[0].body, { status: 'draft' });
  assert.equal(result.structuredContent.status, 'draft');
  requests = [];
  stored = { ...draftNewsletter, status: 'live' };
  assert.equal((await call('pause_email', { emailId: id })).isError, true);
  assert.equal(writes().length, 0);
});

test('get_email_automation returns the settings and refuses non-emails', async () => {
  stored = { ...configured };
  const result = await call('get_email_automation', { emailId: id });
  assert.deepEqual(result.structuredContent.trigger, configured.trigger);
  assert.equal(result.structuredContent.targetAudience, 'users');
  stored = { ...configured, type: 'SURVEY' };
  assert.equal((await call('get_email_automation', { emailId: id })).isError, true);
});

test('invalid IDs never reach the API', async () => {
  await assert.rejects(call('publish_email', { emailId: '../other' }));
  assert.equal(requests.length, 0);
});

test('customer-scoped requests cannot use email automation tools', async () => {
  stored = { ...configured };
  for (const name of ['get_email_automation', 'configure_email_automation', 'publish_email', 'pause_email']) {
    const result = await call(name, { emailId: id }, { sessionScope: 'customer' });
    assert.equal(result.structuredContent.sessionScope, true);
  }
  assert.equal(requests.length, 0);
});

test('publish refuses a Kai-written email without review or instructions, and shows its kind', async () => {
  const kai = { enabled: true, prompt: 'Check in on day 3.', sources: ['contact'], review: { mode: 'none', n: 20 }, onNothingToSay: 'skip' };
  stored = { ...configured, kai };
  const refused = await call('publish_email', { emailId: id });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Review is turned off/);
  stored = { ...configured, kai: { ...kai, prompt: ' ', review: { mode: 'firstN', n: 20 } } };
  assert.equal((await call('publish_email', { emailId: id })).isError, true);
  assert.equal(writes().length, 0);
  stored = { ...configured, kai: { ...kai, review: { mode: 'firstN', n: 20 } } };
  const published = await call('publish_email', { emailId: id });
  assert.equal(published.isError, undefined);
  assert.equal(published.structuredContent.kind, 'kai');
  assert.equal(published.structuredContent.emailStyle, 'personal');
});
