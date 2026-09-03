import { describe, expect, it } from 'vitest'
import { ClickUpApiError, ClickUpSchemaError, toAgentMessage, ClickUpUsageError } from '../../src/core/errors.js'

const err = (status: number, endpoint: string, ecode?: string, clickupMessage?: string) =>
  new ClickUpApiError('api failed', { status, endpoint, ecode, clickupMessage })

describe('toAgentMessage', () => {
  it('maps 401 to a credential hint', () => {
    expect(toAgentMessage(err(401, '/v2/user')))
      .toBe('Invalid ClickUp token. Check CLICKUP_API_KEY.')
  })

  it('puts ClickUp\'s own message first on a 401 that carries one, with no dangling separator', () => {
    expect(toAgentMessage(err(401, '/v2/user', undefined, 'Token not found')))
      .toBe('ClickUp says: "Token not found". Invalid ClickUp token. Check CLICKUP_API_KEY.')
  })

  it('maps 404 on a list to a discovery next step naming the id', () => {
    expect(toAgentMessage(err(404, '/v2/list/123'), { resource: 'list', id: '123' }))
      .toBe('List 123 not found. Use clickup_get_workspace_tree to list valid list ids.')
  })

  it('puts ClickUp\'s own message first on a 404 that carries one', () => {
    expect(toAgentMessage(err(404, '/v2/list/123', undefined, 'List not found'), { resource: 'list', id: '123' }))
      .toBe('ClickUp says: "List not found". List 123 not found. Use clickup_get_workspace_tree to list valid list ids.')
  })

  it('maps 403 with no ClickUp message to an actionable but hedged hint, not a firm diagnosis', () => {
    const msg = toAgentMessage(err(403, '/v2/list/123'), { resource: 'list', id: '123' })
    expect(msg).toContain('different workspace than CLICKUP_TEAM_ID')
    // Demonstrably wrong in a real case (ClickUp returned "not available on
    // your plan" for a resource in the correctly-configured workspace), so
    // the hint must not read as a confident diagnosis.
    expect(msg).toMatch(/can also be|may also be|might also be/)
  })

  it('surfaces ClickUp\'s own words first on a 403, ahead of our hypothesis', () => {
    const msg = toAgentMessage(
      err(403, '/v2/task/86abc', undefined, 'Time In Status is not available on your plan'),
      { resource: 'task', id: '86abc' },
    )
    expect(msg.startsWith('ClickUp says: "Time In Status is not available on your plan".')).toBe(true)
    expect(msg).toContain('different workspace than CLICKUP_TEAM_ID')
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

  it('puts ClickUp\'s own message first on a 429 that carries one', () => {
    const e = new ClickUpApiError('rate limited', {
      status: 429, endpoint: '/v2/task/1', clickupMessage: 'Rate limit exceeded',
    })
    expect(toAgentMessage(e))
      .toBe('ClickUp says: "Rate limit exceeded". ClickUp rate limit hit. Wait a moment and retry.')
  })

  // Smaller issue 4: observed live in a bulk update against a deliberately
  // invalid task id. A 400 means ClickUp rejected the request itself, so
  // "retry" is advice that cannot help - and the message must not repeat
  // itself by also including this server's own synthetic
  // "ClickUp API request failed (400)" sentence alongside ClickUp's own
  // "Task ID invalid" (already surfaced via `prefix`).
  it('advises checking the arguments on a 400, not retrying, without a redundant synthetic sentence', () => {
    const msg = toAgentMessage(err(400, '/v2/task/869eunINVALID', undefined, 'Task ID invalid'))
    expect(msg).toContain('ClickUp says: "Task ID invalid".')
    expect(msg).toContain('ClickUp API error (400)')
    expect(msg).toMatch(/check the arguments/i)
    expect(msg).not.toContain('Retry')
    expect(msg).not.toContain('api failed')
  })

  it('advises checking arguments on a 400 with no ClickUp message either', () => {
    const msg = toAgentMessage(err(400, '/v2/task/869eunINVALID'))
    expect(msg).toMatch(/check the arguments/i)
    expect(msg).not.toContain('Retry')
    expect(msg).not.toContain('api failed')
  })

  it('gives a retry next step for an unmapped status code', () => {
    const msg = toAgentMessage(err(500, '/v2/task/1'))
    expect(msg).toContain('ClickUp API error (500)')
    expect(msg).toContain('Retry')
    // Not the redundant synthetic sentence either - "api failed" is this
    // test's stand-in for the server's own generated message text, which
    // never adds information beyond the "(500)" already shown.
    expect(msg).not.toContain('api failed')
  })

  it('puts ClickUp\'s own message first on an unmapped status code that carries one', () => {
    const msg = toAgentMessage(err(500, '/v2/task/1', undefined, 'Internal error'))
    expect(msg.startsWith('ClickUp says: "Internal error".')).toBe(true)
    expect(msg).toContain('ClickUp API error (500)')
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
