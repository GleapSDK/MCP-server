import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSurveyTools } = await import('../src/tools/survey.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { definitionIssues, normalizeDefinition } = await import('../src/utils/surveyDefinition.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerSurveyTools(registry);

const id = '0123456789abcdef01234567';
const base = `https://gleap-api.invalid/v3/engagement/surveys`;

// The NPS example the tool descriptions teach.
const npsDefinition = () => ({
  blocks: [
    { id: 'q_nps', key: 'nps_score', type: 'nps', title: 'How likely are you to recommend us?', required: true, jumps: [
      { if: { src: 'answer', op: 'between', value: [0, 6] }, go: 'q_detractor' },
      { if: { src: 'answer', op: 'between', value: [7, 8] }, go: 'q_passive' },
      { if: { src: 'answer', op: 'between', value: [9, 10] }, go: 'q_promoter' },
    ] },
    { id: 'q_detractor', key: 'detractor_reason', type: 'long', title: 'What disappointed you?', next: 'end_thanks' },
    { id: 'q_passive', key: 'passive_improve', type: 'long', title: 'What would make it a 10?', next: 'end_thanks' },
    { id: 'q_promoter', key: 'promoter_love', type: 'long', title: 'What do you love most?', next: 'end_thanks' },
  ],
  endings: [{ id: 'end_thanks', title: 'Thanks for your feedback!' }],
});
const choiceDefinition = () => ({
  blocks: [
    { id: 'q_reason', key: 'cancel_reason', type: 'single', title: 'Main reason?', required: true,
      choices: [{ id: 'too_expensive', label: 'Too expensive' }, { id: 'missing_features', label: 'Missing features' }],
      jumps: [{ if: { src: 'answer', op: 'eq', value: 'too_expensive' }, go: 'q_price' }], next: 'q_better' },
    { id: 'q_price', key: 'fair_price', type: 'number', title: 'What monthly price would have worked?', next: 'end' },
    { id: 'q_better', key: 'do_better', type: 'long', title: 'What could we have done better?' },
  ],
  endings: [{ id: 'end', title: 'Thank you' }],
});

let requests;
let stored;
let publishReply;
let rejectGet;
const ok = (data, config) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
const httpError = (status, data, config) => new AxiosError('Failed', 'ERR_BAD_REQUEST', config, null, { status, data, headers: {}, config });

beforeEach(() => {
  requests = [];
  rejectGet = false;
  stored = { _id: id, type: 'SURVEY', status: 'draft', name: 'NPS', actionType: 'sv_abc', survey: { draft: normalizeDefinition(npsDefinition(), 'card'), version: 0 } };
  publishReply = config => { throw httpError(403, { message: 'Publishing needs approval', requiresApproval: true }, config); };
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body, params: config.params });
    const path = config.url.slice(base.length);
    if (config.method === 'get' && rejectGet) throw httpError(403, { message: 'Denied' }, config);
    if (config.method === 'post' && path === '') return ok({ ...body, _id: id, type: 'SURVEY', actionType: 'sv_new' }, config);
    if (config.method === 'post' && path.endsWith('/validate')) return ok({ ok: true, errors: [] }, config);
    if (config.method === 'post' && path.endsWith('/publish')) return publishReply(config);
    if (config.method === 'post' && path.endsWith('/insights/ask')) return ok({ answer: 'Sync.', citations: [{ responseId: 'rsp_1', quote: 'x'.repeat(1000) }], basedOn: 3 }, config);
    if (config.method === 'post' && path.endsWith('/reach-out')) return ok({ ticketId: 'ticket1', ticketShareToken: 'tok' }, config);
    if (config.method === 'put' && path.endsWith('/draft')) return ok({ definition: body.definition, warnings: [] }, config);
    if (config.method === 'put') return ok({ ...stored, ...body }, config);
    if (path.includes('/responses/')) {
      return ok({ response: { _id: 'rsp_1', status: 'completed', answers: { nps_score: 3, detractor_reason: 'Slow sync' }, path: ['q_nps', 'q_detractor', 'end_thanks'], endingId: 'end_thanks', contactUserId: 'u1' },
        contact: { _id: 'c1', userId: 'u1', name: 'Ada', email: 'ada@example.com' }, definition: stored.survey.draft }, config);
    }
    if (path.endsWith('/responses')) {
      return ok({ responses: [{ _id: 'rsp_1', status: 'completed', answers: { nps_score: 3, detractor_reason: 'y'.repeat(2000) } }], nextCursor: 'c2' }, config);
    }
    if (path.endsWith('/stats')) return ok({ totals: { shown: 10, started: 8, completed: 4 }, perBlock: { nps_score: { reached: 8, answered: 8, values: { 3: 2, 9: 6 } } } }, config);
    if (path.endsWith('/insights')) return ok({ themes: [], updatedAt: null }, config);
    return ok(stored, config);
  };
});

