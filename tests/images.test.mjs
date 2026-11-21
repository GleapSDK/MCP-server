import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerImageTools } = await import('../src/tools/image.tool.js');
const { registerMarketingDraftTools } = await import('../src/tools/marketing-drafts.tool.js');
const { registerHelpCenterTools } = await import('../src/tools/helpcenter.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerImageTools(registry);
registerMarketingDraftTools(registry);
registerHelpCenterTools(registry);

const PROJECT = '613b5dd730aed737108f87ab';
const id = '0123456789abcdef01234567';
const CDN = `https://staticfiles.gleap.io/p${PROJECT}/abc.png`;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const doc = (...content) => ({ type: 'doc', content });
const para = { type: 'paragraph', content: [{ type: 'text', text: 'Shipped.' }] };
const draft = { name: 'Sonnet 5.5', subject: { en: 'Claude Sonnet 5.5' }, message: { en: doc(para) } };

let requests;
let fromUrlResponse;
beforeEach(() => {
  requests = [];
  fromUrlResponse = { success: true, fileUrl: CDN };
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method, url: config.url, body, headers: config.headers });
    let data;
    if (config.url.endsWith('/uploads/from-url')) data = fromUrlResponse;
    else if (config.url.endsWith('/uploads/links')) data = { uploadUrl: 'https://api.gleap.io/v3/uploads/links/tok', expiresAt: '2026-09-28T12:15:00Z' };
    else if (config.url.endsWith('/uploads')) data = { success: true, fileUrl: CDN };
    else data = config.method === 'get' ? { _id: id, type: 'NEWS', status: 'draft' } : { _id: id, type: 'NEWS', status: 'draft', ...body };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args, creds = {}) => runWithCreds({ apiKey: 'test-only', projectId: PROJECT, ...creds }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).strict().parse(args));
});

test('base64 upload goes to the caller\'s project and returns the CDN url', async () => {
  const result = await call('upload_image', { data: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.fileUrl, CDN);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://gleap-api.invalid/v3/uploads');
  assert.equal(requests[0].headers.project ?? requests[0].headers.get?.('project'), PROJECT);
});

test('an upload cannot name another project or storage path', async () => {
  for (const extra of [{ projectId: '5f0c0a0a0a0a0a0a0a0a0a0a' }, { project: 'x' }, { path: 'organisations/x/assets' }]) {
    await assert.rejects(call('upload_image', { data: png.toString('base64'), ...extra }));
  }
  assert.equal(requests.length, 0);
});

test('non-image bytes are refused before any upload', async () => {
  for (const data of [svg.toString('base64'), Buffer.from('<html></html>').toString('base64'), 'not base64 !!!']) {
    assert.equal((await call('upload_image', { data })).isError, true);
  }
  assert.equal(requests.length, 0);
});

test('url import is fetched by the Gleap API (SSRF guard), never by the MCP server', async () => {
  const result = await call('upload_image', { url: 'http://169.254.169.254/latest/meta-data' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => r.url), ['https://gleap-api.invalid/v3/uploads/from-url']);
});

test('url import that turns out to be SVG is reported, not returned as usable', async () => {
  fromUrlResponse = { success: true, fileUrl: `https://staticfiles.gleap.io/p${PROJECT}/x.svg` };
  assert.equal((await call('upload_image', { url: 'https://example.com/logo.svg' })).isError, true);
});

test('customer-scoped runs cannot upload or mint upload links', async () => {
  for (const [name, args] of [['upload_image', { data: png.toString('base64') }], ['create_image_upload_link', {}]]) {
    const result = await call(name, args, { sessionScope: 'customer-session' });
    assert.equal(result.structuredContent.sessionScope, true);
  }
  assert.equal(requests.length, 0);
});

test('news draft with an external cover imports it, then saves a draft only', async () => {
  const result = await call('create_news_draft', { ...draft, coverImageUrl: 'https://example.com/cover.png' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => r.url.replace('https://gleap-api.invalid/v3', '')), ['/uploads/from-url', '/engagement/news']);
  assert.equal(requests[1].body.status, 'draft');
  assert.equal(requests[1].body.coverImageUrl, CDN);
  assert.deepEqual(requests[1].body.config, { push: false, sendEmailToSubscribers: false });
});

test('news draft update sets a Gleap-hosted cover without an import and never publishes', async () => {
  const result = await call('update_news_draft', { draftId: id, coverImageUrl: CDN });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => r.method), ['get', 'put']);
  assert.deepEqual(requests[1].body, { status: 'draft', coverImageUrl: CDN });
});

test('image nodes with data: URIs or inside paragraphs are refused without writing', async () => {
  const bad = [
    doc({ type: 'imageBlock', attrs: { src: `data:image/png;base64,${png.toString('base64')}` } }),
    doc({ type: 'paragraph', content: [{ type: 'imageBlock', attrs: { src: CDN } }] }),
    doc({ type: 'imageBlock', attrs: { src: 'javascript:alert(1)' } }),
  ];
  for (const message of bad) {
    assert.equal((await call('create_news_draft', { ...draft, message: { en: message } })).isError, true);
    assert.equal((await call('create_help_center_article', { helpcenterCollectionId: id, title: { en: 't' }, description: { en: 'd' }, content: { en: message } })).isError, true);
  }
  assert.equal(requests.length, 0);
});
