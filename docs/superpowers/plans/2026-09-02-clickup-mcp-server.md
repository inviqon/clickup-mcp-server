# clickup-mcp-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted ClickUp MCP server optimised for an agent doing daily task management, exposing 36 tools over stdio and Streamable HTTP.

**Architecture:** A transport-agnostic core. Tool handlers receive an explicit `ClickUpContext` and return typed objects; the registry renders those to markdown or JSON and emits them as `structuredContent`. Two thin entrypoints (stdio, stateless HTTP) build the context from environment or request headers. No module-level mutable state, so the same code serves a single local user and a multi-tenant remote connector.

**Tech Stack:** Node 24, ESM, TypeScript strict, `@modelcontextprotocol/sdk` 1.30, zod 4, vitest 4, msw 2. No web framework (`node:http`), no HTTP client library (native `fetch`).

**Spec:** `docs/superpowers/specs/2026-09-02-clickup-mcp-server-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- Package name `@inviqon/clickup-mcp-server`. Binaries `clickup-mcp` (stdio) and `clickup-mcp-http`.
- Tool names are `clickup_<action>_<resource>`, snake_case, always prefixed.
- All prose, code comments, commit messages and tool descriptions are English. Plain ASCII only: no em dashes, en dashes or smart quotes.
- Input schemas use `z.strictObject(...)`. In zod 4 `.strict()` is deprecated; use the strict constructor. A mistyped parameter must fail loudly.
- API responses are parsed with zod before use. Never render an unvalidated field.
- A missing value is omitted from output. Never `N/A`, never a default, never a guess.
- Ids are copied verbatim from API responses and never constructed.
- Errors never degrade into empty results.
- Logging goes to stderr only. `console.log` is forbidden anywhere in `src/`.
- Secrets are never logged and never appear in error messages.
- Modern SDK APIs only: `server.registerTool`. Never `server.tool()` or manual `setRequestHandler`.
- Default limit 25, maximum 100. Character budget default 40000.
- TDD throughout: failing test first, minimal implementation, passing test, commit.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/config.ts` | Parse and validate environment into a typed `ServerConfig` |
| `src/core/errors.ts` | `ClickUpApiError` plus mapping to actionable agent-facing messages |
| `src/core/rate-limiter.ts` | Token bucket, one instance per credential |
| `src/core/cache.ts` | TTL cache with per-key invalidation |
| `src/core/dates.ts` | Natural language and ISO dates to epoch ms, timezone aware |
| `src/core/context.ts` | `ClickUpContext` construction and credential keying |
| `src/core/registry.ts` | `ToolDefinition`, annotation derivation, mode and category filtering |
| `src/clickup/client.ts` | Authenticated fetch with retry, 429 backoff, response validation |
| `src/clickup/schemas.ts` | Zod schemas for ClickUp API response payloads |
| `src/clickup/endpoints/*.ts` | One thin typed module per API area |
| `src/format/common.ts` | Pagination envelope, truncation, shared markdown primitives |
| `src/format/*.ts` | Renderers, one per domain |
| `src/tools/*.ts` | Tool definitions, one file per category |
| `src/server.ts` | Builds an `McpServer` from the registry plus a context factory |
| `src/bin/stdio.ts` | stdio entrypoint |
| `src/bin/http.ts` | Streamable HTTP entrypoint, stateless JSON mode |
| `scripts/generate-tool-docs.ts` | Emits `docs/TOOLS.md` from the registry |

---

### Task 1: Project scaffolding and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/config.ts`, `.env.example`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ServerConfig`, `function loadConfig(env: NodeJS.ProcessEnv): ServerConfig`. Fields: `apiKey: string`, `teamId: string`, `mode: 'read' | 'write' | 'admin'`, `enabledCategories: Category[] | null`, `disabledTools: string[]`, `timezone: string`, `cacheTtlSeconds: number`, `rateLimit: number`, `maxResponseChars: number`, `httpPort: number`, `httpHost: string`, `allowedOrigins: string[]`, `logLevel: 'debug' | 'info' | 'warn' | 'error'`.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@inviqon/clickup-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24" },
  "bin": {
    "clickup-mcp": "dist/src/bin/stdio.js",
    "clickup-mcp-http": "dist/src/bin/http.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "docs:tools": "npm run build && node dist/scripts/generate-tool-docs.js",
    "inspect": "npx @modelcontextprotocol/inspector node dist/src/bin/stdio.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.5.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@vitest/coverage-v8": "^4.1.0",
    "msw": "^2.15.0",
    "typescript": "^7.0.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
})
```

- [ ] **Step 4: Install and verify the toolchain compiles**

Run: `npm install && npx tsc --noEmit`
Expected: exits 0 with no output.

- [ ] **Step 5: Write the failing config test**

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/core/config.js'

const base = { CLICKUP_API_KEY: 'pk_123', CLICKUP_TEAM_ID: '9007' }

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base)
    expect(c.mode).toBe('write')
    expect(c.cacheTtlSeconds).toBe(300)
    expect(c.rateLimit).toBe(100)
    expect(c.maxResponseChars).toBe(40000)
    expect(c.enabledCategories).toBeNull()
  })

  it('rejects a missing api key with an actionable message', () => {
    expect(() => loadConfig({ CLICKUP_TEAM_ID: '9007' }))
      .toThrow(/CLICKUP_API_KEY is required/)
  })

  it('rejects an unknown mode naming the valid values', () => {
    expect(() => loadConfig({ ...base, CLICKUP_MCP_MODE: 'god' }))
      .toThrow(/read, write, admin/)
  })

  it('parses comma separated lists and trims blanks', () => {
    const c = loadConfig({ ...base, CLICKUP_ENABLED_CATEGORIES: 'tasks, time ,' })
    expect(c.enabledCategories).toEqual(['tasks', 'time'])
  })

  it('rejects a non numeric rate limit rather than silently defaulting', () => {
    expect(() => loadConfig({ ...base, CLICKUP_RATE_LIMIT: 'lots' }))
      .toThrow(/CLICKUP_RATE_LIMIT/)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/core/config.test.ts`
Expected: FAIL, cannot resolve `src/core/config.js`.

- [ ] **Step 7: Implement config loading**

Implement `loadConfig` in `src/core/config.ts` using a zod schema over the raw
environment. Requirements the tests encode: required keys produce a message
naming the variable; enum errors list the valid values; list variables split on
comma, trim, and drop empty entries; numeric variables reject non numeric input
instead of falling back to the default. Export `CATEGORIES` as a const tuple
`['navigation', 'tasks', 'comments', 'structure', 'tags', 'time', 'docs', 'daily']`
and `type Category = typeof CATEGORIES[number]`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/core/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write .env.example**

Every variable from the spec configuration table, with its default as a comment
and required variables left blank.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/core/config.ts tests/core/config.test.ts .env.example
git commit -m "feat: project scaffolding and typed configuration loading"
```

---

### Task 2: Error taxonomy and agent-facing messages

**Files:**
- Create: `src/core/errors.ts`
- Test: `tests/core/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class ClickUpApiError extends Error` with `status: number`, `ecode: string | undefined`, `endpoint: string`, `resetAt: Date | undefined`.
  - `class ClickUpSchemaError extends Error` with `endpoint: string`, `issues: string[]`.
  - `function toAgentMessage(err: unknown, hint?: { resource?: string; id?: string }): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { ClickUpApiError, ClickUpSchemaError, toAgentMessage } from '../../src/core/errors.js'

const err = (status: number, endpoint: string, ecode?: string) =>
  new ClickUpApiError('api failed', { status, endpoint, ecode })