const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});
const writes = () => requests.filter(r => r.method !== 'get');

test('registers the 13 Surveys 2.0 tools plus the legacy names', () => {
  for (const name of ['list_surveys', 'get_survey', 'create_survey', 'update_survey', 'validate_survey', 'publish_survey', 'pause_survey',
    'get_survey_results', 'get_survey_insights', 'ask_survey_results', 'get_survey_responses', 'get_survey_response', 'reach_out_to_respondent',
    'get_surveys', 'get_survey_summary']) {
    assert.ok(tools.has(name), name);
  }
});

test('the taught examples are valid definitions', () => {
  assert.deepEqual(definitionIssues(npsDefinition()), []);
  assert.deepEqual(definitionIssues(choiceDefinition()), []);
});

test('create_survey saves a draft, never a live or published survey', async () => {
  const result = await call('create_survey', { name: 'Churn', format: 'full', definition: choiceDefinition(), status: 'live', published: true,
    trigger: { event: 'subscription_cancelled' } });
  assert.equal(result.isError, undefined);
  const posts = writes();
  assert.deepEqual(posts.map(r => r.url), [base, `${base}/${id}/validate`]);
  const body = posts[0].body;
  assert.equal(body.status, 'draft');
  assert.equal('published' in body, false);
  assert.equal(body.format, 'full');
  assert.equal(body.definition.schemaVersion, 2);
  assert.equal(body.definition.format, 'full');
  assert.deepEqual(body.definition.blocks[0].title, { en: 'Main reason?' });
  assert.equal(body.definition.blocks[2].next, null);
  assert.deepEqual(body.definition.blocks[2].jumps, []);
  assert.deepEqual(body.trigger, { event: 'subscription_cancelled', type: 'firstoccured', dateOperator: 'relative', matchOperator: 'greaterthan', data: 0, ti: 'day' });
  assert.equal(body.frequencyType, 'dynamic');
  assert.equal(body.frequency, 'once');
  assert.equal(result.structuredContent.status, 'draft');
  assert.equal(result.structuredContent.validation.ok, true);
  assert.equal(result.structuredContent.reviewUrl, `https://app.gleap.io/projects/test-project/engagement/surveys/${id}/edit`);
});

const broken = [
  ['dangling jump target', d => { d.blocks[0].jumps[0].go = 'nowhere'; }],
  ['backward jump (loop)', d => { d.blocks[1].next = 'q_reason'; }],
  ['duplicate key', d => { d.blocks[1].key = 'cancel_reason'; }],
  ['block and ending share an id', d => { d.endings[0].id = 'q_better'; }],
  ['invalid key', d => { d.blocks[0].key = 'Cancel Reason'; }],
  ['label instead of choice id', d => { d.blocks[0].jumps[0].if.value = 'Too expensive'; }],
  ['includes on a single block', d => { d.blocks[0].jumps[0].if = { src: 'answer', op: 'includes', value: 'too_expensive' }; }],
  ['single without choices', d => { delete d.blocks[0].choices; d.blocks[0].jumps = []; }],
  ['unknown hidden field', d => { d.blocks[2].jumps = [{ if: { src: 'field', key: 'plan', op: 'eq', value: 'pro' }, go: 'end' }]; }],
  ['no endings', d => { d.endings = []; }],
  ['unknown property', d => { d.blocks[0].options = ['a']; }],
  ['unknown block type', d => { d.blocks[2].type = 'paragraph'; }],
];
for (const [label, mutate] of broken) {
  test(`create_survey rejects a definition with ${label} and writes nothing`, async () => {
    const definition = choiceDefinition();
    mutate(definition);
    await assert.rejects(call('create_survey', { name: 'x', format: 'card', definition }));
    assert.equal(requests.length, 0);
  });
}

