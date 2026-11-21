// Customer-scoped runs (Kai Resolve) and feature requests. create_feature_request
// and subscribe_to_feature_request may only link the scoped customer's own
// tickets and record the scoped contact's email. get_feature_request
// reads roadmap data by id, so it runs without the ticket-ownership check that
// guards every other ticket-id tool; it must still never return anything but a
// feature-request summary. The ownership check itself retries transient API
// errors and refuses honestly when it cannot tell whose ticket it is.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { registerFeatureRequestTools } = await import('../src/tools/featurerequest.tool.js');
const { registerTicketTools } = await import('../src/tools/ticket.tool.js');
const { runWithCreds } = await import('../src/utils/credentials.js');
const { applySessionScopePolicy } = await import('../src/utils/sessionScope.js');

const API = 'https://gleap-api.invalid/v3';
const FR_ID = '0123456789abcdef01234567';
const SCOPED = { sessionScope: 'customer-session' };
const summary = {
  id: FR_ID,
  type: 'FEATURE_REQUEST',
  bugId: 42,
  title: 'Dark mode for the dashboard',
  descriptionExcerpt: 'Agents working at night want a dark dashboard.',
  status: 'Planned',
  statusKey: 'PLANNED',
  public: true,
  archived: false,
  upvotesCount: 3,
  dueDate: null,
  shareUrl: `https://feedback.acme.test/en/feature-requests?id=${FR_ID}`,
};

const tools = new Map();
const registry = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
applySessionScopePolicy(registry);
registerTicketTools(registry);
registerFeatureRequestTools(registry);

