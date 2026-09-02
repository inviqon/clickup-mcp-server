# Architecture

This describes how `@inviqon/clickup-mcp-server` is layered, and - more than
the layout itself - the reasoning behind the decisions that are not obvious
from reading one file in isolation. File paths below are relative to the
repository root.

## Layout

```
src/
  core/
    context.ts        ClickUpContext: client, cache, teamId, mode, timezone, maxResponseChars
    registry.ts        ToolDefinition, annotationsFor, selectTools, RESPONSE_FORMAT_SHAPE
    config.ts          loadConfig: env -> ServerConfig
    errors.ts           ClickUp errors -> short, actionable agent-facing messages
    dates.ts             natural language dates <-> epoch ms, timezone aware
    cache.ts               TTL cache
    rate-limiter.ts    token bucket
  clickup/
    client.ts           fetch wrapper: auth, retry, 429 backoff, zod-parsed responses
    pagination.ts     bounded upstream page walking
    schemas.ts          zod schemas for API RESPONSES (not only tool inputs)
    endpoints/           thin typed functions per resource: tasks, structure,
                         time, comments, tags, docs, workspace
  tools/                 one file per category; each exports an AnyToolDefinition[]
    navigation.ts tasks.ts comments.ts structure.ts tags.ts time.ts docs.ts myday.ts
    index.ts               ALL_TOOLS = the concatenation of all of the above
  format/                 typed object -> compact markdown, one renderer per shape
  server.ts               buildServer: registry + config + context factory -> McpServer
  bin/
    stdio.ts               env -> one Context -> StdioServerTransport
    http.ts                 headers -> one Context per request -> StreamableHTTPServerTransport
scripts/
  generate-tool-docs.ts  ALL_TOOLS -> docs/TOOLS.md (this is renderToolDocs, tested for drift)
```

Each layer only calls the one below it: `tools/` calls `clickup/endpoints/`
and `format/`, never `clickup/client.ts` directly; `clickup/endpoints/` calls
`clickup/client.ts`, never a tool. `core/` has no dependency on `tools/` or
`format/` - neither is ever imported from `core/`. It is NOT independent of
`clickup/`, though: `core/context.ts` imports `ClickUpClient`
(`src/clickup/client.ts`) at runtime to build a `ClickUpContext`, and
`clickup/client.ts` in turn imports `core/errors.ts` and
`core/rate-limiter.ts` - so `core/` and `clickup/` depend on each other, not
one only on the other. What keeps this from being a real circular-import
problem is that the edge going the other way, `clickup/endpoints/*.ts`
depending on `ClickUpContext`, is a type-only import (`import type`), erased
before either module runs; `core/` is still "the layer everything else is
built on" in the sense that neither `tools/` nor `format/` ever reaches back
into it in reverse, not in the sense of having zero edges toward `clickup/`.

## The tool contract

Every tool in `src/tools/` is a `ToolDefinition<TIn, TOut>`
(`src/core/registry.ts`):

```ts
type ToolDefinition<TIn, TOut> = {
  name: string                        // clickup_<verb>_<resource>
  title: string
  description: string                 // purpose, boundaries, worked examples
  category: Category
  mode: 'read' | 'write' | 'admin'    // drives visibility AND annotations
  inputSchema: TIn                    // a ZodRawShape, strict-parsed by the server
  outputSchema: TOut                  // a ZodRawShape
  handler: (args, ctx: ClickUpContext) => Promise<TOut>
  render: (out: TOut, ctx: ClickUpContext) => string   // markdown, pure function of `out`
}
```

### Handlers return typed objects, never strings

