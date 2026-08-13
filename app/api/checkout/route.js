import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

/** POST /api/checkout -> { url } (Stripe Checkout for the $30/mo subscription) */
export async function POST() {
  const key = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  if (!key || !price) {
    return NextResponse.json(
      { error: "Stripe not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID." },
      { status: 500 }
    );
  }
  const stripe = new Stripe(key);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/`,
  });
  return NextResponse.json({ url: session.url });
}
