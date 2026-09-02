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
})
