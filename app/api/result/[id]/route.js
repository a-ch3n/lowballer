import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getCurrentUser } from "@/lib/auth";
import { getResult, markPaid, isResultId, UNLOCK_PRICE_CENTS } from "@/lib/lockedResults";

export const runtime = "nodejs";

/**
 * GET /api/result/:id[?unlock_session=cs_…]
 *  -> paid:   { paid: true, mode, result, inputs }
 *  -> locked: { locked: true, mode, teaser, inputs, price }
 *
 * The full result only leaves the server once the result is paid — or for
 * a Pro subscriber. `unlock_session` is the fast path after the Stripe
 * redirect (the webhook may not have landed yet): the session is checked
 * with Stripe and must be a paid unlock for THIS result.
 */
export async function GET(req, { params }) {
  const id = params?.id;
  if (!isResultId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let rec = await getResult(id);
  if (!rec) return NextResponse.json({ error: "not_found", detail: "That appraisal has expired — run it again." }, { status: 404 });

  const sessionId = new URL(req.url).searchParams.get("unlock_session");
  if (!rec.paid && sessionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const session = await new Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(sessionId);
      if (session.payment_status === "paid" && session.metadata?.kind === "unlock" && session.metadata?.resultId === id) {
        rec = await markPaid(id, { sessionId: session.id });
      }
    } catch (e) {
      console.error("unlock verify:", e?.message || e);
    }
  }

  const user = rec.paid ? null : await getCurrentUser();
  const pro = !!user && (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing");
  if (rec.paid || pro) {
    return NextResponse.json({ paid: true, mode: rec.mode, result: rec.result, inputs: rec.inputs });
  }
  return NextResponse.json({ locked: true, mode: rec.mode, teaser: rec.teaser, inputs: rec.inputs, price: UNLOCK_PRICE_CENTS });
}
