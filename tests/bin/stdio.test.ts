import { describe, expect, it } from 'vitest'
import { assertApiKeyPresent } from '../../src/bin/stdio.js'

describe('assertApiKeyPresent', () => {
  it('throws naming CLICKUP_API_KEY when the key is empty but present', () => {
    expect(() => assertApiKeyPresent({ apiKey: '' })).toThrow(/CLICKUP_API_KEY/)
  })

  it('does not throw when a real key is set', () => {
    expect(() => assertApiKeyPresent({ apiKey: 'pk_123' })).not.toThrow()
  })
})
