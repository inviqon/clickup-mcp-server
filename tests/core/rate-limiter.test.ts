import { describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../../src/core/rate-limiter.js'

function harness(limitPerMinute: number) {
  let clock = 0
  const slept: number[] = []
  const limiter = new RateLimiter({
    limitPerMinute,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  return { limiter, slept, advance: (ms: number) => { clock += ms } }
}

describe('RateLimiter', () => {
  it('passes through while tokens remain', async () => {
    const { limiter, slept } = harness(60)
    for (let i = 0; i < 60; i++) await limiter.acquire()
    expect(slept).toEqual([])
  })

  it('sleeps once the bucket is empty', async () => {
    const { limiter, slept } = harness(60)
    for (let i = 0; i < 61; i++) await limiter.acquire()
    expect(slept.length).toBe(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('refills over time', async () => {
    const { limiter, slept, advance } = harness(60)
    for (let i = 0; i < 60; i++) await limiter.acquire()
    advance(60_000)
    await limiter.acquire()
    expect(slept).toEqual([])
  })

  it('empties the bucket until the reset time reported by a 429', async () => {
    const { limiter, slept } = harness(60)
    limiter.notifyReset(new Date(30_000))
    await limiter.acquire()
    expect(slept[0]).toBe(30_000)
  })

  // Regression test: notifyReset must not let a later refill credit tokens
  // for the interval between the last real refill and the drain. Without
  // resetting the refill clock in notifyReset, this scenario would under-
  // sleep by exactly the 5 tokens accrued during the 5 seconds before the
  // 429 was reported.
  it('does not credit refill for time elapsed before notifyReset was called', async () => {
    const { limiter, advance } = harness(60)
    // Drain 30 of 60 tokens at clock=0, no sleeping needed yet.
    for (let i = 0; i < 30; i++) await limiter.acquire()
    // 5 seconds pass with the limiter idle (no acquire/refill observes it).
    advance(5_000)
    // A 429 arrives; the reset is 10 seconds further out, at clock=15000.
    limiter.notifyReset(new Date(15_000))
    await limiter.acquire()
    // Correct: floor wait credits only the 10s after notifyReset (10
    // tokens), consumed down to 9. Buggy (crediting the pre-drain 5s too)
    // would land at 14.
    expect(limiter.availableTokens).toBe(9)
  })
})
