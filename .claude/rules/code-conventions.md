---
paths:
  - "src/**/*.ts"
---

# Code conventions

For new files and the code you change; do not rewrite other code to match. Old code here is no precedent: copy the examples below, not your neighbours.

- **Size:** aim for files under 400 lines and never write a new one over 700. Functions 80 lines, counted without blanks and comments. These are working values, not proven limits. Tests and data tables have none. A file or function already too big must not grow (`src/utils/activityLog.ts`, `src/tools/pipeline.tool.ts`, `src/tools/ticket.tool.ts`, `src/index.ts` and others): a new tool for such an area goes in a new `src/tools/<area><Topic>.tool.ts`. Split by responsibility; never squeeze code onto fewer lines.
- **Parameters:** at most 2 positional, from 3 on one object: `fn({ a, b, c })`. Tool handlers and callbacks a library calls are exempt.
- **Files:** a tool registrar is `src/tools/<area>.tool.ts`, its input schemas `src/schemas/<area>.schema.ts`, prompts `src/prompts/<area>.prompts.ts`; everything else is a camelCase module, `src/utils/<name>.ts`. Names are camelCase, never kebab-case or underscores, and unique in the repo: no new `index.ts`, `types.ts`, `utils.ts` or `helpers.ts`. No new barrel files.
- **Imports:** relative imports end in `.js` (Node16 ESM). Type-only imports use `import type`, so the code stays runnable by Node's own type stripping. No import cycles: `src/utils/*` imports no tool.
- **Code:** `const` arrow functions, named exports, no classes except `Error` subclasses. No `enum`, `namespace` or constructor parameter properties (`npm run typecheck` enforces this with `erasableSyntaxOnly`); a closed set of values is an `as const` array or object with its union type.
- **One definition:** before adding a schema, helper or projection, search `src/schemas/` and `src/utils/` (`projections.ts`, `api.ts`, `boardMeta.ts`). Values the Gleap API owns (statuses, ticket types, enum strings) keep the API's exact strings: check the Server repo (`../Server`, from a worktree `../../Server`).
- **Errors:** no empty `catch`. A catch that deliberately falls back says why in one line. An expected failure is an error result (`validationErrorResponse`, or the API helpers' own), never a throw.
- **Logging:** tools do not log. The HTTP layer logs one line per request with the `[gleap-mcp]` prefix: `console.error` for failures, `console.warn` for refusals. Never log tool arguments, results, keys, tokens or customer text.
- **Noise:** no new `any`, `as` (except `as const`), `!` or `@ts-ignore`; `@ts-expect-error` only with a reason. A comment says why, in English, in one or two lines, and only where the code cannot. No ticket or PR numbers, people's names, dates or decision histories: those belong in the PR.

## Tools

A tool is what a model reads and calls; its contract is checked for every tool by `tests/tool-contract.test.ts`.

- **Name:** `snake_case` verb and object (`get_ticket`, `update_help_center_article`), at most 64 characters. A name is a public API: clients, saved workflows and the ChatGPT directory app call it. Never rename or remove a tool; a retired tool keeps its name and schema and answers with `removedToolResponse` (`src/utils/removedTool.ts`) for one release.
- **Title and description:** a `title`, and a description that says what the tool does, when to use it and when another tool fits better, what it returns, and its limits. Write for a model that has never seen Gleap. Descriptions are static text: never build one, a title or the server instructions from API data.
- **Input:** a zod object in `src/schemas/<area>.schema.ts`, passed as `inputSchema: TheArgs.shape`, with `.describe()` on every field. Ids are validated (`/^[a-f0-9]{24}$/i`), free text and lists are bounded (`.max()`), lists of results take a `limit` with a default. Credentials and the project never come from arguments: read them with `getCredsOrThrow()` (`src/utils/credentials.ts`).
- **Annotations:** always `readOnlyHint`, `destructiveHint` and `openWorldHint`; `idempotentHint: true` when a repeat with the same arguments changes nothing more. Their defaults assume the worst, and clients ask before calling a tool that may destroy.
- **Results:** through the API helpers, which return `content` plus `structuredContent` (always an object). Project large payloads before serializing them (`src/utils/projections.ts`). A refused or failed call is `isError: true` with a message that tells the model what to do next.
- **Register** the area's tools in `buildServer` (`src/index.ts`), after the wrappers. Kai operator and coding-agent tools go inside the `toolNamesRegisteredBy` block, so ChatGPT's list stays under OpenAI's 128 tools.

## One job, one system

New code uses the first column. A new import of a package from the last column fails the quality check.

| Job | Use | Not in new code |
|---|---|---|
| Calling the Gleap API | `gleapGet`, `gleapGetData`, `gleapPost`, `gleapPut`, `gleapDelete` (`src/utils/api.ts`): credentials, session headers, retries, error results | `axios` or `fetch` directly in a tool, `node-fetch`, `got`, `undici`, `ky` |
| Validating input | zod schemas in `src/schemas/`, which the SDK validates and lists | `joi`, `yup`, `ajv`, hand-written checks of a field's type |
| JWTs | `jose` | `jsonwebtoken`, `jwt-decode` |

## Examples to copy

The closest we have today, so copy only what each line names.

- A small tool registrar with its annotations: `src/tools/team.tool.ts`. Not its `GleapApiResponse` import without `import type`.
- Input with `.describe()` on every field and a bounded `limit`: `SearchKnowledgebaseArgs` in `src/schemas/knowledge.schema.ts`. Not its unbounded `query`.
- A cross-cutting wrapper with its contract stated at the top: `src/utils/shareTokenRedaction.ts`.
- A tool test through the SDK client: `tests/widget-credential-redaction.test.mjs`. A test through the real endpoint: `tests/mcp-endpoint.test.ts`.
