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

/** Shared daily cap — one Redis counter per UTC day, for spend that has to
 *  be bounded across ALL visitors, not just per IP (someone rotating IPs
 *  gets past per-IP limits). Fails open on a Redis error; the per-IP
 *  limits still apply. */
export async function dailyBudgetOk(name, cap) {
  const key = `lb_budget:${name}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const [n] = await redis.pipeline().incr(key).expire(key, 2 * 24 * 60 * 60).exec();
    return n <= cap;
  } catch (e) {
    console.error(`daily budget ${name}:`, e);
    return true;
  }
}
