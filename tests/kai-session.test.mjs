// Kai Code native turns (external sessions): tenant scoping and input caps.
// Scoping itself lives in the Gleap API (it resolves sessions/tickets only
// inside the caller's project); these tests pin the MCP side of it: the
// project and key always come from the caller's credentials, ids never reach
// a path unchecked, another project's ids come back as errors, customer-scoped
// runs cannot use the session tools or prompts, and oversized input is refused
// before any request.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSessionTools } = await import('../src/tools/session.tool.js');
const { registerTicketPrompts } = await import('../src/prompts/ticket.prompts.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { sessionRoute } = await import('../src/utils/kaiSession.js');

const tools = new Map();
const prompts = new Map();
const registry = {
  registerTool(name, config, handler) { tools.set(name, { config, handler }); },
  registerPrompt(name, config, handler) { prompts.set(name, { config, handler }); },
};
applySessionScopePolicy(registry);
registerSessionTools(registry);
registerTicketPrompts(registry);

const PROJECT = '613b5dd730aed737108f87ab';
const OWN_SESSION = '64f0c0ffee0000000000abcd';
const OTHER_SESSION = '64f0c0ffee0000000000ffff';
const OWN_TICKET = '650000000000000000000001';
const OTHER_TICKET = '650000000000000000000002';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let requests;
let screenshotUrl;
const header = (headers, name) => headers?.[name] ?? headers?.get?.(name);
beforeEach(() => {
  requests = [];
  screenshotUrl = 'https://files.gleap.io/p/screenshot.png';
  axios.defaults.adapter = async (config) => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data || '{}') : config.data;
    requests.push({ method: config.method, url: config.url, params: config.params, body, headers: config.headers });
    const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    const notFound = () => {
      const err = new axios.AxiosError('Not found', 'ERR_BAD_REQUEST', config, null, { data: { message: 'Not found' }, status: 404, statusText: 'Not Found', headers: {}, config });
      throw err;
    };
    if (config.url === screenshotUrl) return ok(png);
    // The fake API resolves only this project's sessions and tickets.
    if (header(config.headers, 'project') !== PROJECT) notFound();
    const url = new URL(config.url);
    const session = /\/gleapcode\/sessions\/([a-f0-9]{24})\//.exec(url.pathname)?.[1];
    if (session && session !== OWN_SESSION) notFound();
    const ticketInPath = /\/tickets\/([^/]+)$/.exec(url.pathname)?.[1];
    if (ticketInPath) {
      if (ticketInPath !== OWN_TICKET) notFound();
      return ok({ _id: OWN_TICKET, bugId: 7, type: 'BUG', title: 'Broken', screenshotUrl, shareToken: 'secret-share', session: { gleapHash: 'h' } });
    }
    const ticketRef = body?.ticketId ?? config.params?.ticketId;
    if (!session && ticketRef !== undefined && ticketRef !== OWN_TICKET && ticketRef !== '#7') notFound();
    if (url.pathname.endsWith('/agent-share')) {
      return ok({ sessionId: OWN_SESSION, shareId: 's1', expiresAt: '2026-10-18T12:15:00Z', uploads: (body.files ?? []).map((f, i) => ({ name: f.name, url: `https://api.gleap.io/v3/kai-agent-uploads/tok${i}` })) });
    }
    if (url.pathname.endsWith('/agent-workflow')) return ok({ sessionId: OWN_SESSION, markdown: '# Workflow', hook: { sessionId: OWN_SESSION, token: 'hook-jwt', apiBase: 'https://api.gleap.io/v3', expiresAt: 'x' } });
    return ok({ success: true, sessionId: OWN_SESSION });
  };
});

const creds = (extra = {}) => ({ apiKey: 'test-only', projectId: PROJECT, ...extra });
const call = (name, args, extra) => runWithCreds(creds(extra), async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).strict().parse(args));
});
const getPrompt = (name, args, extra) => runWithCreds(creds(extra), async () => prompts.get(name).handler(args));
const plan = { items: [{ content: 'Reproduce', status: 'inProgress' }, { content: 'Fix', status: 'pending' }] };

