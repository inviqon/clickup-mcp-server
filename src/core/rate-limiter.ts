export type RateLimiterOptions = {
  limitPerMinute: number
  now?: (() => number) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

const MS_PER_MINUTE = 60_000

/** See `acquireExclusive`. Guards against float drift, nothing else. */
const TOKEN_EPSILON = 1e-9

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Token bucket rate limiter with continuous refill.
 *
 * Tokens refill at `limitPerMinute / 60000` per millisecond, up to a
 * capacity of `limitPerMinute`. `acquire()` blocks (via the injected
 * `sleep`) until at least one token is available, then consumes it -
 * serialized, so concurrent callers cannot all consume the same refilled
 * token (see `acquire`).
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
  /**
   * The tail of the acquisition chain. Every `acquire` appends to it, so at
   * most one caller is inspecting or decrementing the bucket at a time.
   */
  private queue: Promise<void> = Promise.resolve()

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

  /**
   * Waits until a token is genuinely available, then consumes it.
   *
   * Acquisition is serialized through `queue`: every caller waits for the
   * one before it to have taken its token before it even looks at the
   * bucket. That serialization is the fix for a real burst, not a tidiness
   * preference. The previous shape re-checked nothing after sleeping - N
   * concurrent callers finding an empty bucket all slept the same interval,
   * woke together, and each fell through to decrement. The first took the
   * one refilled token; the other N-1 proceeded on credit that did not
   * exist, so the client overshot the configured rate by exactly the
   * concurrency of the call site. The tools generate precisely that
   * concurrency: `clickup_update_tasks_bulk` fires up to 50 concurrent
   * updates, create and update fire one concurrent write per custom field,
   * and `clickup_get_my_day` fires four reads at once.
   *
   * A rejected acquire must not stall the queue behind it, hence the
   * swallowed settlement on the chain (the rejection itself is still
   * returned to that caller).
   */
  async acquire(): Promise<void> {
    const run = this.queue.then(() => this.acquireExclusive())
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Runs with exclusive access to the bucket, guaranteed by `acquire`'s
   * queue. Loops rather than sleeping once: a computed wait can end with
   * the bucket still short (a `notifyReset` landing mid-sleep, or a clock
   * that advanced less than asked), and proceeding anyway is the burst this
   * class exists to prevent.
   */
  private async acquireExclusive(): Promise<void> {
    if (this.resetFloor !== undefined) {
      const waitForReset = this.resetFloor - this.now()
      if (waitForReset > 0) {
        await this.sleep(waitForReset)
      }
      this.resetFloor = undefined
    }

    for (;;) {
      this.refill()
      // `TOKEN_EPSILON`, not a bare `>= 1`: `tokens` is accumulated by
      // floating-point multiplication, so a wait computed to produce
      // exactly one token can land a few ulps short and spin one extra
      // (near-zero) sleep for no reason.
      if (this.tokens >= 1 - TOKEN_EPSILON) {
        this.tokens = Math.max(0, this.tokens - 1)
        return
      }
      const missing = 1 - this.tokens
      await this.sleep(missing / this.refillPerMs)
    }
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
