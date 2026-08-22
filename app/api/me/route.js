import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { FREE_LIMIT } from "@/lib/sign";
import { anonUsageCount, clientKey } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** GET /api/me -> { email, pro, remaining, freeLimit, configured } */
export async function GET(req) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ email: null, pro: false, remaining: null, freeLimit: FREE_LIMIT, configured: false });
  }

  const user = await getCurrentUser();
  if (!user) {
    // Anonymous visitors get FREE_LIMIT IP-tracked uses before sign-in is
    // required — see app/api/appraise/route.js.
    const anonUses = await anonUsageCount(clientKey(req));
    return NextResponse.json({
      email: null,
      pro: false,
      remaining: Math.max(0, FREE_LIMIT - anonUses),
      freeLimit: FREE_LIMIT,
      configured: true,
    });
  }

  const pro = user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing";
  return NextResponse.json({
    email: user.email,
    pro,
    remaining: pro ? null : Math.max(0, FREE_LIMIT - user.freeUsesConsumed),
    freeLimit: FREE_LIMIT,
    configured: true,
  });
}
