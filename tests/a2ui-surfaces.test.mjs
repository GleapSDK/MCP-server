// A2UI surfaces: the Kai session view renders any surface without turning its
// text into HTML and opens or shows only https links and images; the session
// tools never put a non-https link into a surface; answer_ticket_card answers
// through the action endpoint with the card's own id, never with anything from
// the answer text in the path.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios from 'axios';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { A2UI_RENDERER_JS } = await import('../src/ui/a2uiRenderer.js');
const { registerSessionTools } = await import('../src/tools/session.tool.js');
const { registerTicketCardTools } = await import('../src/tools/ticketCard.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');
const { applyShareTokenRedaction } = await import('../src/utils/shareTokenRedaction.js');

// ---- a DOM that refuses every HTML-parsing sink ----

const HTML_SINKS = ['innerHTML', 'outerHTML'];
const makeDocument = () => {
  const created = [];
  const textOf = (node) => (node.nodeType === 3 ? node.data : node.children.map(textOf).join(''));
  const element = (tagName) => {
    const el = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      children: [],
      attributes: {},
      style: {},
      className: '',
      disabled: false,
      onclick: null,
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) {
        if (/^on/i.test(name)) throw new Error(`event handler attribute ${name} set from surface data`);
        this.attributes[name] = String(value);
      },
      addEventListener(type, fn) { if (type === 'click') this.onclick = fn; },
      insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); },
      get textContent() { return textOf(this); },
      set textContent(value) { this.children = value === '' || value == null ? [] : [{ nodeType: 3, data: String(value) }]; },
    };
    for (const sink of HTML_SINKS) {
      Object.defineProperty(el, sink, { get: () => '', set: () => { throw new Error(`${sink} set`); } });
    }
    created.push(el);
    return el;
  };
  return {
    created,
    textOf,
    createElement: element,
    createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
    write() { throw new Error('document.write used'); },
  };
};

const loadRenderer = (doc) => new Function('document', `${A2UI_RENDERER_JS}\nreturn { safeUrl: safeUrl, renderSurface: renderSurface };`)(doc);

const surface = (components, dataModel = {}) => ({
  v: '1.0',
  surfaceId: 'kaicode:64f0c0ffee0000000000abcd:test',
  catalogId: 'https://gleap.io/a2ui/catalog/v1.json',
  components,
  dataModel,
});

const render = (s) => {
  const doc = makeDocument();
  const { renderSurface } = loadRenderer(doc);
  const mount = doc.createElement('div');
  const opened = [];
  renderSurface(s, mount, (url) => opened.push(url));
  const clickAll = () => doc.created.filter((e) => typeof e.onclick === 'function' && !e.disabled).forEach((e) => e.onclick({ preventDefault() {} }));
  return { doc, mount, opened, clickAll };
};

const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';