test('create_survey rejects NPS ranges outside 0-10', async () => {
  const definition = npsDefinition();
  definition.blocks[0].jumps[2].if.value = [9, 11];
  await assert.rejects(call('create_survey', { name: 'x', format: 'card', definition }));
  assert.equal(requests.length, 0);
});

test('create_survey refuses contact-attribute triggers before writing', async () => {
  const result = await call('create_survey', { name: 'x', format: 'card', definition: npsDefinition(), trigger: { event: 'gleap-up-plan' } });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test('unexpected create response is not reported as a verified draft and is not retried', async () => {
  axios.defaults.adapter = async config => { requests.push(config); return ok({ _id: id, type: 'SURVEY', status: 'live' }, config); };
  const result = await call('create_survey', { name: 'x', format: 'card', definition: npsDefinition() });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reviewUrl, undefined);
  assert.equal(requests.length, 1);
});

test('update_survey writes only the draft definition', async () => {
  const result = await call('update_survey', { surveyId: id, definition: npsDefinition(), status: 'live' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [`get ${base}/${id}`, `put ${base}/${id}/draft`]);
  assert.deepEqual(Object.keys(requests[1].body), ['definition']);
  assert.equal(requests[1].body.definition.format, 'card');
});

test('update_survey on a live survey saves the next draft and leaves the live version alone', async () => {
  stored = { ...stored, status: 'live', survey: { ...stored.survey, published: stored.survey.draft, version: 3 } };
  const result = await call('update_survey', { surveyId: id, definition: choiceDefinition() });
  assert.equal(result.isError, undefined);
  assert.deepEqual(writes().map(r => r.url), [`${base}/${id}/draft`]);
  assert.match(result.structuredContent.nextStep, /version 3/);
});

test('update_survey refuses to rename a live survey and non-survey ids', async () => {
  stored = { ...stored, status: 'live' };
  assert.equal((await call('update_survey', { surveyId: id, definition: npsDefinition(), name: 'New' })).isError, true);
  stored = { ...stored, type: 'EMAIL', status: 'draft' };
  assert.equal((await call('update_survey', { surveyId: id, definition: npsDefinition() })).isError, true);
  assert.equal(writes().length, 0);
});

test('get_survey returns a definition update_survey accepts unchanged', async () => {
  stored.survey.draft = { ...stored.survey.draft, _id: 'mongo', blocks: stored.survey.draft.blocks.map(b => ({ ...b, _id: 'x', media: null })) };
  const read = await call('get_survey', { surveyId: id });
  const definition = read.structuredContent.definition;
  assert.equal(JSON.stringify(definition).includes('_id'), false);
  const result = await call('update_survey', { surveyId: id, definition });
  assert.equal(result.isError, undefined);
});

test('publish_survey surfaces needs-approval (403) without retrying or writing anything else', async () => {
  const result = await call('publish_survey', { surveyId: id });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.published, false);
  assert.equal(result.structuredContent.requiresApproval, true);
  assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [`post ${base}/${id}/publish`]);
});

test('publish_survey surfaces a requiresApproval success body', async () => {
  publishReply = config => ok({ requiresApproval: true }, config);
  const result = await call('publish_survey', { surveyId: id });
  assert.equal(result.structuredContent.published, false);
  assert.equal(result.structuredContent.requiresApproval, true);
});

