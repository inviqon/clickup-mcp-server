# Security Policy

This server holds a ClickUp personal API token and can optionally listen on a
network port, so both deserve a direct explanation of what actually happens
in the code, not just a promise.

## The token: where it lives, and where it does not

There are exactly two ways this server learns a ClickUp token:

- **stdio**: `CLICKUP_API_KEY` from the process environment, read once at
  startup by `loadConfig` (`src/core/config.ts`).
- **HTTP**: the `Authorization` header of each request (`Bearer <token>` or
  the bare token), resolved per request by `resolveToken` in
  `src/bin/http.ts`. `CLICKUP_API_KEY` is used only as a fallback when a
  request carries no header.

From there:

- **It is never logged.** `src/core/logger.ts` writes exactly one line per
  transport at startup (`clickup-mcp ready: ...` /
  `clickup-mcp-http ready: ...`), and neither line contains the token or any
  request header. There is no other logging in `src/`; `console.log` under
  `src/` is forbidden and enforced by `tests/stdout-guard.test.ts`, since
  stdout is the stdio MCP transport's own protocol channel.
- **It never appears in an error message.** `tests/clickup/client.test.ts`
  - *"never includes the token in an error message"* - sends a live token
  through a request that fails with a 403 and asserts the token string does
  not appear anywhere in the thrown error, including its own property
  values. `tests/http.test.ts` adds two more: *"never echoes the token in an
  error body"* and *"rejects a malformed JSON body without leaking the
  token"*, both asserting the response body sent back to the client never
  contains it either.
- **It is never a cleartext map key.** The HTTP transport keeps one
  `ClickUpContext` per tenant in `TenantStore` (`src/http/tenant-store.ts`),
  keyed by `credentialKey` (`src/core/context.ts`), which is
  `sha256(token).slice(0, 16) + ":" + teamId` - the raw token is hashed
  before it becomes a key, never stored as one. `tests/core/context.test.ts`
  - *"never contains the raw token"* - asserts the key produced for a real
  token string does not contain that string.
- **It is not persisted anywhere.** Nothing under `src/` writes the token to
  disk. It lives only in memory, for the life of the process (stdio) or of
  one cached tenant context (HTTP, bounded - see below).

The token is sent to exactly one place: `https://api.clickup.com`, in the
`Authorization` header of the upstream request
(`src/clickup/client.ts`, *"sends the token in the Authorization header
without a Bearer prefix"*).

## The HTTP transport's posture

The HTTP transport (`src/bin/http.ts`) is designed to be safe to run on a
single machine for yourself, and unsafe to expose without extra work.

- **Binds to `127.0.0.1` by default** (`CLICKUP_HTTP_HOST`,
  `src/core/config.ts`). `tests/http.test.ts` - *"binds to loopback only"*
  - asserts the default bind address directly.
- **Validates the `Origin` header** before anything else happens.
  `isOriginAllowed` (`src/bin/http.ts`) is called first in
  `handleMcpRequest`, before the request body is read, before a token is
  resolved, before any ClickUp call. A request carrying an `Origin` header
  not in `CLICKUP_ALLOWED_ORIGINS` is rejected with 403
  (`tests/http.test.ts` - *"rejects a disallowed Origin"* and *"rejects a
  disallowed Origin before making any ClickUp call"*, the latter asserting
  the upstream ClickUp endpoint is never even reached). A request with **no**
  `Origin` header is always allowed - local, non-browser MCP clients
  (`curl`, another local process) never send one, so this is a DNS-rebinding
  defence against a malicious web page silently talking to a server bound on
  `localhost`, not a general authentication mechanism. It does nothing to
  stop a non-browser client with network access to the port.
- **Runs stateless.** Each request gets a fresh `McpServer` and
  `StreamableHTTPServerTransport` (`enableJsonResponse: true`, no session
  id); nothing about one request's handling persists on the transport
  itself into the next.
- **Bounds the request body.** `MAX_BODY_BYTES` (5 MiB,
  `src/bin/http.ts`) caps how much of an incoming request this server will
  buffer before giving up with a 413, so a single oversized POST cannot
  force unbounded memory growth.
- **Bounds the tenant store.** `TenantStore` (`src/http/tenant-store.ts`)
  caps itself at `MAX_TENANTS` (1000) with least-recently-used eviction, and
  additionally evicts any tenant idle for over an hour
  (`IDLE_EVICTION_MS`), so a caller who can reach the port cannot grow the
  process's memory without limit simply by presenting one new bogus token
  per request.

**Exposing this server beyond loopback is a deliberate act with real
consequences, not a supported deployment mode as shipped.**
`resolveToken` accepts any non-empty `Authorization` header value and hands
it straight to `TenantStore.contextFor`, which builds and caches a
`ClickUpContext` for it - before ClickUp itself ever validates that token.
Nothing at this layer verifies the caller is who they claim to be beyond
"presented some string." If you set `CLICKUP_HTTP_HOST` to bind beyond
loopback, put this behind your own network controls first: a reverse proxy
doing real authentication, a VPN, or a firewall restricting who can reach
the port at all. The `Origin` check above is not a substitute for any of
those.

## Tenant isolation

Each `(token, teamId)` pair gets its own `ClickUpContext` - its own
`TtlCache` and its own `RateLimiter` - built fresh by `createContext`
(`src/core/context.ts`) and cached by `TenantStore`. `createContext` never
reads or writes shared state, so isolation is structural: one tenant is
never handed another tenant's cache or rate-limit budget, because there is
no shared object either could reach into. `tests/http.test.ts` -
*"isolates cache between two different tokens - the second token triggers
its own upstream fetch"* - exercises this directly.

## The three access modes

`CLICKUP_MCP_MODE` is `read`, `write` (default) or `admin`:

- **`read`**: read-only tools only.
- **`write`**: read and write tools, never destructive ones.
- **`admin`**: everything, including the five delete tools.

A tool's mode is not a label it can misreport: `annotationsFor(mode)`
(`src/core/registry.ts`) derives both a tool's visibility (via
`selectTools`) and its MCP annotations (`readOnlyHint`, `destructiveHint`,
...) from the same one `mode` field, so a tool cannot be visible outside its
intended mode while also claiming to be safe.

