---
paths:
  - "src/**/*.ts"
  - "tests/**"
---

# Testing

Tests come first and stay fixed while the code is written: an agent that may change a test will change it to get green.

- **New behaviour or a bug fix:** write the test first, from the requirement and not from the code. Use the `test-writer` subagent if you can start one. See it fail for the expected reason and commit it on its own, then write the code without touching it.
- **Refactor without a behaviour change:** tests stay unchanged. A move may change a test's import path, never its assertions. Nothing covers the code? Pin today's behaviour with a test first.
- **Never edit, skip or delete an existing test to make a change pass,** and never detect test inputs or hardcode answers. No `.skip`, `.only`, `todo`, retries or sleeps. If a test looks wrong, stop and report `BLOCKED` with the reason. A test changes only when the required behaviour changed; say so in the PR.
- **Never lower a coverage floor** in `scripts/test/run.mjs` to get a change through; raise it when coverage rises.

## How

`node:test` + `node:assert/strict`, in TypeScript, run by `npm test` on the sources through tsx: no build. Nothing reaches the network: the Gleap API is a stub (`axios.defaults.adapter`), `fetch` reaches only `127.0.0.1`, and `scripts/test/run.mjs` points every Gleap URL at a host that does not resolve.

| What changed | Test |
|---|---|
| A helper or decision in `src/utils/` or `src/auth/` | `<name>.test.ts` next to it: the module alone, I/O and the clock passed in |
| A tool's behaviour: what it sends to the API, what it returns, what it refuses | a test that calls the tool through the SDK `Client`, the API stubbed: copy `tests/widget-credential-redaction.test.mjs`, or put it next to the registrar as `src/tools/<area>.tool.test.ts` |
| HTTP, auth, CORS, the request log, `buildServer` wiring | `tests/mcp-endpoint.test.ts`: the real app from `tests/support/app.ts` |
| A new tool | nothing extra for its contract: `tests/tool-contract.test.ts` checks every tool's metadata, input validation, result shape and scope refusal. Its own behaviour still needs a test (row 2) |
| Text of a description or prompt only | nothing |

New tests read behaviour, not source text, and fake only what we do not own: the Gleap API, time, randomness. A test of a write asserts what was sent (`gleapApi.requests`) and that a refused write reads as an error. A test of anything a customer-scoped caller (`x-gleap-scope-session`) can reach covers the refusal too.

`src/index.ts` starts listening when imported, so only `tests/support/app.ts` imports it, once per test file.

## What to run

- While you work: `npm test -- <file>`.
- Before you finish: `npm run typecheck` and `npm test` (all of it takes about ten seconds). The stop hook runs both.
- After a change to `tools/quality/`: `npm run test:quality`.

If no test reaches the code you changed, that is not a pass: say in your report what no test covered.
