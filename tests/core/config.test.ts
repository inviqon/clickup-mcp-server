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

  it('parses comma separated disabled tools and allowed origins', () => {
    const c = loadConfig({
      ...base,
      CLICKUP_DISABLED_TOOLS: 'clickup_delete_task, clickup_delete_list ,',
      CLICKUP_ALLOWED_ORIGINS: 'https://a.example, https://b.example ,',
    })
    expect(c.disabledTools).toEqual(['clickup_delete_task', 'clickup_delete_list'])
    expect(c.allowedOrigins).toEqual(['https://a.example', 'https://b.example'])
  })

  // A zero rate limit used to pass validation, then make RateLimiter's
  // refillPerMs zero and every computed wait Infinity - the server started
  // cleanly and hung on the first tool call with nothing said about why.
  it('rejects a zero rate limit rather than accepting a limiter that can never refill', () => {
    expect(() => loadConfig({ ...base, CLICKUP_RATE_LIMIT: '0' }))
      .toThrow(/CLICKUP_RATE_LIMIT must be greater than 0/)
  })

  it('rejects a negative rate limit', () => {
    expect(() => loadConfig({ ...base, CLICKUP_RATE_LIMIT: '-5' }))
      .toThrow(/CLICKUP_RATE_LIMIT must be greater than 0/)
  })

  it('accepts a valid custom numeric override', () => {
    const c = loadConfig({ ...base, CLICKUP_RATE_LIMIT: '250' })
    expect(c.rateLimit).toBe(250)
  })

  it('rejects an unknown log level naming the valid values', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' }))
      .toThrow(/debug, info, warn, error/)
  })

  it('rejects an unknown category naming the valid values', () => {
    expect(() => loadConfig({ ...base, CLICKUP_ENABLED_CATEGORIES: 'tasks,bogus' }))
      .toThrow(/unknown category "bogus"/)
  })
})
