import { describe, expect, it, vi } from 'vitest'
import { TtlCache } from '../../src/core/cache.js'

describe('TtlCache', () => {
  it('loads once and serves the cached value', async () => {
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    expect(await cache.getOrLoad('k', load)).toBe('v')
    expect(await cache.getOrLoad('k', load)).toBe('v')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads after the ttl expires', async () => {
    let clock = 0
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60, now: () => clock })
    await cache.getOrLoad('k', load)
    clock = 61_000
    await cache.getOrLoad('k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('invalidates by prefix', async () => {
    const load = vi.fn().mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    await cache.getOrLoad('tree:9007', load)
    await cache.getOrLoad('list:1', load)
    cache.invalidate('tree:')
    await cache.getOrLoad('tree:9007', load)
    await cache.getOrLoad('list:1', load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not cache a rejected load', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('v')
    const cache = new TtlCache({ ttlSeconds: 60 })
    await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom')
    expect(await cache.getOrLoad('k', load)).toBe('v')
  })

  it('deduplicates concurrent loads of the same key', async () => {
    const load = vi.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r('v'), 10)))
    const cache = new TtlCache({ ttlSeconds: 60 })
    const [a, b] = await Promise.all([
      cache.getOrLoad('k', load), cache.getOrLoad('k', load),
    ])
    expect([a, b]).toEqual(['v', 'v'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  // Added beyond the brief's five tests: none of the above exercises
  // invalidate() while a load for the invalidated key is still in flight,
  // so it never proves the in-flight map is actually cleared by prefix (as
  // opposed to only the resolved-entries map). Without that clear, a caller
  // arriving after invalidate() but before the stale load settles would be
  // handed the pre-invalidation promise instead of triggering a fresh load.
  it('invalidate clears in-flight loads so a caller arriving after it gets a fresh load', async () => {
    let resolveFirst: (value: string) => void = () => {}
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const load = vi.fn().mockImplementationOnce(() => first).mockResolvedValue('v2')
    const cache = new TtlCache({ ttlSeconds: 60 })

    const p1 = cache.getOrLoad('tree:9007', load)
    cache.invalidate('tree:')
    const p2 = cache.getOrLoad('tree:9007', load)
    resolveFirst('v1')

    await expect(p1).resolves.toBe('v1')
    await expect(p2).resolves.toBe('v2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  // Added per reviewer finding on this task: an orphaned in-flight load
  // (started before invalidate(), still running after it) must not
  // overwrite a fresher entry once it finally settles. Load A starts,
  // invalidate() fires while A is still pending, load B starts for the
  // same key and settles first (the fresh value), then A settles late
  // (the stale value). The cache's final state - not either promise's own
  // resolved value - must reflect B, and a later getOrLoad must not
  // re-invoke the loader.
  it('does not let an orphaned in-flight load overwrite a fresher entry after invalidate', async () => {
    let resolveStale: (value: string) => void = () => {}
    const staleLoad = new Promise<string>((resolve) => {
      resolveStale = resolve
    })
    let resolveFresh: (value: string) => void = () => {}
    const freshLoad = new Promise<string>((resolve) => {
      resolveFresh = resolve
    })

    const load = vi.fn()
      .mockImplementationOnce(() => staleLoad)
      .mockImplementationOnce(() => freshLoad)
    const cache = new TtlCache({ ttlSeconds: 60 })

    const pStale = cache.getOrLoad('tree:9007', load)
    cache.invalidate('tree:')
    const pFresh = cache.getOrLoad('tree:9007', load)

    resolveFresh('fresh')
    await pFresh
    resolveStale('stale')
    await pStale

    expect(await cache.getOrLoad('tree:9007', load)).toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
