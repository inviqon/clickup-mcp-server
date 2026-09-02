#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, type ServerConfig } from '../core/config.js'
import { createContext } from '../core/context.js'
import { ALL_TOOLS } from '../tools/index.js'
import { buildServer } from '../server.js'

/**
 * The stdio transport is single-tenant and always needs a real ClickUp
 * token up front - unlike the HTTP transport (Task 17), which legitimately
 * runs with an empty `CLICKUP_API_KEY` and resolves credentials per request
 * from an `Authorization` header instead. `loadConfig` (Task 1) is
 * deliberately transport-agnostic and accepts an empty key so HTTP mode can
 * load at all; this is the stdio-specific check that turns an empty key
 * here into an immediate, actionable failure - naming `CLICKUP_API_KEY` -
 * instead of a silent start followed by an opaque upstream 401 on the first
 * tool call. A realistic way to hit this: an unset shell variable
 * interpolated into a `.env` line, or a docker-compose default that
 * resolves to `""`.
 */
export function assertApiKeyPresent(config: Pick<ServerConfig, 'apiKey'>): void {
  if (config.apiKey.length === 0) {
    throw new Error(
      'CLICKUP_API_KEY is required to start the stdio transport (it is empty). Set it in the environment, or ' +
        'use clickup-mcp-http instead, which resolves credentials per request from an Authorization header.',
    )
  }
}

// Only runs when this module is executed directly as the `clickup-mcp`
// entry point - never as a side effect of importing `assertApiKeyPresent`
// from a test, the same guard `src/bin/http.ts` uses for the same reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(process.env)
  assertApiKeyPresent(config)
  const context = createContext(config)
  const server = buildServer({ tools: ALL_TOOLS, config, contextFactory: () => context })
  await server.connect(new StdioServerTransport())
  console.error(`clickup-mcp ready: mode=${config.mode}`)
}