The five delete tools - `clickup_delete_task`, `clickup_delete_space`,
`clickup_delete_folder`, `clickup_delete_list` and
`clickup_delete_time_entry` - exist only in `admin` mode, and are not
reachable at all in `read` or `write`.

Four of the five additionally require a `confirm_name` argument
(`assertConfirmName`, `src/tools/confirm.ts`) that must exactly match the
entity's real, freshly-read name before the delete call is ever made - a
stale or guessed id cannot destroy the wrong thing, because the caller has
to have already read the entity and typed its actual name back. This check
runs strictly before the delete endpoint is called. `clickup_delete_time_entry`
is the one exception: a ClickUp time entry has no name to confirm against,
so there is nothing meaningful to type back - see the comment in
`src/tools/confirm.ts` for why a confirmation string there would be theatre
rather than a guard. Identify the entry with `clickup_list_time_entries`
first instead.

**Deleting a space or a list through the ClickUp API is unrecoverable.**
There is no undo, and no trash this server can restore from. Only grant
`admin` mode to a deployment where that is an acceptable risk, and consider
whether a given integration needs `admin` at all - most daily task
management does not.

This server also trusts whatever permissions the supplied ClickUp token
actually carries. It does not maintain its own permission model on top of
ClickUp's; `CLICKUP_MCP_MODE` controls which *tools this server will call*,
not what the token is *allowed to do* once ClickUp receives the call. A
token with workspace-owner permissions behaves the same way in `admin` mode
regardless of who is holding the MCP client.

## Known limitations

- Coverage thresholds (`vitest.config.ts`: statements 80, branches 75,
  functions 80, lines 80) are enforced in aggregate over `src/**/*.ts`, not
  per file. A file below any of those numbers individually can still pass
  if others compensate; it is a project-wide floor, not a per-file
  guarantee.
- The `Origin` allowlist is a DNS-rebinding defence for a locally bound
  server, not an authentication mechanism. See "The HTTP transport's
  posture" above.
- `clickup_update_time_entry`'s request contract for a partial `start`
  update is unverified against a live ClickUp account (see `README.md`) -
  not a security issue, but worth knowing before relying on it in an
  automated write path.

## Supported versions

This project is at `0.1.0` and pre-1.0. Only the latest published release
receives fixes, security or otherwise; there is no back-porting to older
versions while the project is pre-1.0. Update to the latest release before
reporting an issue you have not reproduced there.

## Reporting a vulnerability

Please do not open a public GitHub issue for a suspected vulnerability.

Email **security@inviqon.com** with what you found, how to reproduce it, and
its likely impact. This is a small, part-time-maintained open source
project, not a security team with an SLA: expect an acknowledgement within
a few days, not hours, and a timeline for a fix discussed once the report is
understood rather than promised up front. Please give us a reasonable
window to ship a fix before any public disclosure.
