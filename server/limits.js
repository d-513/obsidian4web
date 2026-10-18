// In-memory per-client rate limiting (requests/minute, bytes/hour, concurrency).
// Single-process: when running several instances, put a shared limiter in front.

const MAX_CLIENTS = 50000;

export class RateLimiter {
  constructor(limits) {
    this.limits = limits;
    this.clients = new Map();
    this.sweep = setInterval(() => this.cleanup(), 60e3);
    this.sweep.unref?.();
  }

  client(key) {
    let c = this.clients.get(key);
    const now = Date.now();
    if (!c) {
      if (this.clients.size >= MAX_CLIENTS) {
        this.cleanup();
        if (this.clients.size >= MAX_CLIENTS) {
          for (const [k, v] of this.clients) {
            if (v.active === 0 && v.ws === 0) {
              this.clients.delete(k);
              break;
            }
          }
        }
      }
      c = { tokens: this.limits.requestsPerMinute, refilled: now, bytes: 0, windowStart: now, active: 0, ws: 0, seen: now };
      this.clients.set(key, c);
    }
    c.seen = now;
    // Token bucket for requests.
    const elapsed = now - c.refilled;
    c.tokens = Math.min(this.limits.requestsPerMinute, c.tokens + (elapsed / 60e3) * this.limits.requestsPerMinute);
    c.refilled = now;
    if (now - c.windowStart > 3600e3) {
      c.windowStart = now;
      c.bytes = 0;
    }
    return c;
  }

  /** Returns null when allowed, or a reason string. */
  begin(key) {
    const c = this.client(key);
    if (c.tokens < 1) return "Too many requests";
    if (c.active >= this.limits.concurrent) return "Too many concurrent requests";
    if (c.bytes >= this.limits.bytesPerHour) return "Transfer quota exceeded";
    c.tokens -= 1;
    c.active += 1;
    return null;
  }

  end(key) {
    const c = this.clients.get(key);
    if (c && c.active > 0) c.active -= 1;
  }

  addBytes(key, n) {
    const c = this.clients.get(key);
    if (!c) return true;
    c.bytes += n;
    return c.bytes <= this.limits.bytesPerHour;
  }

  beginWs(key) {
    const c = this.client(key);
    if (c.tokens < 1) return "Too many requests";
    if (c.ws >= this.limits.wsPerClient) return "Too many open WebSockets";
    c.tokens -= 1;
    c.ws += 1;
    return null;
  }

  endWs(key) {
    const c = this.clients.get(key);
    if (c && c.ws > 0) c.ws -= 1;
  }

  cleanup() {
    const cutoff = Date.now() - 2 * 3600e3;
    for (const [k, c] of this.clients) if (c.seen < cutoff && c.active === 0 && c.ws === 0) this.clients.delete(k);
  }
}
