import { describe, expect, it } from 'vitest'
import { ClickUpClient } from '../../src/clickup/client.js'
import { TtlCache } from '../../src/core/cache.js'
import type { ServerConfig } from '../../src/core/config.js'
import { createContext, credentialKey } from '../../src/core/context.js'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'pk_test_token',
    teamId: 'team-1',
    mode: 'write',
    enabledCategories: null,
    disabledTools: [],
    timezone: 'Europe/Vienna',
    cacheTtlSeconds: 300,
    rateLimit: 100,
    maxResponseChars: 40000,
    httpPort: 3000,
    httpHost: '127.0.0.1',
    allowedOrigins: [],
    logLevel: 'info',
    ...overrides,
  }
}

describe('createContext', () => {
  it('builds a context whose plain fields mirror the config', () => {
    const ctx = createContext(config({ teamId: 'team-42', mode: 'admin', timezone: 'UTC', maxResponseChars: 123 }))
    expect(ctx.teamId).toBe('team-42')
    expect(ctx.mode).toBe('admin')
    expect(ctx.timezone).toBe('UTC')
    expect(ctx.maxResponseChars).toBe(123)
  })

  it('constructs a real ClickUpClient and TtlCache, not stubs', () => {
    const ctx = createContext(config())
    expect(ctx.client).toBeInstanceOf(ClickUpClient)
    expect(ctx.cache).toBeInstanceOf(TtlCache)
  })

  it('builds independent instances on each call, sharing no mutable module state', () => {
    const first = createContext(config())
    const second = createContext(config())
    expect(first.cache).not.toBe(second.cache)
    expect(first.client).not.toBe(second.client)
  })
})

describe('credentialKey', () => {
  it('differs for different tokens with the same team id', () => {
    expect(credentialKey('token-a', 'team-1')).not.toBe(credentialKey('token-b', 'team-1'))
  })

  it('differs for the same token with different team ids', () => {
    expect(credentialKey('token-a', 'team-1')).not.toBe(credentialKey('token-a', 'team-2'))
  })

  it('never contains the raw token', () => {
    const token = 'pk_super_secret_token_value'
    expect(credentialKey(token, 'team-1')).not.toContain(token)
  })

  it('is deterministic for the same token and team id', () => {
    expect(credentialKey('token-a', 'team-1')).toBe(credentialKey('token-a', 'team-1'))
  })

  it('has the shape sha256(token).slice(0, 16) + ":" + teamId', () => {
    const key = credentialKey('token-a', 'team-9')
    expect(key).toMatch(/^[0-9a-f]{16}:team-9$/)
  })
})
