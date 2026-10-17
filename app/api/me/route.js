import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { FREE_LIMIT } from "@/lib/sign";
import { anonUsageCount, clientKey } from "@/lib/rateLimit";
import { linkScanAccess } from "@/lib/listingFetch";

export const runtime = "nodejs";

/** GET /api/me -> { email, pro, remaining, freeLimit, configured, linkScan }
 *  `remaining` is the lifetime free runs left (FREE_LIMIT total, never
 *  resets) — the higher of the account's count and this IP's count, the
 *  same rule /api/appraise enforces. null for Pro (unlimited).
 *  `linkScan` is "on" | "pro_only" | "off" — see lib/listingFetch.js. */
export async function GET(req) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ email: null, pro: false, remaining: null, freeLimit: FREE_LIMIT, configured: false, linkScan: "off" });
  }

  const user = await getCurrentUser();
  const pro = !!user && (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing");
  if (pro) {
    return NextResponse.json({ email: user.email, pro: true, remaining: null, freeLimit: FREE_LIMIT, configured: true, linkScan: linkScanAccess(user, true) });
  }

  const ipUses = await anonUsageCount(clientKey(req));
  const used = Math.max(ipUses, user?.freeUsesConsumed ?? 0);
  return NextResponse.json({
    email: user?.email ?? null,
    pro: false,
    remaining: Math.max(0, FREE_LIMIT - used),
    freeLimit: FREE_LIMIT,
    configured: true,
    linkScan: linkScanAccess(user, false),
  });
}
