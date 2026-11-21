// get_ticket_activity_log: the bounded, redacted view of a ticket's SDK
// activity log (console logs, network requests, click trail). The selection
// cases are ported from the Gleap Server's Kai Resolve digest tests
// (ticket.telemetry.digest.test.ts).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { buildActivityLog, activityLogText, ACTIVITY_LOG_LIMITS } = await import('../src/utils/activityLog.js');
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const T0 = Date.parse('2026-09-25T14:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

const consoleEntry = (seconds, priority, log) => ({ t: 'l', date: at(seconds), priority, log });
const request = (seconds, overrides = {}) => ({
  t: 'n',
  date: at(seconds),
  type: 'GET',
  url: `https://api.acme.test/v1/items/${seconds}`,
  duration: 40,
  success: true,
  request: { headers: { Authorization: 'Bearer secret-header-token' }, payload: '{}' },
  response: {
    status: 200,
    statusText: 'OK',
    headers: { 'Set-Cookie': 'sid=secret-cookie-value' },
    responseText: '{"ok":true}',
  },
  ...overrides,
});
const event = (seconds, name, data) => ({ t: 'e', date: at(seconds), name, ...(data === undefined ? {} : { data }) });
const received = (seconds) => ({ t: 's', date: at(seconds), name: 'Feedback received' });

// The endpoint lists newest first (Server buildActivityLog).
const apiOrder = (entries) => [...entries].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
const logOf = (entries, extra = {}) => buildActivityLog({ ticketId: 'T1', entries: apiOrder(entries), ...extra });
const ofKind = (log, kind) => log.timeline.filter((entry) => entry.kind === kind);
const textOf = (log) => activityLogText(log);
const costOf = (entries) => entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 6, 0);

describe('console logs', () => {
  test('the SDK priority field sets the level', () => {
    const log = logOf([
      consoleEntry(1, 'ERROR', 'failed to load cart'),
      consoleEntry(2, 'WARNING', 'slow response'),
      consoleEntry(3, 'INFO', 'cart rendered'),
    ]);
    assert.deepEqual(ofKind(log, 'console'), [
      { time: at(1), kind: 'console', level: 'ERROR', message: 'failed to load cart' },
      { time: at(2), kind: 'console', level: 'WARN', message: 'slow response' },
      { time: at(3), kind: 'console', level: 'INFO', message: 'cart rendered' },
    ]);
    assert.equal(log.summary.console.note, '3 of 3 lines shown');
  });

  test('an error older than the tail survives trimming, and the note says N of M', () => {
    const logs = [consoleEntry(0, 'ERROR', 'the original crash')];
    for (let i = 1; i <= 400; i++) logs.push(consoleEntry(i, 'INFO', `render tick ${i}`));
    const log = logOf(logs);
    const messages = ofKind(log, 'console').map((entry) => entry.message);

    assert.ok(messages.includes('the original crash'));
    assert.ok(messages.includes('render tick 400'), 'the newest lines are kept');
    assert.ok(!messages.includes('render tick 1'), 'the oldest info lines are dropped');
    assert.equal(log.summary.console.total, 401);
    assert.equal(log.summary.console.errors, 1);
    assert.ok(log.summary.console.shown <= ACTIVITY_LOG_LIMITS.console.maxEntries);
    assert.match(
      log.summary.console.note,
      new RegExp(`^${log.summary.console.shown} of 401 lines shown: the only error first, then the newest$`),
    );
    assert.match(log.hint, /section .* search/);
  });

  test('lines come out in chronological order after trimming', () => {
    const logs = [];
    for (let i = 0; i < 100; i++) logs.push(consoleEntry(i, i % 10 === 0 ? 'ERROR' : 'INFO', `line ${i}`));
    const times = ofKind(logOf(logs), 'console').map((entry) => entry.time);
    assert.deepEqual(times, [...times].sort());
  });

  test('consecutive repeats collapse into one line with a count', () => {
    const log = logOf([
      consoleEntry(1, 'ERROR', 'socket closed'),
      consoleEntry(2, 'ERROR', 'socket closed'),
      consoleEntry(3, 'ERROR', 'socket closed'),
      consoleEntry(4, 'INFO', 'reconnected'),
    ]);
    assert.deepEqual(ofKind(log, 'console'), [
      { time: at(1), kind: 'console', level: 'ERROR', message: 'socket closed', repeated: 3 },
      { time: at(4), kind: 'console', level: 'INFO', message: 'reconnected' },
    ]);
    assert.equal(log.summary.console.shown, 4);
    assert.equal(log.summary.console.total, 4);
  });

  test('CLICK entries go to the click trail, not the console', () => {
    const log = logOf([consoleEntry(1, 'CLICK', '<a href="/billing">Billing</a>'), consoleEntry(2, 'INFO', 'navigated')]);
    assert.deepEqual(ofKind(log, 'click'), [{ time: at(1), kind: 'click', target: '<a href="/billing">Billing</a>' }]);
    assert.equal(log.summary.console.total, 1);
    assert.equal(log.summary.actions.clicks, 1);
  });

  test('a noisy console (500 lines of 1000 chars) stays inside its limits', () => {
    const logs = [];
    for (let i = 0; i < 500; i++) logs.push(consoleEntry(i, i % 3 === 0 ? 'ERROR' : 'INFO', `${i} `.padEnd(1000, 'x')));
    const lines = ofKind(logOf(logs), 'console');
    assert.ok(costOf(lines) <= ACTIVITY_LOG_LIMITS.console.maxChars, `console is ${costOf(lines)} chars`);
    for (const line of lines) assert.ok(line.message.length <= ACTIVITY_LOG_LIMITS.console.messageChars + 1);
  });

  test('secrets in log text are redacted', () => {
    const log = logOf([
      consoleEntry(1, 'INFO', 'calling api with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl'),
      consoleEntry(2, 'ERROR', 'login failed {"email":"a@acme.test","password":"hunter2"}'),
    ]);
    const text = textOf(log);
    assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9|hunter2/);
    assert.match(text, /Bearer \[redacted\]/);
    assert.match(text, /a@acme\.test/, 'the customer identity stays');
  });

  test('a secret on the cut of a long line does not survive as a prefix', () => {
    // Three JWTs shrink to "[redacted]" and pull the work cut into view.
    const jwt = `eyJ${'a'.repeat(500)}.${'b'.repeat(500)}.${'c'.repeat(500)}`;
    const line = `${jwt} {"sessionToken":"st_${'9'.repeat(4000)}"}`;
    const [entry] = ofKind(logOf([consoleEntry(1, 'ERROR', line)]), 'console');
    assert.doesNotMatch(entry.message, /st_9/);
    assert.match(entry.message, /"sessionToken":"\[redacted\]/);
  });
});

