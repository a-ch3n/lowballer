import { Redis } from "@upstash/redis";

/* Marketplace link scans. We never fetch Facebook ourselves: the listing is
   loaded by a third-party listing-retrieval vendor (ScrapeCreators — one
   synchronous GET per listing, 1 credit). Swapping vendors means replacing
   fetchFromVendor + normalizeFacebookItem; everything else stays.

   Access is gated by LINK_SCAN_MODE:
     "off"     — hidden for everyone
     "testers" — only emails in LINK_SCAN_TESTERS (default, for testing)
     "pro"     — Pro subscribers (testers keep access too)
     "all"     — everyone, signed in or not; non-Pro scans are bounded by
                 the route's per-IP cap and freeBudgetOk() below
   and nothing is on without SCRAPECREATORS_API_KEY. */

const redis = Redis.fromEnv();
const VENDOR_URL = "https://api.scrapecreators.com/v1/facebook/marketplace/item";
const CACHE_TTL = 6 * 60 * 60; // listings change price / sell; 6h keeps repeat scans free without going stale
const MISS_TTL = 10 * 60; // remember dead links briefly so retries don't each cost a credit
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 880_000; // stays under the appraise route's per-photo limit once base64'd
const MAX_TOTAL_BYTES = 2_900_000; // ~3.9 MB base64 — under the route's total photo limit
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** "on" | "pro_only" | "off" for this user. "pro_only" means the feature is
 *  live for Pro but this user isn't Pro — the UI shows it as an upsell. */
