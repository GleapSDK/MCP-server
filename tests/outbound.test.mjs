import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerOutboundTools } = await import('../src/tools/outbound.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerOutboundTools(registry);

const id = '0123456789abcdef01234567';
const base = 'https://gleap-api.invalid/v3';
const message = { localized: { en: 'Hi {{name}}, need help with checkout?' } };
const draftChat = { _id: id, type: 'MESSAGE', status: 'draft', sender: 'aaaaaaaaaaaaaaaaaaaaaaaa', frequencyType: 'dynamic', frequency: 'once', trigger: null, targetAudience: 'all', message };

let requests;
let stored;
let reach;
beforeEach(() => {
  requests = [];
  stored = { ...draftChat };
  reach = 40;
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body });
    if (config.url.endsWith('/fixed-audience-samples')) {
      return { data: { count: reach, limit: 10000, limitReached: false, sample: [{ _id: 's1', name: 'Ada', email: 'ada@example.com', gleapHash: 'secret' }] }, status: 200, statusText: 'OK', headers: {}, config };
    }
    if (config.method === 'put') {
      // Mongo adds _id to pageRules subdocuments.
      const saved = { ...stored, ...body };
      if (Array.isArray(body.pageRules)) saved.pageRules = body.pageRules.map((rule, i) => ({ ...rule, _id: `r${i}` }));
      stored = saved;
      return { data: saved, status: 200, statusText: 'OK', headers: {}, config };
    }
    return { data: stored, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project' }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});
const writes = () => requests.filter(r => r.method === 'put');
const text = result => result.content.map(c => c.text).join('\n');

test('configure writes the dashboard shape for a page-triggered in-app message and never publishes', async () => {
  const result = await call('configure_outbound_targeting', {
    type: 'chat_message', id,
    trigger: { event: 'pageView', delaySeconds: 0 },
    frequency: { mode: 'every_n_days', days: 14 },
    pages: { rules: [{ match: 'contains', value: '/checkout' }], showAfterSeconds: 10 },
    audience: { targetAudience: 'users', conditions: [{ event: 'checkout_completed', type: 'count', matchOperator: 'is', data: 0 }] },
  });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes()[0].body, {
    frequency: 'continuously', frequencyDays: 14,
    trigger: { event: 'pageView', type: 'lastoccured', dateOperator: 'relative', matchOperator: 'greaterthan', data: 0, ti: 'day' },
    frequencyType: 'dynamic',
    pageRules: [{ pageFilter: '/checkout', pageFilterType: 'contains' }], pageFilter: '/checkout', pageFilterType: 'contains',
    pageFilterDelay: 10,
    targetAudience: 'users',
    conditions: { logicalOperator: 'AND', conditions: [{ event: 'checkout_completed', type: 'count', matchOperator: 'is', data: 0 }] },
  });
  assert.equal(writes().some(w => w.body.status), false);
});

for (const [label, args, expected] of [
  ['page rules without a pageView trigger', { pages: { rules: [{ match: 'contains', value: '/pricing' }] } }, /pageView/],
  ['a contact attribute as an in-app trigger', { trigger: { event: 'gleap-up-plan', delaySeconds: 0 } }, /contact attribute/],
  ['event data the server never stores', { audience: { conditions: [{ event: 'trial_started', type: 'latestdata', dataKey: 'plan', matchOperator: 'is', data: 'team' }] } }, /only stored for dataKey "page"/],
  ['a trigger on a one-off', { delivery: 'one_off', trigger: { event: 'sessionStarted', delaySeconds: 0 } }, /one-off has no trigger/],
]) {
  test(`configure refuses ${label}`, async () => {
    const result = await call('configure_outbound_targeting', { type: 'chat_message', id, ...args });
    assert.equal(result.isError, true);
    assert.match(text(result), expected);
    assert.equal(writes().length, 0);
  });
}

test('configure refuses one-off delivery for types that cannot be one-offs and live items', async () => {
  stored = { ...stored, type: 'CHECKLIST', config: { steps: [{}] } };
  assert.match(text(await call('configure_outbound_targeting', { type: 'checklist', id, delivery: 'one_off' })), /cannot be a one-off/);
  stored = { ...draftChat, status: 'live' };
  assert.match(text(await call('configure_outbound_targeting', { type: 'chat_message', id, audience: { targetAudience: 'users' } })), /pause_outbound/);
  assert.equal(writes().length, 0);
});

test('an ID of another type is not found', async () => {
  stored = { ...draftChat, type: 'BANNER' };
  const result = await call('configure_outbound_targeting', { type: 'chat_message', id, audience: { targetAudience: 'users' } });
  assert.match(text(result), /No chat message with this ID/);
  assert.equal(writes().length, 0);
});

test('publish refuses a triggered in-app item without trigger (it would never show)', async () => {
  const result = await call('publish_outbound', { type: 'chat_message', id });
  assert.equal(result.isError, true);
  assert.match(text(result), /no trigger/);
  assert.equal(writes().length, 0);
});

test('publish refuses an item with no content', async () => {
  stored = { ...draftChat, message: {}, trigger: { event: 'sessionStarted' } };
  assert.match(text(await call('publish_outbound', { type: 'chat_message', id })), /no message/);
  stored = { ...draftChat, type: 'CHECKLIST', config: { steps: [] }, trigger: { event: 'sessionStarted' } };
  assert.match(text(await call('publish_outbound', { type: 'checklist', id })), /no steps/);
  assert.equal(writes().length, 0);
});

test('a one-off needs the approved recipient count and is refused when the audience grew', async () => {
  stored = { ...draftChat, frequencyType: 'fixed', targetAudience: 'users', conditions: { logicalOperator: 'AND', conditions: [{ event: 'gleap-up-plan', type: 'latestdata', matchOperator: 'is', data: 'pro' }] } };
  assert.match(text(await call('publish_outbound', { type: 'chat_message', id })), /confirmedReach/);
  reach = 500;
  const grown = await call('publish_outbound', { type: 'chat_message', id, confirmedReach: 40 });
  assert.match(text(grown), /now 500 people/);
  assert.equal(writes().length, 0);
  reach = 42;
  const ok = await call('publish_outbound', { type: 'chat_message', id, confirmedReach: 40 });
  assert.equal(ok.isError, undefined, text(ok));
  assert.deepEqual(writes().map(w => w.body), [{ status: 'live' }]);
  assert.equal(ok.structuredContent.recipients, 42);
});

test('a one-off push to everyone is never published', async () => {
  stored = { ...draftChat, type: 'PUSH', frequencyType: 'fixed', targetAudience: 'all', conditions: null };
  const result = await call('publish_outbound', { type: 'push', id, confirmedReach: 40 });
  assert.match(text(result), /never sends a one-off push notification to the whole contact list/);
  assert.equal(writes().length, 0);
});

test('a triggered email on sessionStarted without rules is refused (it reaches every contact)', async () => {
  stored = { ...draftChat, type: 'EMAIL', trigger: { event: 'sessionStarted' }, conditions: null };
  assert.match(text(await call('publish_outbound', { type: 'email', id })), /reach every contact/);
  assert.equal(writes().length, 0);
});

test('a triggered in-app message with a trigger publishes without a reach confirmation', async () => {
  stored = { ...draftChat, trigger: { event: 'sessionStarted', type: 'firstoccured', dateOperator: 'relative', matchOperator: 'greaterthan', data: 0 } };
  const result = await call('publish_outbound', { type: 'chat_message', id });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes().map(w => w.body), [{ status: 'live' }]);
});

