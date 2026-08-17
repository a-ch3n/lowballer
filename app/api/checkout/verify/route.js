import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

/**
 * GET /api/checkout/verify?session_id=cs_...
 * Fast-path UI signal only — lets the page show "you're Pro" immediately
 * after checkout instead of waiting on the webhook. Grants nothing itself;
 * the Stripe webhook writing to the User row remains the source of truth
 * that /api/me and /api/appraise actually check.
 */
export async function GET(req) {
  const key = process.env.STRIPE_SECRET_KEY;
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!key || !sessionId) {
    return NextResponse.json({ pro: false, error: "Missing session or Stripe key" }, { status: 400 });
  }
  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === "paid" || session.status === "complete";
    return NextResponse.json({ pro: paid });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ pro: false, error: "Verification failed" }, { status: 500 });
  }
}
