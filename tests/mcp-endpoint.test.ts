// The MCP endpoint over HTTP, as a client reaches it: the real Express app of src/index.ts on a free port, with the
// Gleap API and Gleap's OAuth server (its JWKS and client registry) as stubs in this process.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, beforeEach, describe, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';

import { gleapApi, startApp } from './support/app.js';

const RESOURCE = 'https://mcp.gleap.test/mcp';
const RESOURCE_METADATA = 'https://mcp.gleap.test/.well-known/oauth-protected-resource/mcp';
const API_KEY = 'endpoint-test-key-77ab';
const CHATGPT_CLIENT = 'chatgpt-connector-client';
const KEY_ID = 'test-signing-key';

const signingKey = await generateKeyPair('RS256');
const strangerKey = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(signingKey.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };

// Gleap's OAuth server as far as this server asks it: the keys tokens are signed with, and who a client is.
const authServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/.well-known/jwks.json') return void res.end(JSON.stringify({ keys: [publicJwk] }));
  if (req.url === `/oauth/register/${CHATGPT_CLIENT}`) {
    return void res.end(JSON.stringify({ client_id: CHATGPT_CLIENT, redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'] }));
  }
  res.statusCode = 404;
  res.end('{}');
});
authServer.listen(0, '127.0.0.1');
await once(authServer, 'listening');
const authAddress = authServer.address();
if (!authAddress || typeof authAddress === 'string') throw new Error('the OAuth stub has no port');
const ISSUER = `http://127.0.0.1:${authAddress.port}`;

process.env.GLEAP_AUTH_ISSUER = ISSUER;
process.env.GLEAP_JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
process.env.MCP_SERVER_URL = RESOURCE;
process.env.MCP_JSON_BODY_LIMIT = '64kb';
const app = await startApp();

after(async () => {
  await app.close();
  authServer.close();
});
beforeEach(() => gleapApi.reset());

type TokenOptions = { claims?: Record<string, unknown>; key?: KeyLike; audience?: string; expiresAt?: number };
const tokenFor = ({ claims = {}, key = signingKey.privateKey, audience = RESOURCE, expiresAt }: TokenOptions = {}) =>
  new SignJWT({ project_id: 'oauth-project', api_key: API_KEY, scope: '', client_id: 'claude-client', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(expiresAt ?? '5m')
    .sign(key);

const apiKeyHeaders = (projectId = 'header-project') => ({ 'x-gleap-api-key': API_KEY, 'x-gleap-project-id': projectId });
const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(app.mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const connect = async (headers: Record<string, string>) => {
  const client = new Client({ name: 'endpoint-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.mcpUrl), { requestInit: { headers } }));
  return client;
};
const callText = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  return { result, text: result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n') };
};

describe('HTTP', () => {
  test('GET /health answers ok', async () => {
    const response = await fetch(`${app.origin}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });

  test('a request without credentials gets 401 and where to sign in', async () => {
    const response = await post(LIST_TOOLS);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${RESOURCE_METADATA}"`);
    assert.deepEqual(gleapApi.requests, []);
  });

  test('an API key without a project is no credential', async () => {
    const response = await post(LIST_TOOLS, { 'x-gleap-api-key': API_KEY });
    assert.equal(response.status, 401);
  });

  test('the protected resource metadata names this resource and Gleap as its authorization server', async () => {
    const metadata = await (await fetch(`${app.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(metadata.resource, RESOURCE);
    assert.deepEqual(metadata.authorization_servers, [ISSUER]);
  });

  test('the authorization server metadata points at Gleap with PKCE', async () => {
    const metadata = await (await fetch(`${app.origin}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.token_endpoint, `${ISSUER}/oauth/token`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  });

  for (const method of ['GET', 'DELETE']) {
    test(`${method} gets 405: a stateless server has no stream and no session`, async () => {
      const response = await fetch(app.mcpUrl, { method, headers: apiKeyHeaders() });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST');
    });
  }

  test('a malformed JSON body gets a JSON-RPC error', async () => {
    const response = await post('{"jsonrpc":', apiKeyHeaders());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32600);
  });

  test('a body over MCP_JSON_BODY_LIMIT gets 413 with the limit', async () => {
    const response = await post({ ...LIST_TOOLS, params: { padding: 'x'.repeat(70_000) } }, apiKeyHeaders());
    assert.equal(response.status, 413);
    assert.match((await response.json()).error.message, /64kb/);
  });
});

describe('API key headers', () => {
  test('a client initializes, lists and calls tools against its project', async () => {
    const client = await connect(apiKeyHeaders());
    assert.equal(client.getServerVersion()?.name, 'gleap-mcp');
    assert.match(client.getInstructions() ?? '', /report_progress/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'get_teams'));

    gleapApi.answerWith(() => ({ status: 200, data: [{ _id: 'team-1', name: 'Support' }] }));
    const { result, text } = await callText(client, 'get_teams');
    assert.notEqual(result.isError, true);
    assert.match(text, /Support/);
    assert.equal(gleapApi.requests.length, 1);
    assert.equal(gleapApi.requests[0].url, `${process.env.GLEAP_API_BASE}/teams`);
    assert.equal(gleapApi.requests[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(gleapApi.requests[0].headers.project, 'header-project');
    await client.close();
  });

  test('concurrent clients each get their own project, never another one', async () => {
    gleapApi.answerWith((request) => ({ status: 200, data: [{ _id: request.headers.project, name: `team of ${request.headers.project}` }] }));
    const projects = Array.from({ length: 12 }, (_, i) => `project-${i}`);
    const answers = await Promise.all(
      projects.map(async (project) => {
        const client = await connect(apiKeyHeaders(project));
        const { text } = await callText(client, 'get_teams');
        await client.close();
        return { project, text };
      })
    );
    for (const { project, text } of answers) {
      assert.match(text, new RegExp(`team of ${project}\\b`));
      assert.equal(text.match(/team of project-\d+/g)?.length, 1);
    }
  });
});

describe('OAuth bearer tokens', () => {
  test('a valid token reaches Gleap with the API key it carries, never with the token', async () => {
    const token = await tokenFor();
    const client = await connect({ authorization: `Bearer ${token}` });
    await callText(client, 'get_teams');
    await client.close();
    assert.equal(gleapApi.requests.length, 1);
    assert.equal(gleapApi.requests[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(gleapApi.requests[0].headers.project, 'oauth-project');
    assert.ok(!JSON.stringify(gleapApi.requests).includes(token));
  });

  const refused: Array<[string, () => Promise<string>]> = [
    ['a token for another resource', () => tokenFor({ audience: 'https://elsewhere.test/mcp' })],
    ['an expired token', () => tokenFor({ expiresAt: Math.floor(Date.now() / 1000) - 120 })],
    ['a token signed with another key', () => tokenFor({ key: strangerKey.privateKey })],
    ['a token without the project claims', () => tokenFor({ claims: { project_id: undefined, api_key: undefined } })],
    ['a token that is no JWT', async () => 'not-a-jwt'],
  ];
  for (const [name, token] of refused) {
    test(`refuses ${name} with 401 invalid_token, before calling Gleap`, async () => {
      const response = await post(LIST_TOOLS, { authorization: `Bearer ${await token()}` });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
      assert.deepEqual(gleapApi.requests, []);
    });
  }

  test('ChatGPT lists at most 128 tools and still calls the others by name', async () => {
    const everyone = await connect(apiKeyHeaders());
    const all = (await everyone.listTools()).tools.map((tool) => tool.name);
    await everyone.close();

    const chatGpt = await connect({ authorization: `Bearer ${await tokenFor({ claims: { client_id: CHATGPT_CLIENT } })}` });
    const listed = new Set((await chatGpt.listTools()).tools.map((tool) => tool.name));
    assert.ok(listed.size <= 128, `ChatGPT lists ${listed.size} tools; OpenAI refuses more than 128`);
    const hidden = all.find((name) => !listed.has(name));
    assert.ok(hidden, 'ChatGPT leaves tools out');
    const { text } = await callText(chatGpt, hidden);
    assert.doesNotMatch(text, /not found|unknown tool/i);
    await chatGpt.close();
  });
});
