export class TokenBucket {
  private tokens: number
  private lastRefillAt: number

  public constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number,
  ) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new Error('Token bucket limits must be positive')
    }

    this.tokens = capacity
    this.lastRefillAt = now
  }

  public consume(now: number, amount = 1): boolean {
    if (amount <= 0 || amount > this.capacity) {
      return false
    }

    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1_000
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond)
    this.lastRefillAt = Math.max(this.lastRefillAt, now)

    if (this.tokens < amount) {
      return false
    }

    this.tokens -= amount
    return true
  }
}
