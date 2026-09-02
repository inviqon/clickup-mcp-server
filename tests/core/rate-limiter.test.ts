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


/**
 * A virtual-time scheduler, unlike `harness` above: `sleep` registers a
 * wake-up at `clock + ms` instead of advancing the clock itself. With N
 * concurrent sleepers, advancing per-sleeper (which `harness` does) would
 * count the same wall-clock interval N times and make a burst look like
 * elapsed time. Here the clock only ever moves forward to the earliest
 * pending wake-up, which is what real concurrent waiters experience.
 */
function concurrentHarness(limitPerMinute: number) {
  let clock = 0
  const pending: Array<{ at: number; resolve: () => void }> = []
  const limiter = new RateLimiter({
    limitPerMinute,
    now: () => clock,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        pending.push({ at: clock + ms, resolve })
      }),
  })

  /**
   * Drives the virtual clock until `work` settles. Each turn drains the
   * microtask queue first, so anything that can proceed without sleeping
   * does, then jumps the clock to the earliest pending wake-up.
   */
  async function runToCompletion<T>(work: Promise<T>): Promise<T> {
    let settled = false
    const tracked = work.then(
      (value) => {
        settled = true
        return value
      },
      (err: unknown) => {
        settled = true
        throw err
      },
    )
    for (let turn = 0; turn < 10_000 && !settled; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
      if (settled) break
      const next = pending.sort((a, b) => a.at - b.at).shift()
      if (next === undefined) continue
      clock = Math.max(clock, next.at)
      next.resolve()
    }
    return tracked
  }

  return { limiter, runToCompletion, elapsed: () => clock }
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

  // Regression test for the concurrency burst: N callers finding an empty
  // bucket used to sleep the same interval, wake together, and each fall
  // through to decrement - an `if`, not a loop, with no re-check. Only the
  // first was paid for by a refilled token; the rest bursted straight past
  // the configured limit. `clickup_update_tasks_bulk` fires up to 50
  // concurrent updates through this limiter, so this is the real call
  // shape, not a synthetic one.
  it('keeps concurrent acquires inside the configured rate', async () => {
    const { limiter, runToCompletion, elapsed } = concurrentHarness(2)
    // Capacity is 2, so the bucket starts with 2 free tokens and the other
    // 8 acquires must each wait a full refill interval (60000 / 2 = 30000ms).
    await runToCompletion(Promise.all(Array.from({ length: 10 }, () => limiter.acquire())))
    expect(elapsed()).toBe(8 * 30_000)
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
