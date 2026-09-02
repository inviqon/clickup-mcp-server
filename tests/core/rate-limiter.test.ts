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
})