export function linkScanAccess(user, pro) {
  const mode = (process.env.LINK_SCAN_MODE || "testers").trim().toLowerCase();
  if (!process.env.SCRAPECREATORS_API_KEY || mode === "off") return "off";
  const testers = (process.env.LINK_SCAN_TESTERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const isTester = !!user?.email && testers.includes(user.email.toLowerCase());
  if (isTester || mode === "all") return "on";
  if (mode === "pro") return pro ? "on" : "pro_only";
  return "off";
}

/** Only facebook.com/marketplace/item/<id> links. Returns the canonical URL
 *  (tracking params dropped) so the vendor never sees arbitrary input and
 *  the cache key is stable. */
export function parseListingUrl(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/marketplace\/(?:[a-z0-9_-]+\/)?item\/(\d{5,25})(?:[/?#]|$)/i);
  if (!m) return null;
  return { site: "facebook", id: m[1], url: `https://www.facebook.com/marketplace/item/${m[1]}/` };
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Vehicle details aren't documented in the vendor's schema, so also pick up
// any top-level scalar field whose name looks vehicle-related.
const VEHICLE_KEY = /vehicle|mileage|odometer|vin|transmission|title_status|exterior|interior|fuel|drivetrain|condition/i;

export function normalizeFacebookItem(d) {
  const attributes = [];
  for (const a of Array.isArray(d?.attributes) ? d.attributes : []) {
    const name = str(a?.attribute_name, 60);
    const value = str(a?.label, 120) || str(a?.value, 120);
    if (name && value) attributes.push({ name, value });
  }
  for (const [k, v] of Object.entries(d || {})) {
    if (!VEHICLE_KEY.test(k)) continue;
    if ((typeof v === "string" && v.trim()) || typeof v === "number") {
      attributes.push({ name: k.replace(/_/g, " "), value: String(v).slice(0, 120) });
    }
  }
  const amount = Number(d?.price?.amount);
  const photos = (Array.isArray(d?.photos) ? d.photos : [])
    .map((p) => p?.url)
    .filter((u) => typeof u === "string" && isFbCdn(u))
    .slice(0, MAX_PHOTOS);
  return {
    title: str(d?.title, 200),
    price: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency: str(d?.price?.currency, 8) || "USD",
    description: str(d?.description, 5000),
    location: str(d?.location_text, 120),
    attributes: attributes.slice(0, 30),
    sold: !!d?.is_sold,
    pending: !!d?.is_pending,
    photos,
  };
}

/** Plain-text version for the extraction step and the analysis prompt. */
export function listingText(l) {
  return [
    l.title,
    l.price != null ? `Price: $${Math.round(l.price).toLocaleString("en-US")}` : "",
    l.location ? `Location: ${l.location}` : "",
    ...l.attributes.map((a) => `${a.name}: ${a.value}`),
    l.sold ? "Status: SOLD" : l.pending ? "Status: pending" : "",
    l.description ? `\nDescription:\n${l.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isFbCdn(u) {
  try {
    const h = new URL(u);
    return h.protocol === "https:" && (h.hostname.endsWith(".fbcdn.net") || h.hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
}

async function fetchFromVendor(url) {
  let res;
  try {
    res = await fetch(`${VENDOR_URL}?url=${encodeURIComponent(url)}`, {
      headers: { "x-api-key": process.env.SCRAPECREATORS_API_KEY },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error("listing vendor request failed:", e?.name || e);
    return { ok: false, reason: "unavailable" };
  }
  const data = await res.json().catch(() => null);
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok || !data || data.success === false) {
    console.error("listing vendor error:", res.status, String(data?.message || data?.error || "").slice(0, 200));
    if (res.status === 401 || res.status === 402 || res.status === 403) return { ok: false, reason: "vendor_account" };
    return { ok: false, reason: "unavailable" };
  }
  const listing = normalizeFacebookItem(data);
  if (!listing.title && !listing.description && listing.price == null) return { ok: false, reason: "not_found" };
  return { ok: true, listing };
}

/** Claims one credit from today's shared budget for non-Pro scans
 *  (LINK_SCAN_FREE_DAILY, default 200). Bounds worst-case vendor spend even
 *  if someone rotates IPs to get around the per-IP cap. Fails open on a
 *  Redis error — the per-IP limits still apply. */
export async function freeBudgetOk() {
  const cap = Number(process.env.LINK_SCAN_FREE_DAILY) || 200;
  const key = `lb_listing_budget:${new Date().toISOString().slice(0, 10)}`;
  try {
    const [n] = await redis.pipeline().incr(key).expire(key, 2 * 24 * 60 * 60).exec();
    return n <= cap;
  } catch (e) {
    console.error("listing budget:", e);
    return true;
  }
}

/** Cached listing lookup. { ok, listing, cached } or { ok: false, reason }.
 *  `beforeVendor` runs only on a cache miss (the part that costs a credit);
 *  returning false stops the lookup with reason "busy". */
export async function getListing({ id, url }, { beforeVendor } = {}) {
  const key = `lb_listing:fb:${id}`;
  try {
    const hit = await redis.get(key);
    if (hit?.miss) return { ok: false, reason: hit.miss };
    if (hit?.listing) return { ok: true, listing: hit.listing, cached: true };
  } catch (e) {
    console.error("listing cache read:", e);
  }
  if (beforeVendor && !(await beforeVendor())) return { ok: false, reason: "busy" };
  const out = await fetchFromVendor(url);
  try {
    if (out.ok) await redis.set(key, { listing: out.listing }, { ex: CACHE_TTL });
    else if (out.reason === "not_found") await redis.set(key, { miss: "not_found" }, { ex: MISS_TTL });
  } catch (e) {
    console.error("listing cache write:", e);
  }
  return { ...out, cached: false };
}

/** Downloads the listing photos as base64 so they go through the same
 *  photo path as uploads. Photos aren't cached (too big for Redis values);
 *  a photo that fails or is too large is just skipped. */
export async function downloadPhotos(urls) {
  const results = await Promise.all(
    urls.slice(0, MAX_PHOTOS).map(async (u) => {
      if (!isFbCdn(u)) return null;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return null;
        const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!PHOTO_TYPES.has(type)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MAX_PHOTO_BYTES) return null;
        return { type, bytes: buf.length, data: buf.toString("base64") };
      } catch {
        return null;
      }
    })
  );
  const images = [];
  let total = 0;
  for (const im of results) {
    if (!im || total + im.bytes > MAX_TOTAL_BYTES) continue;
    total += im.bytes;
    images.push({ type: im.type, data: im.data });
  }
  return { images, skipped: Math.min(urls.length, MAX_PHOTOS) - images.length };
}