describe('Kai session view renderer', () => {
  test('safeUrl keeps plain https links only', () => {
    const { safeUrl } = loadRenderer(makeDocument());
    assert.equal(safeUrl('https://app.gleap.io/projects/p/sessions/s'), 'https://app.gleap.io/projects/p/sessions/s');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://app.gleap.io/x', 'data:text/html,<b>x</b>', '//evil.test/x', '/relative', 'https://user:pw@evil.test/', 'vbscript:x', '', null, 42, { '@path': '/x' }]) {
      assert.equal(safeUrl(bad), null, String(bad));
    }
  });

  test('surface text stays text: markup is shown literally, bold and line breaks become elements', () => {
    const { doc, mount } = render(surface([
      { id: 'root', component: 'Column', children: ['t1', 't2', 'pill', 'kv', 'tl', 'other'] },
      { id: 't1', component: 'Text', text: `**Bold** ${HOSTILE}\nsecond line` },
      { id: 't2', component: 'Text', text: { '@path': '/caption' } },
      { id: 'pill', component: 'GleapStatusPill', label: HOSTILE, tone: 'success' },
      { id: 'kv', component: 'GleapKeyValue', items: [{ label: HOSTILE, value: HOSTILE }] },
      { id: 'tl', component: 'GleapTimeline', steps: [{ label: HOSTILE, state: 'done', detail: HOSTILE }] },
      { id: 'other', component: 'GleapSomethingNew', label: HOSTILE },
    ], { caption: `bound ${HOSTILE}` }));
    const text = doc.textOf(mount);
    assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'markup is rendered as literal text');
    assert.ok(text.includes(`bound ${HOSTILE}`), 'a binding resolves against the data model');
    assert.ok(!doc.created.some((e) => e.tagName === 'SCRIPT' || e.tagName === 'IMG' || e.tagName === 'IFRAME'), 'no element comes from surface text');
    const strong = doc.created.find((e) => e.tagName === 'STRONG' || e.tagName === 'B');
    assert.ok(strong, 'bold becomes an element');
    assert.equal(doc.textOf(strong), 'Bold');
    assert.ok(doc.created.some((e) => e.tagName === 'BR'), 'a line break becomes an element');
    assert.ok(!text.includes('**'), 'bold markers are not shown');
  });

  test('images load from https only, literal or bound', () => {
    for (const url of ['javascript:alert(1)', 'http://evil.test/a.png', 'data:image/svg+xml,<svg onload=alert(1)>']) {
      const { doc } = render(surface([
        { id: 'root', component: 'Column', children: ['a', 'b'] },
        { id: 'a', component: 'Image', url },
        { id: 'b', component: 'Image', url: { '@path': '/img' } },
      ], { img: url }));
      const imgs = doc.created.filter((e) => e.tagName === 'IMG');
      assert.ok(imgs.every((img) => !img.src && !img.attributes.src), `${url} reached an image`);
    }
    const { doc } = render(surface([{ id: 'root', component: 'Image', url: 'https://files.gleap.io/a.png' }]));
    const img = doc.created.find((e) => e.tagName === 'IMG');
    assert.equal(img?.src ?? img?.attributes.src, 'https://files.gleap.io/a.png');
  });

  test('buttons and links open https only; an event button stays disabled', () => {
    const button = (id, url) => [
      { id, component: 'Button', child: `${id}l`, action: { functionCall: { '@call': 'openUrl', args: { url } } } },
      { id: `${id}l`, component: 'Text', text: 'Open' },
    ];
    const { opened, clickAll, doc } = render(surface([
      { id: 'root', component: 'Column', children: ['b1', 'b2', 'b3', 'b4', 'b5', 'kv'] },
      ...button('b1', 'javascript:alert(1)'),
      ...button('b2', 'http://evil.test/'),
      ...button('b3', { '@path': '/bad' }),
      ...button('b4', 'https://app.gleap.io/ok'),
      { id: 'b5', component: 'Button', child: 'b5l', action: { event: { name: 'task.answer', context: {} } } },
      { id: 'b5l', component: 'Text', text: 'Answer' },
      { id: 'kv', component: 'GleapKeyValue', items: [{ label: 'PR', value: 'x', url: 'javascript:alert(1)' }, { label: 'Doc', value: 'y', url: 'https://gleap.io/doc' }] },
    ], { bad: 'javascript:alert(3)' }));
    clickAll();
    assert.deepEqual(opened.sort(), ['https://app.gleap.io/ok', 'https://gleap.io/doc']);
    const anchorsWithHref = doc.created.filter((e) => e.href || e.attributes.href);
    assert.ok(anchorsWithHref.every((e) => String(e.href ?? e.attributes.href).startsWith('https://')));
  });
});

// ---- the tools, through the SDK client ----

const PROJECT = '613b5dd730aed737108f87ab';
const SESSION = '64f0c0ffee0000000000abcd';
const TICKET = '650000000000000000000001';
const TASK = '6a1b2c3d4e5f60718293a4b5';
let requests;
let card;
let actionResponse;
let wrapUpUrl;

beforeEach(() => {
  requests = [];
  card = { id: TASK, metadata: { card: { type: 'question', question: 'Refund or replace?', lines: [] } } };
  actionResponse = { ok: true, result: { status: 'answered' } };
  wrapUpUrl = 'https://app.gleap.io/projects/p/kai-code/s';
  axios.defaults.adapter = async (config) => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data || '{}') : config.data;
    requests.push({ method: config.method, url: config.url, body });
    const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    const { pathname } = new URL(config.url);
    if (pathname.endsWith(`/hard-tickets/tickets/${TICKET}`)) return ok({ card });
    if (pathname.endsWith('/a2ui/action')) return ok(actionResponse);
    if (pathname.endsWith('/agent-wrap-up')) return ok({ success: true, sessionId: SESSION, turnId: 't1', sessionUrl: wrapUpUrl });
    if (pathname.endsWith('/agent-artifacts')) return ok({ success: true, sessionId: SESSION, artifactId: 'a1', version: 1, url: wrapUpUrl });
    throw new Error(`unexpected request ${config.method} ${config.url}`);
  };
});

