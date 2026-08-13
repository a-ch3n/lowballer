import { NextResponse } from "next/server";
import Stripe from "stripe";
import { sign, cookieOpts } from "@/lib/sign";

export const runtime = "nodejs";

/**
 * GET /api/checkout/verify?session_id=cs_...
 * Verifies the Checkout Session with Stripe; if paid, sets the signed pro cookie.
 */
export async function GET(req) {
  const key = process.env.STRIPE_SECRET_KEY;
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("session_id");
  if (!key || !sessionId) {
    return NextResponse.json({ pro: false, error: "Missing session or Stripe key" }, { status: 400 });
  }
  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === "paid" || session.status === "complete";
    if (!paid) return NextResponse.json({ pro: false });
    const resp = NextResponse.json({ pro: true });
    resp.cookies.set("lb_pro", sign("pro"), cookieOpts);
    return resp;
  } catch (e) {
    console.error(e);
    return NextResponse.json({ pro: false, error: "Verification failed" }, { status: 500 });
  }
}
