import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/rateLimit";
import { getResult, isResultId, UNLOCK_PRICE_CENTS } from "@/lib/lockedResults";

export const runtime = "nodejs";

/**
 * POST /api/unlock { resultId } -> { url } (Stripe Checkout, one-time payment)
 *
 * Unlocks one locked appraisal. No account needed — Stripe collects the
 * email. The webhook (metadata.kind === "unlock") and the success redirect
 * (/api/result/:id?unlock_session=…) both mark the result paid; neither ever
 * touches subscription status.
 */
export async function POST(req) {
  const key = process.env.STRIPE_SECRET_KEY;
  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  if (!key) return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });

  const limit = await rateLimit(`unlock-ip:${clientKey(req)}`, { max: 20, windowMs: 15 * 60 * 1000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited", detail: "Too many requests. Try again in a few minutes." }, { status: 429 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const id = body?.resultId;
  if (!isResultId(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const rec = await getResult(id);
  if (!rec) return NextResponse.json({ error: "not_found", detail: "That appraisal has expired — run it again." }, { status: 404 });
  if (rec.paid) return NextResponse.json({ paid: true });

  const user = await getCurrentUser();
  const stripe = new Stripe(key);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: UNLOCK_PRICE_CENTS,
          product_data: { name: "Lowballer appraisal unlock", description: "Full results for one appraisal" },
        },
      },
    ],
    // Distinct param names from the Pro flow's ?session_id= so this can never
    // be mistaken for a subscription checkout on the way back.
    success_url: `${base}/?unlock=${id}&unlock_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/?unlock=${id}`,
    ...(user ? { customer_email: user.email } : {}),
    metadata: { kind: "unlock", resultId: id, source: "lowballer_web" },
    payment_intent_data: { metadata: { kind: "unlock", resultId: id } },
  });
  return NextResponse.json({ url: session.url });
}
