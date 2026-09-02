#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, type ServerConfig } from '../core/config.js'
import { createContext, type ClickUpContext } from '../core/context.js'
import { toAgentMessage } from '../core/errors.js'
import { getAuthorizedUser } from '../clickup/endpoints/workspace.js'
import { logStderr } from '../core/logger.js'
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

/**
 * Spec section 10's startup validation: a `GET /v2/user` probe that fails
 * fast on a bad token, rather than starting cleanly and surfacing an opaque
 * 401 on whichever tool the agent happens to call first. `assertApiKeyPresent`
 * above only proves a token was SET; this proves ClickUp accepts it, and
 * names the variable to fix when it does not.
 *
 * Deliberately stdio only. The HTTP transport resolves a different token per
 * request, so the equivalent check there would be a probe on every single
 * call - a round trip added to every tool invocation to re-learn something
 * the first upstream call reports anyway. That difference is documented in
 * the README.
 */
export async function assertTokenAccepted(ctx: ClickUpContext): Promise<void> {
  try {
    await getAuthorizedUser(ctx)
  } catch (err) {
    throw new Error(
      `ClickUp rejected the configured token on startup (GET /v2/user): ${toAgentMessage(err)} ` +
        'Check CLICKUP_API_KEY, and CLICKUP_TEAM_ID if the token is valid but cannot see that workspace.',
    )
  }
}

/**
 * The stdio transport's startup readiness line, gated by `LOG_LEVEL` (Task
 * 19 follow-up to Task 18): `info` level, so `LOG_LEVEL=warn` or `error`
 * suppresses it while the default `info` and `debug` both keep it. Exported
 * so its gating can be tested directly, the same reason `assertApiKeyPresent`
 * is pulled out of the module-execution guard below rather than inlined.
 */
export function logReadiness(config: ServerConfig): void {
  logStderr(config.logLevel, 'info', `clickup-mcp ready: mode=${config.mode}`)
}

// Only runs when this module is executed directly as the `clickup-mcp`
// entry point - never as a side effect of importing `assertApiKeyPresent`
// from a test, the same guard `src/bin/http.ts` uses for the same reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(process.env)
  assertApiKeyPresent(config)
  const context = createContext(config)
  await assertTokenAccepted(context)
  const server = buildServer({ tools: ALL_TOOLS, config, contextFactory: () => context })
  await server.connect(new StdioServerTransport())
  logReadiness(config)
}