describe('network requests', () => {
  test('method, status and duration render', () => {
    const log = logOf([request(1, { type: 'PATCH', duration: 123.4 })]);
    assert.deepEqual(ofKind(log, 'network'), [
      {
        time: at(1),
        kind: 'network',
        method: 'PATCH',
        url: 'https://api.acme.test/v1/items/1',
        status: 200,
        durationMs: 123,
      },
    ]);
  });

  test('a failed request shows its bodies, a successful one does not', () => {
    const log = logOf([
      request(1, { response: { status: 200, responseText: '{"items":[1,2,3]}' } }),
      request(2, {
        type: 'POST',
        url: 'https://api.acme.test/v1/orders',
        request: { payload: '{"sku":"A1","qty":2}' },
        response: { status: 422, responseText: '{"error":"qty exceeds stock"}' },
      }),
    ]);
    assert.deepEqual(ofKind(log, 'network'), [
      { time: at(1), kind: 'network', method: 'GET', url: 'https://api.acme.test/v1/items/1', status: 200, durationMs: 40 },
      {
        time: at(2),
        kind: 'network',
        method: 'POST',
        url: 'https://api.acme.test/v1/orders',
        status: 422,
        failed: true,
        durationMs: 40,
        requestBody: '{"sku":"A1","qty":2}',
        responseBody: '{"error":"qty exceeds stock"}',
      },
    ]);
    assert.equal(log.summary.network.failed, 1);
  });

  test('request and response headers are never returned, even with bodies', () => {
    const failing = request(1, { response: { status: 500, headers: { 'Set-Cookie': 'sid=secret-cookie-value' }, responseText: 'oops' } });
    for (const log of [logOf([failing, request(2)]), logOf([failing, request(2)], { search: 'items' })]) {
      const text = textOf(log);
      assert.doesNotMatch(text, /secret-header-token|secret-cookie-value/);
      assert.doesNotMatch(text, /Authorization|Set-Cookie|"headers"/i);
    }
  });

  test('Android: a JSON body spread into the response object shows without its headers', () => {
    const android = {
      t: 'n',
      date: at(1),
      type: 'POST',
      status: 401,
      url: 'https://api.acme.test/v1/session',
      success: true,
      request: { headers: { 'X-Android-Sent-Millis': '1' }, payload: { email: 'a@acme.test', password: 'hunter2' } },
      response: { status: 401, error: 'invalid login', access_token: 'at_abcdef123456', headers: { Server: 'nginx' } },
    };
    const [entry] = ofKind(logOf([android]), 'network');
    assert.equal(entry.status, 401);
    assert.equal(entry.requestBody, '{"email":"a@acme.test","password":"[redacted]"}');
    assert.equal(entry.responseBody, '{"error":"invalid login","access_token":"[redacted]"}');
  });

  test('an error payload behind a 200 (GraphQL style) counts as failed', () => {
    const graphql = request(1, {
      type: 'POST',
      url: 'https://api.acme.test/graphql',
      request: { payload: '{"query":"mutation { pay }"}' },
      response: { status: 200, responseText: '{"data":null,"errors":[{"message":"card declined"}]}' },
    });
    const log = logOf([graphql]);
    const [entry] = ofKind(log, 'network');
    assert.equal(entry.failed, true);
    assert.equal(entry.error, 'error in body');
    assert.match(entry.responseBody, /card declined/);
    assert.equal(log.summary.network.failed, 1);
  });

  test('a request that never got a response -> failed, no response', () => {
    const offline = { t: 'n', date: at(1), type: 'GET', url: 'https://api.acme.test/v1/me', success: false, duration: 3001 };
    assert.deepEqual(ofKind(logOf([offline]), 'network'), [
      {
        time: at(1),
        kind: 'network',
        method: 'GET',
        url: 'https://api.acme.test/v1/me',
        failed: true,
        error: 'no response',
        durationMs: 3001,
      },
    ]);
  });

  test('an iOS transport error carries its text', () => {
    const failed = {
      t: 'n',
      date: at(1),
      type: 'GET',
      url: 'https://api.acme.test/v1/me',
      success: false,
      response: { errorText: 'The Internet connection appears to be offline.' },
    };
    const [entry] = ofKind(logOf([failed]), 'network');
    assert.equal(entry.error, 'The Internet connection appears to be offline.');
  });

  test('secrets in bodies and URLs are redacted, the customer identity stays', () => {
    const leaky = request(1, {
      type: 'POST',
      url: 'https://api.acme.test/v1/login?redirect=%2Fhome&access_token=tok_123456789',
      request: {
        headers: { Cookie: 'sid=secret-cookie-value' },
        payload: '{"email":"a@acme.test","password":"hunter2","card":{"number":"4242424242424242","cvc":"123"}}',
      },
      response: { status: 401, responseText: '{"error":"invalid","refreshToken":"rt_abcdef123456"}' },
    });
    const text = textOf(logOf([leaky]));
    assert.doesNotMatch(text, /tok_123456789|hunter2|4242424242424242|"123"|rt_abcdef123456|secret-cookie-value/);
    assert.match(text, /access_token=\[redacted\]/);
    assert.match(text, /redirect=%2Fhome/);
    assert.match(text, /\\"password\\":\\"\[redacted\]\\"/);
    assert.match(text, /a@acme\.test/);
  });

  test('a huge response body is truncated', () => {
    const big = request(1, { response: { status: 500, responseText: `{"error":"${'e'.repeat(20_000)}"}` } });
    const [entry] = ofKind(logOf([big]), 'network');
    assert.ok(entry.responseBody.length <= ACTIVITY_LOG_LIMITS.network.responseBodyChars + 40, `${entry.responseBody.length}`);
    assert.match(entry.responseBody, /… \[truncated from 20012 chars\]$/);
  });

  test('failed requests are kept first when there are too many requests', () => {
    const requests = [request(0, { url: 'https://api.acme.test/v1/early-failure', response: { status: 503, responseText: 'down' } })];
    for (let i = 1; i <= 70; i++) requests.push(request(i));
    const log = logOf(requests);
    const urls = ofKind(log, 'network').map((entry) => entry.url);
    assert.ok(urls.includes('https://api.acme.test/v1/early-failure'));
    assert.ok(urls.includes('https://api.acme.test/v1/items/70'));
    assert.equal(log.summary.network.total, 71);
    assert.ok(log.summary.network.shown <= ACTIVITY_LOG_LIMITS.network.maxEntries);
    assert.match(
      log.summary.network.note,
      new RegExp(`^${log.summary.network.shown} of 71 requests shown: the only failed request first, then the newest$`),
    );
  });

  test('resource timings show as timing-only entries', () => {
    const resource = { t: 'n', date: at(1), type: 'RESOURCE', url: 'https://cdn.acme.test/app.js', duration: 12.6, initiatorType: 'script' };
    assert.deepEqual(ofKind(logOf([resource]), 'network'), [
      { time: at(1), kind: 'network', method: 'RESOURCE', initiator: 'script', url: 'https://cdn.acme.test/app.js', durationMs: 13 },
    ]);
  });
});

