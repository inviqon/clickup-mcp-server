# @inviqon/clickup-mcp-server

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server
for [ClickUp](https://clickup.com), built for one concrete job: an agent doing
daily task management - planning, updating, commenting, tracking time - without
falling back to the ClickUp web UI.

It exists for two reasons:

- **Rate limits are per API token, not per workspace.** Running your own
  server with client-side throttling and caching keeps a session inside the
  plan tier's limit instead of competing with a shared vendor-hosted server.
- **Tool surface and response shape are ours to tune.** 37 tools, chosen and
  shaped for what a daily-task-management agent actually needs, not a 1:1
  wrapper around every ClickUp endpoint. Responses are compact markdown by
  default (JSON on request), empty and null fields are omitted, and every
  list response carries the same `total` / `count` / `offset` / `has_more`
  envelope - all of it aimed at using fewer tokens per session than issuing
  the equivalent raw API calls would.

It runs two ways from one codebase, with no rewrite between them: locally over
stdio for a single user, or as a remote Streamable HTTP connector serving
multiple tenants at once, each isolated by their own ClickUp credentials.

See [`docs/TOOLS.md`](docs/TOOLS.md) for the full generated tool reference,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the server is built and
why, and [`docs/RELIABILITY.md`](docs/RELIABILITY.md) for the reliability
rules every tool is held to and the tests that enforce them.

## What this is not

Out of scope for this version, all addable later without a structural change:
chat channels and messages, webhooks, guests and user groups, goals/OKRs,
views, audit logs, task and list templates, attachment upload, checklists
(subtasks cover the same need), and Docs *writing* - Docs are read-only here.
There is no OAuth2 authorisation code flow either: authentication is by
personal API token only.

## Install

This package is not published to a registry yet; run it from source.

```bash
git clone <this repository>
cd click-up-mcp
npm install
npm run build
```

The build produces `dist/src/bin/stdio.js` and `dist/src/bin/http.js`, the two
entry points referenced below. `npm link` (or a global `npm install -g .`)
puts the `clickup-mcp` and `clickup-mcp-http` commands on your `PATH`, which
is what the client configuration examples below assume; substitute
`node /absolute/path/to/click-up-mcp/dist/src/bin/stdio.js` wherever you see
`clickup-mcp` if you would rather not link it.

Requires Node.js 24 or newer.

## Configuration

All configuration is environment variables, read once at startup by
`loadConfig` (`src/core/config.ts`). See [`.env.example`](.env.example) for a
copy-pasteable template.

| Variable | Default | Purpose |
|---|---|---|
| `CLICKUP_API_KEY` | required (stdio); may be empty (HTTP) | ClickUp personal API token (`pk_...`). The stdio transport refuses to start without one, and additionally probes `GET /v2/user` at startup so a token ClickUp rejects fails immediately, naming this variable, rather than surfacing as an opaque 401 on whichever tool is called first. The HTTP transport allows an empty value here because it resolves the token per request from the `Authorization` header instead - see [HTTP transport](#http-transport-streamable-http) below. |
| `CLICKUP_TEAM_ID` | required | ClickUp workspace (team) id. The HTTP transport lets a request override this per call via an `X-ClickUp-Team-Id` header. |
| `CLICKUP_MCP_MODE` | `write` | `read`, `write` or `admin`. Controls which tools this server instance advertises: `write` exposes read and write tools but never admin (destructive) ones; `admin` exposes everything. See [Tool reference](#tool-reference). |
| `CLICKUP_ENABLED_CATEGORIES` | all categories | Comma separated category filter. Valid values: `navigation`, `tasks`, `comments`, `structure`, `tags`, `time`, `docs`, `daily`. Leave unset to enable every category. |
| `CLICKUP_DISABLED_TOOLS` | none | Comma separated explicit tool name blocklist, e.g. `clickup_delete_task,clickup_delete_space`. Applied after the mode and category filters, so it can remove a tool those two would otherwise admit. |
| `CLICKUP_TIMEZONE` | the host's system timezone | IANA timezone (e.g. `Europe/Berlin`) used to resolve natural-language dates (`"tomorrow 17:00"`) and to render every date this server returns, so a mismatch between what you meant and what was resolved is visible rather than silent. |
| `CLICKUP_CACHE_TTL_SECONDS` | `300` | How long the cached workspace tree and per-list metadata (statuses, custom fields) stay fresh before the next read re-fetches them. |
| `CLICKUP_RATE_LIMIT` | `100` | Requests per minute the client-side token-bucket limiter allows, plan dependent - keeps this server's own calls inside your ClickUp plan tier's limit rather than relying on ClickUp's 429 responses alone. |
| `CLICKUP_MAX_RESPONSE_CHARS` | `40000` | Character budget enforced on both the rendered text and the `structuredContent` of every tool response. A response over budget drops whole items from the end - the rendered text appends a notice naming how many were dropped and the `offset` that fetches them; `structuredContent` gains `bounded: true`, the same field `clickup_list_tasks` and `clickup_get_my_day` already use for a bounded result. A response with no item list (a single task, a doc page) cannot be item-truncated and is left whole - see [Security and known limits](#security-and-known-limits). |
| `CLICKUP_HTTP_PORT` | `3000` | HTTP transport only: port to listen on. |
| `CLICKUP_HTTP_HOST` | `127.0.0.1` | HTTP transport only: host to bind to. Binding anywhere other than loopback is a deliberate choice - see [Security](#security-and-known-limits). |
| `CLICKUP_ALLOWED_ORIGINS` | none | HTTP transport only: comma separated list of `Origin` header values to accept. A request with no `Origin` header at all is always allowed (non-browser MCP clients never send one); a request that *does* carry an `Origin` is rejected unless it is in this list. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Gates the startup readiness line each transport writes to stderr (`src/core/logger.ts`): a message is written when its level is at or above `LOG_LEVEL`, so `LOG_LEVEL=warn` or `error` suppresses the readiness line while the default `info` and `debug` both keep it. This server never writes to stdout (`console.log` is forbidden under `src/`), and it has no other log lines yet - this is the one thing `LOG_LEVEL` currently controls. |

## Client configuration

### Claude Code (stdio)

```bash
claude mcp add clickup \
  --env CLICKUP_API_KEY=pk_your_token_here \
  --env CLICKUP_TEAM_ID=9007123456 \
  -- clickup-mcp
```

Add any other variable from the table above with additional `--env` flags,
for example `--env CLICKUP_MCP_MODE=admin` to enable the destructive tools.

### Claude Desktop (stdio)

Add an entry to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "clickup-mcp",
      "env": {
        "CLICKUP_API_KEY": "pk_your_token_here",
        "CLICKUP_TEAM_ID": "9007123456"
      }
    }
  }
}
```

If you did not `npm link` the package, replace `"command": "clickup-mcp"`
with `"command": "node", "args": ["/absolute/path/to/click-up-mcp/dist/src/bin/stdio.js"]`.

### HTTP transport (Streamable HTTP)

For a remote, multi-tenant deployment. Each request carries its own
credentials, so one running server instance can serve many ClickUp accounts
at once without any of them sharing a cache or rate limiter
(`src/http/tenant-store.ts` keys a context per token+team pair).

Start it:

```bash
CLICKUP_TEAM_ID=9007123456 clickup-mcp-http
# clickup-mcp-http ready: listening on 127.0.0.1:3000, mode=write
```

`CLICKUP_API_KEY` may be left empty here - see the security note below - and
every request must then supply its own credentials as headers against the
single route, `POST /mcp`:

There is deliberately **no startup token probe on this transport**, unlike
stdio. Each request resolves its own token, so the equivalent check would be
a `GET /v2/user` round trip added to every single tool call, to re-learn
something the call's own first upstream request reports anyway. A bad token
here surfaces as ClickUp's own 401, mapped to a hint naming
`CLICKUP_API_KEY` as worth checking (see `src/core/errors.ts` for the exact
wording - a 401 can also mean the token could not resolve the requested
resource, not that the token itself is bad), on the first tool the client
calls.

- `Authorization: <token>` or `Authorization: Bearer <token>` (both accepted;
  the `Bearer ` prefix, if present, is stripped before the token is sent to
  ClickUp). Falls back to `CLICKUP_API_KEY` when the header is absent.
- `X-ClickUp-Team-Id: <team id>` (optional). Falls back to `CLICKUP_TEAM_ID`
  when absent.

A generic Streamable HTTP MCP client configuration looks like:

```json
{
  "mcpServers": {
    "clickup": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "pk_your_token_here",
        "X-ClickUp-Team-Id": "9007123456"
      }
    }
  }
}
```

## Tool reference

37 tools across 8 categories: navigation (5), tasks (8), comments (3),
structure (9), tags (2), time tracking (7), docs (2, read-only), daily (1).
Every tool is one of three modes, which double as its MCP annotations
(`annotationsFor`, `src/core/registry.ts`):

- **read** - `readOnlyHint: true`, always visible.
- **write** - visible in `write` and `admin` mode.
- **admin** - destructive (`destructiveHint: true`), visible only in
  `CLICKUP_MCP_MODE=admin`.

Four of the five admin delete tools - `clickup_delete_task`,
`clickup_delete_space`, `clickup_delete_folder` and `clickup_delete_list` -
additionally require a `confirm_name` argument that must match the entity's
current name, read fresh at call time; the DELETE is never reached on a
mismatch, so a stale or guessed id cannot destroy the wrong thing. The fifth,
`clickup_delete_time_entry`, has no such guard: a ClickUp time entry has no
name to confirm against. There is nothing to type back, so requiring a
confirmation string there would be theatre rather than a check - identify the
entry with `clickup_list_time_entries` before deleting it.

The full list, with input parameters, output fields and annotations for each
tool, is generated straight from the code at
[`docs/TOOLS.md`](docs/TOOLS.md) - run `npm run docs:tools` to regenerate it
after any change to a tool's shape or description.

## Worked examples

These are real tool call sequences, with real tool names and the arguments
those tools actually accept (see [`docs/TOOLS.md`](docs/TOOLS.md) to check
any of them). Every example assumes `response_format` is left at its default,
`markdown`.

### 1. Start a timer on a task found by search

```
clickup_search_tasks({ query: "login redirect" })
```

Returns matching tasks with their ids. Suppose it surfaces
`Fix login redirect (86abc123)`:

```
clickup_start_timer({
  task_id: "86abc123",
  description: "Investigating the login redirect bug"
})
```

`clickup_start_timer` checks for an already-running timer first and refuses
to start a new one if it finds one, because ClickUp silently stops (and loses
the tracked time on) whatever was running the moment a new timer starts.

### 2. Create a task with a due date and a custom field

First, find the list's id (from `clickup_get_workspace_tree`) and see what
custom fields it defines and what its status names are:

```
clickup_get_list({ list_id: "901234567" })
```

Suppose that list has a custom field named `Story Points`. Create the task:

```
clickup_create_task({
  list_id: "901234567",
  name: "Fix login redirect",
  due_date: "tomorrow 17:00",
  priority: "high",
  custom_fields: { "Story Points": 5 }
})
```

`due_date` accepts natural language or ISO; the response echoes the resolved
due date with its timezone offset, so a timezone mistake is visible rather
than silent. `custom_fields` is keyed by the field's *name*, not its id - the
server resolves the name against the list's own field definitions and rejects
an unknown one by naming the fields that do exist, before writing anything.

### 3. Review the day

```
clickup_get_my_day({})
```

One call returns the currently running timer (if any), time already tracked
today, tasks due today, and overdue tasks - all for the authenticated user.
It composes four existing reads rather than adding new API surface, and is
meant to be the first call of a session: if any one of the four pieces fails,
the other three still render, with the failed one named explicitly rather
than silently missing. Pass `{ date: "tomorrow" }` (or any date `resolveDate`
accepts) to preview a different day instead of today.

## Security and known limits

- **The HTTP transport binds to `127.0.0.1` by default and validates
  `Origin`.** A request that carries an `Origin` header not in
  `CLICKUP_ALLOWED_ORIGINS` is rejected with 403; a request with no `Origin`
  at all (the normal case for a non-browser MCP client) is always allowed.
  This is a DNS-rebinding defence for the common case of a locally bound
  server, not a substitute for real authentication - setting
  `CLICKUP_HTTP_HOST` to bind beyond loopback and expose this server on a
  network is a deliberate act with consequences: `resolveToken` accepts any
  non-empty `Authorization` header value before ClickUp itself ever validates
  it, so a caller who can merely reach the port can force a `ClickUpContext`
  to be built (and cached, up to a bound) for any token they choose, valid or
  not. Put this behind your own network controls (a reverse proxy with real
  auth, a VPN, a firewall) before binding it anywhere but loopback.
- **`clickup_search_docs` only sees the workspace's first 100 docs.** ClickUp's
  Docs v3 API has no free-text filter, so this tool lists docs and matches
  locally; a workspace with more than 100 docs can have a match this search
  never reaches. The tool's response says so explicitly (`bounded: true`)
  when the cap is hit.
- **`clickup_list_tasks` and `clickup_search_tasks` walk at most 5 upstream
  pages (500 tasks)** before giving up and reporting what they found so far,
  with `bounded: true` in the response when that cap was hit before ClickUp
  confirmed the end of the result set. Narrow the query (a list or space id,
  more specific filters) to search a smaller pool and get a result that is
  not just a probable answer.
- **The character budget bounds both the rendered text and `structuredContent`,
  at item granularity.** `CLICKUP_MAX_RESPONSE_CHARS` caps the markdown (or
  JSON) text view of a response and the `structuredContent` field a client
  reads directly; an over-budget response drops whole items from the end of
  either, never a raw byte cut, so `structuredContent` always stays valid
  against the tool's own `outputSchema` - the dropped-item notice appears in
  the rendered text, and `bounded: true` appears in `structuredContent`
  itself. A response with no item list (a single task, a doc page) has
  nothing to drop and is left whole even when it exceeds the budget - only
  the rendered text falls back to a character cut in that case. Use `limit`
  and `offset` to bound the actual result size when that matters.
- **Docs are read-only in this version.** There is no tool to create or edit
  a Doc or a Doc page.
- **Chat, webhooks, goals, views, guests, user groups, audit logs, templates,
  attachment upload and checklists are out of scope for this version** (see
  [What this is not](#what-this-is-not)).
- **`clickup_update_time_entry`'s request contract for a partial
  `start`-or-`duration` update is unverified against a live ClickUp account.**
  ClickUp's own "Update a Time Entry" reference documents `start` as requiring
  `end` alongside it, but there is no "get one time entry by id" endpoint to
  read an entry's current `end` back before writing, and this tool's schema
  only accepts `start`/`duration`. It sends exactly the fields you pass,
  rather than fabricating a plausible `end`. If updating `start` alone 400s
  in practice against your workspace, that is the sign this assumption needs
  revisiting - see the comment inside `updateTimeEntryTool`'s handler in
  `src/tools/time.ts`.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
