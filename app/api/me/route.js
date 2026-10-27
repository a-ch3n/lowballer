import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { linkScanAccess } from "@/lib/listingFetch";
import { UNLOCK_PRICE_CENTS } from "@/lib/lockedResults";

export const runtime = "nodejs";

/** GET /api/me -> { email, pro, configured, linkScan, unlockPrice }
 *  There's no free tier: non-Pro appraisals come back locked and unlock for
 *  `unlockPrice` cents each (see lib/lockedResults.js). `linkScan` is
 *  "on" | "pro_only" | "off" — see lib/listingFetch.js. */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ email: null, pro: false, configured: false, linkScan: "off", unlockPrice: UNLOCK_PRICE_CENTS });
  }
  const user = await getCurrentUser();
  const pro = !!user && (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing");
  return NextResponse.json({
    email: user?.email ?? null,
    pro,
    configured: true,
    linkScan: linkScanAccess(user, pro),
    unlockPrice: UNLOCK_PRICE_CENTS,
  });
}
