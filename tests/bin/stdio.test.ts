import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertApiKeyPresent, assertTokenAccepted, logReadiness } from '../../src/bin/stdio.js'
import { loadConfig } from '../../src/core/config.js'
import { mswServer, useMsw } from '../support/msw.js'
import { testContext } from '../support/context.js'

const API = 'https://api.clickup.com/api'

useMsw()

describe('assertApiKeyPresent', () => {
  it('throws naming CLICKUP_API_KEY when the key is empty but present', () => {
    expect(() => assertApiKeyPresent({ apiKey: '' })).toThrow(/CLICKUP_API_KEY/)
  })

  it('does not throw when a real key is set', () => {
    expect(() => assertApiKeyPresent({ apiKey: 'pk_123' })).not.toThrow()
  })
})

describe('logReadiness', () => {
  const base = { CLICKUP_API_KEY: 'pk_123', CLICKUP_TEAM_ID: '9007' }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses the readiness line when LOG_LEVEL=warn', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig({ ...base, LOG_LEVEL: 'warn' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the readiness line when LOG_LEVEL=debug', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig({ ...base, LOG_LEVEL: 'debug' }))
    expect(spy).toHaveBeenCalledWith('clickup-mcp ready: mode=write')
  })

  it('keeps the readiness line at the default LOG_LEVEL (info)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadiness(loadConfig(base))
    expect(spy).toHaveBeenCalledWith('clickup-mcp ready: mode=write')
  })
})

// Spec section 10 promised a GET /v2/user probe that fails fast on a bad
// token. getAuthorizedUser existed but only tools called it, so the stdio
// transport started cleanly on a dead token and surfaced an opaque 401 on
// whichever tool the agent happened to call first.
describe('assertTokenAccepted', () => {
  it('fails fast naming CLICKUP_API_KEY when ClickUp rejects the token', async () => {
    mswServer.use(
      http.get(`${API}/v2/user`, () => HttpResponse.json({ err: 'Token invalid', ECODE: 'OAUTH_025' }, { status: 401 })),
    )
    await expect(assertTokenAccepted(testContext())).rejects.toThrow(/GET \/v2\/user.*CLICKUP_API_KEY/s)
  })

  it('passes on a token ClickUp accepts', async () => {
    mswServer.use(
      http.get(`${API}/v2/user`, () => HttpResponse.json({ user: { id: 1, username: 'Alice' } })),
    )
    await expect(assertTokenAccepted(testContext())).resolves.toBeUndefined()
  })
})