describe('click trail', () => {
  test('clicks, page views and custom events merge chronologically', () => {
    const log = logOf([
      consoleEntry(20, 'CLICK', '<button>Pay now</button>'),
      event(1, 'sessionStarted'),
      event(10, 'pageView', { page: 'https://app.acme.test/checkout' }),
      event(21, 'checkout_submitted', { plan: 'pro' }),
    ]);
    assert.deepEqual(log.timeline, [
      { time: at(1), kind: 'event', name: 'sessionStarted' },
      { time: at(10), kind: 'page', url: 'https://app.acme.test/checkout' },
      { time: at(20), kind: 'click', target: '<button>Pay now</button>' },
      { time: at(21), kind: 'event', name: 'checkout_submitted', data: '{"plan":"pro"}' },
    ]);
  });

  test('a long trail keeps the newest entries within the limits', () => {
    const events = [];
    for (let i = 0; i < 500; i++) events.push(event(i, 'pageView', { page: `https://app.acme.test/p/${i}` }));
    const log = logOf(events);
    const pages = ofKind(log, 'page');
    assert.ok(pages.length <= ACTIVITY_LOG_LIMITS.actions.maxEntries);
    assert.ok(costOf(pages) <= ACTIVITY_LOG_LIMITS.actions.maxChars);
    assert.equal(pages[pages.length - 1].url, 'https://app.acme.test/p/499');
    assert.equal(log.summary.actions.total, 500);
    assert.match(log.summary.actions.note, /^\d+ of 500 entries shown: the newest$/);
  });

  test('secrets in event data are redacted', () => {
    const log = logOf([event(1, 'login', { user: 'a@acme.test', sessionToken: 'st_secret_value' })]);
    const [entry] = ofKind(log, 'event');
    assert.equal(entry.data, '{"user":"a@acme.test","sessionToken":"[redacted]"}');
  });
});

