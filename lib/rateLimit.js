import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

/* Sliding-window rate limiter backed by Upstash Redis — shared across every
   serverless instance, unlike an in-memory Map (each Vercel invocation can
   land on a different instance with its own memory, which made an
   in-memory version provide close to no real protection in production).

   One Ratelimit instance per distinct (max, windowMs) pair, created lazily
   and cached — @upstash/ratelimit wants its window pre-configured per
   instance rather than passed per call. */
const redis = Redis.fromEnv();
const limiters = new Map();

function getLimiter(max, windowMs) {
  const cacheKey = `${max}:${windowMs}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${Math.round(windowMs / 1000)} s`),
      analytics: false,
      prefix: "lb_rl",
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

export async function rateLimit(key, { max, windowMs }) {
  const { success, reset } = await getLimiter(max, windowMs).limit(key);
  if (!success) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
  }
  return { ok: true };
}

export function clientKey(req) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/* Anonymous free-use counter, keyed by IP instead of a cookie so it isn't
   reset by incognito or clearing cookies. A persistent count, not a
   time-windowed rate limit — so it's a plain Redis counter (with a long TTL
   just to bound key growth), not a Ratelimit instance. */
const ANON_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

export async function anonUsageCount(ip) {
  const n = await redis.get(`lb_anon_free:${ip}`);
  return Number(n) || 0;
}

export async function incrAnonUsage(ip) {
  const key = `lb_anon_free:${ip}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, ANON_TTL_SECONDS);
  return n;
}
