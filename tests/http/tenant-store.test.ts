import { describe, expect, it } from 'vitest'
import { TenantStore } from '../../src/http/tenant-store.js'
import { loadConfig } from '../../src/core/config.js'

const config = loadConfig({ CLICKUP_API_KEY: 'pk_env', CLICKUP_TEAM_ID: '9007' })

/**
 * `TenantStore`'s eviction constants (`MAX_TENANTS = 1000`,
 * `IDLE_EVICTION_MS` = 1 hour) are deliberately not exported - they are a
 * safety bound, not something a caller should be able to tune - so these
 * tests exercise the store's *behaviour* (it stops growing, an evicted
 * tenant rebuilds) rather than importing the constant.
 */
const MAX_TENANTS = 1000

describe('TenantStore', () => {
  it('builds one context per distinct token and reuses it on repeat calls', () => {
    const store = new TenantStore(config)
    const a1 = store.contextFor('pk_a', '9007')
    const a2 = store.contextFor('pk_a', '9007')
    const b1 = store.contextFor('pk_b', '9007')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b1)
    expect(store.size).toBe(2)
  })

  it('stops growing past MAX_TENANTS - the map does not accumulate one entry per bogus token forever', () => {
    const store = new TenantStore(config)
    for (let i = 0; i < MAX_TENANTS + 500; i++) {
      store.contextFor(`pk_bogus_${i}`, '9007')
    }
    expect(store.size).toBeLessThanOrEqual(MAX_TENANTS)
  })

  it('rebuilds a fresh context for a tenant evicted by the LRU cap, rather than staying evicted', () => {
    const store = new TenantStore(config)
    const first = store.contextFor('pk_first', '9007')

    // Fill past the cap with other tenants - none of these touch 'pk_first'
    // again, so it is the least-recently-used entry and gets evicted.
    for (let i = 0; i < MAX_TENANTS; i++) {
      store.contextFor(`pk_filler_${i}`, '9007')
    }

    const rebuilt = store.contextFor('pk_first', '9007')
    // A brand new ClickUpContext (new cache, new limiter) - not the same
    // object 'first' was - proving the tenant was evicted and rebuilt
    // rather than permanently locked out or silently still cached.
    expect(rebuilt).not.toBe(first)
  })

  it('keeps a tenant that is used regularly, evicting the genuinely least-recently-used one instead', () => {
    const store = new TenantStore(config)
    const kept = store.contextFor('pk_kept', '9007')

    // Fill to the cap, touching 'pk_kept' again partway through so it is no
    // longer the least-recently-used entry once the cap is reached.
    for (let i = 0; i < MAX_TENANTS; i++) {
      if (i === Math.floor(MAX_TENANTS / 2)) {
        store.contextFor('pk_kept', '9007')
      }
      store.contextFor(`pk_filler_${i}`, '9007')
    }

    expect(store.contextFor('pk_kept', '9007')).toBe(kept)
  })

  it('evicts a tenant idle for over an hour, rebuilding its context on next use', () => {
    let now = 1_700_000_000_000
    const store = new TenantStore(config, { now: () => now })

    const first = store.contextFor('pk_idle', '9007')
    now += 60 * 60 * 1000 + 1 // just past the 1 hour idle window
    const rebuilt = store.contextFor('pk_idle', '9007')

    expect(rebuilt).not.toBe(first)
  })

  it('does not evict a tenant used within the idle window', () => {
    let now = 1_700_000_000_000
    const store = new TenantStore(config, { now: () => now })

    const first = store.contextFor('pk_active', '9007')
    now += 30 * 60 * 1000 // 30 minutes - well within the 1 hour window
    const stillSame = store.contextFor('pk_active', '9007')

    expect(stillSame).toBe(first)
  })
})
