import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSequenceTools } = await import('../src/tools/sequence.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { docAsText, outline } = await import('../src/utils/sequenceRules.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerSequenceTools(registry);

const base = 'https://gleap-api.invalid/v3';
const id = '0123456789abcdef01234567';
const template = {
  id, name: 'Untitled sequence', status: 'draft', steps: [],
  enrollment: { triggers: [{ type: 'manual' }], targetAudience: 'all', conditions: [], reenroll: 'never' },
  exit: { onReply: true, events: [], conditions: [] },
  sending: { emailType: 'personal', emailLook: 'plain', senderId: 'aaaaaaaaaaaaaaaaaaaaaaaa', window: { enabled: true, days: [1, 2, 3, 4, 5], startHour: 8, endHour: 18, timezone: 'UTC' } },
};
const liveSequence = {
  ...template, status: 'live',
  steps: [
    { id: 'welcome', type: 'email', subject: 'Welcome', content: 'Hi' },
    { id: 'pause', type: 'wait', mode: 'duration', amount: 2, unit: 'days' },
    { id: 'nudge', type: 'email', content: 'Still there?' },
  ],
};

let requests;
let stored;
let respond;
beforeEach(() => {
  requests = [];
  stored = { ...template };
  respond = undefined;
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body, params: config.params });
    const custom = respond?.(config.method, config.url, body);
    if (custom instanceof Error) throw custom;
    const data = custom ?? (config.method === 'get' ? stored : { ...stored, ...body });
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});
const writes = () => requests.filter(r => r.method !== 'get');
const text = result => result.content.map(c => c.text).join('\n');
const badRequest = message => {
  const err = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST');
  err.response = { status: 400, statusText: 'Bad Request', data: { error: { statusCode: 400, title: 'Bad Request', message } }, headers: {} };
  return err;
};

test('create_sequence creates from the template, then saves the definition merged onto it in the stored shape', async () => {
  const result = await call('create_sequence', {
    template: 'blank', name: 'Onboarding', timezone: 'Europe/Vienna',
    enrollment: { triggers: [{ type: 'contactCreated' }], targetAudience: 'users' },
    goal: { event: 'invited_teammate' },
    sending: { window: { startHour: 9 } },
    steps: [
      { id: 'welcome', type: 'email', subject: 'Welcome to {{project.name}}', content: 'Hi {{session.firstName|there}},\n\nThanks!' },
      { id: 'pause', type: 'wait', amount: 2, unit: 'businessDays' },
      {
        id: 'invited', type: 'waitUntil', event: 'invited_teammate', amount: 3, unit: 'businessDays',
        yes: [{ id: 'tag', type: 'tag', tag: 'activated' }],
        no: [{ id: 'plan', type: 'branch', conditions: [{ event: 'gleap-up-plan', type: 'latestdata', matchOperator: 'is', data: 'pro' }], yes: [], no: [] }],
      },
    ],
  });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['post', `${base}/sequences`], ['put', `${base}/sequences/${id}`]]);
  assert.deepEqual(requests[0].body, { template: 'blank', name: 'Onboarding', timezone: 'Europe/Vienna' });
  const body = requests[1].body;
  assert.deepEqual(body.enrollment, { triggers: [{ type: 'manual' }, { type: 'contactCreated' }], targetAudience: 'users', conditions: [], reenroll: 'never' });
  assert.deepEqual(body.goal, { event: 'invited_teammate', withinDays: 14, exitOnGoal: true });
  assert.deepEqual(body.sending.window, { ...template.sending.window, startHour: 9 });
  assert.equal(body.sending.senderId, template.sending.senderId);
  assert.equal(body.steps[1].mode, 'duration');
  assert.equal(body.steps[2].yes[0].op, 'add');
  assert.deepEqual(body.steps[2].no[0].conditions, { logicalOperator: 'AND', conditions: [{ event: 'gleap-up-plan', type: 'latestdata', matchOperator: 'is', data: 'pro' }] });
  assert.equal('exit' in body, false);
  assert.equal(result.structuredContent.reviewUrl, `https://app.gleap.io/projects/test-project/engagement/sequences/${id}`);
  assert.equal(result.structuredContent.goLiveProblems, undefined);
  assert.match(result.structuredContent.nextStep, /preview_sequence/);
});

for (const [label, args, pattern] of [
  ['duplicate step ids', { steps: [{ id: 'a', type: 'exit' }, { id: 'a', type: 'exit' }] }, /used twice/],
  ['an unknown step type', { steps: [{ id: 'a', type: 'sms' }] }, /type "sms" is unknown/],
  ['a wrong wait unit', { steps: [{ id: 'a', type: 'wait', amount: 1, unit: 'months' }] }, /unit must be one of/],
  ['a wait over a year', { steps: [{ id: 'a', type: 'wait', amount: 60, unit: 'weeks' }] }, /at most 365 days/],
  ['paths on a leaf step', { steps: [{ id: 'a', type: 'email', yes: [] }] }, /only branch and waitUntil/],
  ['event data on a custom event', { steps: [{ id: 'a', type: 'branch', conditions: [{ event: 'signup', type: 'latestdata', dataKey: 'plan', matchOperator: 'is', data: 'pro' }] }] }, /dataKey "page"/],
  ['a tag rule without in/notin', { exit: { conditions: [{ event: 'tags', type: 'latestdata', matchOperator: 'is', data: 'vip' }] } }, /exit\.conditions\[0\]: tags take matchOperator in/],
]) {
  test(`create_sequence refuses ${label} before writing anything`, async () => {
    const result = await call('create_sequence', args);
    assert.equal(result.isError, true);
    assert.match(text(result), pattern);
    assert.equal(requests.length, 0);
  });
}

