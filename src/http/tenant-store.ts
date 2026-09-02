import { createContext, credentialKey, type ClickUpContext } from '../core/context.js'
import type { ServerConfig } from '../core/config.js'

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
 * is deliberately no use of `TtlCache.clear()` anywhere in this class - a
 * second tenant is never handed the first tenant's cache to begin with, so
 * there is nothing to clear.
 */
export class TenantStore {
  private readonly config: ServerConfig
  private readonly contexts = new Map<string, ClickUpContext>()

  constructor(config: ServerConfig) {
    this.config = config
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
    const key = credentialKey(token, teamId)
    const existing = this.contexts.get(key)
    if (existing !== undefined) {
      return existing
    }
    const ctx = createContext({ ...this.config, apiKey: token, teamId })
    this.contexts.set(key, ctx)
    return ctx
  }
}
