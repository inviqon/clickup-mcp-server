import { createContext, credentialKey, type ClickUpContext } from '../core/context.js'
import type { ServerConfig } from '../core/config.js'

/**
 * Safety bounds, not tuning knobs - deliberately constants here, not
 * environment variables. `resolveToken` (src/bin/http.ts) accepts any
 * non-empty `Authorization` header value before ClickUp ever validates it,
 * and a missing `Origin` is allowed by design (local MCP clients send
 * none) - so on a host that binds beyond loopback (`CLICKUP_HTTP_HOST`
 * exists precisely to allow that), a caller who can merely reach the port
 * can force one `ClickUpContext` to be built and cached per bogus token,
 * with no valid credentials and no successful upstream call ever required.
 * Without a bound, that is unauthenticated, unbounded heap growth from a
 * single client issuing one request per fabricated token. `MAX_TENANTS`
 * caps how many contexts this store holds at once (oldest-used evicted
 * first once full); `IDLE_EVICTION_MS` additionally reclaims a context that
 * has not been used in an hour, so a store well under the count cap still
 * does not hold contexts for tenants that came and went once, hours ago.
 */
const MAX_TENANTS = 1000
const IDLE_EVICTION_MS = 60 * 60 * 1000

type TenantEntry = {
  ctx: ClickUpContext
  lastUsedAt: number
}

/**
 * One `ClickUpContext` per (token, teamId) pair, so the HTTP transport's
 * many tenants never share a `TtlCache` or a `RateLimiter`. Keyed by
 * `credentialKey` (src/core/context.ts), which hashes the token - the raw
 * token is never a map key, never logged, and never appears anywhere this
 * store could leak it.
 *
 * Isolation here comes from never sharing a context across tenants in the
 * first place: `createContext` builds a brand new `TtlCache` and
 * `RateLimiter` on every call (Task 8), and `contextFor` calls it exactly
 * once per distinct `credentialKey`, caching the result in `contexts`. There
 * is deliberately no bulk-clear of a `TtlCache` anywhere in this class - a
 * second tenant is never handed the first tenant's cache to begin with, so
 * there is nothing to clear.
 *
 * Bounded per the two constants above: least-recently-used eviction once
 * `MAX_TENANTS` is reached, and idle eviction of any entry unused for over
 * `IDLE_EVICTION_MS`. An evicted tenant is not "logged out" of anything -
 * its next request simply rebuilds a fresh context (and so a fresh, empty
 * cache) the same way a first-ever request from that tenant would.
 */
export class TenantStore {
  private readonly config: ServerConfig
  private readonly now: () => number
  // A `Map`'s iteration order is insertion order, and `contextFor` below
  // deletes-then-reinserts an entry on every hit - that is what keeps this
  // map's key order equal to "least recently used first", so eviction can
  // just take `.keys().next()` rather than tracking recency separately.
  private readonly contexts = new Map<string, TenantEntry>()

  constructor(config: ServerConfig, opts: { now?: () => number } = {}) {
    this.config = config
    this.now = opts.now ?? Date.now
  }

  /**
   * Returns this tenant's `ClickUpContext`, building it on first use and
   * reusing it (cache and rate limiter included) on every subsequent call
   * with the same `token`/`teamId` pair. `teamId` overrides the configured
   * default so a request's `X-ClickUp-Team-Id` header (resolved by the
   * caller before this is invoked) genuinely changes which workspace this
   * context talks to, not just which cache key it is filed under.
   */
  contextFor(token: string, teamId: string): ClickUpContext {
    this.evictIdle()

    const key = credentialKey(token, teamId)
    const existing = this.contexts.get(key)
    if (existing !== undefined) {
      existing.lastUsedAt = this.now()
      // Move to the end of iteration order (most-recently-used) by
      // deleting and reinserting - `Map` keeps insertion order, `set` on an
      // existing key does not change it.
      this.contexts.delete(key)
      this.contexts.set(key, existing)
      return existing.ctx
    }

    if (this.contexts.size >= MAX_TENANTS) {
      this.evictLeastRecentlyUsed()
    }

    const ctx = createContext({ ...this.config, apiKey: token, teamId })
    this.contexts.set(key, { ctx, lastUsedAt: this.now() })
    return ctx
  }

  /** The number of tenant contexts currently held, for tests only. */
  get size(): number {
    return this.contexts.size
  }

  private evictIdle(): void {
    const cutoff = this.now() - IDLE_EVICTION_MS
    for (const [key, entry] of this.contexts) {
      if (entry.lastUsedAt < cutoff) {
        this.contexts.delete(key)
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    const oldestKey = this.contexts.keys().next().value
    if (oldestKey !== undefined) {
      this.contexts.delete(oldestKey)
    }
  }
}