let requests;
let respond;
beforeEach(() => {
  requests = [];
  respond = (config) => {
    throw new Error(`unexpected request ${config.url}`);
  };
  axios.defaults.adapter = async (config) => {
    requests.push({
      method: config.method,
      url: config.url,
      body: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : undefined,
    });
    const data = await respond(config);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});

// `retry-after: 0` keeps the retry backoff out of the test's run time.
const httpError = (config, status, data = { message: `status ${status}` }) =>
  new AxiosError(`Request failed with status code ${status}`, status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, null, {
    status,
    statusText: '',
    data,
    headers: { 'retry-after': '0' },
    config,
  });

const call = (name, args, creds = {}) =>
  runWithCreds({ apiKey: 'test-only', projectId: 'test-project', ...creds }, async () => {
    const { config, handler } = tools.get(name);
    return handler(z.object(config.inputSchema).parse(args));
  });

const urls = () => requests.map((request) => request.url);

describe('feature-requests', () => {
  describe('get_feature_request in a customer-scoped run', () => {
    test('a feature request of the project -> read without an ownership lookup', async () => {
      respond = () => summary;
      const result = await call('get_feature_request', { ticketId: FR_ID }, SCOPED);

      assert.deepEqual(urls(), [`${API}/tickets/${FR_ID}/feature-request`]);
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.id, FR_ID);
      assert.equal(result.structuredContent.title, 'Dark mode for the dashboard');
      assert.equal(result.structuredContent.shareUrl, summary.shareUrl);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    });

    test('a ticket number -> sent encoded, not cut off at the #', async () => {
      respond = () => summary;
      await call('get_feature_request', { ticketId: '#42' }, SCOPED);
      assert.deepEqual(urls(), [`${API}/tickets/%2342/feature-request`]);
    });

    test('a response that is not a feature-request summary -> refused without its content', async () => {
      respond = () => ({ _id: 'T9', type: 'INQUIRY', title: 'Refund for order 1234', session: 'other-session' });
      const result = await call('get_feature_request', { ticketId: 'T9' }, SCOPED);

      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /Refund for order|other-session/);
    });

    test('a request not yet on the public roadmap -> no status and no link', async () => {
      respond = () => ({ ...summary, status: 'Ideas', public: false, shareUrl: 'https://feedback.acme.test/leak' });
      const result = await call('get_feature_request', { ticketId: FR_ID }, SCOPED);

      assert.equal(result.structuredContent.public, false);
      assert.equal(result.structuredContent.status, null);
      assert.equal(result.structuredContent.shareUrl, null);
      assert.doesNotMatch(result.content[0].text, /leak/);
    });

    test('no such feature request -> an error result', async () => {
      respond = (config) => {
        throw httpError(config, 404, { error: { statusCode: 404, message: 'No feature request with id "T9" exists in this project.' } });
      };
      const result = await call('get_feature_request', { ticketId: 'T9' }, SCOPED);

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /\(404\): No feature request with id "T9"/);
    });
  });

  describe('ticket-id tools keep the per-ticket boundary in a customer-scoped run', () => {
    test("another customer's ticket -> refused before the tool runs", async () => {
      respond = () => ({ session: 'other-session' });
      const result = await call('get_ticket_activity_log', { ticketId: FR_ID }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.match(result.content[0].text, /different customer/);
      assert.deepEqual(urls(), [`${API}/tickets/${FR_ID}`]);
    });

    test('a tool without a ticket id -> refused as an error result', async () => {
      respond = () => [];
      const result = await call('search_tickets', { searchTerm: 'refund' }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.equal(requests.length, 0);
    });

    test('the ownership lookup fails transiently, then answers -> retried and the tool runs', async () => {
      let lookups = 0;
      respond = (config) => {
        if (config.url.endsWith('/activity-logs')) return [];
        lookups += 1;
        if (lookups === 1) throw httpError(config, 503);
        return { session: 'customer-session' };
      };
      const result = await call('get_ticket_activity_log', { ticketId: 'T1' }, SCOPED);

      assert.equal(result.isError, undefined);
      assert.deepEqual(urls(), [`${API}/tickets/T1`, `${API}/tickets/T1`, `${API}/tickets/T1/activity-logs`]);
    });

    test('the ownership lookup keeps failing -> refused as unverified, not as another customer', async () => {
      respond = (config) => {
        throw httpError(config, 503);
      };
      const result = await call('get_ticket_activity_log', { ticketId: 'T1' }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.equal(result.structuredContent.transient, true);
      assert.match(result.content[0].text, /could not verify/);
      assert.deepEqual(urls(), [`${API}/tickets/T1`, `${API}/tickets/T1`, `${API}/tickets/T1`]);
    });

    test('the ticket does not exist -> refused as a boundary, without retries', async () => {
      respond = (config) => {
        throw httpError(config, 404);
      };
      const result = await call('get_ticket_activity_log', { ticketId: 'T1' }, SCOPED);

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /different customer/);
      assert.deepEqual(urls(), [`${API}/tickets/T1`]);
    });
  });
  describe('roadmap writes in a customer-scoped run record only the scoped customer', () => {
    const OWN_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const OWN_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const OTHER = 'cccccccccccccccccccccccc';
    const contact = { _id: 'customer-session', email: 'Customer@Acme.test', name: 'Casey Customer' };
    const created = { id: FR_ID, title: 'Dark mode', status: 'OPEN', shareUrl: null };
    const createArgs = {
      title: 'Dark mode',
      description: 'Agents want a dark dashboard.',
      customerEmail: 'customer@acme.test',
      customerName: 'Casey',
      linkedTicketIds: [OWN_A],
    };

    // Tickets OWN_A/OWN_B belong to the scoped session, OTHER to another one.
    const scopedApi = ({ session = contact, onPost = () => created } = {}) => (config) => {
      if (config.method === 'post') return onPost(config);
      if (config.url === `${API}/sessions/customer-session`) return session;
      if (config.url === `${API}/tickets/${OTHER}`) return { session: 'other-session' };
      if (config.url.startsWith(`${API}/tickets/`)) return { session: 'customer-session' };
      throw new Error(`unexpected request ${config.url}`);
    };
    const posts = () => requests.filter((request) => request.method === 'post');

    test("create: another customer's ticket in linkedTicketIds -> refused, nothing filed", async () => {
      respond = scopedApi();
      const result = await call('create_feature_request', { ...createArgs, linkedTicketIds: [OWN_A, OTHER] }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.match(result.content[0].text, /different customer/);
      assert.equal(posts().length, 0);
    });

    test('create: an id that does not resolve -> refused, nothing filed', async () => {
      respond = (config) => {
        if (config.url === `${API}/tickets/T404`) throw httpError(config, 404);
        return scopedApi()(config);
      };
      const result = await call('create_feature_request', { ...createArgs, linkedTicketIds: ['T404'] }, SCOPED);

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /different customer/);
      assert.equal(posts().length, 0);
    });

    test('create: the ownership lookup keeps failing -> refused as unverified', async () => {
      respond = (config) => {
        if (config.url === `${API}/tickets/${OWN_A}`) throw httpError(config, 503);
        return scopedApi()(config);
      };
      const result = await call('create_feature_request', createArgs, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.transient, true);
      assert.equal(posts().length, 0);
    });

    test('create: own tickets and a foreign email -> filed with the scoped contact, not the given email', async () => {
      respond = scopedApi();
      const result = await call(
        'create_feature_request',
        { ...createArgs, customerEmail: 'victim@elsewhere.test', customerName: 'Victim', linkedTicketIds: [OWN_A, OWN_B, OWN_A] },
        SCOPED,
      );

      assert.equal(result.isError, undefined);
      assert.deepEqual(urls().slice(0, 3), [`${API}/tickets/${OWN_A}`, `${API}/tickets/${OWN_B}`, `${API}/sessions/customer-session`]);
      const [post] = posts();
      assert.equal(post.url, `${API}/tickets/tracker-tickets`);
      assert.equal(post.body.customerEmail, 'Customer@Acme.test');
      assert.equal(post.body.customerName, 'Casey Customer');
      assert.deepEqual(post.body.linkedTicketIds, [OWN_A, OWN_B]);
      assert.equal(post.body.createdByAgent.sourceTicketId, OWN_A);
      assert.doesNotMatch(JSON.stringify(post.body), /victim|Victim/);
    });

    test("create: the contact's own email (other casing), no name on file -> the given name is kept", async () => {
      respond = scopedApi({ session: { ...contact, name: '' } });
      await call('create_feature_request', createArgs, SCOPED);

      const [post] = posts();
      assert.equal(post.body.customerEmail, 'Customer@Acme.test');
      assert.equal(post.body.customerName, 'Casey');
    });

    test('create: an anonymous contact (no email) -> filed without any email', async () => {
      respond = scopedApi({ session: { _id: 'customer-session' } });
      const result = await call('create_feature_request', { ...createArgs, customerEmail: 'victim@elsewhere.test' }, SCOPED);

      assert.equal(result.isError, undefined);
      const [post] = posts();
      assert.equal(post.body.customerEmail, undefined);
      assert.equal(post.body.customerName, undefined);
      assert.deepEqual(post.body.linkedTicketIds, [OWN_A]);
    });

    test('create: the scoped contact cannot be found -> refused, nothing filed', async () => {
      respond = (config) => {
        if (config.url === `${API}/sessions/customer-session`) throw httpError(config, 404);
        return scopedApi()(config);
      };
      const result = await call('create_feature_request', createArgs, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.equal(posts().length, 0);
    });

    test('create: the lookup answers with a different session -> refused, nothing filed', async () => {
      respond = scopedApi({ session: { ...contact, _id: 'other-session' } });
      const result = await call('create_feature_request', createArgs, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(posts().length, 0);
    });

    test('subscribe: a foreign email -> the scoped contact is subscribed instead', async () => {
      respond = scopedApi({ onPost: () => ({ id: FR_ID, upvotesCount: 4 }) });
      const result = await call(
        'subscribe_to_feature_request',
        { ticketId: FR_ID, customerEmail: 'victim@elsewhere.test', customerName: 'Victim' },
        SCOPED,
      );

      assert.equal(result.isError, undefined);
      const [post] = posts();
      assert.equal(post.url, `${API}/tickets/${FR_ID}/vote`);
      assert.deepEqual(post.body, { email: 'Customer@Acme.test', name: 'Casey Customer', action: 'subscribe' });
    });

    test('subscribe: a contact without an email -> refused, nobody subscribed', async () => {
      respond = scopedApi({ session: { _id: 'customer-session', name: 'Anon' } });
      const result = await call('subscribe_to_feature_request', { ticketId: FR_ID, customerEmail: 'victim@elsewhere.test' }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.sessionScope, true);
      assert.match(result.content[0].text, /no email address/);
      assert.equal(posts().length, 0);
    });

    test('subscribe: the contact lookup keeps failing -> refused as unverified', async () => {
      respond = (config) => {
        if (config.url === `${API}/sessions/customer-session`) throw httpError(config, 503);
        return scopedApi()(config);
      };
      const result = await call('subscribe_to_feature_request', { ticketId: FR_ID, customerEmail: 'customer@acme.test' }, SCOPED);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.transient, true);
      assert.equal(posts().length, 0);
    });
  });

  describe('roadmap writes in a team (unscoped) run keep their arguments', () => {
    test('create: email, name and linked tickets pass through without lookups', async () => {
      respond = () => ({ id: FR_ID, title: 'Dark mode', status: 'OPEN', shareUrl: null });
      await call('create_feature_request', {
        title: 'Dark mode',
        description: 'Agents want a dark dashboard.',
        customerEmail: 'someone@acme.test',
        customerName: 'Someone',
        linkedTicketIds: ['cccccccccccccccccccccccc'],
      });

      assert.deepEqual(urls(), [`${API}/tickets/tracker-tickets`]);
      assert.equal(requests[0].body.customerEmail, 'someone@acme.test');
      assert.equal(requests[0].body.customerName, 'Someone');
      assert.deepEqual(requests[0].body.linkedTicketIds, ['cccccccccccccccccccccccc']);
    });

    test('subscribe: any email passes through without lookups', async () => {
      respond = () => ({ id: FR_ID, upvotesCount: 2 });
      await call('subscribe_to_feature_request', { ticketId: FR_ID, customerEmail: 'someone@acme.test' });

      assert.deepEqual(urls(), [`${API}/tickets/${FR_ID}/vote`]);
      assert.equal(requests[0].body.email, 'someone@acme.test');
    });
  });
});
