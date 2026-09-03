# @inviqon/clickup-mcp-server

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server
for [ClickUp](https://clickup.com). It gives an agent the tools to run a real
working day in ClickUp - planning, updating, commenting, tracking time -
without falling back to the web UI. Built for anyone who wants their agent
talking to ClickUp under their own token and their own rate limit, not a
shared vendor-hosted one.

## Why it exists

Two reasons, in order of how much they actually bite:

1. **Rate limits are enforced per API token, not per workspace.** The
   established hosted ClickUp MCP option moved to a paid tier with a hard
   cap of 100 requests per 24 hours. Self-hosting this server means your
   agent runs against your own ClickUp plan's own limit - by default,
   [100 requests per minute](#configuration), not 100 requests a day shared
   across every user of someone else's server.
2. **Tool surface and response shape are yours to shape.** 40 tools, chosen
   and shaped for daily task management, not a 1:1 wrapper around every
   ClickUp endpoint. What a tool returns, and how compactly, matters more
   for an agent's reliability than how many endpoints are covered - see
   below.

It runs two ways from one codebase, with no rewrite between them: locally
over stdio for a single user, or as a remote Streamable HTTP connector
serving multiple tenants at once, each isolated by their own ClickUp
credentials.

## What makes it different

Most MCP servers wrap an API. This one is built around a rule that most
tool-calling agents quietly violate under pressure: **never present a guess
as a fact.** Every response this server produces follows the same handful of
rules, and every rule has a named test enforcing it - see
[`docs/RELIABILITY.md`](docs/RELIABILITY.md) for the full list of nine, each
linked to the test file and title that checks it.

The two most concrete ones:

- **A missing value is omitted, never guessed at.** No `null`, no `"N/A"`,
  no invented `0`. Take `clickup_time_report`: asked for a specific member's
  logged hours, a token that cannot see that member's entries (or a member
  who genuinely logged nothing) does not come back as `0h` - a bare `0h`
  would be indistinguishable from "worked zero hours" to anyone reading the
  report, and one of those is a fact while the other is an artifact of
  permissions. Instead the response states the ambiguity explicitly: nothing
  tracked, or this token cannot see it - it is not established which.
- **Ambiguity is surfaced, not resolved.** `clickup_resolve_member("Tiemo")`
  against a workspace with two people named Tiemo returns both candidates
  with their emails, rather than silently picking one and hoping. Silently
  narrowing to a guess is exactly the kind of thing that looks fine in a
  demo and corrupts a real session.

The same discipline runs through the rest: an upstream error (401, 403, 404,
429) always produces a specific message with a next step, never something
that reads like "nothing found"; a bounded list result (paged out, or capped
by ClickUp's own API limits) says explicitly that it is bounded and how to
get the rest; every id in a response is copied verbatim from ClickUp, never
reconstructed; every resolved date is echoed back with its timezone offset,
so a timezone mistake is visible instead of silent.

## Install

Requires Node.js 24 or newer. Not published to a package registry yet - run
it from source:

```bash
git clone https://github.com/inviqon/clickup-mcp-server.git
cd clickup-mcp-server
npm install
npm run build
```

The build produces `dist/src/bin/stdio.js` and `dist/src/bin/http.js`.
`npm link` (or `npm install -g .`) puts `clickup-mcp` and `clickup-mcp-http`
on your `PATH`, which is what the examples below assume; substitute
`node /absolute/path/to/clickup-mcp-server/dist/src/bin/stdio.js` wherever
you see `clickup-mcp` if you would rather not link it.

## Configure

All configuration is environment variables, read once at startup by
`loadConfig` (`src/core/config.ts`). See [`.env.example`](.env.example) for a
copy-pasteable template.

| Variable | Default | Purpose |
|---|---|---|
| `CLICKUP_API_KEY` | required (stdio); may be empty (HTTP) | ClickUp personal API token (`pk_...`). The stdio transport refuses to start without one, and additionally probes `GET /v2/user` at startup so a token ClickUp rejects fails immediately, naming this variable, rather than surfacing as an opaque 401 on whichever tool is called first. The HTTP transport allows an empty value here because it resolves the token per request from the `Authorization` header instead - see [HTTP transport](#http-transport-streamable-http) below. |
| `CLICKUP_TEAM_ID` | required | ClickUp workspace (team) id. The HTTP transport lets a request override this per call via an `X-ClickUp-Team-Id` header. |
| `CLICKUP_MCP_MODE` | `write` | `read`, `write` or `admin`. Controls which tools this server instance advertises: `write` exposes read and write tools but never admin (destructive) ones; `admin` exposes everything. See [The tool surface](#the-tool-surface) and [`SECURITY.md`](SECURITY.md). |
| `CLICKUP_ENABLED_CATEGORIES` | all categories | Comma separated category filter. Valid values: `navigation`, `tasks`, `comments`, `structure`, `tags`, `time`, `docs`, `daily`. Leave unset to enable every category. |
| `CLICKUP_DISABLED_TOOLS` | none | Comma separated explicit tool name blocklist, e.g. `clickup_delete_task,clickup_delete_space`. Applied after the mode and category filters, so it can remove a tool those two would otherwise admit. |
| `CLICKUP_TIMEZONE` | the host's system timezone | IANA timezone (e.g. `Europe/Berlin`) used to resolve natural-language dates (`"tomorrow 17:00"`) and to render every date this server returns, so a mismatch between what you meant and what was resolved is visible rather than silent. |
| `CLICKUP_CACHE_TTL_SECONDS` | `300` | How long the cached workspace tree and per-list metadata (statuses, custom fields) stay fresh before the next read re-fetches them. |
| `CLICKUP_RATE_LIMIT` | `100` | Requests per minute the client-side token-bucket limiter allows, plan dependent - keeps this server's own calls inside your ClickUp plan tier's limit rather than relying on ClickUp's 429 responses alone. |
| `CLICKUP_MAX_RESPONSE_CHARS` | `40000` | Character budget enforced on both the rendered text and the `structuredContent` of every tool response. A response over budget drops whole items from the end - the rendered text appends a notice naming how many were dropped and the `offset` that fetches them; `structuredContent` gains `bounded: true`. A response with no item list (a single task, a doc page) cannot be item-truncated and is left whole - see [Known limits](#known-limits). |
| `CLICKUP_HTTP_PORT` | `3000` | HTTP transport only: port to listen on. |
| `CLICKUP_HTTP_HOST` | `127.0.0.1` | HTTP transport only: host to bind to. Binding anywhere other than loopback is a deliberate choice with consequences - see [`SECURITY.md`](SECURITY.md). |
| `CLICKUP_ALLOWED_ORIGINS` | none | HTTP transport only: comma separated list of `Origin` header values to accept. A request with no `Origin` header at all is always allowed (non-browser MCP clients never send one); a request that *does* carry an `Origin` is rejected unless it is in this list. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Gates the startup readiness line each transport writes to stderr. This server never writes to stdout (`console.log` is forbidden under `src/`, since stdout is the stdio transport's own protocol channel), and it has no other log lines yet - this is the one thing `LOG_LEVEL` currently controls. |

### Claude Code (stdio)

```bash
claude mcp add clickup --scope user \
  --env CLICKUP_API_KEY=pk_your_token_here \
  --env CLICKUP_TEAM_ID=9007123456 \
  -- clickup-mcp
```

Use `--scope user`, not `--scope project`. Project scope writes the command
(including any `--env` values on it) into a config file meant to be checked
into the repository - your ClickUp token has no business sitting in git
history. Add any other variable from the table above with additional `--env`
flags, for example `--env CLICKUP_MCP_MODE=admin` to enable the destructive
tools.

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
with `"command": "node", "args": ["/absolute/path/to/clickup-mcp-server/dist/src/bin/stdio.js"]`.

### HTTP transport (Streamable HTTP)

For a remote, multi-tenant deployment. Each request carries its own
credentials, so one running server instance can serve many ClickUp accounts
at once without any of them sharing a cache or rate limiter - see
[`SECURITY.md`](SECURITY.md) for what this transport does and does not
protect against, in particular before binding it to anything but loopback.

Start it:

```bash
CLICKUP_TEAM_ID=9007123456 clickup-mcp-http
# clickup-mcp-http ready: listening on 127.0.0.1:3000, mode=write
```

`CLICKUP_API_KEY` may be left empty here, and every request must then supply
its own credentials as headers against the single route, `POST /mcp`:

- `Authorization: <token>` or `Authorization: Bearer <token>` (both
  accepted; the `Bearer ` prefix, if present, is stripped before the token
  is sent to ClickUp). Falls back to `CLICKUP_API_KEY` when the header is
  absent.
- `X-ClickUp-Team-Id: <team id>` (optional). Falls back to `CLICKUP_TEAM_ID`
  when absent.

There is deliberately no startup token probe on this transport, unlike
stdio - each request resolves its own token, so the equivalent check would
add a `GET /v2/user` round trip to every single tool call. A bad token here
surfaces as ClickUp's own 401, mapped to a hint naming `CLICKUP_API_KEY` as
worth checking, on the first tool the client calls.

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

## The tool surface

40 tools across 8 categories:

| Category | Count | Covers |
|---|---|---|
| Navigation | 5 | Workspace tree, list details, member lookup, task search |
| Tasks | 10 | Get, list, create, update, bulk update, move, delete, link, time in status (single + bulk) |
| Comments | 3 | List, create, update |
| Structure | 9 | Create/update/delete for spaces, folders, lists |
| Tags | 2 | List space tags, set a task's tags |
| Time tracking | 8 | Start/stop/current timer, list/create/update/delete entries, time report |
| Docs | 2 | Search docs, read a doc (read-only) |
| Daily | 1 | `clickup_get_my_day` - the day's opening "catch me up" in one call |

Every tool is one of three modes, which double as its MCP annotations
(`annotationsFor`, `src/core/registry.ts`):

- **read** - `readOnlyHint: true`, always visible.
- **write** - visible in `write` and `admin` mode.
- **admin** - destructive (`destructiveHint: true`), visible only in
  `CLICKUP_MCP_MODE=admin`. See [`SECURITY.md`](SECURITY.md) for the guard
  each delete tool applies before it will touch anything.

The full reference - every tool's input parameters, output fields and
annotations, generated straight from the code - is at
[`docs/TOOLS.md`](docs/TOOLS.md). Run `npm run docs:tools` to regenerate it
after any change to a tool's shape or description; `tests/docs.test.ts`
fails the build if it drifts.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the server is
layered and why.

## Worked examples

Real tool call sequences, with real tool names and the arguments those tools
actually accept (check any of them against
[`docs/TOOLS.md`](docs/TOOLS.md)). Every example assumes `response_format`
is left at its default, `markdown`.

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
to start a new one if it finds one, because ClickUp silently stops (and
loses the tracked time on) whatever was running the moment a new timer
starts.

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

`due_date` accepts natural language or ISO; the response echoes the
resolved due date with its timezone offset, so a timezone mistake is
visible rather than silent. `custom_fields` is keyed by the field's *name*,
not its id - the server resolves the name against the list's own field
definitions and rejects an unknown one by naming the fields that do exist,
before writing anything.

### 3. Review the day

```
clickup_get_my_day({})
```

One call returns the currently running timer (if any), time already
tracked today, tasks due today, and overdue tasks - all for the
authenticated user. It composes four existing reads rather than adding new
API surface, and is meant to be the first call of a session: if any one of
the four pieces fails, the other three still render, with the failed one
named explicitly rather than silently missing. Pass `{ date: "tomorrow" }`
(or any date `resolveDate` accepts) to preview a different day instead of
today.

## Known limits

- **Docs are read-only in v1.** There is no tool to create or edit a Doc or
  a Doc page.
- **`clickup_search_docs` only sees the workspace's first 100 docs.**
  ClickUp's Docs v3 API has no free-text filter, so this tool lists docs and
  matches locally; a workspace with more than 100 docs can have a match this
  search never reaches. The response says so explicitly (`bounded: true`)
  when the cap is hit.
- **`clickup_list_tasks` and `clickup_search_tasks` walk at most 5 upstream
  pages (500 tasks)** before giving up and reporting what they found so far,
  with `bounded: true` in the response when that cap was hit before ClickUp
  confirmed the end of the result set. Narrow the query (a list or space id,
  more specific filters) to search a smaller pool and get a result that is
  not just a probable answer.
- **Chat, webhooks, goals, views, guests, user groups, audit logs,
  templates, attachment upload and checklists are out of scope for this
  version**, all addable later without a structural change. There is no
  OAuth2 authorisation code flow either - authentication is by personal API
  token only.
- **Time-in-status needs a ClickUp plan that includes it.**
  `clickup_get_task_time_in_status` and its bulk counterpart call an
  endpoint ClickUp rejects outright ("Time In Status is not available on
  your plan") on plans that lack the "Total time in Status" feature, rather
  than returning zeros.
- **`clickup_update_time_entry`'s request contract for a partial
  `start`-or-`duration` update is unverified against a live ClickUp
  account.** ClickUp's own "Update a Time Entry" reference documents `start`
  as requiring `end` alongside it, but there is no "get one time entry by
  id" endpoint to read an entry's current `end` back before writing, and
  this tool's schema only accepts `start`/`duration`. It sends exactly the
  fields you pass, rather than fabricating a plausible `end`. If updating
  `start` alone 400s in practice against your workspace, that is the sign
  this assumption needs revisiting - see the comment inside
  `updateTimeEntryTool`'s handler in `src/tools/time.ts`.

See [`SECURITY.md`](SECURITY.md) for the HTTP transport's posture, tenant
isolation, and the three access modes.

## Development

```bash
npm install
npm run typecheck          # tsc --noEmit over src/, scripts/ and tests/
npx vitest run              # the test suite
npx vitest run --coverage   # with the coverage report
npm run build                 # tsc, emits dist/
npm run docs:tools           # build, then regenerate docs/TOOLS.md from ALL_TOOLS
```

`docs/TOOLS.md` is generated, not hand-maintained - `tests/docs.test.ts`
asserts it matches `renderToolDocs(ALL_TOOLS)` byte for byte, so a tool
changed without regenerating the docs fails the test suite rather than
silently going stale. Coverage thresholds (statements 80, branches 75,
functions 80, lines 80) are enforced in aggregate over `src/**/*.ts`, not
per file.

There is also a ten-question evaluation set
(`evals/clickup-daily.template.xml`) that checks whether an agent connected
to this server, given only its tools, can navigate a real ClickUp workspace
to a correct answer - a small, human-legible check on end-to-end tool
usability that the unit and integration tests under `tests/` cannot cover
themselves. The filled set names real workspace data and is deliberately
not committed; see [`evals/README.md`](evals/README.md) for how to build
and run your own against a workspace you control.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, including
how to add a new tool.

## Licence and contributing

MIT licensed - see [`LICENSE`](LICENSE). Contributions welcome; see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, and
[`SECURITY.md`](SECURITY.md) to report a vulnerability privately rather than
through a public issue.
