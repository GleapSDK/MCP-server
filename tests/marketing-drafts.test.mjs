import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerMarketingDraftTools } = await import('../src/tools/marketing-drafts.tool.js');
const { registerNewsTools } = await import('../src/tools/news.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerMarketingDraftTools(registry);
registerNewsTools(registry);
const id = '0123456789abcdef01234567';
const content = {
  name: 'Weekly update', subject: { en: 'This week', de: 'Diese Woche' },
  message: { en: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shipped.' }] }] } },
};
const templateIds = ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'];
let requests;
let stored;
let templates;
let rejectGet;
beforeEach(() => {
  requests = [];
  stored = { _id: id, type: 'NEWS', status: 'draft' };
  templates = templateIds.map((templateId, i) => ({ _id: templateId, id: templateId, title: ['Personal', 'Plain'][i], htmlContent: { localized: { en: '<html/>' } } }));
  rejectGet = false;
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body, params: config.params });
    if (config.method === 'get' && rejectGet) {
      throw new AxiosError('Denied', 'ERR_BAD_REQUEST', config, null, { status: 403, data: { message: 'Denied' }, headers: {}, config });
    }
    if (config.url.endsWith('/email-templates')) return { data: templates, status: 200, statusText: 'OK', headers: {}, config };
    const data = config.method === 'get' ? stored : { ...stored, ...body };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});