test('update_sequence on a live sequence edits steps by id on top of the unpublished changes and says they need publishing', async () => {
  stored = { ...liveSequence, draft: { steps: [...liveSequence.steps, { id: 'bye', type: 'exit' }], updatedAt: '2026-10-16T10:00:00Z' } };
  respond = (method, url, body) => method === 'put' ? { ...stored, draft: { ...stored.draft, ...body } } : undefined;
  const result = await call('update_sequence', { sequenceId: id, stepChanges: [{ id: 'nudge', content: 'Any questions?' }], sending: { emailLook: 'company' } });
  assert.equal(result.isError, undefined, text(result));
  const put = writes()[0];
  assert.deepEqual(put.body.steps.map(s => s.id), ['welcome', 'pause', 'nudge', 'bye']);
  assert.equal(put.body.steps[2].content, 'Any questions?');
  assert.deepEqual(put.body.sending, { ...template.sending, emailLook: 'company' });
  assert.match(result.structuredContent.nextStep, /publish_sequence_changes/);
  assert.deepEqual(result.structuredContent.unpublishedChanges.changed, ['sending', 'steps']);
});

test('update_sequence refuses stepChanges for unknown ids and type changes without writing', async () => {
  stored = { ...liveSequence };
  assert.match(text(await call('update_sequence', { sequenceId: id, stepChanges: [{ id: 'missing', subject: 'x' }] })), /No step with id missing/);
  assert.match(text(await call('update_sequence', { sequenceId: id, stepChanges: [{ id: 'welcome', type: 'message' }] })), /cannot change type/);
  assert.equal(writes().length, 0);
});

test('set_sequence_status returns the server validation message verbatim', async () => {
  stored = { ...template, steps: [{ id: 'welcome', type: 'email', content: 'Hi' }] };
  respond = method => method === 'post' ? badRequest('Email needs a subject') : undefined;
  const result = await call('set_sequence_status', { sequenceId: id, status: 'live' });
  assert.equal(result.isError, true);
  assert.match(text(result), /Gleap API error \(400\): Email needs a subject/);
  assert.deepEqual(writes().map(w => [w.url, w.body]), [[`${base}/sequences/${id}/status`, { status: 'live' }]]);
});

test('enroll_in_sequence sends emails, userIds and contact ids and explains skipped contacts', async () => {
  stored = { ...liveSequence };
  respond = method => method === 'post' ? { enrolled: 2, skipped: [{ sessionId: 'nobody@example.com', reason: 'notFound' }] } : undefined;
  const result = await call('enroll_in_sequence', { sequenceId: id, emails: ['ada@example.com', 'nobody@example.com'], userIds: ['u1'], contactIds: [id] });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes()[0].body, { sessionIds: [id], emails: ['ada@example.com', 'nobody@example.com'], userIds: ['u1'] });
  assert.equal(writes()[0].url, `${base}/sequences/${id}/enrollments`);
  assert.equal(result.structuredContent.enrolled, 2);
  assert.match(result.structuredContent.skipped[0].why, /no contact/);
});

test('enroll_in_sequence refuses a sequence that is not live and more than 500 contacts', async () => {
  assert.match(text(await call('enroll_in_sequence', { sequenceId: id, emails: ['ada@example.com'] })), /only a live sequence enrolls/);
  stored = { ...liveSequence };
  const userIds = Array.from({ length: 300 }, (_, i) => `u${i}`);
  const emails = Array.from({ length: 201 }, (_, i) => `c${i}@example.com`);
  assert.match(text(await call('enroll_in_sequence', { sequenceId: id, userIds, emails })), /at most 500 contacts per call \(got 501\)/);
  assert.equal(writes().length, 0);
});

test('send_sequence_test_email only sends email steps, through the step test route', async () => {
  stored = { ...liveSequence };
  assert.match(text(await call('send_sequence_test_email', { sequenceId: id, stepId: 'pause' })), /only email steps/);
  respond = method => method === 'post' ? { sent: ['me@example.com'] } : undefined;
  const result = await call('send_sequence_test_email', { sequenceId: id, stepId: 'welcome' });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(writes().map(w => [w.url, w.body]), [[`${base}/sequences/${id}/steps/welcome/test`, {}]]);
});

test('sequence tools are refused in customer-scoped runs', async () => {
  const result = await call('enroll_in_sequence', { sequenceId: id, emails: ['ada@example.com'] }, { sessionScope: 'abc' });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test('plain docs read as text, formatted docs stay JSON, and the outline shows both paths', () => {
  const plain = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'serverVariable', attrs: { variableName: 'session.firstName', fallbackValue: 'there' } }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Welcome.' }] },
  ] };
  assert.equal(docAsText(plain), 'Hi {{session.firstName|there}}\n\nWelcome.');
  assert.equal(docAsText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] }] }), null);
  assert.deepEqual(outline([{ id: 'w', type: 'waitUntil', event: 'invited', amount: 3, unit: 'businessDays', yes: [{ id: 't', type: 'tag', op: 'add', tag: 'ok' }], no: [] }]), [
    '[w] wait until invited (max 3 businessDays)',
    '  yes (did it):',
    '    [t] add tag ok',
    "  no (didn't in time): continue",
  ]);
});