const call = async (name, args) => {
  const server = new McpServer({ name: 'gleap-mcp-test', version: '0.0.0' });
  applyShareTokenRedaction(server);
  applySessionScopePolicy(server);
  registerSessionTools(server);
  registerTicketCardTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return runWithCreds({ apiKey: 'test-only', projectId: PROJECT }, () => client.callTool({ name, arguments: args }));
};

const openUrlsIn = (s) => JSON.stringify(s).match(/"url":"[^"]*"/g) ?? [];

describe('session tool surfaces carry https links only', () => {
  test('wrap_up and publish_artifact link to Gleap over https, and drop any other link', async () => {
    let res = await call('wrap_up', { sessionId: SESSION, recap: 'Done.' });
    assert.equal(res.structuredContent.a2ui.v, '1.0');
    assert.deepEqual(openUrlsIn(res.structuredContent.a2ui), [`"url":"${wrapUpUrl}"`]);

    for (const bad of ['javascript:alert(1)', 'http://app.gleap.io/x']) {
      wrapUpUrl = bad;
      res = await call('wrap_up', { sessionId: SESSION, recap: 'Done.' });
      assert.ok(!JSON.stringify(res.structuredContent.a2ui).includes(bad), `wrap_up surface carries ${bad}`);
      res = await call('publish_artifact', { sessionId: SESSION, title: 'Report', html: '<p>x</p>' });
      assert.ok(!JSON.stringify(res.structuredContent.a2ui).includes(bad), `artifact surface carries ${bad}`);
    }
  });
});

describe('answer_ticket_card answers through the action endpoint', () => {
  test('a question card: task.answer on the card\'s own surface, the answer only in the context', async () => {
    const answer = '../../tickets/x?admin=1#frag Refund';
    const res = await call('answer_ticket_card', { ticketId: TICKET, answer });
    assert.equal(res.isError, undefined);
    const post = requests.find((r) => r.method === 'post');
    assert.equal(post.url, 'https://gleap-api.invalid/v3/a2ui/action');
    assert.equal(post.body.version, '1.0');
    assert.equal(post.body.action.name, 'task.answer');
    assert.equal(post.body.action.surfaceId, `task:${TASK}`);
    assert.equal(post.body.action.sourceComponentId, 'mcp');
    assert.ok(!Number.isNaN(Date.parse(post.body.action.timestamp)));
    assert.deepEqual(post.body.action.context, { answer: answer.trim() });
    assert.ok(!requests.some((r) => r.url.includes('hard-tickets/cards')), 'the old card routes are gone');
  });

  test('a proposed-reply card: task.send with the edited text', async () => {
    card = { id: TASK, metadata: { card: { type: 'proposed_reply', question: 'Send this?', proposal: { text: 'Hi' } } } };
    await call('answer_ticket_card', { ticketId: TICKET, send: true, text: ' Hi there ' });
    const post = requests.find((r) => r.method === 'post');
    assert.equal(post.url, 'https://gleap-api.invalid/v3/a2ui/action');
    assert.equal(post.body.action.name, 'task.send');
    assert.equal(post.body.action.surfaceId, `task:${TASK}`);
    assert.deepEqual(post.body.action.context, { text: 'Hi there' });
  });

  test('a card id that is not an id never becomes a surface id', async () => {
    card = { id: `${TASK}:x/../y`, metadata: { card: { type: 'question', question: 'Q', lines: [] } } };
    const res = await call('answer_ticket_card', { ticketId: TICKET, answer: 'Refund' });
    assert.equal(res.isError, true);
    assert.ok(!requests.some((r) => r.method === 'post'));
  });

  test('a refused action reads as an error', async () => {
    actionResponse = { ok: false, reason: 'already_answered' };
    const res = await call('answer_ticket_card', { ticketId: TICKET, answer: 'Refund' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /already_answered/);
  });
});
