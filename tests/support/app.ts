// The real server of src/index.ts in this test process, on a free port, with the Gleap API replaced by a stub.
// A test file imports this once: index.ts reads its configuration and starts listening when it is imported.
import { once } from 'node:events';
import { tracingChannel } from 'node:diagnostics_channel';
import type { Server } from 'node:http';

import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type ApiRequest = { method: string; url: string; headers: Record<string, string>; params: unknown; body: unknown };
export type ApiReply = { status: number; data: unknown };

const OK: ApiReply = { status: 200, data: {} };

const requests: ApiRequest[] = [];
let answer: (request: ApiRequest) => ApiReply = () => OK;

const headersOf = (config: InternalAxiosRequestConfig): Record<string, string> =>
  Object.fromEntries(Object.entries(config.headers.toJSON()).map(([name, value]) => [name.toLowerCase(), String(value)]));

const bodyOf = (data: unknown): unknown => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

// Every axios call in src goes through axios's default adapter, so this is the Gleap API for the whole process.
axios.defaults.adapter = async (config) => {
  const request: ApiRequest = {
    method: String(config.method ?? 'get').toUpperCase(),
    url: String(config.url),
    headers: headersOf(config),
    params: config.params,
    body: bodyOf(config.data),
  };
  requests.push(request);
  const reply = answer(request);
  const response: AxiosResponse = { data: reply.data, status: reply.status, statusText: String(reply.status), headers: {}, config };
  if (reply.status < 400) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
};

/** What the server sent to the Gleap API, and what the stub answers. Reset before each test. */
export const gleapApi = {
  requests,
  answerWith: (reply: (request: ApiRequest) => ApiReply) => {
    answer = reply;
  },
  reset: () => {
    requests.length = 0;
    answer = () => OK;
  },
};

// Tests talk to 127.0.0.1 only. Anything else (the JWKS, OAuth client lookups) must be pointed at a local stub.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error(`A test tried to reach ${url.origin}: point it at a local stub.`));
  return realFetch(input, init);
};

// The server logs a line per request; in a run of a thousand calls they would bury the test output. Errors still show.
for (const level of ['log', 'warn'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] !== 'string' || !args[0].startsWith('[gleap-mcp]')) write(...args);
  };
}

/** Imports src/index.ts, which listens on PORT, and returns the address it listens on. */
export const startApp = async (): Promise<{ origin: string; mcpUrl: string; close: () => Promise<void> }> => {
  process.env.PORT = '0';
  let server: Server | undefined;
  const listen = tracingChannel<unknown, { server: Server }>('net.server.listen');
  const ignore = () => {};
  const handlers = {
    start: ignore,
    end: ignore,
    asyncStart: (message: { server: Server }) => {
      server ??= message.server;
    },
    asyncEnd: ignore,
    error: ignore,
  };
  listen.subscribe(handlers);
  try {
    await import('../../src/index.js');
  } finally {
    listen.unsubscribe(handlers);
  }
  if (!server) throw new Error('src/index.ts did not start listening');
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`src/index.ts listens on ${address}, not on a port`);
  const origin = `http://127.0.0.1:${address.port}`;
  const started = server;
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    close: async () => {
      started.closeAllConnections();
      await new Promise<void>((resolve) => started.close(() => resolve()));
    },
  };
};
