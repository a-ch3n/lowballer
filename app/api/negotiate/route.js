import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/rateLimit";
import { getResult } from "@/lib/lockedResults";
import { cleanNumbers, runCoach } from "@/lib/negotiate";

export const runtime = "nodejs";

/**
 * POST /api/negotiate
 *  { resultId, sellerMessage, lastOffer, numbers: { asking, open, target, walk }, history: [{ from, text }] }
 *  -> { decision: "accept"|"counter"|"hold"|"walk", price, message, summary, sellerPrice, sellerFinal }
 *
 * The negotiation coach. Only for results the user can see in full — a paid
 * (unlocked or Pro) result — so it can't be used to work out a locked
 * result's numbers. One no-search Claude call per turn; the decision itself
 * is deterministic (lib/negotiate.js).
 */
export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });

  const limit = await rateLimit(`negotiate-ip:${clientKey(req)}`, { max: 40, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited", detail: "Too many coaching requests — try again in a bit." }, { status: 429 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const rec = await getResult(body?.resultId);
  if (!rec) return NextResponse.json({ error: "not_found", detail: "That appraisal has expired — run it again." }, { status: 404 });
  if (!rec.paid) {
    const user = await getCurrentUser();
    const pro = !!user && (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing");
    if (!pro) return NextResponse.json({ error: "locked", detail: "Unlock this appraisal to use the negotiation coach." }, { status: 402 });
  }

  const numbers = cleanNumbers(body?.numbers);
  if (!numbers) return NextResponse.json({ error: "bad_request", detail: "Missing your offer numbers." }, { status: 400 });
  const sellerMessage = typeof body?.sellerMessage === "string" ? body.sellerMessage.trim() : "";
  if (!sellerMessage) return NextResponse.json({ error: "bad_request", detail: "Paste what the seller said first." }, { status: 400 });
  const history = Array.isArray(body?.history)
    ? body.history.filter((t) => t && (t.from === "me" || t.from === "seller") && typeof t.text === "string").slice(-6)
    : [];

  const inp = rec.inputs || {};
  const title =
    rec.mode === "car" && inp.car ? [inp.car.year, inp.car.make, inp.car.model, inp.car.trim].filter(Boolean).join(" ")
    : rec.mode === "item" && inp.item ? [inp.item.brand, inp.item.name].filter(Boolean).join(" ")
    : "";

  const out = await runCoach({ apiKey, title, numbers, lastOffer: Number(body?.lastOffer) || numbers.open, history, sellerMessage });
  if (!out.ok) return NextResponse.json(out.failure.body, { status: out.failure.http });
  return NextResponse.json(out.coach);
}