describe('section and search', () => {
  const busy = () => {
    const entries = [received(200)];
    for (let i = 0; i < 70; i++) {
      entries.push(
        request(i, {
          url: `https://api.acme.test/v1/items/${i}`,
          response: { status: 200, responseText: `{"item":${i},"apiKey":"k_${i}_secret"}` },
        }),
      );
    }
    for (let i = 0; i < 300; i++) entries.push(consoleEntry(i, 'INFO', `render tick ${i}`));
    return entries;
  };

  test('search finds a request the default view left out, with its redacted bodies', () => {
    const all = logOf(busy());
    assert.ok(!ofKind(all, 'network').some((entry) => entry.url.endsWith('/items/3')));

    const found = logOf(busy(), { search: 'items/3' });
    const urls = ofKind(found, 'network').map((entry) => entry.url);
    assert.ok(urls.includes('https://api.acme.test/v1/items/3'));
    assert.ok(urls.every((url) => url.includes('items/3')));
    const [item3] = ofKind(found, 'network').filter((entry) => entry.url.endsWith('/items/3'));
    assert.equal(item3.responseBody, '{"item":3,"apiKey":"[redacted]"}');
    assert.equal(found.summary.network.matched, 11);
    assert.equal(found.search, 'items/3');
    assert.equal(found.summary.network.note, '11 of 11 requests matching the search shown (70 requests in total)');
  });

  test('search only sees redacted text, so it cannot probe for a secret', () => {
    const log = logOf(
      [
        consoleEntry(1, 'ERROR', 'login failed, password: hunter2'),
        request(2, { url: 'https://api.acme.test/v1/cb?access_token=tok_123456789', response: { status: 500, responseText: 'x' } }),
      ],
      { search: 'hunter2' },
    );
    assert.equal(log.timeline.length, 0);
    assert.equal(logOf([request(2, { url: 'https://api.acme.test/v1/cb?access_token=tok_123456789' })], { search: 'tok_1' }).timeline.length, 0);
    assert.equal(log.summary.console.note, 'no lines match the search (1 line in total)');
  });

  test('one section gets the larger budget and only its own summary', () => {
    const log = logOf(busy(), { section: 'network' });
    assert.deepEqual(Object.keys(log.summary), ['network']);
    assert.equal(log.section, 'network');
    assert.equal(log.summary.network.shown, 70);
    assert.ok(log.timeline.every((entry) => entry.kind === 'network'));
    assert.equal(log.hint, undefined);
  });

  test('nothing captured -> the ticket milestone and a note that absence proves nothing', () => {
    const log = logOf([received(1)]);
    assert.deepEqual(log.timeline, [{ time: at(1), kind: 'system', name: 'Feedback received' }]);
    assert.equal(log.summary.console.note, 'no lines captured');
    assert.match(log.hint, /absence says nothing/);
  });
});

