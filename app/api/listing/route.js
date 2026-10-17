import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/rateLimit";
import { linkScanAccess, parseListingUrl, getListing, downloadPhotos, listingText } from "@/lib/listingFetch";

export const runtime = "nodejs";
export const maxDuration = 60;

const FAIL = {
  not_found: { http: 404, detail: "That listing couldn't be found — it may be sold, removed, or private." },
  unavailable: { http: 502, detail: "Couldn't load that listing right now." },
  vendor_account: { http: 503, detail: "Link scans are temporarily unavailable." },
};

/**
 * POST /api/listing  { url } -> { listing, text, images, photosSkipped, cached }
 *
 * Loads a Facebook Marketplace listing through the listing-retrieval vendor
 * (see lib/listingFetch.js) so the client can prefill the appraisal from a
 * pasted link. Not metered — the appraisal that follows is. Gated by
 * LINK_SCAN_MODE (testers / Pro). Any failure tells the client to fall back
 * to screenshots.
 */
export async function POST(req) {
  const ipLimit = await rateLimit(`listing-ip:${clientKey(req)}`, { max: 20, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.ok) {
    return NextResponse.json({ error: "rate_limited", detail: "Too many link scans. Try again in a few minutes." }, { status: 429 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "auth" }, { status: 401 });
  const pro = user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing";

  const access = linkScanAccess(user, pro);
  if (access === "pro_only") return NextResponse.json({ error: "pro_required" }, { status: 402 });
  if (access !== "on") return NextResponse.json({ error: "link_scan_off" }, { status: 403 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const target = parseListingUrl(body?.url);
  if (!target) {
    return NextResponse.json(
      { error: "bad_url", detail: "Paste a Facebook Marketplace listing link — it looks like facebook.com/marketplace/item/123…" },
      { status: 400 }
    );
  }

  // Each uncached scan costs a vendor credit; this bounds it per account.
  const userLimit = await rateLimit(`listing-user:${user.id}`, { max: 30, windowMs: 60 * 60 * 1000 });
  if (!userLimit.ok) {
    return NextResponse.json({ error: "rate_limited", detail: "Too many link scans this hour. Upload screenshots instead." }, { status: 429 });
  }

  const out = await getListing(target);
  if (!out.ok) {
    const f = FAIL[out.reason] || FAIL.unavailable;
    return NextResponse.json({ error: out.reason, detail: f.detail, fallback: "screenshots" }, { status: f.http });
  }

  const { listing } = out;
  const { images, skipped } = await downloadPhotos(listing.photos);
  return NextResponse.json({
    listing: {
      url: target.url,
      title: listing.title,
      price: listing.price,
      location: listing.location,
      sold: listing.sold,
      pending: listing.pending,
      photoCount: listing.photos.length,
    },
    text: listingText(listing),
    images,
    photosSkipped: skipped,
    cached: out.cached,
  });
}
