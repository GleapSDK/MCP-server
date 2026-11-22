# Gleap MCP server

Gleap's remote MCP server. Claude, ChatGPT, Cursor, Kai Code and Gleap's own agents work on a Gleap project through its tools. Each tool calls the Gleap REST API (`/v3`, served by the Server repo: `../Server`, from a worktree `../../Server`) with the caller's credentials; this server stores nothing. One process per region with the same code: EU `https://mcp.gleap.ai/mcp`, US `https://mcp.us.gleap.ai/mcp`.

Node 22 (`engines` in `package.json`), TypeScript ESM (`module: Node16`, compiled by `tsc` to `build/`), Express 5, `@modelcontextprotocol/sdk` 1.x, zod 4, npm.

Layout: `src/index.ts` wires HTTP, auth and `buildServer`, which builds a fresh `McpServer` for every request. `src/tools/<area>.tool.ts` register the tools, `src/schemas/<area>.schema.ts` hold their inputs, `src/utils/` the API client (`api.ts`), credentials and the wrappers every tool runs through, `src/auth/` the OAuth resource server, `src/prompts/` and `src/ui/` the prompts and the MCP Apps view. Tests in `tests/` and next to the code.

## Commands

```bash
npm ci                           # install; also links the pre-push hook
npm run typecheck                # tsc over src and tests, nothing emitted, a few seconds
npm test                         # every test, on the TypeScript sources (no build), about ten seconds
npm test -- tests/<name>.test.ts # one file; --test-name-pattern="text" for one case
npm run test:coverage            # every test with coverage of src/ and its floors (CI)
npm run build                    # tsc to build/: what production runs
npm run quality                  # the quality check on what this branch adds to origin/main
npm run test:quality             # the quality check's own tests, about a minute
```

Done means `npm run typecheck` and `npm test` pass, the quality check reports nothing new (the edit and stop hooks run it), and CI is green: `.github/workflows/ci.yml` runs typecheck, tests with coverage, the build and the quality check's tests; `.github/workflows/quality.yml` runs the quality check. Say which commands you ran and what they printed.

New worktree: `npm ci`; nothing else is needed. Tests never reach Gleap: the API is a stub and every Gleap URL points at a host that does not resolve.

Do not start the server (`npm start`, `node build/index.js`) unless asked: it loads the committed `.env`, which names the production Gleap API, and with a real key every write is real.

`git push` runs the quality check on your branch (`.githooks/pre-push`). Fix what it reports and push again; never `--no-verify`.

## Code

New files and the code you change follow `.claude/rules/code-conventions.md`, and tests follow `.claude/rules/testing.md`. Read both before your first edit: old code here is no precedent. `/review` reviews a branch against them.

## Security

Every tool is reachable by any MCP client with a key, and every result goes into a model's context.

- **Credentials:** OAuth bearer tokens (JWTs from Gleap, verified in `src/auth/jwtVerifier.ts`: issuer, audience = `MCP_SERVER_URLS`, `RS256`) or the API-key headers. Both end in `readCreds` (`src/utils/credentials.ts`). A tool reads credentials and the project only through `getCredsOrThrow()`, never from its arguments. The Gleap API gets the token's `api_key` claim, never the token itself.
- **Customer-session scope:** `x-gleap-scope-session` narrows a request to one customer, and `src/utils/sessionScope.ts` is default-deny: a tool is refused under a scope unless it takes a `ticketId` the customer owns or is on `ALLOWED_UNDER_SCOPE`. Adding to that list is a security decision: stop and ask.
- **Secrets in results:** `applyShareTokenRedaction` strips ticket share tokens and widget credentials from every result, and reduces a teammate's populated user record to id, name, email and picture (`src/utils/userRecordRedaction.ts`); SDK telemetry goes through `src/utils/telemetryRedaction.ts`. A new field that carries a token, hash or key is redacted there, with a test.
- **Untrusted content:** ticket, message and contact text is written by customers. Return it in its own fields, never inside or next to server-written instructions, and never build a tool description, title or the server instructions from API data.
- **Outbound requests** go to `GLEAP_API_BASE` (through `src/utils/api.ts`) or `GLEAP_AUTH_ISSUER` only. A tool that fetches a URL from its arguments checks the host first, as `get_ticket_screenshot` does.
- **Logs:** one line per request with the `[gleap-mcp]` prefix (method, tool names, auth kind, status). Never tool arguments, results, keys, tokens or customer text.
- No secrets in code, logs, error messages or results.

## Traps

- `buildServer` wraps `server.registerTool` in a fixed order (the `MUST` comments in `src/index.ts`): redaction first, then the agent-session signals, project selection, the session-scope policy, then the tools. A tool registered before a wrapper bypasses it.
- Stateless: a fresh `McpServer` and transport per POST, never shared (the comment above `buildServer`). GET and DELETE answer 405.
- ChatGPT lists at most 128 tools, or the connector loads with none. Kai operator and coding-agent tools go inside the `toolNamesRegisteredBy` block in `buildServer`; `tests/mcp-endpoint.test.ts` checks the limit.
- Tool names are a public API: clients, saved workflows and the ChatGPT directory app call them by name. A retired tool keeps its name and answers with `removedToolResponse` (`src/utils/removedTool.ts`) for one release.
- `src/utils/api.ts` retries GETs on 5xx, 429 and network errors, and a POST only when it never reached the API. Pass `idempotent: true` only for a write that cannot double.
- `src/index.ts` starts listening when it is imported, and `src/config/index.ts` throws without `GLEAP_API_BASE`. Tests start the app only through `tests/support/app.ts`.
- `dotenv` never overrides a variable that is already set; `scripts/test/run.mjs` relies on that to keep tests off the production API named in `.env`.
- `MCP_JSON_BODY_LIMIT` is 10 MB because multi-locale help center article updates are large; body-parser's default of 100 KB answered them with 413.

## Customer requests

A ticket is one customer's view, a bug report too. Before changing anything for it:

- **A feature or a change:** decide whether it is right for the product. Would most customers want it, or does it belong behind a setting every customer can use?
- **A bug report:** first check whether the code does something other than intended, from its tests, comments, docs and history. If it works as designed and the customer expected something else, it is not a bug: change nothing, and say so in your report, with what the customer can do instead. Changing intended behaviour is a product decision: stop and ask.
- **Never special-case one customer in code:** no project ids, organisation ids, customer names or domains in conditions. If the only fix that works is specific to one customer, stop and ask.

## Stop and ask

Keep going while a step needs no input. Stop and ask before:

- deploying, merging, or adding a dependency;
- changing auth (`src/auth/`, `readCreds`, the OAuth metadata or the 401 challenge), CORS, the session-scope lists, the redaction, or `engines`;
- renaming or removing a tool or one of its arguments;
- running anything against a real Gleap project.

## Production

How `main` reaches production is configured outside this repository; there is no deploy workflow here. Treat a merge to `main` as a release to both regions. `engines` in `package.json` holds the minimum Node version (22.23.4, a security release). Configuration is in `README.md` under "Configuration".
