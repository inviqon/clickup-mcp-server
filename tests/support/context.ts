import { ClickUpClient } from '../../src/clickup/client.js'
import { TtlCache } from '../../src/core/cache.js'
import { RateLimiter } from '../../src/core/rate-limiter.js'
import type { ClickUpContext } from '../../src/core/context.js'

/**
 * Builds a `ClickUpContext` for tests: a real `TtlCache` (so caching
 * behaviour is exercised, not mocked away), a `RateLimiter` with a limit high
 * enough and a no-op `sleep` so tests never actually wait, and a
 * `ClickUpClient` that talks to the msw-mocked `fetch`. `over` lets an
 * individual test replace one field (e.g. a fresh `cache` to prove no state
 * leaked from a previous call) without repeating the rest.
 */
export function testContext(over: Partial<ClickUpContext> = {}): ClickUpContext {
  const limiter = new RateLimiter({ limitPerMinute: 10_000, sleep: async () => {} })
  return {
    client: new ClickUpClient({ token: 'pk_test', limiter }),
    cache: new TtlCache({ ttlSeconds: 300 }),
    teamId: '9007',
    mode: 'admin',
    timezone: 'Europe/Berlin',
    maxResponseChars: 40_000,
    ...over,
  }
}
