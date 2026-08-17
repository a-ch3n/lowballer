/* Minimal in-memory sliding-window rate limiter. Per-serverless-instance
   only — fine for a single Node process; swap for Redis/Upstash if that
   starts to matter. */
const buckets = new Map();

export function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  buckets.set(key, recent);
  return { ok: true };
}

export function clientKey(req) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