describe('tenant scoping', () => {
  test('every call carries the caller\'s project and key, not anything from the args', async () => {
    await call('update_plan', { sessionId: OWN_SESSION, ...plan });
    assert.equal(requests.length, 1);
    assert.equal(header(requests[0].headers, 'project'), PROJECT);
    assert.equal(header(requests[0].headers, 'Authorization'), 'Bearer test-only');
    assert.match(requests[0].url, new RegExp(`/gleapcode/sessions/${OWN_SESSION}/agent-plan$`));
    assert.deepEqual(requests[0].body.items.map((i) => i.status), ['in_progress', 'pending']);
  });

  test('a session id from another project does not resolve', async () => {
    for (const [name, args] of [
      ['update_plan', plan],
      ['wrap_up', { recap: 'Done.' }],
      ['publish_artifact', { title: 'Report', html: '<p>x</p>' }],
      ['share_screenshot', { caption: 'After', path: '/tmp/a.png' }],
    ]) {
      const res = await call(name, { sessionId: OTHER_SESSION, ...args });
      assert.equal(res.isError, true, name);
      assert.match(res.content[0].text, /404/, name);
    }
  });

  test('a ticket from another project does not resolve, and ticket refs never reach a session path', async () => {
    const res = await call('wrap_up', { ticketId: OTHER_TICKET, recap: 'Done.' });
    assert.equal(res.isError, true);
    assert.match(requests[0].url, /\/gleapcode\/sessions\/agent-wrap-up$/);
    assert.equal(requests[0].body.ticketId, OTHER_TICKET);

    const shot = await call('get_ticket_screenshot', { ticketId: OTHER_TICKET });
    assert.equal(shot.isError, true);
    assert.ok(!requests.some((r) => r.url === screenshotUrl), 'no screenshot fetched for another project\'s ticket');

  });

  test('malformed session ids never become a path', () => {
    assert.equal(sessionRoute({ sessionId: '../../tickets/x' }, 'agent-plan'), null);
    assert.equal(sessionRoute({ sessionId: `${OWN_SESSION}/../x` }, 'agent-plan'), null);
    assert.throws(() => z.object(tools.get('update_plan').config.inputSchema).parse({ sessionId: '../x', ...plan }));
  });

  test('neither id: refused without calling Gleap', async () => {
    const res = await call('update_plan', plan);
    assert.equal(res.isError, true);
    assert.equal(requests.length, 0);
  });

  test('customer-scoped runs cannot use the session tools or the prompts', async () => {
    const scoped = { sessionScope: 'customer-session-1' };
    const res = await call('update_plan', { sessionId: OWN_SESSION, ...plan }, scoped);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.sessionScope, true);
    // The ticket belongs to no customer session -> another customer's.
    const shot = await call('get_ticket_screenshot', { ticketId: OWN_TICKET }, scoped);
    assert.equal(shot.isError, true);
    assert.ok(!requests.some((r) => r.url === screenshotUrl));
    await assert.rejects(getPrompt('fix_ticket', { ticket: OWN_TICKET }, scoped), /customer-scoped/);
  });

  test('prompts load only this project\'s tickets and strip share tokens', async () => {
    await assert.rejects(getPrompt('fix_ticket', { ticket: OTHER_TICKET }), /could not be loaded/);
    const res = await getPrompt('fix_ticket', { ticket: OWN_TICKET });
    const text = res.messages[0].content.text;
    assert.match(text, /# Workflow/);
    assert.ok(!text.includes('secret-share'));
    assert.ok(!text.includes('gleapHash'));
  });
});

describe('input caps', () => {
  test('publish_artifact refuses html over 1 MB before any request', async () => {
    const res = await call('publish_artifact', { sessionId: OWN_SESSION, title: 'Big', html: `<p>${'é'.repeat(500_001)}</p>` });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /limited to 1 MB/);
    assert.equal(requests.length, 0);
  });

  test('share_screenshot refuses base64 over 1.5 MB and non-images before any request', async () => {
    const big = Buffer.concat([png, Buffer.alloc(1_600_000)]).toString('base64');
    let res = await call('share_screenshot', { sessionId: OWN_SESSION, caption: 'After', imageBase64: [big] });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /1\.5 MB/);
    res = await call('share_screenshot', { sessionId: OWN_SESSION, caption: 'After', imageBase64: [Buffer.from('<svg onload=alert(1)>').toString('base64')] });
    assert.equal(res.isError, true);
    assert.equal(requests.length, 0);
    res = await call('share_screenshot', { sessionId: OWN_SESSION, caption: 'After', imageBase64: [`data:image/png;base64,${png.toString('base64')}`] });
    assert.equal(res.isError, undefined);
    assert.equal(requests[0].body.files[0].mimeType, 'image/png');
    assert.equal(requests[0].body.imageBase64[0], png.toString('base64'));
  });

  test('share_screenshot quotes local paths in the upload commands', async () => {
    const res = await call('share_screenshot', { sessionId: OWN_SESSION, caption: 'After', path: "/tmp/it's here.png", compare_with: '/tmp/before.png' });
    assert.equal(res.isError, undefined);
    assert.deepEqual(requests[0].body.files.map((f) => f.name), ["it's here.png", 'before.png']);
    const commands = res.structuredContent.commands;
    assert.equal(commands[0], `curl -sS --fail -T '/tmp/it'\\''s here.png' 'https://api.gleap.io/v3/kai-agent-uploads/tok0'`);
    assert.ok(res.content.some((c) => c.text.includes(commands[1])));
  });

  test('get_ticket_screenshot fetches only from Gleap file hosts', async () => {
    screenshotUrl = 'http://169.254.169.254/latest/meta-data.png';
    let res = await call('get_ticket_screenshot', { ticketId: OWN_TICKET });
    assert.equal(res.isError, true);
    assert.ok(!requests.some((r) => r.url === screenshotUrl));
    screenshotUrl = 'https://files.gleap.io/p/screenshot.png';
    res = await call('get_ticket_screenshot', { ticketId: OWN_TICKET });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].type, 'image');
    assert.equal(res.content[0].mimeType, 'image/png');
  });
});
