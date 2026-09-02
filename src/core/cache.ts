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
 *
 * `invalidate` can remove a key from `inflight` while its load is still
 * running (Task 13 calls `invalidate('tree:')` after every structural
 * write, which can race an already-started read of the same prefix). Such
 * an orphaned load must not resurrect a stale value once it finally
 * settles, and must not clobber a newer load that a later caller started
 * for the same key. Each settlement handler therefore checks, by identity,
 * that `inflight.get(key)` still points at the promise it was registered
 * with before writing to `entries` or deleting from `inflight` - if the key
 * was invalidated or reclaimed by a newer load in the meantime, the settled
 * promise is a no-op.
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

    const promise: Promise<T> = load().then(
      (value) => {
        if (this.inflight.get(key) === promise) {
          this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value })
          this.inflight.delete(key)
        }
        return value
      },
      (error: unknown) => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key)
        }
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
}