describe('toAgentMessage', () => {
  it('maps 401 to a credential hint', () => {
    expect(toAgentMessage(err(401, '/v2/user')))
      .toBe('Invalid ClickUp token. Check CLICKUP_API_KEY.')
  })

  it('maps 404 on a list to a discovery next step naming the id', () => {
    expect(toAgentMessage(err(404, '/v2/list/123'), { resource: 'list', id: '123' }))
      .toBe('List 123 not found. Use clickup_get_workspace_tree to list valid list ids.')
  })

  it('maps 403 to a workspace mismatch hint', () => {
    expect(toAgentMessage(err(403, '/v2/list/123'), { resource: 'list', id: '123' }))
      .toContain('different workspace than CLICKUP_TEAM_ID')
  })

  it('names the reset time on a persistent 429', () => {
    const e = new ClickUpApiError('rate limited', {
      status: 429, endpoint: '/v2/task/1', resetAt: new Date('2026-09-02T10:00:00Z'),
    })
    expect(toAgentMessage(e)).toContain('2026-09-02T10:00:00.000Z')
  })

  it('reports a schema mismatch as a server side problem, not an empty result', () => {
    const e = new ClickUpSchemaError('bad shape', {
      endpoint: '/v2/task/1', issues: ['status: expected object, received null'],
    })
    const msg = toAgentMessage(e)
    expect(msg).toContain('unexpected response shape')
    expect(msg).toContain('status: expected object, received null')
  })

  it('never leaks a stack trace for an unknown error', () => {
    const msg = toAgentMessage(new Error('connect ECONNREFUSED 10.0.0.1:443'))
    expect(msg).not.toContain('at ')
    expect(msg).toContain('Unexpected error')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the error classes and mapping**

`toAgentMessage` switches on status for `ClickUpApiError` (401, 403, 404, 429,
default), uses the `hint.resource` and `hint.id` to build the 403 and 404
messages, renders `resetAt` as an ISO string, formats `ClickUpSchemaError` as
`ClickUp returned an unexpected response shape for <endpoint>: <issues joined>`,
and falls back to `Unexpected error: <message>` for anything else. The fallback
uses `err.message` only, never `err.stack`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts tests/core/errors.test.ts
git commit -m "feat: error taxonomy with actionable agent-facing messages"
```

---

### Task 3: Rate limiter

**Files:**
- Create: `src/core/rate-limiter.ts`
- Test: `tests/core/rate-limiter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RateLimiter` with `constructor(opts: { limitPerMinute: number; now?: () => number; sleep?: (ms: number) => Promise<void> })`, `acquire(): Promise<void>`, `notifyReset(resetAt: Date): void`, `get availableTokens(): number`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../../src/core/rate-limiter.js'

function harness(limitPerMinute: number) {
  let clock = 0
  const slept: number[] = []
  const limiter = new RateLimiter({
    limitPerMinute,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  return { limiter, slept, advance: (ms: number) => { clock += ms } }
}

describe('RateLimiter', () => {
  it('passes through while tokens remain', async () => {
    const { limiter, slept } = harness(60)
    for (let i = 0; i < 60; i++) await limiter.acquire()
    expect(slept).toEqual([])
  })

  it('sleeps once the bucket is empty', async () => {
    const { limiter, slept } = harness(60)
    for (let i = 0; i < 61; i++) await limiter.acquire()
    expect(slept.length).toBe(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('refills over time', async () => {
    const { limiter, slept, advance } = harness(60)
    for (let i = 0; i < 60; i++) await limiter.acquire()
    advance(60_000)
    await limiter.acquire()
    expect(slept).toEqual([])
  })

  it('empties the bucket until the reset time reported by a 429', async () => {
    const { limiter, slept } = harness(60)
    limiter.notifyReset(new Date(30_000))
    await limiter.acquire()
    expect(slept[0]).toBe(30_000)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/rate-limiter.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the token bucket**

Continuous refill at `limitPerMinute / 60000` tokens per millisecond, capacity
`limitPerMinute`. `acquire` refills, and if fewer than one token is available
sleeps for exactly the time until one is. `notifyReset` drains the bucket and
records a floor time before which `acquire` must sleep. Injecting `now` and
`sleep` keeps the tests deterministic and instant.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/rate-limiter.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/rate-limiter.ts tests/core/rate-limiter.test.ts
git commit -m "feat: token bucket rate limiter with 429 reset awareness"
```

---

### Task 4: TTL cache

**Files:**
- Create: `src/core/cache.ts`
- Test: `tests/core/cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class TtlCache` with `constructor(opts: { ttlSeconds: number; now?: () => number })`, `getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T>`, `invalidate(prefix: string): void`, `clear(): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { TtlCache } from '../../src/core/cache.js'

describe('TtlCache', () => {
  it('loads once and serves the cached value', async () => {
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    expect(await cache.getOrLoad('k', load)).toBe('v')
    expect(await cache.getOrLoad('k', load)).toBe('v')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads after the ttl expires', async () => {
    let clock = 0
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60, now: () => clock })
    await cache.getOrLoad('k', load)
    clock = 61_000
    await cache.getOrLoad('k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('invalidates by prefix', async () => {
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    await cache.getOrLoad('tree:9007', load)
    await cache.getOrLoad('list:1', load)
    cache.invalidate('tree:')
    await cache.getOrLoad('tree:9007', load)
    await cache.getOrLoad('list:1', load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not cache a rejected load', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom')
    expect(await cache.getOrLoad('k', load)).toBe('v')
  })

  it('deduplicates concurrent loads of the same key', async () => {
    const load = vi.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r('v'), 10)))
    const cache = new TtlCache({ ttlSeconds: 60 })
    const [a, b] = await Promise.all([
      cache.getOrLoad('k', load), cache.getOrLoad('k', load),
    ])
    expect([a, b]).toEqual(['v', 'v'])
    expect(load).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/cache.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the cache**

A `Map<string, { expiresAt: number; value: T }>` plus a separate
`Map<string, Promise<T>>` of in-flight loads for deduplication. A rejected load
removes the in-flight entry and stores nothing. `invalidate` deletes every key
starting with the prefix, from both maps.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/cache.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/cache.ts tests/core/cache.test.ts
git commit -m "feat: ttl cache with in-flight deduplication and prefix invalidation"
```

---

### Task 5: Authenticated ClickUp HTTP client

**Files:**
- Create: `src/clickup/client.ts`
- Test: `tests/clickup/client.test.ts`, `tests/support/msw.ts`

**Interfaces:**
- Consumes: `RateLimiter` (Task 3), `ClickUpApiError` and `ClickUpSchemaError` (Task 2).
- Produces:
  - `class ClickUpClient` with `constructor(opts: { token: string; limiter: RateLimiter; fetchImpl?: typeof fetch; maxRetries?: number })`
  - `request<T>(spec: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; version?: 'v2' | 'v3'; query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; schema: z.ZodType<T> }): Promise<T>`
  - `const API_BASE = 'https://api.clickup.com/api'`

- [ ] **Step 1: Create the MSW test harness**

```ts
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

export const mswServer = setupServer()

export function useMsw() {
  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => mswServer.resetHandlers())
  afterAll(() => mswServer.close())
}
```

`onUnhandledRequest: 'error'` is deliberate: an unmocked call is a test bug, not
a silent network attempt.

- [ ] **Step 2: Write the failing client test**

```ts
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClickUpClient } from '../../src/clickup/client.js'
import { ClickUpApiError, ClickUpSchemaError } from '../../src/core/errors.js'
import { RateLimiter } from '../../src/core/rate-limiter.js'
import { mswServer, useMsw } from '../support/msw.js'

useMsw()

const schema = z.object({ id: z.string() })
const client = () => new ClickUpClient({
  token: 'pk_123',
  limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
})

describe('ClickUpClient', () => {
  it('sends the token in the Authorization header without a Bearer prefix', async () => {
    let seen: string | null = null
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', ({ request }) => {
      seen = request.headers.get('authorization')
      return HttpResponse.json({ id: '1' })
    }))
    await client().request({ method: 'GET', path: '/task/1', schema })
    expect(seen).toBe('pk_123')
  })

  it('serialises array query parameters as repeated keys', async () => {
    let url = ''
    mswServer.use(http.get('https://api.clickup.com/api/v2/list/1/task', ({ request }) => {
      url = request.url
      return HttpResponse.json({ id: '1' })
    }))
    await client().request({
      method: 'GET', path: '/list/1/task', schema,
      query: { statuses: ['open', 'in progress'], page: 0, archived: false },
    })
    expect(url).toContain('statuses=open')
    expect(url).toContain('statuses=in+progress')
    expect(url).toContain('page=0')
    expect(url).toContain('archived=false')
  })

  it('omits undefined query parameters entirely', async () => {
    let url = ''
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', ({ request }) => {
      url = request.url
      return HttpResponse.json({ id: '1' })
    }))
    await client().request({ method: 'GET', path: '/task/1', schema, query: { foo: undefined } })
    expect(url).not.toContain('foo')
  })

  it('targets the v3 base path when asked', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v3/workspaces/9007/docs',
      () => HttpResponse.json({ id: 'd1' })))
    const out = await client().request({
      method: 'GET', version: 'v3', path: '/workspaces/9007/docs', schema,
    })
    expect(out.id).toBe('d1')
  })

  it('retries a 429 using X-RateLimit-Reset and then succeeds', async () => {
    let calls = 0
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', () => {
      calls++
      if (calls === 1) {
        return new HttpResponse(null, {
          status: 429,
          headers: { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1) },
        })
      }
      return HttpResponse.json({ id: '1' })
    }))
    const out = await client().request({ method: 'GET', path: '/task/1', schema })
    expect(out.id).toBe('1')
    expect(calls).toBe(2)
  })

  it('surfaces a persistent 429 as ClickUpApiError carrying resetAt', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => new HttpResponse(null, {
        status: 429,
        headers: { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1) },
      })))
    const c = new ClickUpClient({
      token: 'pk_123', maxRetries: 1,
      limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
    })
    await expect(c.request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toMatchObject({ status: 429 })
  })

  it('raises ClickUpApiError carrying the ClickUp ECODE on 404', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ err: 'Task not found', ECODE: 'ITEM_013' }, { status: 404 })))
    await expect(client().request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toMatchObject({ status: 404, ecode: 'ITEM_013' })
  })

  it('raises ClickUpSchemaError rather than returning an unvalidated payload', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ id: 42 })))
    await expect(client().request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toBeInstanceOf(ClickUpSchemaError)
  })

  it('never includes the token in an error message', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ err: 'nope' }, { status: 403 })))
    const err = await client().request({ method: 'GET', path: '/task/1', schema })
      .then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('pk_123')
  })

  it('does not retry a 500 more than maxRetries times', async () => {
    let calls = 0
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', () => {
      calls++
      return HttpResponse.json({ err: 'boom' }, { status: 500 })
    }))
    const c = new ClickUpClient({
      token: 'pk_123', maxRetries: 2,
      limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
    })
    await expect(c.request({ method: 'GET', path: '/task/1', schema })).rejects.toThrow()
    expect(calls).toBe(3)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/clickup/client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the client**

Behaviour the tests pin down:

- URL is `${API_BASE}/${version ?? 'v2'}${path}`.
- Header is `Authorization: <token>` with no `Bearer` prefix. Personal ClickUp
  tokens are sent raw; only OAuth tokens use `Bearer`.
- Query building: skip `undefined`, append arrays as repeated keys, stringify
  numbers and booleans.
- Before each attempt, `await limiter.acquire()`.
- On 429, read `X-RateLimit-Reset` (Unix seconds), call `limiter.notifyReset`,
  and retry up to `maxRetries` (default 3).
- On 5xx, retry with exponential backoff up to `maxRetries`.
- On any other non-2xx, throw `ClickUpApiError` with `status`, `endpoint`, and
  `ecode` read from the body's `ECODE` field when present.
- On 2xx, `schema.safeParse` the body; on failure throw `ClickUpSchemaError`
  with the flattened issue paths.
- 204 and empty bodies parse against the supplied schema as `{}`, so a schema of
  `z.object({})` is the correct choice for delete endpoints.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/clickup/client.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/clickup/client.ts tests/clickup/client.test.ts tests/support/msw.ts
git commit -m "feat: clickup http client with retry, rate limiting and response validation"
```

---

### Task 6: Date resolution

**Files:**
- Create: `src/core/dates.ts`
- Test: `tests/core/dates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function resolveDate(input: string | number, opts: { timezone: string; now?: Date }): { epochMs: number; iso: string }`
  - `function formatDate(epochMs: number, timezone: string): string` returning ISO 8601 with offset.
  - `function parseDuration(input: string | number): number` returning milliseconds.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { formatDate, parseDuration, resolveDate } from '../../src/core/dates.js'

const tz = 'Europe/Berlin'
const now = new Date('2026-09-02T09:00:00Z') // 11:00 Berlin, a Wednesday

describe('resolveDate', () => {
  it('passes an epoch number through unchanged', () => {
    expect(resolveDate(1756803600000, { timezone: tz, now }).epochMs).toBe(1756803600000)
  })

  it('accepts an ISO string', () => {
    expect(resolveDate('2026-09-05T14:00:00+02:00', { timezone: tz, now }).iso)
      .toBe('2026-09-05T14:00:00+02:00')
  })

  it('resolves "tomorrow 17:00" in the configured timezone', () => {
    const r = resolveDate('tomorrow 17:00', { timezone: tz, now })
    expect(r.iso).toBe('2026-09-03T17:00:00+02:00')
  })

  it('resolves "today" to the start of the day in the configured timezone', () => {
    expect(resolveDate('today', { timezone: tz, now }).iso).toBe('2026-09-02T00:00:00+02:00')
  })

  it('resolves "next monday" to the following Monday, not today', () => {
    expect(resolveDate('next monday', { timezone: tz, now }).iso)
      .toBe('2026-09-07T00:00:00+02:00')
  })

  it('resolves relative offsets', () => {
    expect(resolveDate('in 3 days', { timezone: tz, now }).iso)
      .toBe('2026-09-05T11:00:00+02:00')
  })

  it('rejects an unparseable string instead of guessing', () => {
    expect(() => resolveDate('sometime soon', { timezone: tz, now }))
      .toThrow(/Could not parse date "sometime soon"/)
  })

  it('names the accepted formats in the error', () => {
    expect(() => resolveDate('nope', { timezone: tz, now })).toThrow(/ISO 8601/)
  })
})

describe('parseDuration', () => {
  it.each([
    ['1h30m', 5_400_000],
    ['45m', 2_700_000],
    ['2h', 7_200_000],
    ['90', 90],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it('rejects nonsense rather than returning zero', () => {
    expect(() => parseDuration('a while')).toThrow(/Could not parse duration/)
  })
})

describe('formatDate', () => {
  it('renders with the timezone offset so mistakes are visible', () => {
    expect(formatDate(Date.parse('2026-09-02T09:00:00Z'), tz))
      .toBe('2026-09-02T11:00:00+02:00')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/dates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement date resolution with no extra dependency**

Use `Intl.DateTimeFormat` with `timeZone` and `formatToParts` to compute the
zone offset for a given instant, so no date library is needed. Support exactly
this grammar, and nothing beyond it:

- a number, or a numeric string, taken as epoch milliseconds
- an ISO 8601 string, parsed by `Date.parse`
- `today`, `tomorrow`, `yesterday`, each optionally followed by `HH:MM`
- `next <weekday>` and `last <weekday>`, strictly the next or previous
  occurrence, never today
- `in <n> <minutes|hours|days|weeks>` and `<n> <unit> ago`

Anything else throws `Could not parse date "<input>". Accepted: epoch
milliseconds, ISO 8601, "today", "tomorrow", "next monday", "in 3 days".`
A narrow grammar that fails loudly is the point: a permissive parser that
silently picks a wrong date is the failure mode this guards against.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/dates.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/dates.ts tests/core/dates.test.ts
git commit -m "feat: timezone aware date and duration parsing with strict grammar"
```

---

### Task 7: Response envelope, truncation and markdown primitives

**Files:**
- Create: `src/format/common.ts`
- Test: `tests/format/common.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Page<T> = { total: number; count: number; offset: number; items: T[]; has_more: boolean; next_offset?: number }`
  - `function paginate<T>(items: T[], opts: { offset: number; limit: number; total?: number }): Page<T>`
  - `function truncateResponse(text: string, opts: { maxChars: number; itemCount: number; retryHint: string }): string`
  - `function nameWithId(name: string, id: string): string`
  - `function omitEmpty<T extends object>(obj: T): Partial<T>`
  - `function bulletList(entries: Array<[string, string | undefined]>): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { bulletList, nameWithId, omitEmpty, paginate, truncateResponse } from '../../src/format/common.js'

describe('paginate', () => {
  it('reports has_more and next_offset when more remain', () => {
    const p = paginate([1, 2, 3, 4, 5], { offset: 0, limit: 2 })
    expect(p).toEqual({ total: 5, count: 2, offset: 0, items: [1, 2], has_more: true, next_offset: 2 })
  })

  it('omits next_offset on the last page', () => {
    const p = paginate([1, 2, 3], { offset: 2, limit: 2 })
    expect(p.has_more).toBe(false)
    expect(p.next_offset).toBeUndefined()
  })

  it('uses a server reported total when the local slice is partial', () => {
    const p = paginate([1, 2], { offset: 0, limit: 2, total: 100 })
    expect(p.total).toBe(100)
    expect(p.has_more).toBe(true)
  })
})

describe('truncateResponse', () => {
  it('returns the text unchanged when within budget', () => {
    expect(truncateResponse('short', { maxChars: 100, itemCount: 1, retryHint: 'x' })).toBe('short')
  })

  it('announces truncation and names the way to get the rest', () => {
    const out = truncateResponse('x'.repeat(200), {
      maxChars: 100, itemCount: 20, retryHint: "use offset=10 or narrow with 'statuses'",
    })
    expect(out.length).toBeLessThanOrEqual(100 + 200)
    expect(out).toContain('Response truncated')
    expect(out).toContain("use offset=10 or narrow with 'statuses'")
  })
})

describe('omitEmpty', () => {
  it('drops undefined, null and empty string but keeps false and zero', () => {
    expect(omitEmpty({ a: undefined, b: null, c: '', d: false, e: 0, f: 'x' }))
      .toEqual({ d: false, e: 0, f: 'x' })
  })
})

describe('bulletList', () => {
  it('skips entries with no value instead of printing a placeholder', () => {
    expect(bulletList([['Status', 'open'], ['Due', undefined]]))
      .toEqual(['- **Status**: open'])
  })
})

describe('nameWithId', () => {
  it('renders the id verbatim next to the name', () => {
    expect(nameWithId('Fix login redirect', '86abc123')).toBe('Fix login redirect (86abc123)')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/format/common.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the primitives**

`omitEmpty` and `bulletList` are the mechanical enforcement of reliability rule
2: they make omitting a missing value the path of least resistance, so no
renderer has to remember it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/format/common.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/format/common.ts tests/format/common.test.ts
git commit -m "feat: pagination envelope, visible truncation and markdown primitives"
```

---

### Task 8: Tool contract, context and registry

**Files:**
- Create: `src/core/context.ts`, `src/core/registry.ts`
- Test: `tests/core/registry.test.ts`

**Interfaces:**
- Consumes: `ServerConfig` (Task 1), `TtlCache` (Task 4), `RateLimiter` (Task 3), `ClickUpClient` (Task 5).
- Produces:

```ts
// src/core/context.ts
export type ClickUpContext = {
  client: ClickUpClient
  cache: TtlCache
  teamId: string
  mode: 'read' | 'write' | 'admin'
  timezone: string
  maxResponseChars: number
}

export function createContext(config: ServerConfig): ClickUpContext
export function credentialKey(token: string, teamId: string): string

// src/core/registry.ts
export type ToolMode = 'read' | 'write' | 'admin'

export type ToolDefinition<TIn extends z.ZodRawShape, TOut extends z.ZodRawShape> = {
  name: string
  title: string
  description: string
  category: Category
  mode: ToolMode
  inputSchema: TIn
  outputSchema: TOut
  handler: (args: z.infer<z.ZodObject<TIn>>, ctx: ClickUpContext) => Promise<z.infer<z.ZodObject<TOut>>>
  render: (out: z.infer<z.ZodObject<TOut>>, ctx: ClickUpContext) => string
}

export type AnyToolDefinition = ToolDefinition<z.ZodRawShape, z.ZodRawShape>

export function annotationsFor(mode: ToolMode): {
  readOnlyHint: boolean; destructiveHint: boolean
  idempotentHint: boolean; openWorldHint: boolean
}

export function selectTools(
  all: AnyToolDefinition[],
  opts: { mode: ToolMode; enabledCategories: Category[] | null; disabledTools: string[] },
): AnyToolDefinition[]

export const RESPONSE_FORMAT_SHAPE: {
  response_format: z.ZodDefault<z.ZodEnum<['markdown', 'json']>>
}
```

- [ ] **Step 1: Write the failing registry test**

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { annotationsFor, selectTools, type AnyToolDefinition } from '../../src/core/registry.js'

const tool = (name: string, mode: 'read' | 'write' | 'admin', category: string) => ({
  name, title: name, description: name, category, mode,
  inputSchema: {}, outputSchema: {},
  handler: async () => ({}), render: () => '',
}) as unknown as AnyToolDefinition

const all = [
  tool('clickup_get_task', 'read', 'tasks'),
  tool('clickup_update_task', 'write', 'tasks'),
  tool('clickup_delete_task', 'admin', 'tasks'),
  tool('clickup_start_timer', 'write', 'time'),
]

describe('selectTools', () => {
  it('read mode exposes only read tools', () => {
    const names = selectTools(all, { mode: 'read', enabledCategories: null, disabledTools: [] })
      .map((t) => t.name)
    expect(names).toEqual(['clickup_get_task'])
  })

  it('write mode exposes read and write but never admin', () => {
    const names = selectTools(all, { mode: 'write', enabledCategories: null, disabledTools: [] })
      .map((t) => t.name)
    expect(names).not.toContain('clickup_delete_task')
    expect(names).toContain('clickup_update_task')
  })

  it('admin mode exposes everything', () => {
    expect(selectTools(all, { mode: 'admin', enabledCategories: null, disabledTools: [] }))
      .toHaveLength(4)
  })

  it('filters by enabled categories', () => {
    const names = selectTools(all, { mode: 'admin', enabledCategories: ['time'], disabledTools: [] })
      .map((t) => t.name)
    expect(names).toEqual(['clickup_start_timer'])
  })

  it('applies the tool blocklist last', () => {
    const names = selectTools(all, {
      mode: 'admin', enabledCategories: null, disabledTools: ['clickup_delete_task'],
    }).map((t) => t.name)
    expect(names).not.toContain('clickup_delete_task')
  })
})

describe('annotationsFor', () => {
  it('marks read tools read only and idempotent', () => {
    expect(annotationsFor('read')).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    })
  })

  it('marks admin tools destructive', () => {
    expect(annotationsFor('admin').destructiveHint).toBe(true)
  })

  it('never marks a write tool read only', () => {
    expect(annotationsFor('write').readOnlyHint).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement context and registry**

`createContext` builds one `RateLimiter`, one `TtlCache` and one `ClickUpClient`
from the config. `credentialKey` returns `sha256(token).slice(0, 16) + ':' + teamId`,
so cache and limiter instances can be keyed per tenant in the HTTP transport
without the token ever being used as a map key in cleartext.

`selectTools` applies mode ranking (`read` 0, `write` 1, `admin` 2, a tool is
visible when its rank is at most the configured rank), then the category filter,
then the blocklist.

`RESPONSE_FORMAT_SHAPE` is NOT spread into individual tool schemas. `buildServer`
appends it to the advertised input schema of every `read` mode tool and strips
`response_format` from the arguments before the strict parse of the rest, so no
tool can forget it and no tool can trip over it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/context.ts src/core/registry.ts tests/core/registry.test.ts
git commit -m "feat: tool contract, request context and mode aware registry"
```

---

### Task 9: Server assembly, stdio entrypoint and protocol tests

**Files:**
- Create: `src/server.ts`, `src/bin/stdio.ts`, `src/tools/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 through 8.
- Produces:
  - `function buildServer(opts: { tools: AnyToolDefinition[]; config: ServerConfig; contextFactory: () => ClickUpContext }): McpServer`
  - `src/tools/index.ts` exporting `export const ALL_TOOLS: AnyToolDefinition[]`, initially empty and appended to by every later task.

- [ ] **Step 1: Write the failing protocol test**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildServer } from '../src/server.js'
import type { AnyToolDefinition } from '../src/core/registry.js'
import { loadConfig } from '../src/core/config.js'

const echo = {
  name: 'clickup_echo', title: 'Echo', description: 'Echo a value.',
  category: 'tasks', mode: 'read',
  inputSchema: { value: z.string() },
  outputSchema: { value: z.string() },
  handler: async ({ value }: { value: string }) => ({ value }),
  render: (o: { value: string }) => `Echo: ${o.value}`,
} as unknown as AnyToolDefinition

const failing = {
  ...echo, name: 'clickup_fail',
  handler: async () => { throw new Error('upstream exploded') },
} as unknown as AnyToolDefinition

async function connect(tools: AnyToolDefinition[]) {
  const config = loadConfig({ CLICKUP_API_KEY: 'pk_1', CLICKUP_TEAM_ID: '9007' })
  const server = buildServer({ tools, config, contextFactory: () => ({}) as never })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([client.connect(clientT), server.connect(serverT)])
  return client
}

describe('buildServer', () => {
  it('lists registered tools with annotations derived from mode', async () => {
    const client = await connect([echo])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['clickup_echo'])
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true)
  })

  it('returns both markdown content and structuredContent', async () => {
    const client = await connect([echo])
    const res = await client.callTool({ name: 'clickup_echo', arguments: { value: 'hi' } })
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe('Echo: hi')
    expect(res.structuredContent).toEqual({ value: 'hi' })
  })

  it('returns raw json when response_format is json', async () => {
    const client = await connect([echo])
    const res = await client.callTool({
      name: 'clickup_echo', arguments: { value: 'hi', response_format: 'json' },
    })
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual({ value: 'hi' })
  })

  it('rejects an unknown argument instead of ignoring it', async () => {
    const client = await connect([echo])
    const res = await client.callTool({
      name: 'clickup_echo', arguments: { value: 'hi', typoo: 1 },
    })
    expect(res.isError).toBe(true)
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('typoo')
  })

  it('reports a handler failure as isError with no stack trace', async () => {
    const client = await connect([failing])
    const res = await client.callTool({ name: 'clickup_fail', arguments: { value: 'x' } })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('Unexpected error')
    expect(text).not.toContain('at ')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement buildServer**

For each selected tool call `server.registerTool(name, { title, description,
inputSchema, outputSchema, annotations: annotationsFor(mode) }, wrapper)`.

The wrapper, in order:

1. Pulls `response_format` out of the arguments (defaulting to `markdown`) and
   parses what remains with `z.strictObject(inputSchema)`. On failure returns
   `{ isError: true, content: [{ type: 'text', text: 'Invalid arguments: <issues>' }] }`,
   with each issue naming the offending key. The SDK validates against a
   non-strict object, so this second strict parse is what makes an unknown key
   an error rather than a silent no-op.
2. Builds the context via `contextFactory()`.
3. Awaits `handler`.
4. Returns `structuredContent` plus `content`: `render(out, ctx)` for markdown,
   `JSON.stringify(out, null, 2)` for json, truncated to `maxResponseChars`.
5. Catches anything thrown and returns `{ isError: true, content: [{ type: 'text',
   text: toAgentMessage(err) }] }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the stdio entrypoint**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../core/config.js'
import { createContext } from '../core/context.js'
import { ALL_TOOLS } from '../tools/index.js'
import { buildServer } from '../server.js'

const config = loadConfig(process.env)
const context = createContext(config)
const server = buildServer({ tools: ALL_TOOLS, config, contextFactory: () => context })
await server.connect(new StdioServerTransport())
console.error(`clickup-mcp ready: mode=${config.mode}`)
```

Note the `console.error`. Writing readiness to stdout would corrupt the JSON-RPC
stream. Add an ESLint-free guard instead: a test asserting that no file under
`src/` contains the string `console.log`.

- [ ] **Step 6: Add the stdout guard test**

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

it('never writes to stdout from src', () => {
  const offenders = walk('src').filter((f) => readFileSync(f, 'utf8').includes('console.log'))
  expect(offenders).toEqual([])
})
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npx vitest run`
Expected: PASS.

```bash
git add src/server.ts src/bin/stdio.ts src/tools/index.ts tests/server.test.ts tests/stdout-guard.test.ts
git commit -m "feat: server assembly, stdio entrypoint and protocol level tests"
```

---

### Task 10: Navigation tools

**Files:**
- Create: `src/clickup/schemas.ts`, `src/clickup/endpoints/workspace.ts`, `src/format/tree.ts`, `src/tools/navigation.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/navigation.test.ts`, `tests/fixtures/workspace.ts`

**Interfaces:**
- Consumes: `ClickUpClient.request` (Task 5), `TtlCache.getOrLoad` (Task 4), `paginate` and `omitEmpty` (Task 7), `ToolDefinition` (Task 8).
- Produces:
  - `src/clickup/endpoints/workspace.ts`: `getSpaces(ctx)`, `getFolders(ctx, spaceId)`, `getFolderlessLists(ctx, spaceId)`, `getListsInFolder(ctx, folderId)`, `getList(ctx, listId)`, `getListFields(ctx, listId)`, `getTeamMembers(ctx)`
  - `loadWorkspaceTree(ctx): Promise<WorkspaceTree>` cached under key `tree:<teamId>`
  - `loadListMeta(ctx, listId): Promise<ListMeta>` cached under key `list:<listId>`, where `ListMeta = { id, name, statuses: Array<{ id, status, type }>, customFields: Array<{ id, name, type, options?: Array<{ id, name }> }> }`
  - Four tool definitions exported as `NAVIGATION_TOOLS`

- [ ] **Step 1: Capture response fixtures**

Create `tests/fixtures/workspace.ts` holding literal ClickUp response payloads
for `GET /v2/team`, `/v2/team/9007/space`, `/v2/space/1/folder`,
`/v2/space/1/list`, `/v2/folder/10/list`, `/v2/list/100`, `/v2/list/100/field`.
Take the field set from the OpenAPI specification at
`https://developer.clickup.com/docs/open-api-spec.md`. Include at least one
nullable field (`due_date: null`) and one empty array so the omission rules are
exercised by real shapes.

- [ ] **Step 2: Write the failing navigation test**

```ts
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { NAVIGATION_TOOLS } from '../../src/tools/navigation.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/workspace.js'

useMsw()
const tool = (name: string) => NAVIGATION_TOOLS.find((t) => t.name === name)!

describe('clickup_get_workspace_tree', () => {
  it('assembles spaces, folders and lists into one tree', async () => {
    mswServer.use(...fx.treeHandlers())
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    expect(out.spaces[0].folders[0].lists[0]).toMatchObject({ id: '100', name: 'Sprint 1' })
  })

  it('is served from cache on the second call', async () => {
    const spy = vi.fn()
    mswServer.use(...fx.treeHandlers(spy))
    const ctx = testContext()
    await tool('clickup_get_workspace_tree').handler({}, ctx)
    await tool('clickup_get_workspace_tree').handler({}, ctx)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('renders folderless lists without inventing a folder', async () => {
    mswServer.use(...fx.treeHandlers())
    const out = await tool('clickup_get_workspace_tree').handler({}, testContext())
    const md = tool('clickup_get_workspace_tree').render(out, testContext())
    expect(md).toContain('Backlog (101)')
    expect(md).not.toContain('undefined')
  })
})

describe('clickup_get_list', () => {
  it('returns statuses and custom field definitions together', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    expect(out.statuses.map((s: { status: string }) => s.status)).toContain('in progress')
    expect(out.custom_fields[0]).toMatchObject({ name: 'Client', type: 'drop_down' })
  })

  it('exposes dropdown option names so a writer does not have to guess', async () => {
    mswServer.use(...fx.listHandlers())
    const out = await tool('clickup_get_list').handler({ list_id: '100' }, testContext())
    expect(out.custom_fields[0].options.map((o: { name: string }) => o.name)).toContain('Selectry')
  })
})

describe('clickup_resolve_member', () => {
  it('returns every candidate rather than picking the first', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'a' }, testContext())
    expect(out.matches.length).toBeGreaterThan(1)
    expect(out.ambiguous).toBe(true)
  })

  it('resolves "me" to the authenticated user', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'me' }, testContext())
    expect(out.matches).toHaveLength(1)
    expect(out.ambiguous).toBe(false)
  })

  it('says so explicitly when nothing matches', async () => {
    mswServer.use(...fx.memberHandlers())
    const out = await tool('clickup_resolve_member').handler({ query: 'zzz' }, testContext())
    const md = tool('clickup_resolve_member').render(out, testContext())
    expect(md).toContain('No workspace member matches "zzz"')
  })
})

describe('clickup_search_tasks', () => {
  it('paginates with the documented envelope', async () => {
    mswServer.use(...fx.searchHandlers())
    const out = await tool('clickup_search_tasks').handler(
      { query: 'login', limit: 1 }, testContext())
    expect(out).toMatchObject({ count: 1, has_more: true, next_offset: 1 })
  })

  it('reports an empty result with the query that produced it', async () => {
    mswServer.use(...fx.searchHandlers({ empty: true }))
    const out = await tool('clickup_search_tasks').handler({ query: 'zzz' }, testContext())
    const md = tool('clickup_search_tasks').render(out, testContext())
    expect(md).toContain('No tasks found matching "zzz"')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/tools/navigation.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Create the shared test context helper**

```ts
// tests/support/context.ts
import { ClickUpClient } from '../../src/clickup/client.js'
import { TtlCache } from '../../src/core/cache.js'
import { RateLimiter } from '../../src/core/rate-limiter.js'
import type { ClickUpContext } from '../../src/core/context.js'

export function testContext(over: Partial<ClickUpContext> = {}): ClickUpContext {
  const limiter = new RateLimiter({ limitPerMinute: 10_000, sleep: async () => {} })
  return {
    client: new ClickUpClient({ token: 'pk_test', limiter }),
    cache: new TtlCache({ ttlSeconds: 300 }),
    teamId: '9007',
    mode: 'admin',
    timezone: 'Europe/Berlin',
    maxResponseChars: 40_000,
    ...over,
  }
}
```

- [ ] **Step 5: Implement the response schemas and endpoint functions**

In `src/clickup/schemas.ts` define zod schemas mirroring the fixtures. Use
`.passthrough()` on API objects so ClickUp adding a field does not break the
server, but declare every field the code reads. Reading an undeclared field is
forbidden: that is the mechanism behind reliability rule 1.

- [ ] **Step 6: Implement the four tools**

Full definition of the smallest one, as the pattern every later tool follows:

```ts
export const getListTool: ToolDefinition<typeof inputShape, typeof outputShape> = {
  name: 'clickup_get_list',
  title: 'Get ClickUp List',
  category: 'navigation',
  mode: 'read',
  description: [
    'Get a ClickUp list with the statuses and custom field definitions available in it.',
    'Call this before creating or updating a task in a list you have not written to yet:',
    'status names and custom field ids are list specific, and a wrong one is rejected by the API.',
    'Use clickup_get_workspace_tree first if you do not know the list id.',
    'Examples: "what statuses does Sprint 1 use", "which custom fields can I set on this list".',
  ].join(' '),
  inputSchema: inputShape,   // { list_id: z.string().describe('ClickUp list id, e.g. "901234"') }
  outputSchema: outputShape, // { id, name, statuses[], custom_fields[] }
  handler: async ({ list_id }, ctx) => loadListMeta(ctx, list_id),
  render: (out) => [
    `# ${nameWithId(out.name, out.id)}`,
    '',
    `**Statuses**: ${out.statuses.map((s) => s.status).join(', ')}`,
    '',
    ...(out.custom_fields.length ? ['**Custom fields**', ...out.custom_fields.map(
      (f) => `- ${nameWithId(f.name, f.id)} (${f.type})${
        f.options?.length ? `: ${f.options.map((o) => o.name).join(', ')}` : ''}`,
    )] : []),
  ].join('\n'),
}
```

The remaining three:

- `clickup_get_workspace_tree`: input `{}`. Output
  `{ team_id, spaces: [{ id, name, folders: [{ id, name, lists: [{ id, name, task_count? }] }], lists: [...] }] }`.
  Loads through `loadWorkspaceTree`, which fans out with `Promise.all` over
  spaces and folders under the rate limiter. Renders as an indented list.
- `clickup_resolve_member`: input `{ query: z.string().min(1) }`.
  Output `{ query, ambiguous: boolean, matches: [{ id, username, email }] }`.
  `me` resolves through `GET /v2/user`. Otherwise case insensitive substring
  match on username and email. `ambiguous` is `matches.length > 1`. Never
  truncate to the first match.
- `clickup_search_tasks`: input
  `{ query: z.string().min(2), space_id: z.string().optional(), list_id: z.string().optional(), include_closed: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) }`.
  Backed by `GET /v2/team/{teamId}/task`, filtered locally on name and
  description because the endpoint has no text query parameter. Returns a
  `Page<TaskSummary>`.

- [ ] **Step 7: Register the tools**

```ts
// src/tools/index.ts
import { NAVIGATION_TOOLS } from './navigation.js'
export const ALL_TOOLS = [...NAVIGATION_TOOLS]
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/navigation.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 9: Commit**

```bash
git add src/clickup src/format/tree.ts src/tools tests/tools/navigation.test.ts tests/fixtures tests/support/context.ts
git commit -m "feat: navigation tools with cached workspace tree and list metadata"
```

---

### Task 11: Task tools

**Files:**
- Create: `src/clickup/endpoints/tasks.ts`, `src/format/task.ts`, `src/tools/tasks.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/tasks.test.ts`, `tests/fixtures/tasks.ts`

**Interfaces:**
- Consumes: `loadListMeta` (Task 10), `resolveDate` and `formatDate` (Task 6), `paginate`, `omitEmpty`, `nameWithId`, `bulletList` (Task 7).
- Produces: `TASK_TOOLS`; `TaskSummarySchema` and `type TaskSummary` exported from `src/clickup/schemas.ts` (consumed by Tasks 12, 14 and 15); plus `resolveCustomFields(ctx, listId, input: Record<string, string | number | boolean>): Promise<Array<{ id: string; value: unknown }>>`.

- [ ] **Step 1: Write the failing test**

```ts
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { TASK_TOOLS } from '../../src/tools/tasks.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'
import * as fx from '../fixtures/tasks.js'

useMsw()
const tool = (n: string) => TASK_TOOLS.find((t) => t.name === n)!

describe('clickup_get_task', () => {
  it('returns subtasks compactly without a second call', async () => {
    mswServer.use(...fx.taskHandlers())
    const out = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    expect(out.subtasks).toEqual([{ id: '86def', name: 'Write migration', status: 'open' }])
  })

  it('omits an unset due date instead of printing a placeholder', async () => {
    mswServer.use(...fx.taskHandlers({ dueDate: null }))
    const out = await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext())
    const md = tool('clickup_get_task').render(out, testContext())
    expect(md).not.toMatch(/Due/)
    expect(md).not.toContain('null')
  })

  it('renders dates with the configured timezone offset', async () => {
    mswServer.use(...fx.taskHandlers({ dueDate: 1757000000000 }))
    const md = tool('clickup_get_task').render(
      await tool('clickup_get_task').handler({ task_id: '86abc' }, testContext()), testContext())
    expect(md).toMatch(/Due.*\+02:00/)
  })
})

describe('clickup_create_task', () => {
  it('resolves a natural language due date and echoes the resolution', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(...fx.listMetaHandlers(), http.post(
      'https://api.clickup.com/api/v2/list/100/task', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(fx.createdTask({ due_date: body.due_date as number }))
      }))
    const out = await tool('clickup_create_task').handler(
      { list_id: '100', name: 'Ship it', due_date: 'tomorrow 17:00' }, testContext())
    expect(typeof body.due_date).toBe('number')
    expect(tool('clickup_create_task').render(out, testContext())).toContain('+02:00')
  })

  it('rejects an unknown status naming the ones the list actually has', async () => {
    mswServer.use(...fx.listMetaHandlers())
    await expect(tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', status: 'shipped' }, testContext()))
      .rejects.toThrow(/List 100 has no status "shipped". Available: open, in progress, closed/)
  })

  it('rejects an unknown custom field name naming the available fields', async () => {
    mswServer.use(...fx.listMetaHandlers())
    await expect(tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Kunde: 'Selectry' } }, testContext()))
      .rejects.toThrow(/no custom field "Kunde".*Client/)
  })

  it('sends custom fields as resolved ids in a second call', async () => {
    const seen: string[] = []
    mswServer.use(...fx.listMetaHandlers(), ...fx.createWithFieldHandlers(seen))
    await tool('clickup_create_task').handler(
      { list_id: '100', name: 'x', custom_fields: { Client: 'Selectry' } }, testContext())
    expect(seen).toContain('/v2/task/86new/field/cf-1')
  })
})

describe('clickup_update_task', () => {
  it('appends to the description by default rather than overwriting', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(...fx.taskHandlers(), ...fx.updateHandler((b) => { body = b }))
    await tool('clickup_update_task').handler(
      { task_id: '86abc', description: 'New note' }, testContext())
    expect(body.description).toContain('Existing description')
    expect(body.description).toContain('New note')
  })

  it('overwrites only when explicitly asked', async () => {
    let body: Record<string, unknown> = {}
    mswServer.use(...fx.taskHandlers(), ...fx.updateHandler((b) => { body = b }))
    await tool('clickup_update_task').handler(
      { task_id: '86abc', description: 'Replaced', description_mode: 'overwrite' }, testContext())
    expect(body.description).toBe('Replaced')
  })

  it('returns the task as the API reports it, not the input echo', async () => {
    mswServer.use(...fx.taskHandlers(), ...fx.updateHandler(() => {}, { name: 'Server wins' }))
    const out = await tool('clickup_update_task').handler(
      { task_id: '86abc', name: 'Client says' }, testContext())
    expect(out.name).toBe('Server wins')
  })
})

describe('clickup_move_task', () => {
  it('detects a missing status in the destination and names it', async () => {
    mswServer.use(...fx.taskHandlers(), ...fx.listMetaHandlers({ listId: '200', statuses: ['todo'] }))
    await expect(tool('clickup_move_task').handler(
      { task_id: '86abc', list_id: '200' }, testContext()))
      .rejects.toThrow(/status "open" does not exist in list 200.*status_mappings/)
  })

  it('uses the v3 home_list endpoint', async () => {
    let path = ''
    mswServer.use(...fx.taskHandlers(), ...fx.listMetaHandlers({ listId: '200' }),
      http.put('https://api.clickup.com/api/v3/workspaces/9007/tasks/86abc/home_list/200',
        ({ request }) => { path = new URL(request.url).pathname; return HttpResponse.json({}) }))
    await tool('clickup_move_task').handler({ task_id: '86abc', list_id: '200' }, testContext())
    expect(path).toBe('/api/v3/workspaces/9007/tasks/86abc/home_list/200')
  })
})

describe('clickup_update_tasks_bulk', () => {
  it('reports per task success and failure rather than failing the whole call', async () => {
    mswServer.use(...fx.bulkHandlers({ failing: ['86bad'] }))
    const out = await tool('clickup_update_tasks_bulk').handler(
      { task_ids: ['86abc', '86bad'], status: 'closed' }, testContext())
    expect(out.succeeded).toEqual(['86abc'])
    expect(out.failed[0]).toMatchObject({ task_id: '86bad' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/tasks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the eight tools**

Input schemas, verbatim:

```ts
// clickup_get_task (read)
{ task_id: z.string(), include_comments: z.boolean().default(false) }

// clickup_list_tasks (read)
{
  list_id: z.string().optional(),
  space_id: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  due_before: z.string().optional(),
  due_after: z.string().optional(),
  include_closed: z.boolean().default(false),
  include_subtasks: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
}

// clickup_create_task (write)
{
  list_id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  due_date: z.string().optional(),
  start_date: z.string().optional(),
  time_estimate: z.string().optional(),
  parent: z.string().optional(),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}

// clickup_update_task (write): task_id plus every create field except list_id,
// plus description_mode: z.enum(['append', 'overwrite']).default('append')

// clickup_update_tasks_bulk (write)
{ task_ids: z.array(z.string()).min(1).max(50), status: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  due_date: z.string().optional() }

// clickup_move_task (write)
{ task_id: z.string(), list_id: z.string(),
  status_mappings: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  move_custom_fields: z.boolean().default(true) }

// clickup_delete_task (admin)
{ task_id: z.string() }

// clickup_link_tasks (write)
{ task_id: z.string(), other_task_id: z.string(),
  relation: z.enum(['link', 'blocks', 'blocked_by']).default('link') }
```

Behaviours the tests pin down, each mapping to a reliability rule:

- Status and custom field names are validated against `loadListMeta` before the
  write, and the error names what the list actually offers. This turns a
  rejected API call into a message the agent can act on.
- `description_mode` defaults to `append`, which reads the current description
  first and concatenates with a blank line separator. Overwriting is opt-in.
- Every write returns the entity from the API response.
- Bulk update is throttled through the limiter and reports partial success.
- Move pre-checks the destination status set and names the exact missing status.
- `time_estimate` accepts `1h30m` via `parseDuration`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/tasks.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/clickup/endpoints/tasks.ts src/format/task.ts src/tools/tasks.ts src/tools/index.ts tests/tools/tasks.test.ts tests/fixtures/tasks.ts
git commit -m "feat: task tools with pre-write validation and append-only descriptions"
```

---

### Task 12: Comment and tag tools

**Files:**
- Create: `src/clickup/endpoints/comments.ts`, `src/clickup/endpoints/tags.ts`, `src/format/comment.ts`, `src/tools/comments.ts`, `src/tools/tags.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/comments.test.ts`, `tests/tools/tags.test.ts`, `tests/fixtures/comments.ts`

**Interfaces:**
- Consumes: `ClickUpClient`, `paginate`, `formatDate`, `loadWorkspaceTree` (for space lookup in tag tools).
- Produces: `COMMENT_TOOLS`, `TAG_TOOLS`.

Input schemas, verbatim:

```ts
// clickup_get_comments (read)
{ task_id: z.string(), limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0) }

// clickup_create_comment (write)
{ task_id: z.string(), text: z.string().min(1),
  assignee: z.string().optional(), notify_all: z.boolean().default(false) }

// clickup_update_comment (write)
{ comment_id: z.string(), text: z.string().min(1), resolved: z.boolean().optional() }

// clickup_list_space_tags (read)
{ space_id: z.string() }

// clickup_set_task_tags (write)
{ task_id: z.string(), tags: z.array(z.string()) }
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('clickup_get_comments', () => {
  it('renders author, timestamp with offset and text', async () => { /* asserts +02:00 present */ })
  it('says so explicitly when a task has no comments', async () => {
    // expects 'Task 86abc has no comments.'
  })
})

describe('clickup_create_comment', () => {
  it('returns the comment id from the API response', async () => { /* out.id === '90010' */ })
})

describe('clickup_set_task_tags', () => {
  it('issues only the difference between current and desired tags', async () => {
    // current ['a','b'], desired ['b','c'] -> one DELETE for 'a', one POST for 'c'
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v2/task/86abc/tag/a' },
      { method: 'POST', path: '/v2/task/86abc/tag/c' },
    ])
  })

  it('makes no call at all when the tag set already matches', async () => {
    expect(calls).toEqual([])
  })

  it('rejects a tag that does not exist in the space, naming the available ones', async () => {
    await expect(run({ task_id: '86abc', tags: ['nope'] }))
      .rejects.toThrow(/Space 1 has no tag "nope". Available: a, b, c/)
  })
})
```

Write these out in full in the test files following the shape used in Task 11.

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Run: `npx vitest run tests/tools/comments.test.ts tests/tools/tags.test.ts`
Expected: FAIL first, then PASS.

Endpoints: `GET|POST /v2/task/{id}/comment`, `PUT /v2/comment/{id}`,
`GET /v2/space/{id}/tag`, `POST|DELETE /v2/task/{id}/tag/{tag_name}`.
`clickup_set_task_tags` reads the task's current tags, diffs against the
requested set, and validates every requested tag against the space tag list
before issuing any write. The task's space is resolved through
`loadWorkspaceTree` (task -> list -> folder -> space), which is already cached;
no new endpoint is introduced for it.

- [ ] **Step 3: Commit**

```bash
git add src/clickup/endpoints/comments.ts src/clickup/endpoints/tags.ts src/format/comment.ts src/tools/comments.ts src/tools/tags.ts src/tools/index.ts tests/tools/comments.test.ts tests/tools/tags.test.ts tests/fixtures/comments.ts
git commit -m "feat: comment tools and diffing tag tool"
```

---

### Task 13: Structure tools

**Files:**
- Create: `src/clickup/endpoints/structure.ts`, `src/tools/structure.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/structure.test.ts`

**Interfaces:**
- Consumes: `ClickUpClient`, `TtlCache.invalidate`, `loadWorkspaceTree`.
- Produces: `STRUCTURE_TOOLS` (nine definitions).

Input schemas, verbatim:

```ts
// clickup_create_space (write)
{ name: z.string().min(1), private: z.boolean().default(false),
  features: z.object({ time_tracking: z.boolean().optional(),
                       tags: z.boolean().optional(), due_dates: z.boolean().optional() }).optional() }
// clickup_update_space (write)   { space_id: z.string(), name: z.string().optional(), private: z.boolean().optional() }
// clickup_delete_space (admin)   { space_id: z.string(), confirm_name: z.string() }
// clickup_create_folder (write)  { space_id: z.string(), name: z.string().min(1) }
// clickup_update_folder (write)  { folder_id: z.string(), name: z.string().min(1) }
// clickup_delete_folder (admin)  { folder_id: z.string(), confirm_name: z.string() }
// clickup_create_list (write)    { name: z.string().min(1), folder_id: z.string().optional(),
//                                  space_id: z.string().optional(), content: z.string().optional(),
//                                  due_date: z.string().optional(), assignee: z.string().optional() }
// clickup_update_list (write)    { list_id: z.string(), name: z.string().optional(),
//                                  content: z.string().optional(), status: z.string().optional() }
// clickup_delete_list (admin)    { list_id: z.string(), confirm_name: z.string() }
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('delete guards', () => {
  it('refuses to delete when confirm_name does not match the actual name', async () => {
    await expect(run('clickup_delete_space', { space_id: '1', confirm_name: 'Wrong' }))
      .rejects.toThrow(/confirm_name "Wrong" does not match space name "Client Work"/)
  })

  it('deletes when confirm_name matches exactly', async () => { /* one DELETE issued */ })
})

describe('clickup_create_list', () => {
  it('requires exactly one of folder_id or space_id', async () => {
    await expect(run('clickup_create_list', { name: 'x' }))
      .rejects.toThrow(/Provide either folder_id or space_id/)
    await expect(run('clickup_create_list', { name: 'x', folder_id: '10', space_id: '1' }))
      .rejects.toThrow(/not both/)
  })
})

describe('cache invalidation', () => {
  it('invalidates the workspace tree after a structural write', async () => {
    // build tree, create a folder, build tree again -> two upstream fetches
    expect(treeFetches).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Endpoints: `POST /v2/team/{teamId}/space`, `PUT|DELETE /v2/space/{id}`,
`POST /v2/space/{id}/folder`, `PUT|DELETE /v2/folder/{id}`,
`POST /v2/folder/{id}/list`, `POST /v2/space/{id}/list`, `PUT|DELETE /v2/list/{id}`.

The `confirm_name` parameter on every delete tool is a deliberate second gate on
top of admin mode: deleting a space through the API is unrecoverable, so the
agent must have read the entity before it can destroy it.

Every mutating tool calls `ctx.cache.invalidate('tree:')` and, where a list is
affected, `ctx.cache.invalidate('list:<id>')`.

- [ ] **Step 3: Commit**

```bash
git add src/clickup/endpoints/structure.ts src/tools/structure.ts src/tools/index.ts tests/tools/structure.test.ts
git commit -m "feat: space, folder and list tools with confirm-name delete guards"
```

---

### Task 14: Time tracking tools

**Files:**
- Create: `src/clickup/endpoints/time.ts`, `src/format/time.ts`, `src/tools/time.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/time.test.ts`, `tests/fixtures/time.ts`

**Interfaces:**
- Consumes: `ClickUpClient`, `resolveDate`, `parseDuration`, `formatDate`, `paginate`.
- Produces: `TIME_TOOLS`, plus `getRunningEntry(ctx): Promise<TimeEntry | null>` reused by Task 15.

Input schemas, verbatim:

```ts
// clickup_start_timer (write)
{ task_id: z.string().optional(), description: z.string().optional(),
  billable: z.boolean().optional(), tags: z.array(z.string()).optional() }

// clickup_stop_timer (write)     { description: z.string().optional(), tags: z.array(z.string()).optional() }
// clickup_get_current_timer (read){}

// clickup_list_time_entries (read)
{ start_date: z.string().optional(), end_date: z.string().optional(),
  assignee: z.string().optional(), task_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0) }

// clickup_create_time_entry (write)
{ task_id: z.string().optional(), start: z.string(), duration: z.string(),
  description: z.string().optional(), billable: z.boolean().optional(),
  tags: z.array(z.string()).optional() }

// clickup_update_time_entry (write)
{ entry_id: z.string(), start: z.string().optional(), duration: z.string().optional(),
  description: z.string().optional(), billable: z.boolean().optional(),
  tags: z.array(z.string()).optional() }

// clickup_delete_time_entry (admin) { entry_id: z.string() }
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('clickup_start_timer', () => {
  it('refuses to start while a timer is already running, naming the running task', async () => {
    mswServer.use(...fx.runningTimer({ taskName: 'Fix login redirect', taskId: '86abc' }))
    await expect(run('clickup_start_timer', { task_id: '86def' }))
      .rejects.toThrow(/A timer is already running on Fix login redirect \(86abc\).*clickup_stop_timer/)
  })

  it('starts when nothing is running and echoes the resolved start time', async () => {
    const md = render(await run('clickup_start_timer', { task_id: '86abc' }))
    expect(md).toMatch(/Started .*\+02:00/)
  })
})

describe('clickup_get_current_timer', () => {
  it('states plainly that no timer is running instead of returning empty', async () => {
    mswServer.use(...fx.noRunningTimer())
    expect(render(await run('clickup_get_current_timer', {}))).toBe('No timer is currently running.')
  })

  it('reports elapsed time in h m form', async () => {
    expect(render(await run('clickup_get_current_timer', {}))).toContain('1h 23m')
  })
})

describe('clickup_create_time_entry', () => {
  it('accepts a human duration and sends milliseconds', async () => {
    await run('clickup_create_time_entry', { start: 'today 09:00', duration: '1h30m' })
    expect(body.duration).toBe(5_400_000)
  })

  it('echoes the resolved start and duration so a timezone error is visible', async () => {
    const md = render(await run('clickup_create_time_entry',
      { start: 'today 09:00', duration: '1h30m' }))
    expect(md).toContain('2026-09-02T09:00:00+02:00')
    expect(md).toContain('1h 30m')
  })

  it('rejects an unparseable duration rather than logging zero', async () => {
    await expect(run('clickup_create_time_entry', { start: 'today 09:00', duration: 'a while' }))
      .rejects.toThrow(/Could not parse duration/)
  })
})

describe('clickup_list_time_entries', () => {
  it('defaults to the last 7 days and says so in the output', async () => {
    expect(render(await run('clickup_list_time_entries', {}))).toContain('2026-08-26')
  })

  it('totals the listed duration', async () => {
    expect(render(await run('clickup_list_time_entries', {}))).toContain('Total: 6h 45m')
  })
})
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Endpoints: `POST /v2/team/{teamId}/time_entries/start`,
`POST /v2/team/{teamId}/time_entries/stop`,
`GET /v2/team/{teamId}/time_entries/current`,
`GET|POST /v2/team/{teamId}/time_entries`,
`PUT|DELETE /v2/team/{teamId}/time_entries/{id}`.

The start guard is the important one. ClickUp silently stops the previous timer
when a new one starts, which loses time an agent cannot recover. Checking first
and refusing with a named alternative is the safe behaviour.

- [ ] **Step 3: Commit**

```bash
git add src/clickup/endpoints/time.ts src/format/time.ts src/tools/time.ts src/tools/index.ts tests/tools/time.test.ts tests/fixtures/time.ts
git commit -m "feat: time tracking tools with running timer guard and human durations"
```

---

### Task 15: The daily aggregate tool

**Files:**
- Create: `src/tools/myday.ts`, `src/format/myday.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/myday.test.ts`

**Interfaces:**
- Consumes: `getRunningEntry` and the time entry endpoint (Task 14), the task listing endpoint (Task 11), `resolveDate` (Task 6).
- Produces: `MYDAY_TOOLS` with the single tool `clickup_get_my_day`.

Input schema: `{ date: z.string().optional() }`, where
`date` defaults to today in the configured timezone.

Output schema:

```ts
{
  date: z.string(),
  running_timer: z.object({ task_id: z.string().optional(), task_name: z.string().optional(),
                            started_at: z.string(), elapsed: z.string() }).nullable(),
  tracked_today: z.object({ total: z.string(), entries: z.array(z.object({
    id: z.string(), task_name: z.string().optional(), duration: z.string(),
    description: z.string().optional() })) }),
  due_today: z.array(TaskSummarySchema),
  overdue: z.array(TaskSummarySchema),
}
```

- [ ] **Step 1: Write the failing test**

```ts
describe('clickup_get_my_day', () => {
  it('composes running timer, tracked time, due and overdue in one call', async () => {
    mswServer.use(...fx.myDayHandlers())
    const out = await run('clickup_get_my_day', {})
    expect(out.running_timer?.task_name).toBe('Fix login redirect')
    expect(out.tracked_today.total).toBe('3h 15m')
    expect(out.due_today).toHaveLength(2)
    expect(out.overdue).toHaveLength(1)
  })

  it('renders a section per area and omits empty sections entirely', async () => {
    mswServer.use(...fx.myDayHandlers({ overdue: [] }))
    const md = render(await run('clickup_get_my_day', {}))
    expect(md).toContain('## Running timer')
    expect(md).not.toContain('## Overdue')
  })

  it('states plainly when nothing is running rather than omitting the section', async () => {
    mswServer.use(...fx.myDayHandlers({ running: null }))
    expect(render(await run('clickup_get_my_day', {}))).toContain('No timer is currently running.')
  })

  it('does not fail the whole call when the overdue query fails', async () => {
    mswServer.use(...fx.myDayHandlers({ overdueFails: true }))
    const md = render(await run('clickup_get_my_day', {}))
    expect(md).toContain('Overdue tasks could not be loaded')
    expect(md).toContain('## Running timer')
  })

  it('issues at most four upstream requests', async () => {
    mswServer.use(...fx.myDayHandlers(counter))
    await run('clickup_get_my_day', {})
    expect(counter.total).toBeLessThanOrEqual(4)
  })
})
```

The partial failure test matters: an aggregate tool that fails entirely when one
of four sources is unavailable is worse than the separate calls it replaces. A
failed section is reported as failed, never as empty.

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Implementation is composition only: `Promise.allSettled` over four existing
endpoint functions, with a rejected member rendering as a named failure line.
No new API surface.

- [ ] **Step 3: Commit**

```bash
git add src/tools/myday.ts src/format/myday.ts src/tools/index.ts tests/tools/myday.test.ts
git commit -m "feat: clickup_get_my_day aggregate with partial failure reporting"
```

---

### Task 16: Read-only Docs tools

**Files:**
- Create: `src/clickup/endpoints/docs.ts`, `src/format/doc.ts`, `src/tools/docs.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/docs.test.ts`, `tests/fixtures/docs.ts`

**Interfaces:**
- Consumes: `ClickUpClient.request` with `version: 'v3'`, `paginate`, `truncateResponse`.
- Produces: `DOC_TOOLS`.

Input schemas, verbatim:

```ts
// clickup_search_docs (read)
{ query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10),
  offset: z.number().int().min(0).default(0) }

// clickup_read_doc (read)
{ doc_id: z.string(), page_id: z.string().optional() }
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('clickup_search_docs', () => {
  it('matches on doc name and returns ids verbatim', async () => { /* out.items[0].id === 'd-1' */ })
  it('reports no match with the query that produced it', async () => {
    expect(render(await run('clickup_search_docs', { query: 'zzz' })))
      .toContain('No docs found matching "zzz"')
  })
})

describe('clickup_read_doc', () => {
  it('lists pages when no page_id is given rather than dumping the whole doc', async () => {
    const md = render(await run('clickup_read_doc', { doc_id: 'd-1' }))
    expect(md).toContain('Pages in')
    expect(md).toContain('Architecture (p-1)')
  })

  it('returns page content when a page_id is given', async () => {
    expect(render(await run('clickup_read_doc', { doc_id: 'd-1', page_id: 'p-1' })))
      .toContain('The system is layered')
  })

  it('announces truncation of an oversized page and names the remedy', async () => {
    const md = render(await run('clickup_read_doc',
      { doc_id: 'd-1', page_id: 'p-big' }), testContext({ maxResponseChars: 500 }))
    expect(md).toContain('Response truncated')
  })
})
```

Listing pages before dumping content is the token-efficient default: a doc can
be very large, and the agent usually wants one page.

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Endpoints: `GET /v3/workspaces/{teamId}/docs`,
`GET /v3/workspaces/{teamId}/docs/{doc_id}/pages`,
`GET /v3/workspaces/{teamId}/docs/{doc_id}/pages/{page_id}`.

- [ ] **Step 3: Commit**

```bash
git add src/clickup/endpoints/docs.ts src/format/doc.ts src/tools/docs.ts src/tools/index.ts tests/tools/docs.test.ts tests/fixtures/docs.ts
git commit -m "feat: read-only docs tools with page listing before content"
```

---

### Task 17: Streamable HTTP transport and security hardening

**Files:**
- Create: `src/bin/http.ts`, `src/http/tenant-store.ts`
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: `buildServer` (Task 9), `createContext` and `credentialKey` (Task 8), `loadConfig` (Task 1).
- Produces:
  - `function createHttpServer(config: ServerConfig): import('node:http').Server`
  - `class TenantStore` with `contextFor(token: string, teamId: string): ClickUpContext`, holding one cache and limiter per `credentialKey`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHttpServer } from '../src/bin/http.js'
import { loadConfig } from '../src/core/config.js'

let base: string
let server: ReturnType<typeof createHttpServer>

beforeAll(async () => {
  server = createHttpServer(loadConfig({
    CLICKUP_API_KEY: 'pk_env', CLICKUP_TEAM_ID: '9007',
    CLICKUP_ALLOWED_ORIGINS: 'https://claude.ai',
  }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })

const init = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
}

describe('http transport', () => {
  it('binds to loopback only', () => {
    expect((server.address() as { address: string }).address).toBe('127.0.0.1')
  })

  it('rejects a disallowed Origin', async () => {
    const res = await rpc(init, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('accepts an allowed Origin', async () => {
    expect((await rpc(init, { origin: 'https://claude.ai' })).status).toBe(200)
  })

  it('accepts a request with no Origin header, as a local client sends', async () => {
    expect((await rpc(init)).status).toBe(200)
  })

  it('rejects a request with no Authorization header when no env token is set', async () => {
    const s = createHttpServer(loadConfig({ CLICKUP_TEAM_ID: '9007', CLICKUP_API_KEY: '' }))
    // expects 401 with a body naming the Authorization header
  })

  it('prefers the Authorization header over the environment token', async () => {
    // asserts the upstream request carries the header token, not pk_env
  })

  it('isolates cache between two different tokens', async () => {
    // same tool call with two tokens triggers two upstream fetches
  })

  it('returns 404 for any path other than /mcp', async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(404)
  })

  it('never echoes the token in an error body', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'nope' }, { authorization: 'pk_secret' })
    expect(await res.text()).not.toContain('pk_secret')
  })
})
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Implementation notes:

- One `node:http` server, single route `POST /mcp`, everything else 404.
- `StreamableHTTPServerTransport` in stateless JSON mode:
  `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`.
  A fresh server and transport per request, closed on response end. Stateless
  removes session bookkeeping and makes horizontal scaling trivial.
- Origin validation runs before anything else. Missing Origin is allowed, since
  local MCP clients do not send one; a present Origin must be in
  `CLICKUP_ALLOWED_ORIGINS`. This is the DNS rebinding defence.
- Credentials come from the `Authorization` header when present, falling back to
  `CLICKUP_API_KEY`. Team id comes from `X-ClickUp-Team-Id` or `CLICKUP_TEAM_ID`.
- `TenantStore` keys one cache and one limiter per `credentialKey`, so tenants
  never share cached workspace data and never share a rate budget.
- Bind address comes from `CLICKUP_HTTP_HOST`, default `127.0.0.1`. Binding
  elsewhere is explicit, and the startup log names the address on stderr.
- Auth resolution has no feature flag: header if present, else `CLICKUP_API_KEY`,
  else 401 naming the `Authorization` header.

- [ ] **Step 3: Commit**

```bash
git add src/bin/http.ts src/http/tenant-store.ts tests/http.test.ts
git commit -m "feat: stateless streamable http transport with origin and tenant isolation"
```

---

### Task 18: Documentation

**Files:**
- Create: `README.md`, `docs/ARCHITECTURE.md`, `docs/RELIABILITY.md`, `CONTRIBUTING.md`, `LICENSE`, `scripts/generate-tool-docs.ts`
- Generate: `docs/TOOLS.md`
- Test: `tests/docs.test.ts`

**Interfaces:**
- Consumes: `ALL_TOOLS` (Tasks 10 to 16), `annotationsFor` (Task 8).
- Produces: `function renderToolDocs(tools: AnyToolDefinition[]): string`.

- [ ] **Step 1: Write the failing drift test**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_TOOLS } from '../src/tools/index.js'
import { renderToolDocs } from '../scripts/generate-tool-docs.js'

describe('tool documentation', () => {
  it('docs/TOOLS.md matches the registry', () => {
    expect(readFileSync('docs/TOOLS.md', 'utf8')).toBe(renderToolDocs(ALL_TOOLS))
  })

  it('every tool has a description naming when not to use it', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(80)
      expect(t.description).toMatch(/Example|Use /)
    }
  })

  it('every tool name is prefixed and snake_case', () => {
    for (const t of ALL_TOOLS) expect(t.name).toMatch(/^clickup_[a-z0-9_]+$/)
  })

  it('README documents every environment variable the config reads', () => {
    const readme = readFileSync('README.md', 'utf8')
    for (const v of ['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID', 'CLICKUP_MCP_MODE',
      'CLICKUP_ENABLED_CATEGORIES', 'CLICKUP_DISABLED_TOOLS', 'CLICKUP_TIMEZONE',
      'CLICKUP_CACHE_TTL_SECONDS', 'CLICKUP_RATE_LIMIT', 'CLICKUP_MAX_RESPONSE_CHARS',
      'CLICKUP_HTTP_PORT', 'CLICKUP_HTTP_HOST', 'CLICKUP_ALLOWED_ORIGINS', 'LOG_LEVEL']) {
      expect(readme).toContain(v)
    }
  })

  it('exactly 36 tools are registered', () => {
    expect(ALL_TOOLS).toHaveLength(36)
  })
})
```

The first test is what keeps documentation honest: `docs/TOOLS.md` is generated,
and CI fails if someone edits a tool without regenerating.

- [ ] **Step 2: Implement the generator and write the prose docs**

`renderToolDocs` emits a table of contents, then one section per category with
tool name, mode, annotations, input parameters with types and descriptions, and
the output schema keys.

`README.md` covers: what the server is, install, the full configuration table,
client configuration for stdio (Claude Code `claude mcp add`, Claude Desktop
JSON) and for HTTP, the tool table, and three worked examples: start a timer on
a task found by search; create a task with a due date and a custom field; review
the day with `clickup_get_my_day`.

`docs/RELIABILITY.md` is section 7 of the spec as a maintained checklist, each
rule linking to the test that enforces it.

- [ ] **Step 3: Generate, verify and commit**

Run: `npm run docs:tools && npx vitest run tests/docs.test.ts`
Expected: PASS, 5 tests.

```bash
git add README.md docs/ARCHITECTURE.md docs/RELIABILITY.md docs/TOOLS.md CONTRIBUTING.md LICENSE scripts/generate-tool-docs.ts tests/docs.test.ts
git commit -m "docs: readme, architecture, reliability checklist and generated tool reference"
```

---

### Task 19: Evaluations and CI

**Files:**
- Create: `evals/clickup-daily.xml`, `evals/README.md`, `.github/workflows/ci.yml`
- Test: `tests/evals.test.ts`

**Interfaces:**
- Consumes: the running server.
- Produces: an evaluation set in the XML format from the MCP evaluation guide.

- [ ] **Step 1: Explore the real workspace read-only**

With `CLICKUP_MCP_MODE=read`, use the inspector (`npm run inspect`) to browse the
actual workspace. Evaluation questions must be answerable from real data.

- [ ] **Step 2: Write ten questions**

Each question must be independent, read-only, require several tool calls, have
one verifiable answer, and be stable over time. Shape:

```xml
<evaluation>
  <qa_pair>
    <question>In the space that contains a list named "Sprint 1", how many custom fields are defined on that list, and what is the name of the only drop down field among them?</question>
    <answer>3, Client</answer>
  </qa_pair>
</evaluation>
```

Cover at minimum: workspace navigation, task filtering by assignee and due date,
status discovery before a write, time entry aggregation over a fixed past week,
member disambiguation, and doc page lookup. Avoid anything whose answer moves:
no "today", no open task counts, no running timers.

- [ ] **Step 3: Verify every answer by solving it yourself**

Answer each question through the tools and record the result. A question whose
answer you cannot reproduce exactly is removed, not softened.

- [ ] **Step 4: Add the structural eval test**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('evaluation set', () => {
  const xml = readFileSync('evals/clickup-daily.xml', 'utf8')

  it('contains exactly ten qa pairs', () => {
    expect(xml.match(/<qa_pair>/g)).toHaveLength(10)
  })

  it('has a non empty answer for every question', () => {
    const answers = [...xml.matchAll(/<answer>(.*?)<\/answer>/gs)].map((m) => m[1]!.trim())
    expect(answers).toHaveLength(10)
    expect(answers.every((a) => a.length > 0)).toBe(true)
  })

  it('contains no time relative wording that would make answers unstable', () => {
    expect(xml.toLowerCase()).not.toMatch(/\b(today|yesterday|this week|currently)\b/)
  })
})
```

- [ ] **Step 5: Add CI**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run coverage
      - run: npm run docs:tools && git diff --exit-code docs/TOOLS.md
```

The last line is the documentation drift gate.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run coverage`
Expected: PASS, coverage thresholds met.

```bash
git add evals .github/workflows/ci.yml tests/evals.test.ts
git commit -m "test: evaluation set and ci with coverage and docs drift gates"
```

---

## Self-review

Checked after writing, issues fixed inline.

**Spec coverage.** Every section maps to a task: architecture to Tasks 8 and 9,
the 36 tools to Tasks 10 through 16, response design to Task 7 with per-tool
assertions throughout, the nine reliability rules to the tests named below,
error handling to Task 2, configuration to Task 1, security to Tasks 5 and 17,
testing to every task plus the thresholds in Task 1, evaluations to Task 19,
documentation to Task 18, milestones to the task order.

**Reliability rules to enforcing tests.**

| Rule | Enforced by |
|---|---|
| 1 Response validation | Task 5 `ClickUpSchemaError` test |
| 2 Omit missing values | Task 7 `omitEmpty` and `bulletList`, Task 11 unset due date |
| 3 Verbatim ids | Task 10 tree and member tests, Task 16 doc id test |
| 4 Surface ambiguity | Task 10 `clickup_resolve_member` ambiguity test |
| 5 Explicit empty results | Tasks 10, 12, 14, 16 empty result tests |
| 6 Errors never become empty | Task 2 mapping tests, Task 15 partial failure test |
| 7 Echo resolved dates | Task 6 offset test, Tasks 11 and 14 echo tests |
| 8 Visible truncation | Task 7 truncation test, Task 16 oversized page test |
| 9 Strict inputs | Task 9 unknown argument test |

**Type consistency.** `ClickUpContext` is defined once in Task 8 and consumed
unchanged everywhere. `Page<T>` from Task 7 is the return shape of every list
tool. `loadListMeta` returns `ListMeta`, used by Tasks 11 and 13. `resolveDate`
returns `{ epochMs, iso }` in Tasks 6, 11, 14 and 15. `getRunningEntry` is
defined in Task 14 and reused in Task 15. Tool counts: 4 + 8 + 3 + 9 + 2 + 7 +
2 + 1 = 36, matching the assertion in Task 18.

**Two gaps found and closed.** The spec mentions `CLICKUP_DISABLED_TOOLS` but no
task originally consumed it, so it is now asserted in Task 8. The spec requires
that logging never reaches stdout with no mechanism behind it, so Task 9 gained
the stdout guard test.