describe('size limit', () => {
  const largestCapture = () => {
    const bigBody = JSON.stringify({ error: 'x'.repeat(150_000), token: 'secret-token-value' });
    const entries = [received(900)];
    for (let i = 0; i < 500; i++) entries.push(consoleEntry(i, i % 2 ? 'ERROR' : 'CLICK', `${i} "${'y'.repeat(990)}"`));
    for (let i = 0; i < 70; i++) {
      entries.push(
        request(i, {
          url: `https://api.acme.test/v1/${'p'.repeat(2000)}?i=${i}`,
          request: { headers: { Authorization: 'Bearer secret-header-token' }, payload: bigBody },
          response: { status: 500, headers: { 'Set-Cookie': 'sid=secret-cookie-value' }, responseText: bigBody },
        }),
      );
    }
    for (let i = 0; i < 500; i++) entries.push(event(i, 'custom', { blob: 'z'.repeat(5000) }));
    return apiOrder(entries);
  };

  for (const options of [{}, { section: 'console' }, { section: 'network' }, { section: 'actions' }, { search: 'p' }]) {
    test(`the largest SDK capture stays under the total limit ${JSON.stringify(options)}`, () => {
      const started = process.hrtime.bigint();
      const log = buildActivityLog({ ticketId: 'T1', entries: largestCapture(), ...options });
      const text = activityLogText(log);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(text.length <= ACTIVITY_LOG_LIMITS.totalChars, `result is ${text.length} chars`);
      assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
      assert.doesNotMatch(text, /secret-token-value|secret-header-token|secret-cookie-value/);
      assert.deepEqual(JSON.parse(text), log, 'the text is the structured result as JSON');
    });
  }
});

describe('get_ticket_activity_log tool', () => {
  const tools = new Map();
  const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
  applySessionScopePolicy(registry);
  registerTicketTools(registry);

  let requests;
  let respond;
  beforeEach(() => {
    requests = [];
    respond = () => apiOrder([consoleEntry(1, 'ERROR', 'boom'), request(2), received(3)]);
    axios.defaults.adapter = async (config) => {
      requests.push({ method: config.method, url: config.url });
      const data = await respond(config);
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
  });
  const call = (args, creds = {}) =>
    runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
      const { config, handler } = tools.get('get_ticket_activity_log');
      return handler(z.object(config.inputSchema).parse(args));
    });

  test('the description says what the tool returns', () => {
    const { description } = tools.get('get_ticket_activity_log').config;
    assert.match(description, /console logs, network requests/);
    assert.match(description, /headers are never returned/);
    assert.match(description, /N of M/);
    assert.doesNotMatch(description, /status changes, assignments/);
    assert.ok(description.length <= 1024, 'Gleap agents cut tool descriptions at 1024 chars');
  });

  test('reads the activity-logs endpoint and returns the text and structured result', async () => {
    const result = await call({ ticketId: '#138803' });
    assert.deepEqual(requests, [{ method: 'get', url: 'https://gleap-api.invalid/v3/tickets/%23138803/activity-logs' }]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.deepEqual(
      result.structuredContent.timeline.map((entry) => entry.kind),
      ['console', 'network', 'system'],
    );
    assert.doesNotMatch(result.content[0].text, /secret-header-token|secret-cookie-value/);
  });

  test('an API error passes through unchanged', async () => {
    respond = (config) => {
      throw new AxiosError('Payment Required', 'ERR_BAD_REQUEST', config, null, {
        status: 402,
        data: { message: 'Upgrade plan.' },
        headers: {},
        config,
      });
    };
    const result = await call({ ticketId: 'T1' });
    assert.equal(result.structuredContent.error, true);
    assert.equal(result.structuredContent.status, 402);
    assert.match(result.content[0].text, /Upgrade plan/);
  });

  test('an unexpected response shape is refused without its content', async () => {
    respond = () => ({ logs: [request(1)] });
    const result = await call({ ticketId: 'T1' });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /secret-header-token|items\/1/);
  });

  test("a customer-scoped run cannot read another customer's ticket", async () => {
    respond = (config) => (config.url.endsWith('/activity-logs') ? [request(1)] : { session: 'other-session' });
    const result = await call({ ticketId: 'T1' }, { sessionScope: 'scoped-session' });
    assert.equal(result.structuredContent.sessionScope, true);
    assert.ok(!requests.some((r) => r.url.endsWith('/activity-logs')));
  });
});
