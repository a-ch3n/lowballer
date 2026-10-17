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

/* Free-use counter, keyed by IP instead of a cookie so it isn't reset by
   incognito or clearing cookies. A lifetime count, not a time-windowed rate
   limit — so it's a plain Redis counter with NO expiry, not a Ratelimit
   instance. Signed-in non-Pro users bump it too (see app/api/appraise), so
   the free tier is 3 runs total rather than 3 anonymous + 3 per account. */
const anonKey = (ip) => `lb_anon_free:${ip}`;

export async function anonUsageCount(ip) {
  const n = await redis.get(anonKey(ip));
  return Number(n) || 0;
}

/** Atomically claim one free use for this IP and return the new total. The
 *  caller must check it against FREE_LIMIT and releaseAnonUse() if it went
 *  over, or if the run later fails. INCR-first (rather than read, then
 *  write after the run) is what stops parallel requests from slipping extra
 *  runs past the limit. PERSIST strips the 180-day TTL that earlier
 *  versions put on these keys, so existing counts stop expiring too. */
export async function reserveAnonUse(ip) {
  const key = anonKey(ip);
  const [n] = await redis.pipeline().incr(key).persist(key).exec();
  return n;
}

export async function releaseAnonUse(ip) {
  await redis.decr(anonKey(ip));
}
