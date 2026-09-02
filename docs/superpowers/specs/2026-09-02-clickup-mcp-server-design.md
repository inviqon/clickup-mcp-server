# Design: clickup-mcp-server

- Date: 2026-09-02
- Status: approved
- Owner: tiemo
- Type: architectural design (new project)

## 1. Purpose

A self-hosted Model Context Protocol server for ClickUp, optimised for a single
concrete job: an agent doing daily task management. Spaces, folders, lists,
tasks, comments, tags, time tracking.

Two motivations drive the build:

1. Rate limits are enforced per API token, not per workspace. Running our own
   server with client-side throttling and caching keeps us inside the plan tier
   limit instead of competing with a shared vendor server.
2. Tool surface and response shape become ours to tune. Both matter more for
   agent reliability than raw API coverage does.

The server must be deployable locally over stdio today and hostable as a remote
connector over Streamable HTTP without a rewrite.

## 2. Success criteria

- An agent can run a full working day (plan, update, comment, track time)
  without falling back to the ClickUp web UI.
- A typical daily session costs materially fewer tokens than issuing the
  equivalent raw API calls, mainly through response shaping and caching.
- The server never presents invented data as fact. Unknown is rendered as
  absent, ambiguity is surfaced, failure is reported.
- Ten evaluation questions answerable end to end by an agent with no prior
  workspace knowledge.

## 3. Non-goals

Out of scope for v1, all addable later without structural change:

- Chat channels and messages
- Webhooks
- Guests and user groups
- Goals and OKRs
- Views
- Audit logs
- Task and list templates
- Attachment upload
- Checklists (subtasks cover the need)
- Doc writing (Docs are read-only in v1)
- OAuth2 authorisation code flow (token auth only; the context abstraction
  leaves room for it)

## 4. Architecture

### 4.1 Layout

```
src/
  core/
    context.ts        ClickUpContext: token, teamId, mode, timezone, cache, limiter
    registry.ts       ToolDefinition[] filtered by mode and enabled categories
    errors.ts         ClickUp errors -> short, actionable messages
    dates.ts          natural language dates -> epoch ms, timezone aware
    truncate.ts       character budget enforcement with visible notices
  clickup/
    client.ts         fetch wrapper: auth, retry, 429 backoff via X-RateLimit-Reset
    rate-limiter.ts   token bucket per credential
    cache.ts          TTL cache
    schemas.ts        zod schemas for API RESPONSES (not only inputs)
    endpoints/        thin typed functions: tasks, lists, folders, spaces,
                      time, comments, tags, docs, members
  tools/
    navigation.ts tasks.ts comments.ts structure.ts tags.ts time.ts docs.ts myday.ts
  format/             typed object -> compact markdown
  server.ts           builds McpServer from registry plus a context factory
  bin/
    stdio.ts          env -> context -> StdioServerTransport
    http.ts           headers -> context -> StreamableHTTPServerTransport
```

### 4.2 The tool contract

```ts
type ToolDefinition<TIn, TOut> = {
  name: string                       // clickup_<action>_<resource>
  title: string
  description: string                // purpose, boundaries, 2 examples
  category: Category                 // for CLICKUP_ENABLED_CATEGORIES
  mode: 'read' | 'write' | 'admin'   // drives visibility AND annotations
  inputSchema: z.ZodObject<TIn>      // .strict()
  outputSchema: z.ZodObject<TOut>
  handler: (args, ctx: ClickUpContext) => Promise<TOut>
  render: (out: TOut) => string      // markdown
}
```

The handler returns a typed object, never a string. The registry then emits
both `structuredContent` (the object) and `content` (markdown from `render`,
or JSON when `response_format: 'json'` was requested). Three consequences:

- Unit tests assert on typed objects, rendering is tested separately.
- The client receives machine-readable truth alongside the compact view.
- Markdown and JSON cannot drift, since both derive from one source.

`annotations` are derived from `mode`, so they cannot fall out of sync:
`read` -> readOnlyHint true, destructiveHint false, idempotentHint true.
`write` -> readOnlyHint false, destructiveHint false.
`admin` -> readOnlyHint false, destructiveHint true.
`openWorldHint` is true everywhere.

### 4.3 Context and transports

