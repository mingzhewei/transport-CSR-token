/**
 * Simple in-memory token-bucket rate limiter.
 * Buckets are keyed by client identifier (usually IP or token).
 */

export function createRateLimiter(options = {}) {
  const capacity = options.capacity ?? 60;
  const windowMs = options.windowMs ?? 60_000;

  if (capacity <= 0) {
    // Rate limiting disabled.
    return {
      allow() {
        return { allowed: true, remaining: capacity, resetMs: 0 };
      }
    };
  }

  const buckets = new Map();

  function refill(bucket) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefillAt;
    if (elapsed <= 0) {
      return;
    }
    const tokensToAdd = (elapsed / windowMs) * capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;
  }

  function allow(key) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillAt: Date.now() };
      buckets.set(key, bucket);
    }

    refill(bucket);

    if (bucket.tokens < 1) {
      const resetMs = Math.ceil(windowMs - (Date.now() - bucket.lastRefillAt));
      return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), resetMs: 0 };
  }

  function cleanup(maxIdleMs = windowMs * 2) {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.lastRefillAt > maxIdleMs) {
        buckets.delete(key);
      }
    }
  }

  // Periodically clean up idle buckets to avoid unbounded memory growth.
  const cleanupInterval = setInterval(() => cleanup(), windowMs).unref?.();

  return {
    allow,
    cleanup,
    stop() {
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
      }
      buckets.clear();
    }
  };
}

export function rateLimitResponse(res, retryAfterMs) {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(retryAfterSeconds)
  });
  res.end(
    JSON.stringify({
      error: {
        message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
        type: "rate_limit_exceeded"
      }
    })
  );
}