`handler` returns the tool's `outputSchema` type, a plain object - it never
builds a string. `server.ts`'s `makeWrapper` is the one place that turns that
object into what the client actually receives: it emits the object verbatim
as `structuredContent`, and separately renders `content` as either markdown
(via the tool's own `render`) or `JSON.stringify(out)`, chosen by the caller's
`response_format` argument. Three things follow from routing both outputs
through one typed object instead of building markdown and JSON separately in
each tool:

- Markdown and JSON cannot drift from each other. There is exactly one source
  of truth per response - the object `handler` returned - and both
  presentations are pure functions of it.
- Tests assert on the typed object a handler returns, not on markdown string
  matching. `render` is tested separately, as a pure function of a fixture
  object - it does not need a mocked ClickUp API to test at all.
- The client gets machine-readable truth (`structuredContent`) alongside a
  token-efficient human view (`content`), rather than having to parse the
  markdown back apart to get at the data.

### Annotations are derived from mode, not declared per tool

`annotationsFor(mode)` (`src/core/registry.ts`) is the only place that maps a
tool's `mode` to its MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). No individual tool definition sets its own
annotations. This means a tool cannot advertise itself as safe while actually
being destructive, or vice versa - the two are structurally the same fact
(`mode`), read twice: once to decide whether `selectTools` includes the tool
at the configured `CLICKUP_MCP_MODE` at all, and once to compute the
annotations `server.ts` registers it with. There is no code path where they
could fall out of sync, because there is only one value to keep in sync with
itself.

### Responses are zod-parsed, not merely typed

`clickup/schemas.ts` defines zod schemas for what ClickUp's API actually
returns, not only for this server's own tool inputs. `clickup/client.ts`
parses every response through the relevant schema before any endpoint
function or tool ever sees it. A field ClickUp renames or removes, or a shape
that stops matching what the schema expects, raises a `ClickUpSchemaError`
immediately - a loud, actionable failure - instead of the field silently
becoming `undefined` somewhere downstream and rendering as a blank or a
false-seeming absence. Every schema uses `.passthrough()`, so a field ClickUp
*adds* later does not break parsing; only a field this server actually reads
disappearing or changing shape does. This is reliability rule 1 in
[`RELIABILITY.md`](RELIABILITY.md), and it is enforced structurally by being
the only way a response reaches a handler at all, not by convention.

## Context and transports: no module-level mutable state

`ClickUpContext` (`src/core/context.ts`) - a `ClickUpClient`, a `TtlCache`, a
`RateLimiter`, plus `teamId`, `mode`, `timezone` and `maxResponseChars` - is
the only thing a handler receives beyond its already-validated arguments.
Nothing in `src/` holds a module-level `let` or a singleton that a request
handler reads or writes; `createContext(config)` builds a fresh set of these
every time it is called, and every handler is a pure function from
`(args, ctx)` to a promise of an output object.

This is what lets the same tool code serve two very different deployments
without a rewrite:

- **stdio** (`src/bin/stdio.ts`): one process, one user. `createContext` runs
  exactly once at startup, from environment variables, and that single
  context is reused for the lifetime of the process.
- **Streamable HTTP** (`src/bin/http.ts`): one process, potentially many
  ClickUp accounts. `TenantStore` (`src/http/tenant-store.ts`) calls
  `createContext` once per distinct `(token, teamId)` pair - keyed by
  `credentialKey`, a salted hash of the token, so the raw token is never a
  map key, never logged, and never appears anywhere this could leak it - and
  reuses that tenant's context (cache and rate limiter included) across their
  later requests. Because `createContext` never touches shared state, one
  tenant's cache is never visible to another's: isolation comes from each
  tenant simply having their own object graph, not from an access check on a
  shared one. The store bounds itself (`MAX_TENANTS`, idle eviction) so an
  unbounded number of distinct tokens cannot grow the process's memory
  without limit.

If a single mutable cache or limiter lived at module scope instead, the HTTP
transport would need a second, parallel implementation to avoid one tenant's
requests throttling or invalidating another's - the stdio-only design would
not extend to multi-tenant HTTP without being rebuilt.

## Response shaping

Token efficiency is mostly a response-shaping concern, not a tool-count one
(`src/format/`, `src/server.ts`):

- Markdown by default; `response_format: 'json'` on any `read`-mode tool call
  switches to raw JSON. Both derive from the same handler output (see above).
- `omitEmpty` and `bulletList` (`src/format/common.ts`) make omitting a
  missing field the path of least resistance for every renderer, rather than
  a rule each one has to remember - see reliability rule 2.
- `paginate` (`src/format/common.ts`) gives every list response the same
  envelope: `total`, `count`, `offset`, `items`, `has_more`, `next_offset`.
- `truncateResponse` (`src/format/common.ts`) enforces
  `CLICKUP_MAX_RESPONSE_CHARS` per response and appends a notice naming what
  was dropped and how to get the rest, rather than silently cutting output.
- `clickup_get_my_day` (`src/tools/myday.ts`) is the one tool that composes
  several other endpoint reads into a single call, specifically because a
  session's opening "catch me up" question would otherwise cost four or five
  separate tool calls every time.

## Error handling

`ClickUpApiError` (`src/clickup/client.ts`) carries the HTTP status, ClickUp's
own error code, and which endpoint failed. `toAgentMessage`
(`src/core/errors.ts`) maps that to a short, specific message with a concrete
next step - naming the resource and id involved rather than repeating a
generic "request failed." A 429 is retried automatically with backoff derived
from ClickUp's `X-RateLimit-Reset` header before ever reaching a tool caller;
only a persistent limit surfaces at all. Internal stack traces are never
returned to the client. A tool failure is reported inside the result object
as `isError: true` with a plain-text message, not as an MCP protocol-level
error - see [`RELIABILITY.md`](RELIABILITY.md) rule 6.

## Testing

Vitest plus MSW, in three layers (see `tests/`):

- **Unit**: date parsing (`tests/core/dates.test.ts`), formatters
  (`tests/format/*.test.ts`), the rate limiter, the cache, mode/category
  filtering (`tests/core/registry.test.ts`), error mapping
  (`tests/core/errors.test.ts`).
- **Integration**: every tool handler against MSW-mocked ClickUp endpoints
  (`tests/tools/*.test.ts`), using fixtures shaped like real ClickUp
  responses (`tests/fixtures/`) - success, empty result, and failure paths.
- **Protocol**: `tests/server.test.ts` and `tests/http.test.ts` drive
  `buildServer`/`createHttpServer` directly, verifying tool registration,
  schema validation, `structuredContent` presence, truncation, and origin/
  credential handling for the HTTP transport.

## Documentation generation

`docs/TOOLS.md` is not hand-maintained. `scripts/generate-tool-docs.ts`
exports a pure function, `renderToolDocs(tools: AnyToolDefinition[]): string`,
that reads each tool's name, category, mode, computed annotations
(`annotationsFor`), description, input schema (introspected via
`z.toJSONSchema`) and output schema keys, and renders one Markdown document.
`npm run docs:tools` runs it against `ALL_TOOLS` and writes `docs/TOOLS.md`.
`tests/docs.test.ts` asserts `docs/TOOLS.md` equals
`renderToolDocs(ALL_TOOLS)` byte for byte, so a tool changed without
regenerating the docs fails CI rather than silently going stale - the same
principle as zod-parsing API responses, applied to the documentation of the
server's own interface instead of to ClickUp's.
