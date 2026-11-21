import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSurveyTools } = await import('../src/tools/survey.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { analyticsView } = await import('../src/utils/surveyAnalytics.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerSurveyTools(registry);

const id = '0123456789abcdef01234567';
const base = `https://gleap-api.invalid/v3/engagement/surveys`;
const metric = (value, previous) => ({ value, previous, byDevice: { desktop: null, tablet: null, phone: null } });

// A payload shaped like analytics-contract §3, with more rows than the view keeps.
const analytics = () => ({
  available: true,
  range: { from: '2026-09-01', to: '2026-09-30', previousFrom: '2026-08-02', previousTo: '2026-08-31', interval: 'day', tz: 'UTC' },
  header: {
    views: metric(200, 100), uniqueViews: metric(150, 0), starts: metric(80, 40), submissions: metric(40, 30),
    completionRate: metric(0.5, 0.75), startRate: metric(0.4, 0.4), avgTimeToCompleteMs: metric(61000, 30500),
  },
  funnel: Array.from({ length: 35 }, (_, index) => ({
    blockId: `b${index}`, key: `q_${index}`, type: 'single', index, title: index === 1 ? 'x'.repeat(500) : `Question ${index}`,
    viewed: 100 - index, answered: 90 - index, skipped: index === 0 ? 3 : 0, closedHere: index === 1 ? 20 : 1,
    dropOff: index === 1 ? 0.2041 : 0.01, medianMs: 4200, p75Ms: 8000, backFrom: 0,
  })),
  worstStepBlockId: 'b1',
  dismissed: { count: 60, rate: 0.3, medianMsToDismiss: 2500 },
  timing: { firstAnswerMedianMs: 3000, firstAnswerP75Ms: 5000, completeMedianMs: 60000, completeP75Ms: 90000 },
  backNavigation: 4,
  closePoints: Array.from({ length: 8 }, (_, index) => ({ blockId: `b${index}`, key: `q_${index}`, title: `Question ${index}`, count: 10 - index })),
  series: Array.from({ length: 30 }, (_, index) => ({ bucket: `2026-09-${String(index + 1).padStart(2, '0')}`, views: 5, starts: 2, submissions: 1 })),
  breakdowns: {
    channel: [{ value: 'web', views: 150, starts: 60, submissions: 30, completionRate: 0.5, score: 42 }, { value: 'ios', views: 50, starts: 20, submissions: 10, completionRate: 0.5, score: 30 }],
    device: Array.from({ length: 9 }, (_, index) => ({ value: `d${index}`, views: index, starts: 0, submissions: 0, completionRate: null, score: null })),
    os: [], language: [],
  },
  heatmap: { tz: 'UTC', cells: [
    { dow: 0, hour: 9, count: 3 }, { dow: 2, hour: 14, count: 12 }, { dow: 6, hour: 20, count: 7 }, { dow: 4, hour: 11, count: 5 }, { dow: 1, hour: 1, count: 0 },
  ] },
  versions: [{ version: 1, views: 50, starts: 20, submissions: 10, completionRate: 0.5, score: 20, n: 10 }, { version: 2, views: 150, starts: 60, submissions: 30, completionRate: 0.5, score: 45, n: 30 }],
  score: { kind: 'nps', key: 'nps_score', blockId: 'b0', current: 42, previous: 30, n: 40, series: [{ bucket: '2026-09-01', score: 40, n: 2 }] },
  reminders: { sent: 12, resumed: 5, completed: 3 },
  email: { campaigns: [{ id: 'c1', name: 'Q3', sent: 300, opened: 120, answered: 40, completed: 30 }], totals: { sent: 300, opened: 120, answered: 40, completed: 30 } },
  sources: {
    pagePaths: Array.from({ length: 6 }, (_, index) => ({ value: `/p${index}`, views: index, submissions: 0 })),
    referrers: [{ value: 'google.com', views: 20, submissions: 4 }],
    utm: [{ source: 'newsletter', medium: 'email', campaign: 'q3', views: 9, submissions: 2 }],
  },
  quality: { speeders: 2, speederThresholdMs: 18000, straightLiners: 1 },
});

let requests;
let analyticsReply;
const ok = (data, config) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
const httpError = (status, data, config) => new AxiosError('Failed', 'ERR_BAD_REQUEST', config, null, { status, data, headers: {}, config });

beforeEach(() => {
  requests = [];
  analyticsReply = config => ok(analytics(), config);
  axios.defaults.adapter = async config => {
    requests.push({ method: config.method, url: config.url, params: config.params });
    const path = config.url.slice(base.length);
    if (path.endsWith('/analytics')) return analyticsReply(config);
    if (path.endsWith('/stats')) return ok({ totals: { shown: 10, started: 8, completed: 4 }, perBlock: {} }, config);
    return ok({ _id: id, type: 'SURVEY', name: 'NPS', survey: { version: 1 } }, config);
  };
});

const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});

