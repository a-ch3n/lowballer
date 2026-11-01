import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimit, clientKey, dailyBudgetOk } from "@/lib/rateLimit";
import { callAnthropic, webSearchTool, upstreamFailure, responseText, extractJson } from "@/lib/anthropic";
import { parseVehicleRequest, runVehicleAnalysis } from "@/lib/vehicleAnalysis";
import { saveResult, UNLOCK_PRICE_CENTS } from "@/lib/lockedResults";

export const runtime = "nodejs";
export const maxDuration = 180; // web search + (rarely) a corrective retry can take a while

/**
 * POST /api/appraise
 * Body: { content: string | ContentBlock[], useSearch: boolean, mode: string, inputs?: object }
 *  - content: the user message for Claude (text, or blocks incl. base64 images)
 *  - useSearch: attach the web search tool
 *  - mode: "car" | "item" | "salvage" — recorded on the Appraisal row
 *  - inputs: the form fields, stored with a locked result so the page can
 *            rebuild the view after the Stripe redirect
 * Returns: { json, pro } — or, for a non-Pro research call,
 *          { locked: true, resultId, teaser, price, pro: false }
 *
 * Vehicle deal analysis: body { analysis: "vehicle", listing, images }. The
 * server builds the prompt, validates the result against a schema (one
 * corrective retry) and returns { analysis, pro } (or the locked shape).
 *
 * Pay-per-result: any research call (web search, or the vehicle analysis)
 * by a non-Pro user is a paid result. It runs in full, but the result is
 * stored server-side and only a teaser comes back until it's unlocked for
 * UNLOCK_PRICE_CENTS via /api/unlock. The server decides this, not the
 * client — a "count: false" flag can't get research results out for free.
 * Plain extraction (no search) stays open and unlocked.
 */
export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  // Blanket per-IP cap on every call, since extraction is open to anonymous
  // callers. Cheap, so check it before touching the DB or Anthropic.
  const ip = clientKey(req);
  const ipLimit = await rateLimit(`appraise-ip:${ip}`, { max: 30, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "rate_limited", detail: `Too many requests. Try again in ${Math.ceil(ipLimit.retryAfter / 60)} min.` },
      { status: 429, headers: { "retry-after": String(ipLimit.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  let { content, useSearch = false, mode = "car" } = body || {};
  if (!["car", "item", "salvage"].includes(mode)) mode = "car";

  const isVehicle = body?.analysis === "vehicle";
  let vehicle = null;
  if (isVehicle) {
    vehicle = parseVehicleRequest(body);
    if (!vehicle.ok) return NextResponse.json({ error: "bad_request", detail: vehicle.error }, { status: 400 });
    useSearch = true;
    mode = "car";
  } else if (!content) {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }
  const research = isVehicle || !!useSearch;

  const user = await getCurrentUser();
  const pro = user ? user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing" : false;

  if (research) {
    if (user) {
      // Bounds spend for Pro, which otherwise has no ceiling.
      const userLimit = await rateLimit(`appraise-user:${user.id}`, { max: 20, windowMs: 60 * 60 * 1000 });
      if (!userLimit.ok) {
        return NextResponse.json(
          { error: "rate_limited", detail: `Too many appraisals. Try again in ${Math.ceil(userLimit.retryAfter / 60)} min.` },
          { status: 429, headers: { "retry-after": String(userLimit.retryAfter) } }
        );
      }
    }
    if (!pro) {
      // Locked runs cost us a full analysis before anyone pays, so bound
      // them per IP and across everyone per day.
      const daily = await rateLimit(`locked-ip:${ip}`, { max: 8, windowMs: 24 * 60 * 60 * 1000 });
      if (!daily.ok) {
        return NextResponse.json(
          { error: "rate_limited", detail: "That's today's limit for new appraisals. Unlock one you've already run, or go Pro for unlimited." },
          { status: 429 }
        );
      }
      if (!(await dailyBudgetOk("locked", Number(process.env.LOCKED_DAILY_CAP) || 300))) {
        return NextResponse.json({ error: "busy", detail: "Appraisals are busy right now — try again later." }, { status: 503 });
      }
    }
  }

  let result;
  if (isVehicle) {
    const out = await runVehicleAnalysis({ apiKey, listing: vehicle.listing, images: vehicle.images });
    if (!out.ok) return NextResponse.json(out.failure.body, { status: out.failure.http });
    result = out.analysis;
  } else {
    const res = await callAnthropic({
      apiKey,
      messages: [{ role: "user", content }],
      tools: useSearch ? [webSearchTool()] : undefined,
      maxTokens: useSearch ? 3000 : 1500,
    });
    if (!res.ok) {
      const f = upstreamFailure(res.status, res.data);
      return NextResponse.json(f.body, { status: f.http });
    }
    const parsed = extractJson(responseText(res.data));
    if (parsed.error) {
      const noJson = parsed.error.startsWith("no JSON");
      return NextResponse.json({ error: noJson ? "No JSON in AI response" : "Could not parse AI response" }, { status: 502 });
    }
    result = parsed.value;
  }

  // Usage history for signed-in accounts; a failure here shouldn't fail the run.
  if (research && user) {
    await prisma.appraisal.create({ data: { userId: user.id, mode } }).catch((e) => console.error("appraisal row:", e));
  }

  if (research && !pro) {
    const { id, teaser } = await saveResult({ mode, result, inputs: body.inputs, userId: user?.id });
    return NextResponse.json({ locked: true, resultId: id, mode, teaser, price: UNLOCK_PRICE_CENTS, pro: false });
  }
  // Pro results are stored too (already paid), so they get an id for the
  // negotiation coach, share cards and the saved-deals list. A storage
  // hiccup shouldn't cost a Pro user their result.
  let resultId = null;
  if (research) {
    resultId = await saveResult({ mode, result, inputs: body.inputs, userId: user?.id, paid: true })
      .then((r) => r.id)
      .catch((e) => { console.error("save pro result:", e); return null; });
  }
  if (isVehicle) return NextResponse.json({ analysis: result, pro, resultId });
  return NextResponse.json({ json: result, pro, resultId });
}
