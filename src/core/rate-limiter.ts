export type RateLimiterOptions = {
  limitPerMinute: number
  now?: (() => number) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

const MS_PER_MINUTE = 60_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Token bucket rate limiter with continuous refill.
 *
 * Tokens refill at `limitPerMinute / 60000` per millisecond, up to a
 * capacity of `limitPerMinute`. `acquire()` blocks (via the injected
 * `sleep`) until at least one token is available, then consumes it.
 * `notifyReset()` drains the bucket and imposes a floor time (from a
 * ClickUp 429 response's X-RateLimit-Reset) before which `acquire()`
 * must wait, regardless of how many tokens would otherwise be available.
 */
export class RateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  private tokens: number
  private lastRefillAt: number
  private resetFloor: number | undefined

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.limitPerMinute
    this.refillPerMs = opts.limitPerMinute / MS_PER_MINUTE
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep

    this.tokens = this.capacity
    this.lastRefillAt = this.now()
    this.resetFloor = undefined
  }

  private refill(): void {
    const current = this.now()
    const elapsed = current - this.lastRefillAt
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
      this.lastRefillAt = current
    }
  }

  async acquire(): Promise<void> {
    this.refill()

    if (this.resetFloor !== undefined) {
      const waitForReset = this.resetFloor - this.now()
      if (waitForReset > 0) {
        await this.sleep(waitForReset)
        this.refill()
      }
      this.resetFloor = undefined
    }

    if (this.tokens < 1) {
      const missing = 1 - this.tokens
      const waitMs = missing / this.refillPerMs
      await this.sleep(waitMs)
      this.refill()
    }

    this.tokens = Math.max(0, this.tokens - 1)
  }

  notifyReset(resetAt: Date): void {
    this.tokens = 0
    this.lastRefillAt = this.now()
    this.resetFloor = resetAt.getTime()
  }

  get availableTokens(): number {
    this.refill()
    return this.tokens
  }
}