for (const kind of ['news', 'newsletter']) {
  test(`${kind} creates a draft with localized content and review link`, async () => {
    const result = await call(`create_${kind}_draft`, { ...content, status: 'live' });
    assert.equal(result.isError, undefined);
    const writes = requests.filter(r => r.method !== 'get');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'post');
    const body = writes[0].body;
    assert.equal(body.status, 'draft');
    assert.deepEqual(body.subject, { localized: content.subject });
    assert.deepEqual(body.message, { localized: content.message });
    assert.equal(body.type, kind === 'news' ? 'NEWS' : 'EMAIL');
    assert.equal(result.structuredContent.reviewUrl, `https://app.gleap.io/projects/test-project/engagement/${kind === 'news' ? 'news' : 'emails'}/${id}/edit`);
    if (kind === 'news') assert.deepEqual(body.config, { push: false, sendEmailToSubscribers: false });
    else {
      assert.equal(body.frequencyType, 'fixed');
      assert.equal(body.frequency, 'once');
      assert.equal(body.trigger, null);
      assert.equal(body.emailStyle, 'company');
      assert.deepEqual(body.tracking, { opens: true, links: true });
      assert.equal('emailTemplate' in body, false);
      assert.equal(result.structuredContent.look.kind, 'newsletter');
    }
  });

  test(`${kind} updates draft content without clearing existing settings`, async () => {
    stored = { ...stored, type: kind === 'news' ? 'NEWS' : 'EMAIL', frequencyType: 'fixed', frequency: 'once', emailTemplate: templateIds[1] };
    const result = await call(`update_${kind}_draft`, { draftId: id, subject: { en: 'Revised' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(requests.map(r => r.method), ['get', 'put']);
    assert.deepEqual(requests[1].body, { status: 'draft', subject: { localized: { en: 'Revised' } } });
  });

  for (const changes of [{ status: 'live' }, { status: 'paused' }, { sentAt: '2026-09-01' }, { sent: true }, { type: 'SURVEY' }]) {
    test(`${kind} refuses revision of ${JSON.stringify(changes)}`, async () => {
      stored = { ...stored, type: kind === 'news' ? 'NEWS' : 'EMAIL', frequencyType: 'fixed', frequency: 'once', ...changes };
      const result = await call(`update_${kind}_draft`, { draftId: id, name: 'Revised' });
      assert.equal(result.isError, true);
      assert.deepEqual(requests.map(r => r.method), ['get']);
    });
  }
}

test('newsletter create with emailTemplate selects custom and refuses a foreign template', async () => {
  await call('create_newsletter_draft', { ...content, emailTemplate: templateIds[1] });
  assert.equal(requests.at(-1).body.emailTemplate, templateIds[1]);
  assert.equal(requests.at(-1).body.emailStyle, 'custom');
  requests = [];
  const result = await call('create_newsletter_draft', { ...content, emailTemplate: 'cccccccccccccccccccccccc' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Personal/);
  assert.deepEqual(requests.map(r => r.method), ['get']);
});

test('newsletter create takes look, preheader and tracking without reading templates', async () => {
  const result = await call('create_newsletter_draft', { ...content, emailStyle: 'plain', preheader: { en: 'Short preview' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => r.method), ['post']);
  const body = requests[0].body;
  assert.equal(body.emailStyle, 'plain');
  assert.deepEqual(body.tracking, { opens: false, links: false });
  assert.deepEqual(body.preheader, { localized: { en: 'Short preview' } });
});

test('custom look without a template, or a template with another look, never writes', async () => {
  assert.equal((await call('create_newsletter_draft', { ...content, emailStyle: 'custom' })).isError, true);
  assert.equal((await call('create_newsletter_draft', { ...content, emailStyle: 'plain', emailTemplate: templateIds[0] })).isError, true);
  assert.equal(requests.filter(r => r.method !== 'get').length, 0);
});

test('newsletter update switches look and moves default tracking along', async () => {
  stored = { ...stored, type: 'EMAIL', frequencyType: 'fixed', frequency: 'once', emailStyle: 'company', tracking: { opens: true, links: true } };
  await call('update_newsletter_draft', { draftId: id, emailStyle: 'plain' });
  assert.deepEqual(requests.at(-1).body, { status: 'draft', emailStyle: 'plain', tracking: { opens: false, links: false } });
  stored = { ...stored, tracking: { opens: false, links: true } };
  await call('update_newsletter_draft', { draftId: id, emailStyle: 'plain' });
  assert.deepEqual(requests.at(-1).body, { status: 'draft', emailStyle: 'plain' });
  requests = [];
  assert.equal((await call('update_newsletter_draft', { draftId: id })).isError, true);
  assert.equal(requests.length, 0);
});

test('create_email kai starts as a plain draft with review of the first 20 and no tracking', async () => {
  const result = await call('create_email', { kind: 'kai', name: 'Trial day 3', kai: { prompt: 'Write a short check-in.' } });
  assert.equal(result.isError, undefined);
  const body = requests.at(-1).body;
  assert.equal(body.status, 'draft');
  assert.equal(body.frequencyType, 'dynamic');
  assert.equal(body.trigger, null);
  assert.equal(body.emailStyle, 'plain');
  assert.deepEqual(body.tracking, { opens: false, links: false });
  assert.deepEqual(body.kai.review, { mode: 'firstN', n: 20 });
  assert.deepEqual(body.kai.caps, { perDay: 500, costPerDayUsd: 25 });
  assert.equal(body.kai.enabled, true);
  assert.equal(result.structuredContent.look.kind, 'kai');
  assert.match(result.structuredContent.nextStep, /Review tab/);
});

test('create_email refuses Kai without review, without a prompt, or with a fallback but no content', async () => {
  await assert.rejects(call('create_email', { kind: 'kai', name: 'x', kai: { prompt: 'p', review: { mode: 'none' } } }));
  assert.equal((await call('create_email', { kind: 'kai', name: 'x' })).isError, true);
  assert.equal((await call('create_email', { kind: 'kai', name: 'x', kai: { prompt: 'p', onNothingToSay: 'fallback' } })).isError, true);
  assert.equal((await call('create_email', { kind: 'automated', name: 'x', kai: { prompt: 'p' } })).isError, true);
  assert.equal(requests.length, 0);
});

test('create_email automated is a triggerless dynamic personal draft', async () => {
  await call('create_email', { kind: 'automated', ...content });
  const body = requests.at(-1).body;
  assert.equal(body.frequencyType, 'dynamic');
  assert.equal(body.emailStyle, 'personal');
  assert.equal(body.status, 'draft');
});

test('update_email merges Kai config and refuses kai changes on live emails', async () => {
  stored = { ...stored, type: 'EMAIL', frequencyType: 'dynamic', emailStyle: 'plain', kai: { enabled: true, prompt: 'Old', review: { mode: 'firstN', n: 5 } } };
  await call('update_email', { emailId: id, kai: { review: { mode: 'all' } } });
  const kai = requests.at(-1).body.kai;
  assert.equal(kai.prompt, 'Old');
  assert.deepEqual(kai.review, { mode: 'all', n: 5 });
  stored = { ...stored, status: 'live' };
  requests = [];
  const result = await call('update_email', { emailId: id, kai: { prompt: 'New' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /dashboard/);
  assert.deepEqual(requests.map(r => r.method), ['get']);
});

const liveAutomated = {
  type: 'EMAIL', status: 'live', frequencyType: 'dynamic', frequency: 'once', sentAt: '2026-10-01T00:00:00.000Z',
  emailStyle: 'personal', tracking: { opens: true, links: true },
  trigger: 'event', eventTrigger: 'trial_started', eventTriggerDelay: 86400, conditions: [{ event: 'x' }], targetAudience: 'users',
};

test('update_email edits the content of a live automated email in place, sending only the changed fields', async () => {
  stored = { ...stored, ...liveAutomated };
  const result = await call('update_email', { emailId: id, subject: { en: 'Fixed typo' }, sender: 'cccccccccccccccccccccccc', emailStyle: 'company' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => r.method), ['get', 'put']);
  assert.deepEqual(requests[1].body, {
    subject: { localized: { en: 'Fixed typo' } }, sender: 'cccccccccccccccccccccccc', emailStyle: 'company',
  });
  assert.equal(result.structuredContent.status, 'live');
  assert.match(result.structuredContent.nextStep, /stays live/);
  assert.equal(result.structuredContent.reviewUrl, `https://app.gleap.io/projects/test-project/engagement/emails/${id}/edit`);
});

const customLook = { emailStyle: 'custom', emailTemplate: templateIds[0] };
const pxImage = { en: { type: 'doc', content: [
  { type: 'imageBlock', attrs: { src: 'https://staticfiles.gleap.io/p/a.png', width: '540px', align: 'center' } },
  { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
] } };

for (const [label, state] of [
  ['live', { status: 'live' }],
  ['draft', { status: 'draft', sentAt: undefined }],
]) {
  test(`update_email without a look keeps the stored custom look of a ${label} automated email`, async () => {
    stored = { ...stored, ...liveAutomated, ...customLook, ...state };
    const result = await call('update_email', { emailId: id, name: 'Day 3', message: pxImage });
    assert.equal(result.isError, undefined);
    assert.deepEqual(requests.map(r => r.method), ['get', 'put']);
    const body = requests[1].body;
    for (const field of ['emailStyle', 'emailTemplate', 'tracking']) assert.equal(field in body, false, field);
    assert.deepEqual(result.structuredContent.look.emailStyle, 'custom');
    assert.equal(result.structuredContent.look.emailTemplate, templateIds[0]);
  });
}

test('update_newsletter_draft without a look keeps a populated custom template', async () => {
  stored = { ...stored, type: 'EMAIL', frequencyType: 'fixed', frequency: 'once', emailStyle: 'custom', emailTemplate: { _id: templateIds[1], title: 'Plain' } };
  const result = await call('update_newsletter_draft', { draftId: id, subject: { en: 'Revised' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests[1].body, { status: 'draft', subject: { localized: { en: 'Revised' } } });
});

test('update_email reports a look the server reset although none was passed', async () => {
  stored = { ...stored, ...liveAutomated, ...customLook };
  axios.defaults.adapter = async config => {
    requests.push({ method: config.method });
    const body = config.data ? JSON.parse(config.data) : {};
    const data = config.method === 'get' ? stored : { ...stored, ...body, emailStyle: 'personal', emailTemplate: null };
    return { data, status: 200, headers: {}, config };
  };
  const result = await call('update_email', { emailId: id, message: pxImage });
  assert.equal(result.isError, true);
  assert.match(result.content.at(-1).text, new RegExp(`emailStyle "custom" and emailTemplate "${templateIds[0]}"`));
});

test('update_email edits a paused automated email without republishing it', async () => {
  stored = { ...stored, ...liveAutomated, status: 'draft' };
  const result = await call('update_email', { emailId: id, preheader: null, name: 'Day 1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests[1].body, { name: 'Day 1', preheader: null });
  assert.match(result.structuredContent.nextStep, /still paused/);
});

test('update_email reports a live edit whose saved email is no longer live', async () => {
  stored = { ...stored, ...liveAutomated };
  axios.defaults.adapter = async config => {
    requests.push({ method: config.method });
    return { data: config.method === 'get' ? stored : { ...stored, status: 'draft' }, status: 200, headers: {}, config };
  };
  const result = await call('update_email', { emailId: id, subject: { en: 'x' } });
  assert.equal(result.isError, true);
});

for (const [label, changes] of [
  ['a sent one-off newsletter', { frequencyType: 'fixed', sent: true }],
  ['a paused one-off with sentAt', { frequencyType: 'fixed', status: 'draft' }],
  ['an archived email', { status: 'archived' }],
]) {
  test(`update_email refuses ${label}`, async () => {
    stored = { ...stored, ...liveAutomated, ...changes };
    const result = await call('update_email', { emailId: id, subject: { en: 'x' } });
    assert.equal(result.isError, true);
    assert.deepEqual(requests.map(r => r.method), ['get']);
  });
}

test('invalid content, empty updates and invalid IDs never write', async () => {
  for (const bad of [{ name: '' }, { subject: {} }, { message: {} }, { message: { en: { type: 'paragraph' } } }]) {
    await assert.rejects(call('create_newsletter_draft', { ...content, ...bad }));
  }
  await assert.rejects(call('update_news_draft', { draftId: '../other', name: 'x' }));
  assert.equal((await call('update_news_draft', { draftId: id })).isError, true);
  assert.equal(requests.length, 0);
});

test('read failure blocks update and preserves API error', async () => {
  rejectGet = true;
  const result = await call('update_news_draft', { draftId: id, name: 'x' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 403);
  assert.equal(requests.length, 1);
});

test('unexpected create response does not claim verified draft or retry', async () => {
  axios.defaults.adapter = async config => {
    requests.push(config);
    return { data: { _id: id, type: 'NEWS', status: 'live' }, status: 200, headers: {}, config };
  };
  const result = await call('create_news_draft', content);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reviewUrl, undefined);
  assert.equal(requests.length, 1);
});

test('newsletter list filters fixed once drafts and projects summaries', async () => {
  stored = [{ _id: id, type: 'EMAIL', status: 'draft', message: content.message }];
  const result = await call('get_newsletter_drafts', {});
  assert.deepEqual(requests[0].params, { status: 'draft', frequencyType: 'fixed', frequency: 'once', skip: 0, limit: 20 });
  assert.equal(JSON.stringify(result.structuredContent).includes('Shipped.'), false);
});

test('newsletter read rejects an automated email and accepts a one-time draft', async () => {
  stored = { ...stored, type: 'EMAIL', frequencyType: 'dynamic' };
  assert.equal((await call('get_newsletter_draft', { draftId: id })).isError, true);
  stored = { ...stored, frequencyType: 'fixed', frequency: 'once', message: content.message };
  assert.deepEqual((await call('get_newsletter_draft', { draftId: id })).structuredContent.message, content.message);
});

test('customer-scoped requests cannot access marketing draft tools', async () => {
  for (const [name] of tools) {
    if (!name.endsWith('_draft') && !['get_newsletter_drafts', 'create_email', 'update_email', 'get_email'].includes(name)) continue;
    const args = name === 'create_email' ? { kind: 'newsletter', ...content } : name.startsWith('create_') ? content
      : name === 'get_newsletter_drafts' ? {} : name.endsWith('_email') ? { emailId: id } : { draftId: id, name: 'x' };
    const result = await call(name, args, { sessionScope: 'customer' });
    assert.equal(result.structuredContent.sessionScope, true);
  }
  assert.equal(requests.length, 0);
});

test('legacy create_news explicitly sends draft status', async () => {
  await call('create_news', content);
  assert.equal(requests[0].body.status, 'draft');
});
