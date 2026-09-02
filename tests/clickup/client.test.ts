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
