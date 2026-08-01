/**
 * A small in-memory fixed-window rate limiter for the email-OTP gate.
 *
 * Keyed by an arbitrary string (an email address or a client IP). Each key gets
 * `max` hits per `windowMs`; the window resets on first use after it elapses.
 * `hit()` returns whether the call is allowed and, when not, how many seconds
 * until the window resets so a caller can surface a cooldown.
 *
 * In-memory is intentional and sufficient for a single-app-instance gate: an
 * app behind a portr tunnel serves from one process. It is NOT a distributed
 * limiter; a multi-replica deployment would need shared state. Entries are
 * pruned lazily on access, so an idle key costs nothing after its window.
 *
 * @module
 */

interface Window {
  count: number;
  resetAt: number;
}

/** A fixed-window rate limiter over string keys. */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record a hit for `key`. Returns `{ allowed }`, plus `retryAfter` (seconds)
   * when the limit is exceeded. A limit of `<= 0` disables limiting (always
   * allowed), which lets a config turn it off without special-casing callers.
   */
  hit(key: string, now: number = Date.now()): { allowed: boolean; retryAfter?: number } {
    if (this.max <= 0) return { allowed: true };
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }
    if (existing.count < this.max) {
      existing.count += 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }

  /** Forget a key (e.g. clear a caller's window after a successful verify). */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Drop every window (tests). */
  clear(): void {
    this.windows.clear();
  }
}
