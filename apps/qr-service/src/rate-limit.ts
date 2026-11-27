interface RateBucket {
  count: number;
  windowStartMs: number;
}

/**
 * In-memory per-organization sliding-window rate limiter for QR operations & outbound dispatch.
 */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs: number; maxRequests: number }) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  checkAndConsume(key: string, nowMs = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const existing = this.buckets.get(key);
    if (!existing || nowMs - existing.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartMs: nowMs });
      return { allowed: true, retryAfterSec: 0 };
    }

    if (existing.count >= this.maxRequests) {
      const retryAfterMs = Math.max(1000, this.windowMs - (nowMs - existing.windowStartMs));
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
}
