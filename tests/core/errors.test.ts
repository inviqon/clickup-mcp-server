import { describe, expect, it } from 'vitest'
import { ClickUpApiError, ClickUpSchemaError, toAgentMessage, ClickUpUsageError } from '../../src/core/errors.js'

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

  it('gives a retry next step for a 429 with no resetAt', () => {
    const e = new ClickUpApiError('rate limited', { status: 429, endpoint: '/v2/task/1' })
    const msg = toAgentMessage(e)
    expect(msg).toContain('rate limit')
    expect(msg).toContain('retry')
  })

  it('gives a retry next step for an unmapped status code', () => {
    const msg = toAgentMessage(err(500, '/v2/task/1'))
    expect(msg).toContain('ClickUp API error (500)')
    expect(msg).toContain('Retry')
  })

  // Deliberate, actionable errors (a bad status name, an unknown custom
  // field, a confirm_name mismatch, the running-timer guard) used to be
  // plain Errors and so reached the agent as "Unexpected error: ...", which
  // reads as a transient fault to retry rather than an argument to fix.
  it('passes a usage error through verbatim rather than calling it unexpected', () => {
    const msg = toAgentMessage(new ClickUpUsageError('List 100 has no status "dnoe". Available: open, closed'))
    expect(msg).toBe('List 100 has no status "dnoe". Available: open, closed')
    expect(msg).not.toContain('Unexpected error')
  })

  it('still wraps a genuinely unexpected error', () => {
    expect(toAgentMessage(new Error('kaboom'))).toBe('Unexpected error: kaboom')
  })
})
