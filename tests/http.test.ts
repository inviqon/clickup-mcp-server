import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createHttpServer } from '../src/bin/http.js'
import { loadConfig } from '../src/core/config.js'

/**
 * A file-local msw server, not the shared `tests/support/msw.ts` singleton:
 * every request this file's own assertions make goes to `fetch(base + ...)`
 * on `127.0.0.1`, and msw's node interceptor patches globally, not just for
 * ClickUp's host - the shared helper's `onUnhandledRequest: 'error'` would
 * fail every one of those as an "unhandled request" before it ever reaches
 * this server. Loopback traffic is bypassed silently (no matching handler
 * needed - it is the thing under test, not a mock target); any request to
 * `api.clickup.com` without a registered handler still fails loudly, the
 * same strictness every other test file gets from the shared helper.
 */
const mswServer = setupServer()
beforeAll(() =>
  mswServer.listen({
    onUnhandledRequest: (request, print) => {
      if (new URL(request.url).hostname === '127.0.0.1') {
        return
      }
      print.error()
    },
  }),
)
afterEach(() => mswServer.resetHandlers())
afterAll(() => mswServer.close())

let base: string
let server: ReturnType<typeof createHttpServer>

beforeAll(async () => {
  server = createHttpServer(
    loadConfig({
      CLICKUP_API_KEY: 'pk_env',
      CLICKUP_TEAM_ID: '9007',
      CLICKUP_ALLOWED_ORIGINS: 'https://claude.ai',
    }),
  )
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
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
}

const resolveMeCall = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'clickup_resolve_member', arguments: { query: 'me' } },
})

const workspaceTreeCall = {
  jsonrpc: '2.0',
  id: 99,
  method: 'tools/call',
  params: { name: 'clickup_get_workspace_tree', arguments: {} },
}

describe('http transport', () => {
  it('binds to 127.0.0.1 by default when CLICKUP_HTTP_HOST is not set - the actual default, not a hardcoded listen() address', async () => {
    const config = loadConfig({ CLICKUP_API_KEY: 'pk_env', CLICKUP_TEAM_ID: '9007' })
    expect(config.httpHost).toBe('127.0.0.1')
    const s = createHttpServer(config)
    // Deliberately binds using config.httpHost, the same value the real
    // clickup-mcp-http entry point (src/bin/http.ts's own listen() call)
    // uses, rather than the outer `server`'s hardcoded '127.0.0.1' in this
    // file's own beforeAll - that only proves listen() reports back
    // whatever address it was told to use, not that the default is loopback.
    await new Promise<void>((r) => s.listen(0, config.httpHost, r))
    try {
      expect((s.address() as { address: string }).address).toBe('127.0.0.1')
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })

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

  it('rejects a disallowed Origin before making any ClickUp call', async () => {
    let called = false
    mswServer.use(
      http.get('https://api.clickup.com/api/v2/user', () => {
        called = true
        return HttpResponse.json({ user: { id: 1, username: 'should-not-be-reached' } })
      }),
    )
    const res = await rpc(resolveMeCall(2), { origin: 'https://evil.example', authorization: 'pk_whoever' })
    expect(res.status).toBe(403)
    expect(called).toBe(false)
  })

  it('returns 404 for any path other than /mcp', async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(404)
  })

  it('returns 404 for a non-POST request to /mcp', async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(404)
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(404)
  })

  it('never echoes the token in an error body', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'nope' }, { authorization: 'pk_secret' })
    expect(await res.text()).not.toContain('pk_secret')
  })

  it('rejects a malformed JSON body without leaking the token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'pk_secret',
      },
      body: '{not valid json',
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain('pk_secret')
  })
})

describe('credentials', () => {
  it('rejects a request with no Authorization header when no env token is set', async () => {
    const s = createHttpServer(loadConfig({ CLICKUP_TEAM_ID: '9007', CLICKUP_API_KEY: '' }))
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const addr = s.address() as { port: number }
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(init),
      })
      expect(res.status).toBe(401)
      const text = await res.text()
      expect(text).toContain('Authorization')
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })

  it('accepts a request using only CLICKUP_API_KEY when no Authorization header is sent', async () => {
    expect((await rpc(init)).status).toBe(200)
  })

  it('prefers the Authorization header over the environment token', async () => {
    const seenTokens: Array<string | null> = []
    mswServer.use(
      http.get('https://api.clickup.com/api/v2/user', ({ request }) => {
        seenTokens.push(request.headers.get('authorization'))
        return HttpResponse.json({ user: { id: 1, username: 'header-user' } })
      }),
    )
    const res = await rpc(resolveMeCall(3), { authorization: 'pk_header_token' })
    expect(res.status).toBe(200)
    expect(seenTokens).toEqual(['pk_header_token'])
    expect(seenTokens).not.toContain('pk_env')
  })
})

describe('tenant isolation', () => {
  it('isolates cache between two different tokens - the second token triggers its own upstream fetch', async () => {
    let upstreamCalls = 0
    mswServer.use(
      http.get('https://api.clickup.com/api/v2/team/9007/space', () => {
        upstreamCalls++
        return HttpResponse.json({ spaces: [] })
      }),
    )

    const resA = await rpc(workspaceTreeCall, { authorization: 'pk_tenant_a' })
    expect(resA.status).toBe(200)
    expect(upstreamCalls).toBe(1)

    // Same call, same team id, a DIFFERENT token: if TenantStore shared a
    // cache across tenants, this would return tenant A's cached (empty)
    // tree without a second upstream fetch. It must not.
    const resB = await rpc(workspaceTreeCall, { authorization: 'pk_tenant_b' })
    expect(resB.status).toBe(200)
    expect(upstreamCalls).toBe(2)

    // A repeat call for tenant A now hits ITS OWN cache - no third fetch.
    const resA2 = await rpc(workspaceTreeCall, { authorization: 'pk_tenant_a' })
    expect(resA2.status).toBe(200)
    expect(upstreamCalls).toBe(2)
  })
})
