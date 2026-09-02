import { afterEach, describe, expect, it, vi } from 'vitest'
import { logStderr, shouldLog } from '../../src/core/logger.js'

describe('shouldLog', () => {
  it('orders levels debug < info < warn < error', () => {
    expect(shouldLog('debug', 'debug')).toBe(true)
    expect(shouldLog('debug', 'info')).toBe(true)
    expect(shouldLog('debug', 'warn')).toBe(true)
    expect(shouldLog('debug', 'error')).toBe(true)
  })

  it('suppresses a message below the configured level', () => {
    expect(shouldLog('warn', 'info')).toBe(false)
    expect(shouldLog('warn', 'debug')).toBe(false)
    expect(shouldLog('error', 'warn')).toBe(false)
  })

  it('keeps a message at or above the configured level', () => {
    expect(shouldLog('warn', 'warn')).toBe(true)
    expect(shouldLog('warn', 'error')).toBe(true)
    expect(shouldLog('info', 'info')).toBe(true)
  })
})

describe('logStderr', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes to console.error when the level clears the threshold', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logStderr('debug', 'info', 'clickup-mcp ready: mode=write')
    expect(spy).toHaveBeenCalledWith('clickup-mcp ready: mode=write')
  })

  it('does not write to console.error when the level is below the threshold', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logStderr('warn', 'info', 'clickup-mcp ready: mode=write')
    expect(spy).not.toHaveBeenCalled()
  })
})
