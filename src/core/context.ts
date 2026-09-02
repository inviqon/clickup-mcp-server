import { createHash } from 'node:crypto'
import { ClickUpClient } from '../clickup/client.js'
import { TtlCache } from './cache.js'
import type { ServerConfig } from './config.js'
import { RateLimiter } from './rate-limiter.js'

/**
 * Everything a tool handler needs to talk to ClickUp on behalf of one
 * request. No module-level mutable state backs this type: every field is
 * built fresh by `createContext`, which is what lets the same handler code
 * serve a single local stdio user (Task 9) and a multi-tenant remote
 * connector that keys one context per credential (Task 17).
 */
export type ClickUpContext = {
  client: ClickUpClient
  cache: TtlCache
  teamId: string
  mode: 'read' | 'write' | 'admin'
  timezone: string
  maxResponseChars: number
}

/**
 * Builds one `RateLimiter`, one `TtlCache` and one `ClickUpClient` from a
 * `ServerConfig`. Called once for a stdio server and once per tenant for
 * the HTTP transport - it never reads or writes shared state, so repeated
 * calls are fully independent of each other.
 */
export function createContext(config: ServerConfig): ClickUpContext {
  const limiter = new RateLimiter({ limitPerMinute: config.rateLimit })
  const cache = new TtlCache({ ttlSeconds: config.cacheTtlSeconds })
  const client = new ClickUpClient({ token: config.apiKey, limiter })

  return {
    client,
    cache,
    teamId: config.teamId,
    mode: config.mode,
    timezone: config.timezone,
    maxResponseChars: config.maxResponseChars,
  }
}

/**
 * Derives a stable identifier for one (token, team) pair without ever
 * exposing the token itself. The HTTP transport uses this as a map key to
 * give each tenant its own cache and rate limiter, so the raw token must
 * never appear in the key, in logs, or anywhere else it could leak.
 */
export function credentialKey(token: string, teamId: string): string {
  const digest = createHash('sha256').update(token).digest('hex')
  return `${digest.slice(0, 16)}:${teamId}`
}
