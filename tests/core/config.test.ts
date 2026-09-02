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
