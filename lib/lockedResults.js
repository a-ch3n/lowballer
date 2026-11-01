import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* Pay-per-result. A non-Pro appraisal runs in full, but the result is kept
   here and the client only gets a teaser (verdict / score / counts) until
   that result is unlocked with a one-time Stripe payment. The paid details
   never reach the browser before payment, so they can't be read from the
   page or network tab.

   Stored in Redis rather than Postgres: results are self-contained JSON,
   read by id, and unpaid ones should simply expire. Paid ones are kept for
   a year so the unlock link keeps working. */

const redis = Redis.fromEnv();
const UNPAID_TTL = 7 * 24 * 60 * 60;
const PAID_TTL = 365 * 24 * 60 * 60;
const MAX_INPUTS_CHARS = 20_000;
const key = (id) => `lb_result:${id}`;

export const UNLOCK_PRICE_CENTS = Number(process.env.UNLOCK_PRICE_CENTS) || 500;

export const isResultId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{20,40}$/.test(id);

/** What a locked result shows before payment — enough to see the run was
 *  real and worth $5, none of the numbers that make it worth $5. */
export function buildTeaser(mode, r) {
  const len = (a) => (Array.isArray(a) ? a.length : 0);
  if (mode === "car") {
    return {
      verdict: r.verdict,
      deal_score: r.deal_score,
      flags: len(r.red_flags),
      highFlags: (r.red_flags || []).filter((f) => f.severity === "high").length,
      comps: len(r.market_value?.comps),
      repairs: len(r.repair_estimate?.items),
      checklist: len(r.inspection_checklist),
      photos: r.meta?.photos_analyzed || 0,
    };
  }
  if (mode === "salvage") return { comps: len(r.comps), repairs: len(r.repairs?.items) };
  return { comps: len(r.comps) };
}

/** The form fields the run was made from, so the page can rebuild the view
 *  after the Stripe redirect. Untrusted and only ever echoed back. */
function cleanInputs(raw) {
  if (!raw || typeof raw !== "object") return null;
  try {
    const s = JSON.stringify(raw);
    return s.length <= MAX_INPUTS_CHARS ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Stores a result. Non-Pro results are saved locked (`paid: false`); Pro
 *  results are saved already paid, so every result has an id the page can
 *  reopen, share, compare and negotiate from. */
export async function saveResult({ mode, result, inputs, userId, paid = false }) {
  const id = crypto.randomBytes(18).toString("base64url");
  const teaser = buildTeaser(mode, result);
  const now = Date.now();
  await redis.set(
    key(id),
    { mode, result, teaser, inputs: cleanInputs(inputs), userId: userId || null, paid, ...(paid ? { paidAt: now, viaPro: true } : {}), createdAt: now },
    { ex: paid ? PAID_TTL : UNPAID_TTL }
  );
  return { id, teaser };
}

export async function getResult(id) {
  if (!isResultId(id)) return null;
  return (await redis.get(key(id))) || null;
}

/** Idempotent — the redirect and the webhook can both land. */
export async function markPaid(id, { sessionId } = {}) {
  const rec = await getResult(id);
  if (!rec) return null;
  if (!rec.paid) {
    rec.paid = true;
    rec.paidAt = Date.now();
    rec.sessionId = sessionId || null;
  }
  await redis.set(key(id), rec, { ex: PAID_TTL });
  return rec;
}