No module-level mutable state. Every handler receives a `ClickUpContext`.

- stdio: one context built once from environment variables. Logging goes to
  stderr only, because anything on stdout corrupts the protocol stream.
- Streamable HTTP: stateless JSON mode, one context per request from the
  `Authorization` header plus `X-ClickUp-Team-Id`. Multi-tenant safe by
  construction. Binds to 127.0.0.1 by default and validates the `Origin`
  header (DNS rebinding protection).

Cache and rate limiter are keyed by team id plus a hash of the token, so
tenants never share state.

## 5. Tool surface (36 tools)

`R` read, `W` write, `A` admin. Admin tools are hidden unless
`CLICKUP_MCP_MODE=admin`.

### Navigation (4)

| Tool | Mode | Backing endpoints |
|---|---|---|
| `clickup_get_workspace_tree` | R | `GET /v2/team`, `/v2/team/{id}/space`, `/v2/space/{id}/folder`, `/v2/space/{id}/list`, `/v2/folder/{id}/list` |
| `clickup_get_list` | R | `GET /v2/list/{id}` plus `GET /v2/list/{id}/field` |
| `clickup_resolve_member` | R | `GET /v2/team` |
| `clickup_search_tasks` | R | `GET /v2/team/{id}/task` |

`clickup_search_tasks` and `clickup_list_tasks` are deliberately distinct:
search is workspace wide and text driven ("where is the task about the login
redirect"), list is scope driven and filtered ("open tasks assigned to me in
list X, due this week"). Each tool description states when to use the other.

`clickup_get_workspace_tree` collapses what would otherwise be three or more
navigation tools into one cached call. `clickup_get_list` deliberately returns
available statuses and custom field definitions together, because an agent that
has to guess a status name burns a failed write to find out.

### Tasks (8)

| Tool | Mode | Backing endpoints |
|---|---|---|
| `clickup_get_task` | R | `GET /v2/task/{id}` (`include_subtasks`, `include_markdown_description`) |
| `clickup_list_tasks` | R | `GET /v2/list/{id}/task` |
| `clickup_create_task` | W | `POST /v2/list/{id}/task` plus `POST /v2/task/{id}/field/{field_id}` |
| `clickup_update_task` | W | `PUT /v2/task/{id}` plus custom field writes |
| `clickup_update_tasks_bulk` | W | repeated `PUT /v2/task/{id}`, throttled |
| `clickup_move_task` | W | `PUT /v3/workspaces/{id}/tasks/{task_id}/home_list/{list_id}` |
| `clickup_delete_task` | A | `DELETE /v2/task/{id}` |
| `clickup_link_tasks` | W | `POST /v2/task/{id}/link/{links_to}`, `POST /v2/task/{id}/dependency` |

Notes:

- Subtasks are ordinary tasks in ClickUp. The agent should not need to know
  that: `clickup_create_task` takes an optional `parent`, and
  `clickup_get_task` returns subtasks in compact form.
- Custom fields are parameters of create and update, not a separate tool. The
  server resolves field names to ids using the cached definitions from
  `clickup_get_list` and reports an actionable error on an unknown name.
- Move is a v3 endpoint and needs `status_mappings` when the current status
  does not exist in the destination list. The tool detects that case from the
  cached status sets and returns a precise error naming the missing status
  rather than a raw API failure.

### Comments (3)

`clickup_get_comments` (R), `clickup_create_comment` (W),
`clickup_update_comment` (W) over `/v2/task/{id}/comment`.

### Structure (9)

`clickup_create_space` / `update_space` (W) / `delete_space` (A),
`clickup_create_folder` / `update_folder` (W) / `delete_folder` (A),
`clickup_create_list` / `update_list` (W) / `delete_list` (A).
Endpoints: `/v2/team/{id}/space`, `/v2/space/{id}/folder`,
`/v2/folder/{id}/list`, `/v2/space/{id}/list`, plus the id-scoped variants.
Every mutation invalidates the cached workspace tree.

### Tags (2)

`clickup_list_space_tags` (R), `clickup_set_task_tags` (W). Setting rather
than an add/remove pair: the tool diffs current against desired and issues the
minimum number of calls.

### Time tracking (7)

| Tool | Mode | Backing endpoint |
|---|---|---|
| `clickup_start_timer` | W | `POST /v2/team/{id}/time_entries/start` |
| `clickup_stop_timer` | W | `POST /v2/team/{id}/time_entries/stop` |
| `clickup_get_current_timer` | R | `GET /v2/team/{id}/time_entries/current` |
| `clickup_list_time_entries` | R | `GET /v2/team/{id}/time_entries` |
| `clickup_create_time_entry` | W | `POST /v2/team/{id}/time_entries` |
| `clickup_update_time_entry` | W | `PUT /v2/team/{id}/time_entries/{id}` |
| `clickup_delete_time_entry` | A | `DELETE /v2/team/{id}/time_entries/{id}` |

`billable` and time entry tags are parameters, not separate tools. Durations
accept both milliseconds and human forms such as `1h30m`. Every response states
the resolved duration and the resolved start time in the configured timezone.

### Docs (2, read-only)

`clickup_search_docs` (R) over `GET /v3/workspaces/{id}/docs`,
`clickup_read_doc` (R) over the page listing plus
`GET /v3/workspaces/{id}/docs/{doc_id}/pages/{page_id}`.

### Daily (1)

`clickup_get_my_day` (R). One call returns the running timer, time booked
today, tasks due today and overdue tasks assigned to the authenticated user.
It composes existing endpoint functions rather than adding new API surface, and
replaces four to five separate calls at the start of a session. This is the
single largest token saving in the server.

## 6. Response design

Token efficiency comes mostly from response shaping, not from tool count.

- Markdown by default, JSON on request via `response_format`. Both render from
  the same typed object.
- Empty and null fields are omitted rather than printed.
- Descriptions in list responses are truncated to 200 characters;
  `clickup_get_task` returns them in full, as markdown via
  `include_markdown_description`.
- Names are shown with their id: `Fix login redirect (86abc123)`. Ids are
  always reproduced verbatim from the API.
- Pagination is uniform: `total`, `count`, `offset`, `has_more`, `next_offset`.
  Default limit 25, maximum 100 (the ClickUp page ceiling).
- A character budget (`CHARACTER_LIMIT`, set from `CLICKUP_MAX_RESPONSE_CHARS`,
  default 40000) is enforced on the RENDERED TEXT of each response. Exceeding
  it drops whole items from the end and appends a notice naming the number of
  dropped items and the parameter that would retrieve them. A response with no
  item list is cut by character instead, and its notice claims no count.
  `structuredContent` is deliberately NOT truncated: cutting it would produce a
  payload that violates the tool's own `outputSchema`, which is a worse
  outcome than a large one. A client reading `structuredContent` therefore
  receives the full result, and the budget bounds only what the text view
  costs in tokens.
- Write tools return the entity as ClickUp reports it after the write, never an
  echo of the input.

## 7. Reliability rules

These are requirements, not guidance. Each maps to at least one test.

1. API responses are parsed with zod. An unexpected shape raises a clear error
   instead of rendering `undefined`.
2. A missing value is omitted from the output. Never `N/A`, never a default,
   never a guess. A placeholder in output is read by an agent as a fact.
3. Ids are copied verbatim from API responses and never constructed.
4. Ambiguity is surfaced, not resolved. `clickup_resolve_member("Tiemo")`
   returns every candidate. Silent first-match selection is a data integrity
   defect.
5. Empty results say so explicitly, naming the filter that produced them.
6. Errors never degrade into empty results. 401, 403, 404 and 429 each produce
   a distinct message with a concrete next step.
7. Resolved dates are echoed back in ISO form with offset, so timezone errors
   are visible rather than silent.
8. Truncation is always announced along with the way to get the rest.
9. All input schemas are `.strict()`, so a mistyped parameter fails loudly
   instead of being ignored.

## 8. Error handling

`ClickUpApiError` carries status, ClickUp `ECODE`, and endpoint. `errors.ts`
maps it to a short message plus a next step, for example:

- 401: `Invalid ClickUp token. Check CLICKUP_API_KEY.`
- 403: `No access to list 123. It may belong to a different workspace than CLICKUP_TEAM_ID.`
- 404: `List 123 not found. Use clickup_get_workspace_tree to list valid list ids.`
- 429: retried automatically with backoff derived from `X-RateLimit-Reset`;
  only a persistent limit surfaces, naming the reset time.

Internal stack traces are never returned to the client. Tool errors are
reported inside the result object with `isError: true`, not as protocol errors.

## 9. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLICKUP_API_KEY` | required | Personal token, `pk_...` |
| `CLICKUP_TEAM_ID` | required | Workspace id |
| `CLICKUP_MCP_MODE` | `write` | `read`, `write` or `admin` |
| `CLICKUP_ENABLED_CATEGORIES` | all | Comma separated category filter |
| `CLICKUP_DISABLED_TOOLS` | empty | Explicit tool blocklist |
| `CLICKUP_TIMEZONE` | system | IANA zone for date resolution |
| `CLICKUP_CACHE_TTL_SECONDS` | 300 | Tree and list metadata TTL |
| `CLICKUP_RATE_LIMIT` | 100 | Requests per minute, plan dependent |
| `CLICKUP_MAX_RESPONSE_CHARS` | 40000 | Character budget per response |
| `CLICKUP_HTTP_PORT` | 3000 | HTTP transport only |
| `CLICKUP_HTTP_HOST` | 127.0.0.1 | HTTP transport only |
| `CLICKUP_ALLOWED_ORIGINS` | empty | HTTP transport only |
| `LOG_LEVEL` | `info` | stderr logging |

## 10. Security

- Token read from environment (stdio) or the `Authorization` header (HTTP),
  never from arguments, never logged, never included in error messages.
- Startup validation: a `GET /v2/user` probe fails fast on a bad token.
- HTTP transport binds 127.0.0.1 by default and validates `Origin`.
- Ids are validated against expected formats before being placed into URLs.
- Admin mode is opt-in. Deleting a space or folder is unrecoverable through
  the API, so it must never be reachable from a default configuration.

## 11. Testing

Vitest plus MSW. Three layers:

- Unit: date parsing, formatters, rate limiter, cache, mode and category
  filtering, error mapping. `format/`, `core/dates.ts` and `core/errors.ts`
  are the most heavily covered modules; the earlier claim of 100% coverage on
  them was never true and is not a gate. The enforced floor is the aggregate
  one below.
- Integration: every tool handler against MSW-mocked ClickUp endpoints, using
  fixtures captured from real response shapes. Covers success, empty result,
  404, 429 with retry, and malformed response for each tool.
- Protocol: server driven through the official MCP SDK client over
  `InMemoryTransport`, verifying tool listing per mode, schema validation,
  `structuredContent` presence and error reporting.

Overall target 80% statements, enforced in CI.

## 12. Evaluations

Ten read-only questions in the XML format from the MCP evaluation guide,
answered against the real workspace. Each is independent, needs several tool
calls, has one verifiable answer, and is stable over time. This is the only
layer that measures whether an agent can actually operate the server, which
unit tests do not.

## 13. Documentation

- `README.md`: purpose, install, configuration table, client setup for stdio
  and HTTP, tool table, three worked examples.
- `docs/ARCHITECTURE.md`: the layering above, plus the reasoning.
- `docs/TOOLS.md`: generated from the registry by `npm run docs:tools`, so it
  cannot drift from the code.
- `docs/RELIABILITY.md`: section 7 as a maintained checklist.
- `.env.example`, `CONTRIBUTING.md`, MIT `LICENSE`.

## 14. Stack

Node 24, ESM, TypeScript strict. `@modelcontextprotocol/sdk` 1.30, zod 4,
vitest 4, msw 2. No web framework: the HTTP transport runs on `node:http`.
No HTTP client library: native `fetch`. Package name
`@inviqon/clickup-mcp-server`, binaries `clickup-mcp` (stdio) and
`clickup-mcp-http`.

Canonical API reference during implementation:
`https://developer.clickup.com/llms.txt` and the OpenAPI specification at
`https://developer.clickup.com/docs/open-api-spec.md`.

## 15. Milestones

1. Scaffolding, config, client, rate limiter, cache, error mapping, registry.
2. Navigation and task tools, formatters, first protocol tests.
3. Comments, tags, structure tools.
4. Time tracking plus `clickup_get_my_day`.
5. Docs read-only.
6. HTTP transport, security hardening.
7. Documentation generation, evaluations, CI.