test('publish_survey reports validation errors (422)', async () => {
  publishReply = config => { throw httpError(422, { errors: [{ path: 'blocks.1', code: 'unreachable', message: 'unreachable' }] }, config); };
  const result = await call('publish_survey', { surveyId: id });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.published, false);
  assert.equal(result.structuredContent.errors[0].code, 'unreachable');
});

test('publish_survey reports a verified publish', async () => {
  publishReply = config => ok({ version: 2, publishedAt: '2026-10-06T00:00:00Z', status: 'live' }, config);
  const result = await call('publish_survey', { surveyId: id });
  assert.equal(result.structuredContent.published, true);
  assert.equal(result.structuredContent.version, 2);
});

test('pause_survey unpublishes only a live survey', async () => {
  await call('pause_survey', { surveyId: id });
  assert.equal(writes().length, 0);
  stored = { ...stored, status: 'live' };
  axios.defaults.adapter = (orig => async config => {
    const res = await orig(config);
    if (config.method === 'put') res.data = { ...stored, status: 'draft' };
    return res;
  })(axios.defaults.adapter);
  const result = await call('pause_survey', { surveyId: id });
  assert.equal(result.isError, undefined);
  assert.deepEqual(writes().map(r => r.body), [{ status: 'draft' }]);
});

test('reach_out_to_respondent drafts by default and sends only with send: true', async () => {
  const draft = await call('reach_out_to_respondent', { surveyId: id, responseId: 'rsp_1', message: 'Sorry about sync — can we help?' });
  assert.equal(draft.structuredContent.sent, false);
  assert.equal(draft.structuredContent.recipient.email, 'ada@example.com');
  assert.equal(writes().length, 0);
  const sent = await call('reach_out_to_respondent', { surveyId: id, responseId: 'rsp_1', message: 'Hi', send: true });
  assert.equal(sent.structuredContent.sent, true);
  assert.deepEqual(writes().map(r => [r.url, r.body]), [[`${base}/${id}/responses/rsp_1/reach-out`, { channel: 'messenger', message: 'Hi', assignToMe: false }]]);
});

test('get_survey_responses passes filters and cursor and returns compact rows', async () => {
  const result = await call('get_survey_responses', { surveyId: id, status: 'completed', answers: { nps_score: '0..6' }, cursor: 'c1' });
  assert.deepEqual(requests[0].params, { v: 2, status: 'completed', cursor: 'c1', limit: 20, filter: { nps_score: '0..6' } });
  const row = result.structuredContent.responses[0];
  assert.equal(row.answers.detractor_reason.length, 300);
  assert.equal(result.structuredContent.nextCursor, 'c2');
  await assert.rejects(call('get_survey_responses', { surveyId: id, limit: 51 }));
});

test('get_survey_response labels answers with the questions of its version', async () => {
  const result = await call('get_survey_response', { surveyId: id, responseId: 'rsp_1' });
  const answers = result.structuredContent.answers;
  assert.equal(answers[0].question, 'How likely are you to recommend us?');
  assert.equal(answers[1].display, 'Slow sync');
  assert.equal(result.structuredContent.ending.title, 'Thanks for your feedback!');
});

test('results and ask results stay compact', async () => {
  const stats = await call('get_survey_results', { surveyId: id });
  assert.equal(stats.structuredContent.totals.completionRate, 50);
  assert.equal(stats.structuredContent.perQuestion[0].question, 'How likely are you to recommend us?');
  assert.equal('daily' in stats.structuredContent, false);
  const ask = await call('ask_survey_results', { surveyId: id, question: 'Why are people unhappy?' });
  assert.equal(ask.structuredContent.citations[0].quote.length, 300);
});

test('customer-scoped requests cannot use survey tools', async () => {
  for (const [name] of tools) {
    const result = await call(name, { surveyId: id, responseId: 'rsp_1', message: 'x', question: 'why?', query: 'pricing', name: 'x', format: 'card', definition: npsDefinition() }, { sessionScope: 'customer' });
    assert.equal(result.structuredContent.sessionScope, true, name);
  }
  assert.equal(requests.length, 0);
});
