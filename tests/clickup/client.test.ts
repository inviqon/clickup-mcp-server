import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
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
    let resetSeconds = 0
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', () => {
      calls++
      if (calls === 1) {
        resetSeconds = Math.floor(Date.now() / 1000) + 1
        return new HttpResponse(null, {
          status: 429,
          headers: { 'X-RateLimit-Reset': String(resetSeconds) },
        })
      }
      return HttpResponse.json({ id: '1' })
    }))
    // Constructed locally (rather than via the shared `client()` helper) so the
    // test can spy on this specific limiter instance's notifyReset method.
    const limiter = new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} })
    const notifyReset = vi.spyOn(limiter, 'notifyReset')
    const out = await new ClickUpClient({ token: 'pk_123', limiter })
      .request({ method: 'GET', path: '/task/1', schema })
    expect(out.id).toBe('1')
    expect(calls).toBe(2)
    // Pin that notifyReset was actually invoked, and with a correctly-converted
    // Date: X-RateLimit-Reset is Unix seconds, Date expects milliseconds, so a
    // seconds-treated-as-milliseconds bug must fail this assertion.
    expect(notifyReset).toHaveBeenCalledTimes(1)
    expect(notifyReset.mock.calls[0]?.[0]).toBeInstanceOf(Date)
    expect((notifyReset.mock.calls[0]?.[0] as Date).getTime()).toBe(resetSeconds * 1000)
  })

  it('surfaces a persistent 429 as ClickUpApiError carrying resetAt', async () => {
    let resetSeconds = 0
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1', () => {
      resetSeconds = Math.floor(Date.now() / 1000) + 1
      return new HttpResponse(null, {
        status: 429,
        headers: { 'X-RateLimit-Reset': String(resetSeconds) },
      })
    }))
    const c = new ClickUpClient({
      token: 'pk_123', maxRetries: 1,
      limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
    })
    const err = await c.request({ method: 'GET', path: '/task/1', schema })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ClickUpApiError)
    expect((err as ClickUpApiError).status).toBe(429)
    // Pin resetAt to the exact millisecond value derived from the header the
    // handler sent, not just "some Date", so a unit conversion bug (seconds
    // mistaken for milliseconds) fails this test too.
    expect((err as ClickUpApiError).resetAt).toBeInstanceOf(Date)
    expect((err as ClickUpApiError).resetAt?.getTime()).toBe(resetSeconds * 1000)
  })

  it('raises ClickUpApiError carrying the ClickUp ECODE on 404', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ err: 'Task not found', ECODE: 'ITEM_013' }, { status: 404 })))
    await expect(client().request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toMatchObject({ status: 404, ecode: 'ITEM_013' })
  })

  it('raises ClickUpApiError carrying ClickUp\'s own err message on 403', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ err: 'Time In Status is not available on your plan' }, { status: 403 })))
    await expect(client().request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toMatchObject({ status: 403, clickupMessage: 'Time In Status is not available on your plan' })
  })

  it('leaves clickupMessage undefined when the error body carries no err field', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ ECODE: 'ITEM_013' }, { status: 404 })))
    const err = await client().request({ method: 'GET', path: '/task/1', schema })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ClickUpApiError)
    expect((err as ClickUpApiError).clickupMessage).toBeUndefined()
  })

  it('carries ClickUp\'s own err message on a persistent 429', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => new HttpResponse(JSON.stringify({ err: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1) },
      })))
    const c = new ClickUpClient({
      token: 'pk_123', maxRetries: 0,
      limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
    })
    const err = await c.request({ method: 'GET', path: '/task/1', schema })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ClickUpApiError)
    expect((err as ClickUpApiError).clickupMessage).toBe('Rate limit exceeded')
  })

  it('carries ClickUp\'s own err message on a persistent 500', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ err: 'Internal error' }, { status: 500 })))
    const c = new ClickUpClient({
      token: 'pk_123', maxRetries: 0,
      limiter: new RateLimiter({ limitPerMinute: 1000, sleep: async () => {} }),
    })
    const err = await c.request({ method: 'GET', path: '/task/1', schema })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ClickUpApiError)
    expect((err as ClickUpApiError).clickupMessage).toBe('Internal error')
  })

  it('raises ClickUpSchemaError rather than returning an unvalidated payload', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/task/1',
      () => HttpResponse.json({ id: 42 })))
    await expect(client().request({ method: 'GET', path: '/task/1', schema }))
      .rejects.toBeInstanceOf(ClickUpSchemaError)
  })

  it('rejects a 2xx response with a non-JSON body instead of treating it as empty', async () => {
    mswServer.use(http.get('https://api.clickup.com/api/v2/list/1',
      () => new HttpResponse('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })))
    // z.object({}) is the brief's recommended schema for delete-style endpoints
    // with no payload; a corrupted body must not silently pass it as `{}`.
    await expect(client().request({ method: 'GET', path: '/list/1', schema: z.object({}) }))
      .rejects.toBeInstanceOf(ClickUpApiError)
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
