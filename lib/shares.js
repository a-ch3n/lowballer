import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* Shareable deal cards (/d/<shareId>). A share is a small public SNAPSHOT,
   never the result id: anyone holding a paid result's id can read the full
   paid result, so the id must not appear in a public link. The snapshot only
   carries teaser-level facts — title, verdict, score, asking — plus "% under
   asking" when the sharer has the full result (they've seen their offer). */

const redis = Redis.fromEnv();
const TTL = 365 * 24 * 60 * 60;
const shareKey = (id) => `lb_share:${id}`;
const forResultKey = (resultId) => `lb_share_for:${resultId}`;

export const isShareId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,16}$/.test(id);

// Verdict labels the page computes for item / salvage (deal math is client
// side). Only these exact strings are accepted from the client.
const CLIENT_VERDICTS = new Set(["Flip it", "Thin flip", "Pass / lowball", "Worth flipping", "Walk away"]);
const CAR_VERDICTS = { steal: "Steal", fair: "Fair price", overpriced: "Overpriced", money_pit: "Money pit" };

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

/** Builds the public snapshot from a stored result + what the sharer's page shows. */
export function buildSnapshot(rec, { offerTarget, verdictLabel } = {}) {
  const inp = rec.inputs || {};
  let title = "";
  let asking = null;
  if (rec.mode === "car" && inp.car) {
    title = [inp.car.year, inp.car.make, inp.car.model, inp.car.trim].filter(Boolean).join(" ");
    asking = n(inp.car.asking);
  } else if (rec.mode === "item" && inp.item) {
    title = [inp.item.brand, inp.item.name].filter(Boolean).join(" ");
    asking = n(inp.item.asking);
  } else if (rec.mode === "salvage" && inp.sal) {
    title = [inp.sal.year, inp.sal.make, inp.sal.model, inp.sal.trim].filter(Boolean).join(" ") + " (salvage)";
    asking = n(inp.sal.bid);
  }
  const t = rec.teaser || {};
  const verdictKey = rec.mode === "car" ? t.verdict : null;
  const verdict =
    rec.mode === "car" ? CAR_VERDICTS[t.verdict] || null
    : rec.paid && CLIENT_VERDICTS.has(verdictLabel) ? verdictLabel
    : null;
  const target = n(offerTarget);
  const pctUnder =
    rec.paid && rec.mode !== "salvage" && asking && target && target < asking
      ? Math.min(90, Math.round(((asking - target) / asking) * 100))
      : null;
  return {
    mode: rec.mode,
    title: title.slice(0, 90) || (rec.mode === "item" ? "A marketplace find" : "A used car"),
    verdict,
    verdictKey,
    score: rec.mode === "car" && Number.isFinite(t.deal_score) ? t.deal_score : null,
    asking,
    pctUnder,
    flags: rec.mode === "car" ? t.flags || 0 : null,
    highFlags: rec.mode === "car" ? t.highFlags || 0 : null,
    createdAt: Date.now(),
  };
}

/** One share per result: re-sharing returns the same link (snapshot refreshed). */
export async function createShare(resultId, snapshot) {
  let id = await redis.get(forResultKey(resultId));
  if (!isShareId(id)) id = crypto.randomBytes(7).toString("base64url");
  await redis.set(shareKey(id), snapshot, { ex: TTL });
  await redis.set(forResultKey(resultId), id, { ex: TTL });
  return id;
}

export async function getShare(id) {
  if (!isShareId(id)) return null;
  return (await redis.get(shareKey(id))) || null;
}

export const VERDICT_COLORS = { steal: "#3DDC97", fair: "#6E92FF", overpriced: "#FFB547", money_pit: "#FF6161" };
export function shareColor(s) {
  if (s.verdictKey) return VERDICT_COLORS[s.verdictKey] || "#6E92FF";
  if (s.verdict === "Flip it" || s.verdict === "Worth flipping") return VERDICT_COLORS.steal;
  if (s.verdict === "Thin flip") return VERDICT_COLORS.overpriced;
  if (s.verdict) return VERDICT_COLORS.money_pit;
  return "#6E92FF";
}

/** The one-line headline used on the page, the image and the share text. */
export function shareHeadline(s) {
  if (s.pctUnder) return `Lowballing ${s.pctUnder}% under asking`;
  if (s.verdict) return `Verdict: ${s.verdict}`;
  return "Appraised on Lowballer";
}
