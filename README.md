# Gleap MCP Server

[![GleapSDK/MCP-server MCP server](https://glama.ai/mcp/servers/GleapSDK/MCP-server/badges/score.svg)](https://glama.ai/mcp/servers/GleapSDK/MCP-server)
[![Gleap MCP connector](https://glama.ai/mcp/connectors/ai.gleap/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/ai.gleap/mcp)

Connect your [Gleap](https://www.gleap.ai) workspace to Claude and other AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io). Manage tickets, contacts, help center articles, and statistics using natural language.

## Prerequisites

- A Gleap account with at least one project
- An **API key** (Gleap → Settings → Developer → API keys) and your project (the Project ID from Settings → Project → General, or the project's internal ID)

## Local development

Install dependencies, then build and run the server locally:

```bash
npm install    # install dependencies
npm run build  # compile TypeScript to build/
npm start      # run the compiled server (node build/index.js)
```

Use `npm run dev` to recompile automatically on file changes while you work.

Node.js 22 (`engines` in `package.json`). Before opening a PR, run `npm run typecheck`, `npm test` and `npm run build`; CI runs them too. Coding agents: see `AGENTS.md`.

## Connecting to Claude (OAuth — recommended)

1. In Claude, open **Settings** → **Connectors** and add a custom connector
2. Enter the Gleap MCP server URL of the region your Gleap workspace is hosted in:
   - EU: `https://mcp.gleap.ai/mcp`
   - US: `https://mcp.us.gleap.ai/mcp`
3. Click **Connect** — you'll be redirected to Gleap to authorize access
4. Select the project you want Claude to access and approve the requested scopes
5. Done. Claude can now read and manage your Gleap workspace with your role in that project.

No API key or client ID setup is required. The OAuth flow handles authentication automatically.

## Alternative: API key auth (for clients that support custom headers)

Send these headers with every request:

| Header | Value |
|--------|-------|
| `x-gleap-api-key` | Your Gleap API key |
| `x-gleap-project-id` | Your project: the Project ID (Settings → Project → General) or its internal ID |

## Coding sessions

A coding agent working a Gleap ticket names its coding session, with the `sessionId` argument of a tool (`report_progress`, `send_message`, …) or for every call with the header `x-gleap-session-id` (the client sets it from `.gleap/session.json`, a Kai Code sandbox from its MCP config; OAuth and API-key connections alike). The server then sends `X-Gleap-Session-Id` with every write of that tool call (reads go without it), plus `X-Gleap-Session-Explicit: 1` when the id came from the tool's own `sessionId` argument (Gleap refuses every write that explicitly names a stopped session): Gleap books the writes to the session's agent (an agent's reply does not stop the agent the way a teammate's does) and checks each write against the session (the episode guard). A session id that does not count for the write (another project's session, one not linked to the written ticket, or one left behind in `.gleap/session.json`) is ignored: the write is then the caller's own, as without a session. The results then also carry what Gleap says about the session, whatever the tool:

- `stop: true`: the ticket is no longer the session's (a teammate took it over, replied to the customer, unassigned the agent or stopped the session). The result is only the STOP instruction, with `structuredContent.gleapStop: true`: the field Kai Code's runner and the Gleap plugin act on (never words in a result). Only this server sets it; a field of that name in API data is dropped.
- `newCustomerMessages`: what the customer wrote that the agent has not been shown, listed after the result.
- A send written before the customer's newest message is refused (409) with those messages (`staleThread: true` in the result): the agent reads them, adjusts and sends once more.

Without a session id nothing changes: no header, no extra lines.

The deep link that starts a session carries only one line with the session id. The agent's first call is `get_session_brief` with that id: its result is the whole kickoff (ticket, rules, findings, repository, the Gleap plugin skill to load). A kickoff without a session id works by ticket, as before.

## Available Tools

| Tool | Description |
|------|-------------|
| `search_tickets` | Full-text search across tickets |
| `find_tickets` | Filter tickets by status, priority, assignee, tags, date |
| `get_ticket` | Get a specific ticket by ID |
| `create_ticket` | Create a new ticket |
| `get_ticket_types` | List ticket types with their custom fields, status lanes and priorities |
| `get_ticket_messages` | Get the full conversation history (messages) for a ticket |
| `get_ticket_activity_log` | Get the console logs, network requests and click trail the SDK captured with a ticket. Coding agents call it on bug reports before reproducing, to see the console errors, failed requests and the user's clicks. Headers are never returned, secrets are redacted and long logs are trimmed (errors and failed requests first); `section` and `search` narrow it |
| `send_message` | Reply to a customer or add an internal note (Markdown). A session started from a ticket's code fix never sends to the customer (Gleap refuses it; it drafts in `report_progress`). Other agent workflows: the agent asks its operator in its own conversation (an instruction to answer or update the customer is the approval), then sends; with `sessionId` the reply is the session agent's and Gleap refuses a stale one (`stale_thread`, with the new messages) or one after a stop |
| `draft_reply_to_composer` | Stage a drafted reply in the ticket's dashboard composer for a person to review, edit and send. Sends nothing. For a person's own AI client, also when a `.gleap/session.json` from another ticket is still around: Gleap refuses Kai runs and the coding session working that ticket (410): Kai runs ask their operator and send with `send_message`, a code-fix session drafts in `report_progress` |
| `get_session_brief` | The kickoff of a Gleap coding session (`sessionId`, required): `GET /gleapcode/sessions/{id}/agent-workflow` without a kind, which returns the brief as Markdown. The brief (ticket, ownership rules, Kai Support's findings, what an earlier session left, repository, skill and setup lines) is the first text block, then the operator feedback and the `.gleap/session.json` content; a stopped session gets only the STOP instruction. Not read-only: it hands out operator feedback, and a multi-project grant must name its project |
| `report_progress` | Report the fix status on the Gleap coding session you were started from (deeplink hand-off loop; session-scoped since 2026-08), the same snapshot every runtime reports: `status` (`queued`, `working`, `needs_input`, `completed`, `failed`, `cancelled`), `step` while working (`investigating`, `reproduced`, `fixing`), a one-line `message`, `question` with `needs_input` (`kind`, `prompt`, `options`, `audience` customer or team), `customerLine` (one sentence of status the customer may read), `howSolved` (one paragraph on how the ticket was solved, sent with the last report; it feeds Kai Support's learning), `agentKind`, `agentName` and `device`. The older `phase` still works: `status` wins, and a report with only `status` also sends the phase it stands for, for a Server from before the fix status. Registers PRs (`completed` with `prUrl`) and takes the two fix messages: `customerUpdateMessage` (sent right away) and `customerShipMessage` (sent when the fix is live, by the project's post-merge setting); the result says what happened to each. The ticket is done when the customer confirms or 24 hours after the last answer without a reply, not at the merge. The result also carries `stop`, `newCustomerMessages` (see Coding sessions) and the `hook` block for `.gleap/session.json` |
| `update_plan` | Live checklist on the Gleap coding session (`sessionId` or `ticketId`, like `report_progress`): the whole list each call, statuses `pending`/`in_progress`/`completed`/`cancelled` |
| `wrap_up` | End-of-turn card on the session: recap, at most one question, 0-2 actions (`merge_pr`, `open_pr`, `review_changes`, `open_preview`; `send_customer_update` is removed and refused) |
| `share_screenshot` | Post a screenshot (optionally a before/after pair) into the session thread. Returns the `curl -T` upload commands to run (the server cannot read local files); `imageBase64` (≤ 1.5 MB each) for agents without a shell |
| `publish_artifact` | Publish a self-contained HTML page (≤ 1 MB) into the session thread; `artifactId` publishes a new version |
| `get_ticket_screenshot` | The ticket's SDK screenshot as image content (Gleap file hosts only, ≤ 2 MB) |
| `describe_database` | The team's own databases Kai Code may read (read-only, this ticket's customer only): tables, columns, masked columns, query format. Kai Code runs on a ticket only (the run key's ticket pin); refused for every other connection |
| `query_database` | One read-only query (a SQL SELECT or a MongoDB JSON request) on the team's database, kept to the ticket's customer (`scope: team` across customers always waits for a data owner); at most 200 rows, sensitive columns masked. It may wait for a person's approval (`status: pending` with a `queryId`). Values from results never go into code, tests, fixtures, commits or PRs. Kai Code runs on a ticket only |
| `get_query_result` | The status of a query that waited for approval, and its rows once a data owner let it run (kept a day). Kai Code runs on a ticket only |
| `get_workflows` | List all workflows in the project (live and draft), with their channels, whether Kai Support answers in them (`kaiAnswers`) and the agent they pass to |
| `get_workflows_available_for_ticket` | List the live workflows startable on a specific ticket |
| `run_ticket_workflow` | Manually start a workflow on a ticket (the "Start a workflow" action) |
| `get_setup_status` | Where the project stands for AI support: the Hard tickets settings (`hardTickets`: on a click or automatically, on Kai Code Cloud or a Bridge machine; `ticketDone`: thank-you and review ask), the default team, and (admins of a new workspace) the signup steps left |
| `get_agents` | The project's AI agents: name, live or draft, customer-facing or team |
| `set_ai_mode` | Removed (stub for one release): AI-first and AI-assisted are gone; does nothing and points to `update_workflow` and the Hard tickets settings |
| `start_kai_resolve` | Removed (stub for one release): Kai Resolve is Kai Support's hard-ticket mode, started with Work on it on the ticket or automatically; does nothing and says so |
| `update_workflow` | Change which channels a workflow runs on (`addChannels` / `removeChannels`) and whether it is live; never its steps |
| `get_workflow_build_options` | What a workflow can use, by name: teams, tags, Your API endpoints, webhooks, integrations, sequences, contact fields, message variables |
| `get_workflow_steps` | One workflow step by step, with path ids and step numbers, what could go live and the hashes `publish_workflow_draft` needs |
| `create_workflow_draft` | Build a new conversation workflow from steps; always a draft, no customer gets it |
| `change_workflow_draft` | Edit a workflow's name, trigger, channels, audience and steps; a change to a live workflow waits as a draft |
| `publish_workflow_draft` | Make a draft live or apply a waiting change, for the version the person agreed to (`draftHash`), with the editor's publish checks |
| `create_team` / `update_team` | Create a team, rename it, add or remove members (others stay), change how it hands out tickets |
| `set_default_team` | The team agents escalate to when nobody else is named (admins) |
| `search_contacts` | Full-text search across contacts |
| `get_contacts` | Filter contacts by email, name, company |
| `get_contact` | Get a specific contact by ID |
| `create_contact` | Create a new contact |
| `get_companies` | List/search the project's companies (organisations) |
| `get_company` | Get a company by its external companyId, incl. custom data |
| `update_company` | Create or update a company (name, plan, value, custom data) |
| `get_pipelines` | List CRM pipelines with their stages |
| `get_pipeline` | Get a pipeline incl. stages and fields (fieldIds for entry values) |
| `get_pipeline_stats` | Per-stage counts and field aggregations (e.g. sum of deal values per stage) plus pipeline totals |
| `get_pipeline_entries` | List a pipeline's entries, optionally for one stage |
| `get_pipeline_entry` | Get one entry with its pipeline context |
| `add_pipeline_entry` | Add a company/contact to a pipeline (stage + initial values) |
| `move_pipeline_entry` | Move an entry to another stage |
| `update_pipeline_entry_values` | Update an entry's field values (merge; null clears) |
| `remove_pipeline_entry` | Remove an entry from a pipeline (record itself is untouched) |
| `get_record_pipelines` | Which pipelines a company/contact is on |
| `get_help_center_sites` | List the project's help center sites (id, name, url, access mode, layout, collection and article counts); older servers answer with the default site only |
| `get_help_center_collections` | List help center collections; optional `site` (`default` or a site id) lists one site's |
| `get_help_center_collections_tree` | Full tree of collections and subcollections (each carries its `site`) |
| `get_help_center_articles` | List articles in a collection |
| `get_help_center_article` | Get a specific article by ID |
| `create_help_center_collection` | Create a new collection; optional `site` for a top-level collection |
| `move_help_center_collections_to_site` | Move top-level collections (with sub-collections and articles) to another help center site |
| `update_help_center_collection` | Update an existing collection |
| `upload_image` | Store a PNG, JPEG, GIF or WebP (base64 `data` or public `url`) on the project's Gleap CDN and get its permanent `fileUrl` |
| `create_image_upload_link` | Single-use, 15-minute link that uploads one image from disk (`curl -F file=@cover.png <link>`), for agents with a shell |
| `create_help_center_article` | Create a new article (TipTap JSON content) |
| `update_help_center_article` | Update an existing article. Partial per-locale updates: locales you send are changed, locales you omit are preserved |
| `get_statistics_facts` | Fact metrics: response times, ticket counts, SLA, AI stats |
| `get_statistics_list` | List metrics: top agents, top articles, team performance |
| `get_statistics_bar_chart` | Bar chart data: tickets over time, ratings, SLA |
| `get_raw_data_statistics` | Individual event rows behind the metrics, filtered by action type, agent, ticket |
| `get_targeting_options` | Events and contact attributes outbound messages can target, with the condition syntax |
| `get_event_tracking_guide` | Tracking code (SDKs + backend) for an event or contact attribute targeting needs but the project lacks |
| `list_outbound_messages` | List one outbound type: surveys, chat messages, banners, info cards, checklists, tours, tooltips, news, emails, push, WhatsApp |
| `get_outbound_message` | One outbound item: content, targeting, reviewUrl, optional stats |
| `create_outbound_draft` | Draft a survey, chat message, banner, info card, checklist, push, product tour or tooltip set |
| `update_outbound_content` | Revise a non-live outbound item's content |
| `configure_outbound_targeting` | Trigger, frequency, page rules, audience and schedule of a non-live outbound item |
| `preview_outbound_audience` | Count and sample who an audience matches; saves nothing |
| `publish_outbound` | Set an outbound item live after operator approval (one-offs: with the approved recipient count) |
| `pause_outbound` | Take a live outbound item off |
| `list_sequences` | Sequences (Outreach › Sequences) with status, how contacts are enrolled, goal, counts and reply/goal rates |
| `get_sequence` | One sequence: enrollment, exit, goal, sending, the step tree as an outline plus editable steps, unpublished changes and what blocks going live |
| `get_sequence_templates` | The starter templates (blank, onboarding, trial, reengage) and the full step/settings/condition/variable reference with a worked example |
| `create_sequence` | New draft sequence from a template and/or a full definition in one call |
| `update_sequence` | Change name, enrollment, exit, goal, sending (merged) and steps (whole list or `stepChanges` by id); on a live sequence saved as unpublished changes |
| `publish_sequence_changes` / `discard_sequence_changes` | Make a live sequence's unpublished changes live, or drop them |
| `set_sequence_status` | Turn a sequence live or pause it (server validation messages returned verbatim) |
| `enroll_in_sequence` | Enroll up to 500 contacts by email, userId or contact id in a live sequence (they start getting real messages); skipped contacts with reasons |
| `get_sequence_stats` | Counts, reply and goal rates, exit reasons and per-step funnel |
| `list_sequence_enrollments` / `get_sequence_enrollment` | Contacts in a sequence (filter by status, search) and one contact's timeline |
| `manage_sequence_enrollment` | Pause, resume or exit one contact's run |
| `preview_sequence` | Render every message for a contact and list variables that resolve empty; sends nothing |
| `send_sequence_test_email` | Send one email step as a test to yourself or up to 5 addresses |
| `search_feature_requests` | Semantic dedupe search over feature requests: up to 5 matches with rerank scores, including requests not on the public roadmap yet (`public: false`) |
| `get_feature_request` | Read one feature request by id or ticket number: title, description excerpt, status, upvote count, share link (never voter identities) |
| `subscribe_to_feature_request` | Idempotently add a customer as upvoter; returns the request's status and share link |
| `create_feature_request` | File a feature request with the customer as first upvoter. Matching requests refuse it with `{ok: false, duplicate: true, candidates}`; `notDuplicateOf` lists candidates that are a different need |
| `list_surveys` / `get_surveys` | Surveys with id, SDK id, status, format, published version and unpublished changes (`get_surveys` is an alias) |
| `get_survey` | One survey's draft (or published) definition, page settings and in-app targeting |
| `create_survey` | New survey from a definition; always an unpublished draft |
| `update_survey` | Replace a survey's draft definition; on a live survey it saves the next draft version |
| `validate_survey` | Server validation of a definition or the stored draft, without saving |
| `publish_survey` | Launch: publish the draft as the next version; `goLive: true` also shows it in the app |
| `pause_survey` | Stop showing a survey in the app (page and emails keep working) |
| `get_survey_results` | Totals, NPS, per-question counts, drop-off, endings and paths from stored counters, plus the step funnel when analytics events exist |
| `get_survey_analytics` | Event analytics with previous-period deltas: views, starts, submissions, rates, step funnel with drop-off, worst step, timing, score, versions, device/channel breakdowns, busiest times, reminders, email, quality |
| `get_survey_insights` | Stored AI themes, drivers, segments and alerts |
| `ask_survey_results` | Plain-language question about the responses → answer with cited response ids (AI, billed) |
| `get_survey_responses` | Compact response rows with filters (status, answer by key, theme, channel, contact, text) and cursor pagination |
| `get_survey_response` | One response with labelled answers, path, ending and contact |
| `search_survey_responses` | Keyword search over the answers of every survey (or one), with snippet, NPS and contact per hit |
| `reach_out_to_respondent` | Draft (default) or, with `send: true`, start a conversation linked to a response |
| `get_survey_summary` | Stored AI summary of a survey's responses (legacy) |

Error results set `isError: true`. Reads retry transient API failures (5xx, 429, network errors) twice with backoff, within a 20-second budget. Writes retry only when the request never reached the API (connection refused, DNS failure); calls that pass `idempotent: true` (feature-request create and subscribe) also retry 502-504. Other writes such as `send_message` are never repeated.

## Prompts and MCP Apps view

- Prompts `fix_ticket` and `answer_ticket` (argument `ticket`: `#number` or id) start a ticket workflow with the workflow text and a ticket summary.
- `update_plan`, `wrap_up`, `share_screenshot` and `publish_artifact` carry `_meta.ui.resourceUri = "ui://gleap/kai-session"`: hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) render the result inline from `structuredContent.view`; every other client reads the text content.

## Examples

### Marketing drafts and human review

Use these tools after a human approves the content plan:

| Tool | Outcome |
|------|---------|
| `create_news_draft` | Unpublished news or changelog; defaults to `CHANGELOG` |
| `update_news_draft` | Revise an unsent news/changelog draft |
| `create_newsletter_draft` | Unpublished fixed, one-time email campaign |
| `update_newsletter_draft` | Revise an unsent newsletter draft |
| `get_newsletter_drafts` | Paginated summaries of fixed, one-time email drafts |
| `get_newsletter_draft` | Full newsletter draft content and review link |
| `create_email` | Unpublished email of any kind: `newsletter`, `automated` or `kai` (Kai-written) |
| `update_email` | Revise any unsent draft email (content, look, Kai-written config), or the content and look of a live/paused automated email in place (queued sends keep going with the new content) |
| `get_email` | Any email's content, kind, look, Kai-written config and review link |

Creation requires `name`, `subject` (locale-to-string map), and `message`
(locale-to-TipTap-document map). Do not wrap inputs in `localized`; the tools
apply the backend's storage format. `sender` is optional; review it in Gleap.
News creation also accepts `subType: "NEWS"` or `"CHANGELOG"`.
Updates take `draftId` and the content fields being changed. Use existing
`get_news` / `get_news_item` to find and read news drafts.

#### Email kinds and looks

Gleap has three kinds of email. The kind is derived from the stored email, not
stored itself:

| Kind | Stored as | Default look | Tracking |
|------|-----------|--------------|----------|
| `newsletter`: written once, sent once to an audience | `frequencyType: "fixed"` | `company` | on |
| `automated`: written once, sent per contact on an event trigger (+ delay) | `frequencyType: "dynamic"` | `personal` | on |
| `kai` (Kai-written): Kai writes one email per recipient, teammates review the first ones | `kai.enabled: true`, fixed or dynamic | `plain` | off |

`emailStyle` is the look: `plain` looks like a message typed in Gmail (no
layout, no tracking pixel; best for personal notes, check-ins and Kai-written
emails), `personal` is a clean white page signed by the sender with a photo
card (onboarding, lifecycle), `company` has the logo header, a content card and
a footer with links and postal address (newsletters, product updates), and
`custom` renders one of the project's HTML templates (`emailTemplate`). Passing
`emailTemplate` alone selects `custom`; `custom` needs a template of the
project's, and `emailTemplate` with another look is refused. A new email is
saved with an explicit `emailStyle` and no template; the tools no longer fall
back to "the first template" (new projects have no Personal/Plain/Company
templates). Emails stored without `emailStyle` keep rendering as before
(`custom` with a template, otherwise `personal`).

`preheader` (locale → string) is the inbox preview text; plain ignores it.
`tracking: { opens, links }` defaults off for plain and on for the other looks.
An update that changes the look without passing `tracking` moves tracking that
is still at the old look's default to the new look's default, and keeps tracking
somebody set on purpose.

`create_email` takes `kind`, `name`, the content and look fields, and for
`kind: "kai"` a `kai` object (`prompt` required) plus optional
`delivery: "one_off" | "triggered"` (default triggered). Kai-written defaults:
sources `contact, company, events, tickets, helpcenter, website`, rules
`{ maxWords: 120, linkAllowlist: [], forbidden: [] }`, review
`{ mode: "firstN", n: 20 }`, `onNothingToSay: "skip"`, caps
`{ perDay: 500, costPerDayUsd: 25 }`. Subject and message are required for
newsletter and automated emails; for a Kai-written email they are the fallback
email and required only with `onNothingToSay: "fallback"`. `update_email`
merges `kai` into the stored config (`kai.enabled: false` turns it back into an
email written once). The MCP never sets review mode `none` (send without any
review): that stays a dashboard decision, and `publish_email` refuses a
Kai-written email whose review is off or that has no instructions. Kai writes
nothing until the email is live; set trigger and audience with
`configure_email_automation` as for any email.

`create_newsletter_draft` / `update_newsletter_draft` keep working for fixed
one-off newsletters and accept the same `emailStyle`, `emailTemplate`,
`preheader` and `tracking` fields. `update_newsletter_draft` with only
`draftId` is now refused (there is no template to repair).

Every new draft write explicitly sends `status: "draft"`. The draft tools provide
no publication, scheduling, audience, or send controls; for emails those are
the lifecycle email tools below. News draft creation
disables push and subscriber email settings. Newsletter creation uses the
dashboard's fixed/once email shape, with no trigger; `create_email` with
`automated` or `kai` saves a dynamic email without a trigger. Successful creation
and revision return the saved record plus `reviewUrl` and a review instruction.

The intended workflow is: approve plan → create/revise draft → open `reviewUrl`
→ approve completed content → choose sender, audience, delivery settings and
publish/send in the Gleap dashboard. Plan approval is not publication approval.
The MCP does not implement a human approval authority or Slack integration.
Tool descriptions guide the agent; the host/operator must enforce approvals.

Revision checks the current record's type, draft status, and send history before
writing, and refuses live, paused, or previously sent records. It preserves
omitted content and delivery fields. The backend does not provide a conditional
draft update: this read-before-write check is not a transaction or version lock.
Avoid concurrent dashboard publication and agent revision of the same draft.
Use a new draft for changes to published content. After an ambiguous write error,
inspect existing drafts before retrying creation to avoid duplicates.

### Lifecycle emails: trigger, audience, publish

Turn an email (e.g. a newsletter draft) into an event-triggered email and set
it live, without the dashboard:

| Tool | Outcome |
|------|---------|
| `get_email_automation` | An email's status, kind, look, Kai-written config, trigger, frequency, `targetAudience` and conditions, plus `reviewUrl` |
| `configure_email_automation` | Set a non-live email's event trigger, frequency, audience and/or `dropIfConditionsFail`. Never publishes |
| `publish_email` | Set the email live |
| `pause_email` | Take a live email off (the dashboard's Unpublish: status back to `draft`). Every queued pending send is deleted and never re-created on publish; do not pause just to edit content |

`configure_email_automation` takes `emailId` plus any of:

- `trigger: { event, type?, delaySeconds }`: a streamed event name; `type` is
  `firstoccured` or `lastoccured` (default `firstoccured` for once,
  `lastoccured` otherwise); the delay is 0 to 365 days in seconds. Stored as
  the dashboard stores it, `{ event, type, dateOperator: "relative",
  matchOperator: "greaterthan", data: <delaySeconds>, ti }`, and switches the
  email to `frequencyType: "dynamic"`. Contact attributes (`gleap-up-*`,
  `tags`) and `pageView` are refused as triggers: they match every existing
  contact at once or need page rules.
- `frequency`: `{ mode: "once" }` (`frequency: "once"`), `{ mode: "every_time" }`
  (`"continuously"`), or `{ mode: "every_n_days", days }` (`"continuously"`,
  `frequencyDays: days`).
- `audience: { targetAudience?, logicalOperator?, conditions? }`:
  `targetAudience` is `all`, `users` or `guests`; `conditions` replaces all
  rules (AND by default) and is checked when the email is due, so it doubles as
  stop conditions. Shapes, as stored:
  - event count: `{ event, type: "count", matchOperator: "is", data: 0 }`
  - current page: `{ event: "pageView", type: "latestdata", dataKey: "page", matchOperator, data }`.
    Custom events keep no other data, so any other `dataKey` is refused: put the value on the contact instead
  - contact attribute: `{ event: "gleap-up-<attribute>", type: "latestdata", matchOperator, data }`,
    e.g. exclude your team with `{ event: "gleap-up-email", type: "latestdata", matchOperator: "notcontains", data: "gleap.io" }`
  - event date: `{ event, type: "firstoccured" | "lastoccured", dateOperator: "relative", matchOperator: "greaterthan" | "lessthan" | "exactly", data: <seconds> }`
- `dropIfConditionsFail: boolean` ("Skip if conditions no longer match" in the
  dashboard): when the email is due and its audience conditions fail, the send
  is dropped instead of waiting for them to match (by default it stays pending
  and may go out up to 30 days later). For sequences keyed on state that moves
  on, e.g. onboarding step emails conditioned on
  `gleap-up-customData.onboardingGoal`. It is a sending policy, not targeting:
  the only setting the tool also changes on a live email.

Every write goes through `PUT /engagement/emails/:id`, the route the dashboard
saves and publishes with, so the API applies the same project scoping, role
permission (`engagement.email.update`: admins and members, not viewers), plan
gate, live-edit lock and publish checks. The tools add their own guards:

- `configure_email_automation` refuses a live email (pause it first; a call
  that only sets `dropIfConditionsFail` is the exception) and an
  email that sends to an uploaded CSV list, and never sends `status`.
- `publish_email` publishes an email only when it is triggered by a streamed
  event and has no unfinished audience rule. A `sessionStarted` trigger, which
  every contact fires, also needs at least one audience condition.
- A one-off email (no trigger: it goes to everyone who matches at once and
  cannot be recalled) is refused unless the call passes `oneOffAudience`
  equal to the email's stored `targetAudience`, which must be `users` or
  `guests` (never `all`) with at least one audience condition. CSV-list sends
  stay in the dashboard.
- A Kai-written email is published only with instructions (`kai.prompt`), at
  least one source, fallback content when `onNothingToSay` is `fallback`, and
  review `all` or `firstN`. Once live, the emails held for review wait in the
  email's Review tab in the dashboard.
- `publish_email` / `pause_email` on an email already in that state change
  nothing; an already-sent one-off cannot be paused.
- `pause_email` deletes every queued pending send (contacts waiting out a
  trigger delay); publishing again does not re-create them. To fix content of
  a live automated email, use `update_email` instead: it writes only the
  content fields passed (never status, trigger, audience or frequency), the
  email stays live and queued sends go out with the new content. It refuses
  `kai` changes on a published email and any edit of a sent one-off.

Each tool returns the email's resulting status, trigger, frequency, audience
and `reviewUrl`, and reports an error when the saved email does not show the
requested change. Finish content with the newsletter draft tools before
configuring: `update_newsletter_draft` edits only fixed, one-time drafts.
Publishing needs the operator's approval; the tool descriptions say so, the
host must enforce it. Customer-scoped runs cannot use these tools.

### Sequences: build, check, go live, enroll

Sequences (Outreach › Sequences) walk enrolled contacts through emails, chat
messages, waits, "wait until they do X" with did/didn't paths, if/else
branches and actions (tag, attribute, pipeline, another sequence, end) until
they finish, reply, convert (goal) or hit an exit rule. The tools call the
dashboard's routes (`/v3/sequences`), so permissions (`engagement.email.*`),
the plan gate and the go-live validation run on the Server; its 400 messages
reach the agent verbatim.

Typical flow: `get_targeting_options` (real event and attribute names) →
`create_sequence` (template and/or definition; steps as JSON, email content as
plain text with `{{session.firstName|there}}` variables) → `preview_sequence`
(every message rendered for a contact, missing variables listed) →
`send_sequence_test_email` → `set_sequence_status` `live` after the operator
approves → `enroll_in_sequence` for manual enrolling. Edits to a live or paused
sequence are saved as unpublished changes until `publish_sequence_changes`.

The tools check a definition before writing (unique step ids, known step
types, wait units and limits, condition rules) and merge partial settings onto
the current ones, since the Server replaces each settings object whole.
Customer-scoped runs cannot use these tools.

### Outbound messages: draft, target, preview, publish

Every outbound type works through the same tools: `survey`, `chat_message`, `banner`, `modal` (info card),
`checklist`, `product_tour`, `tooltip`, `news`, `email`, `push`, `whatsapp`.

| Tool | Outcome |
|------|---------|
| `get_targeting_options` | The project's events (triggers / event rules) and contact attributes (audience rules) plus the condition syntax; `search` narrows it and says when nothing matches |
| `get_event_tracking_guide` | The SDK and backend code to start tracking a missing event or contact attribute, and whether it is already tracked |
| `list_outbound_messages` / `get_outbound_message` | Items of one type; one item's content (survey questions included), targeting, reviewUrl and optional stats |
| `create_outbound_draft` | Unpublished survey, chat message, banner, info card, checklist, push, product tour or tooltip set, in the shape the dashboard editor writes (emails and news: the draft tools above) |
| `update_outbound_content` | Revise a non-live item's content; lists (questions, steps, tooltips) are replaced whole |
| `configure_outbound_targeting` | Delivery (triggered / one-off), trigger + delay, frequency, page rules, audience (incl. one level of rule groups) and schedule of a non-live item |
| `preview_outbound_audience` | Who the rules match now, with a few sample contacts; nothing is saved |
| `publish_outbound` / `pause_outbound` | Go live / take off through the dashboard's publish path |

Guards: an item without content, sender (banners, chat messages, news), steps or a trigger is not
published (it would show nothing); triggers on contact attributes are refused (use audience rules);
one-offs and news with push need `confirmedReach`, the recipient count from `preview_outbound_audience`
the operator approved, and are refused if the audience grew beyond it; one-off emails, push and WhatsApp
never go to everyone without rules; live items must be paused before their targeting or content changes,
and sent one-offs cannot be paused. Tools outside the customer-session allowlist are refused in
customer-scoped runs.

### Surveys 2.0: drafts, validation and publishing

Agents build surveys from one JSON definition (the same one the dashboard
editor, the API and Kai use): `blocks` (questions with a stable `id`, a
snake_case answer `key`, a `type`, `title`, options and logic `jumps`),
`endings` and hidden `fields`. Jumps are `{ if: condition, go: <later block or
ending id> }`, checked top to bottom; otherwise `next`, otherwise the next
block. The tool descriptions carry the full format and an NPS example
(0–6 / 7–8 / 9–10 to three follow-ups).

- `create_survey` and `update_survey` write drafts only: they always send
  `status: "draft"` (create) or only `{ definition }` to
  `PUT /engagement/surveys/:id/draft` (update), never a status, the published
  definition or targeting on update. On a live survey the live version keeps
  running until the draft is published.
- Definitions are checked before anything is written: unknown properties,
  duplicate ids/keys, jump targets that do not exist or go backwards,
  conditions that do not fit the question type (choice ids, not labels; NPS
  ranges inside 0–10), missing choices, unknown hidden fields. The Server's
  validator (reachability, limits) then runs on the saved draft and its
  result comes back as `validation`.
- `publish_survey` calls `POST /engagement/surveys/:id/publish` (with
  `{ goLive: true }` it also switches the in-app survey on). Agents publish like
  teammates; the tool description has them launch only once the operator
  agreed, the same rule as `publish_outbound`. Invalid drafts come back with
  the validator's errors (422). A Server that still answers "needs approval"
  (403 or `requiresApproval: true`) comes back as
  `{ published: false, requiresApproval: true, reviewUrl }`.
- Contact questions: an `email` question, or a `short` question with
  `contactField: "name" | "phone"`. With `skipWhenKnown` (unset = on) an
  identified contact whose value is known is not asked and the Server fills the
  answer in; `false` always asks. `contactField` on other types and
  `skipWhenKnown: true` on other questions are rejected before writing.
  Responses list those answer keys as `prefilled`. A Server without these
  fields drops them on save; `create_survey` / `update_survey` then return a
  `contactSettingsNote`.
- `reach_out_to_respondent` sends nothing unless `send: true`; the default
  returns the draft message and recipient for the operator to approve.
- Results tools return compact JSON: capped lists, clipped text, cursor
  pagination for responses. Stats and insights are read from stored data; only
  `ask_survey_results` runs AI.

Customer-scoped runs cannot use any survey tool.

### Images: covers and inline images

1. Get the image onto Gleap's CDN. A file on disk (e.g. a generated cover):
   `create_image_upload_link`, then run the returned
   `curl -sS -F "file=@cover.png" "<uploadUrl>"` — the JSON response carries
   `fileUrl`. The link works once and expires after 15 minutes. Small base64
   data or a public URL: `upload_image` (`data` or `url`) returns `fileUrl`.
   PNG, JPEG, GIF and WebP only, judged by the bytes; base64 up to 5 MB, links
   up to 20 MB. Everything is stored in the connected project's upload folder
   through the Gleap API with your credentials; the MCP server itself never
   fetches a URL (the API does, behind its SSRF guard).
2. News/changelog cover: pass `coverImageUrl` to `create_news_draft` or
   `update_news_draft` (`null` removes it). A URL that is not on Gleap's file
   hosts is copied onto the CDN first, so published content never hotlinks a
   third-party host. The draft-only rules above still apply. `create_news` /
   `update_news` accept the same field. Help center articles and newsletters
   have no cover image.
3. Inline images (news, newsletters, help center articles): add a top-level
   block node next to the paragraphs — never inside one:

   ```json
   { "type": "imageBlock", "attrs": { "src": "<fileUrl>", "width": "100%", "align": "center", "alt": "What the image shows" } }
   ```

   `width` is a percentage string (pixel widths such as `"540px"` in existing content are accepted), `align` is `left`, `center` or `right`;
   optional `link` + `target: "_blank"` make the image clickable. This is the
   node the dashboard editors insert, and the widget and help center render it
   the same way. The legacy `{ "type": "image", "attrs": { "src" } }` still
   renders. Writes are refused (nothing saved) when an image node has no
   `src`, a `data:` URI, a non-http(s) `src`, or sits inside a paragraph.

Customer-scoped runs cannot upload images or create upload links.

The legacy `create_news` now explicitly sends draft status (matching the existing
backend default). Legacy `update_news` still edits the specified item, including
live items; marketing agents should use `update_news_draft` for this workflow.
Customer-scoped runs cannot access the new marketing draft tools.

Run `npm test` for the mocked API regression tests; they run on the TypeScript
sources, without a build. Tests do not connect to a live project or send messages. Deploy the updated MCP server
and refresh the client's tool discovery before using the new tools.

### Example 1: Triage unassigned tickets

**Prompt:** "Show me all open high-priority tickets that haven't been assigned to anyone"

**What happens:**
- Claude calls `find_tickets` with `status: "OPEN"` and `priority: "HIGH"` (the filter takes priority keys or names; custom priorities have `p_…` keys listed by `get_ticket_types`)
- Filters the results to surface unassigned tickets
- Returns a ranked list with ticket IDs, titles, and creation dates so you can start triaging immediately

---

### Example 2: Look up a customer and their history

**Prompt:** "Find the contact for sarah@acme.com and show me her recent support tickets"

**What happens:**
- Claude calls `search_contacts` with the email address
- Retrieves the contact record including name, company, and custom attributes
- Calls `find_tickets` filtered by the contact's session ID
- Summarizes the contact profile and ticket history in one response

---

### Example 3: Create a ticket from a conversation

**Prompt:** "Create a high-priority bug report titled 'Payment fails on checkout for EU customers'"

**What happens:**
- Claude calls `get_ticket_types` to find the right ticket type, its required fields and its priorities
- Calls `create_ticket` with the type, title, and priority (a key such as `HIGH` or a priority title such as `"Urgent"`; built-in keys are LOW, MEDIUM, HIGH)
- Returns the new ticket ID and a direct link to it in Gleap

---

### Example 4: Browse and navigate the help center

**Prompt:** "What help center collections do we have, and which articles are in the 'Getting Started' collection?"

**What happens:**
- Claude calls `get_help_center_collections_tree` to get the full structure
- Identifies the matching collection and calls `get_help_center_articles`
- Returns a structured list of all articles with their titles and IDs

---

### Example 5: Write a new help center article

**Prompt:** "Create a help center article explaining how to reset a password. Write it in English and German."

**What happens:**
- Claude asks which collection to add it to (or uses `get_help_center_collections` to list options)
- Drafts localized title, description, and body content in TipTap JSON format for both locales
- Calls `create_help_center_article` with `isDraft: true` so you can review before publishing

---

### Example 6: Check support performance

**Prompt:** "What was our average first response time last month, and how does it compare to the month before?"

**What happens:**
- Claude calls `get_statistics_facts` with `chartType: "avgFirstResponseTime"` for each date range
- Compares the two values and calculates the percentage change
- Presents a concise summary with the trend direction

---

### Example 7: Update an existing help center article

**Prompt:** "Update our 'Getting Started' article to mention the new dark mode feature"

**What happens:**
- Claude calls `get_help_center_collections_tree` to find the article
- Retrieves the current article content with `get_help_center_article`
- Appends the new section while preserving existing content
- Calls `update_help_center_article` with the revised TipTap document
- For large multi-language articles, Claude updates one locale per call (e.g. `content: { "de": ... }`); untouched locales keep their current content

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GLEAP_API_BASE` | *(required)* | Gleap REST API base URL, e.g. `https://api.gleap.io/v3` |
| `GLEAP_AUTH_ISSUER` | `https://api.gleap.io` | OAuth issuer URL |
| `GLEAP_JWKS_URI` | `{GLEAP_AUTH_ISSUER}/.well-known/jwks.json` | JWKS endpoint for token verification |
| `MCP_SERVER_URL` | `http://localhost:{PORT}/mcp` | Public URL of this server (used as OAuth audience) |
| `MCP_SERVER_URL_ALIASES` | *(none)* | Other public URLs this server answers on, comma-separated (e.g. the legacy `https://mcp.gleap.io/mcp`). Each host serves its own OAuth metadata, and tokens for any of them are accepted. |
| `PORT` | `3000` | HTTP port |
| `MCP_JSON_BODY_LIMIT` | `10mb` | Maximum JSON body size accepted on the MCP endpoint (body-parser size string). Large multi-locale help center article updates need more than body-parser's 100 KB default. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | *(current token)* | Token served at `/.well-known/openai-apps-challenge` so OpenAI can verify domain ownership for the ChatGPT plugin directory. Override only when OpenAI issues a new token. |

## Support

- Website: [https://www.gleap.ai](https://www.gleap.ai)
- Email: [support@gleap.io](mailto:support@gleap.io)
