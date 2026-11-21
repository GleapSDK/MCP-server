import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import axios from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerSettingsTools } = await import('../build/tools/settings.tool.js');
const { GetSettingsArgs } = await import('../build/schemas/settings.schema.js');
const { runWithCreds } = await import('../build/utils/credentials.js');
const { applySessionScopePolicy } = await import('../build/utils/sessionScope.js');

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerSettingsTools(registry);

let requests;
beforeEach(() => {
  requests = [];
  axios.defaults.adapter = async config => {
    requests.push({ method: config.method, url: config.url, params: config.params ?? {} });
    return { data: { settings: [] }, status: 200, statusText: 'OK', headers: {}, config };
  };
});
const call = (name, args) => runWithCreds({ apiKey: 'test-only', projectId: 'test-project' }, async () => {
  const { config, handler } = tools.get(name);
  return handler(z.object(config.inputSchema).parse(args));
});

test('get_settings reads static translations in one language, by text keys and by words', async () => {
  const result = await call('get_settings', { page: 'static-translations', locale: 'de', texts: ['newConversation', 'sendMessage'], search: 'new conversation' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['get', 'https://gleap-api.invalid/v3/settings']]);
  assert.deepEqual(requests[0].params, { page: 'static-translations', locale: 'de', texts: 'newConversation,sendMessage', search: 'new conversation' });
});

test('locale, texts or search alone read the Static translations page', async () => {
  await call('get_settings', { search: 'we are back' });
  await call('get_settings', { locale: 'fr' });
  assert.deepEqual(requests.map(r => r.params), [{ page: 'static-translations', search: 'we are back' }, { page: 'static-translations', locale: 'fr' }]);
});

test('a page or keys alone are sent as before, without the texts parameters', async () => {
  await call('get_settings', { page: 'operating-hours' });
  await call('get_settings', { keys: ['flowConfig.color', 'flowConfig.timezone'] });
  assert.deepEqual(requests.map(r => r.params), [{ page: 'operating-hours' }, { keys: 'flowConfig.color,flowConfig.timezone' }]);
});

test('nothing to read: refused without a request', async () => {
  const result = await call('get_settings', {});
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test('the texts parameters are bounded', () => {
  assert.equal(GetSettingsArgs.safeParse({ texts: Array.from({ length: 51 }, (_, index) => `key${index}`) }).success, false);
  assert.equal(GetSettingsArgs.safeParse({ search: 'x'.repeat(101) }).success, false);
  assert.equal(GetSettingsArgs.safeParse({ locale: 'x'.repeat(36) }).success, false);
  assert.equal(GetSettingsArgs.safeParse({ texts: ['k'.repeat(81)] }).success, false);
  assert.equal(GetSettingsArgs.safeParse({ page: 'static-translations', locale: 'zh-Hant', texts: ['newConversation'], search: 'new' }).success, true);
});

test('the descriptions show how to read and change one text in one language', () => {
  const pages = tools.get('list_setting_pages').config.description;
  const read = tools.get('get_settings').config.description;
  const write = tools.get('update_settings').config.description;
  for (const description of [pages, write]) {
    assert.match(description, /\{key:'flowConfig\.staticTranslations', value:\[\{key:'newConversation', locale:'de', text:'[^']+'\}\]\}/);
    assert.match(description, /text null/);
  }
  assert.match(read, /locale/);
  assert.match(read, /texts/);
  assert.match(read, /search/);
  assert.doesNotMatch(pages, /static-translations \(flowConfig\.staticTranslations\);/);
});
