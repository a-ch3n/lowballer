import { NextResponse } from "next/server";
import { rateLimit, clientKey } from "@/lib/rateLimit";
import { getResult } from "@/lib/lockedResults";
import { buildSnapshot, createShare } from "@/lib/shares";

export const runtime = "nodejs";

/**
 * POST /api/share { resultId, offerTarget?, verdictLabel? } -> { shareId, url }
 * Creates (or refreshes) the public deal card for a result. The card is a
 * snapshot of teaser-level facts — see lib/shares.js. `offerTarget` /
 * `verdictLabel` only count for paid results, where the sharer has seen them.
 */
export async function POST(req) {
  const limit = await rateLimit(`share-ip:${clientKey(req)}`, { max: 30, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited", detail: "Too many shares — try again in a bit." }, { status: 429 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const rec = await getResult(body?.resultId);
  if (!rec) return NextResponse.json({ error: "not_found", detail: "That appraisal has expired — run it again." }, { status: 404 });

  const snapshot = buildSnapshot(rec, { offerTarget: body?.offerTarget, verdictLabel: body?.verdictLabel });
  const shareId = await createShare(body.resultId, snapshot);
  const base = process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin;
  return NextResponse.json({ shareId, url: `${base}/d/${shareId}`, headline: snapshot.pctUnder ? `${snapshot.pctUnder}% under asking` : null });
}