test('preview counts the passed audience without saving and never returns session secrets', async () => {
  const result = await call('preview_outbound_audience', { type: 'chat_message', id, audience: { targetAudience: 'users', conditions: [{ event: 'tags', type: 'latestdata', matchOperator: 'in', data: 'beta' }] } });
  assert.equal(result.isError, undefined, text(result));
  const post = requests.find(r => r.method === 'post');
  assert.equal(post.url, `${base}/engagements/${id}/fixed-audience-samples`);
  assert.deepEqual(post.body, { targetAudience: 'users', conditions: { logicalOperator: 'AND', conditions: [{ event: 'tags', type: 'latestdata', matchOperator: 'in', data: 'beta' }] } });
  assert.equal(result.structuredContent.count, 40);
  assert.deepEqual(result.structuredContent.sample, [{ id: 's1', name: 'Ada', email: 'ada@example.com', userId: null }]);
  assert.equal(writes().length, 0);
});

test('pause refuses a sent one-off and takes a live triggered item off', async () => {
  stored = { ...draftChat, status: 'live', frequencyType: 'fixed' };
  assert.match(text(await call('pause_outbound', { type: 'chat_message', id })), /already sent/);
  stored = { ...draftChat, status: 'live' };
  const result = await call('pause_outbound', { type: 'chat_message', id });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes().map(w => w.body), [{ status: 'draft' }]);
});

test('outbound tools are refused in customer-scoped runs', async () => {
  const result = await runWithCreds({ apiKey: 'test-only', projectId: 'test-project', sessionScope: 'abc' }, async () => {
    const { config, handler } = tools.get('publish_outbound');
    return handler(z.object(config.inputSchema).parse({ type: 'chat_message', id }));
  });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test('publish refuses a banner without sender (the Server builds no payload for it)', async () => {
  stored = { ...draftChat, type: 'BANNER', sender: null, trigger: { event: 'sessionStarted' } };
  assert.match(text(await call('publish_outbound', { type: 'banner', id })), /no sender/);
  assert.equal(writes().length, 0);
});

test('tooltips take page rules without a trigger (the SDK applies them) but no page delay', async () => {
  stored = { ...draftChat, type: 'TOOLTIP', sender: null, config: { steps: [{}] } };
  const result = await call('configure_outbound_targeting', { type: 'tooltip', id, pages: { rules: [{ match: 'contains', value: '/settings' }] } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes()[0].body, { pageRules: [{ pageFilter: '/settings', pageFilterType: 'contains' }], pageFilter: '/settings', pageFilterType: 'contains' });
  assert.match(text(await call('configure_outbound_targeting', { type: 'tooltip', id, pages: { showAfterSeconds: 5 } })), /showAfterSeconds does not apply/);
  assert.equal(writes().length, 1);
});
