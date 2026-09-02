export type TtlCacheOptions = {
  ttlSeconds: number
  now?: (() => number) | undefined
}

type CacheEntry = {
  expiresAt: number
  value: unknown
}

/**
 * In-memory cache with per-key TTL expiry, prefix-based invalidation and
 * in-flight load deduplication.
 *
 * Stored values live in `entries`. Concurrent `getOrLoad` calls for the same
 * key that miss the cache share a single in-flight `load()` promise via
 * `inflight`, so the loader runs at most once per key at a time. A rejected
 * load removes its in-flight entry and stores nothing, so a transient
 * failure is never cached and the next call retries.
 */
export class TtlCache {
  private readonly ttlMs: number
  private readonly now: () => number

  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlSeconds * 1000
    this.now = opts.now ?? Date.now
  }

  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.value as T
    }

    const pending = this.inflight.get(key)
    if (pending !== undefined) {
      return pending as Promise<T>
    }

    const promise = load().then(
      (value) => {
        this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value })
        this.inflight.delete(key)
        return value
      },
      (error: unknown) => {
        this.inflight.delete(key)
        throw error
      },
    )

    this.inflight.set(key, promise)
    return promise
  }

  invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key)
      }
    }
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) {
        this.inflight.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }
}