test('get_survey_analytics requests the analytics route with only the given filters', async () => {
  await call('get_survey_analytics', { surveyId: id, from: '2026-09-01', to: '2026-09-30', version: 2, channel: 'web', device: 'phone', interval: 'week' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, `${base}/${id}/analytics`);
  assert.deepEqual(requests[0].params, { from: '2026-09-01', to: '2026-09-30', version: 2, channel: 'web', device: 'phone', interval: 'week' });

  requests = [];
  await call('get_survey_analytics', { surveyId: id });
  assert.deepEqual(requests[0].params, {});
  await assert.rejects(call('get_survey_analytics', { surveyId: id, channel: 'fax' }));
  await assert.rejects(call('get_survey_analytics', { surveyId: id, from: '1.9.2026' }));
});

test('get_survey_analytics returns a compact view', async () => {
  const view = (await call('get_survey_analytics', { surveyId: id })).structuredContent;
  assert.equal(view.available, true);
  assert.deepEqual(view.header.views, { value: 200, previous: 100, changePct: 100 });
  assert.deepEqual(view.header.uniqueViews, { value: 150, previous: 0, changePct: null });
  assert.deepEqual(view.header.completionRatePct, { value: 50, previous: 75, deltaPts: -25 });
  assert.deepEqual(view.header.avgTimeToCompleteSec, { value: 61, previous: 30.5, changePct: 100 });
  assert.equal(view.funnel.length, 30);
  assert.equal(view.funnelTruncated, 35);
  assert.deepEqual(view.funnel[0], { key: 'q_0', title: 'Question 0', type: 'single', viewed: 100, answered: 90, skipped: 3, dropOffPct: 1, closedHere: 1, medianSec: 4.2 });
  assert.equal(view.funnel[1].title.length, 120);
  assert.equal(view.worstStep.key, 'q_1');
  assert.equal(view.worstStep.dropOffPct, 20.4);
  assert.deepEqual(view.dismissed, { count: 60, ratePct: 30, medianSecToDismiss: 2.5 });
  assert.equal(view.timing.completeMedianSec, 60);
  assert.equal(view.topClosePoints.length, 5);
  assert.deepEqual(view.score, { kind: 'nps', key: 'nps_score', current: 42, previous: 30, change: 12, n: 40 });
  assert.deepEqual(view.versions.map(row => row.version), [2, 1]);
  assert.equal(view.breakdowns.device.length, 5);
  assert.equal(view.breakdowns.device[0].value, 'd8');
  assert.equal(view.breakdowns.channel[0].completionRatePct, 50);
  assert.equal(view.sources.pagePaths.length, 3);
  assert.deepEqual(view.sources.utm[0], { source: 'newsletter', medium: 'email', campaign: 'q3', views: 9, submissions: 2 });
  assert.deepEqual(view.busiestTimes, { tz: 'UTC', topSlots: [
    { day: 'Wed', hour: 14, submissions: 12 }, { day: 'Sun', hour: 20, submissions: 7 }, { day: 'Fri', hour: 11, submissions: 5 },
  ] });
  assert.deepEqual(view.reminders, { sent: 12, resumed: 5, completed: 3 });
  assert.deepEqual(view.email, { sent: 300, opened: 120, answered: 40, completed: 30, campaigns: 1 });
  assert.deepEqual(view.quality, { speeders: 2, speederThresholdSec: 18, straightLiners: 1 });
  for (const dropped of ['heatmap', 'series', 'closePoints', 'worstStepBlockId']) assert.equal(dropped in view, false, dropped);
  assert.ok(JSON.stringify(view).length < JSON.stringify(analytics()).length);
});

test('get_survey_analytics without events points to get_survey_results', async () => {
  analyticsReply = config => ok({ available: false, range: analytics().range, funnel: [] }, config);
  const view = (await call('get_survey_analytics', { surveyId: id })).structuredContent;
  assert.equal(view.available, false);
  assert.match(view.note, /get_survey_results/);
  assert.equal('funnel' in view, false);
});

test('get_survey_analytics surfaces API errors', async () => {
  analyticsReply = config => { throw httpError(404, { message: 'Not found' }, config); };
  const result = await call('get_survey_analytics', { surveyId: id });
  assert.equal(result.isError, true);
});

test('analyticsView tolerates missing sections', () => {
  const view = analyticsView({ available: true });
  assert.deepEqual(view.funnel, []);
  assert.equal(view.worstStep, null);
  assert.equal(view.score, null);
  assert.equal(view.busiestTimes, null);
  assert.equal(view.header.views.value, null);
});

test('get_survey_results adds the step funnel from the analytics route', async () => {
  const result = await call('get_survey_results', { surveyId: id, from: '2026-09-01', version: 2 });
  const analyticsRequest = requests.find(r => r.url.endsWith('/analytics'));
  assert.deepEqual(analyticsRequest.params, { from: '2026-09-01', version: 2 });
  assert.equal(result.structuredContent.funnel.length, 30);
  assert.equal(result.structuredContent.funnelRange.from, '2026-09-01');
  assert.equal(result.structuredContent.totals.completionRate, 50);
});

test('get_survey_results ignores analytics failures and empty analytics', async () => {
  analyticsReply = config => { throw httpError(500, { message: 'ClickHouse down' }, config); };
  let result = await call('get_survey_results', { surveyId: id });
  assert.equal(result.isError, undefined);
  assert.equal('funnel' in result.structuredContent, false);
  assert.equal(result.structuredContent.totals.completionRate, 50);

  analyticsReply = config => ok({ available: false, funnel: [] }, config);
  result = await call('get_survey_results', { surveyId: id });
  assert.equal('funnel' in result.structuredContent, false);
});

test('customer-scoped requests cannot read survey analytics', async () => {
  const result = await call('get_survey_analytics', { surveyId: id }, { sessionScope: 'customer' });
  assert.equal(result.structuredContent.sessionScope, true);
  assert.equal(requests.length, 0);
});
