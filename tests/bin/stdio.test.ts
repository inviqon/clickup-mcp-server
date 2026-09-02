import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertApiKeyPresent, logReadiness } from '../../src/bin/stdio.js'
import { loadConfig } from '../../src/core/config.js'

describe('assertApiKeyPresent', () => {
  it('throws naming CLICKUP_API_KEY when the key is empty but present', () => {
    expect(() => assertApiKeyPresent({ apiKey: '' })).toThrow(/CLICKUP_API_KEY/)
  })

  it('does not throw when a real key is set', () => {
    expect(() => assertApiKeyPresent({ apiKey: 'pk_123' })).not.toThrow()
  })
})

describe('logReadiness', () => {
  const base = { CLICKUP_API_KEY: 'pk_123', CLICKUP_TEAM_ID: '9007' }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses the readiness line when LOG_LEVEL=warn', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig({ ...base, LOG_LEVEL: 'warn' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the readiness line when LOG_LEVEL=debug', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig({ ...base, LOG_LEVEL: 'debug' }))
    expect(spy).toHaveBeenCalledWith('clickup-mcp ready: mode=write')
  })

  it('keeps the readiness line at the default LOG_LEVEL (info)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig(base))
    expect(spy).toHaveBeenCalledWith('clickup-mcp ready: mode=write')
  })
})
