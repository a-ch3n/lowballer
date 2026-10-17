import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { FREE_LIMIT } from "@/lib/sign";
import { rateLimit, clientKey, reserveAnonUse, releaseAnonUse } from "@/lib/rateLimit";
import { callAnthropic, webSearchTool, upstreamFailure, responseText, extractJson } from "@/lib/anthropic";
import { parseVehicleRequest, runVehicleAnalysis } from "@/lib/vehicleAnalysis";

export const runtime = "nodejs";
export const maxDuration = 180; // web search + (rarely) a corrective retry can take a while

/**
 * POST /api/appraise
 * Body: { content: string | ContentBlock[], useSearch: boolean, count: boolean, mode: string }
 *  - content: the user message for Claude (text, or blocks incl. base64 images)
 *  - useSearch: attach the web search tool
 *  - count: whether this call consumes a free use (extraction calls pass
 *           false; the final appraisal call passes true). Free uses are
 *           FREE_LIMIT in total, for life — never reset or expire
 *  - mode: "car" | "item" | "salvage" — recorded on the Appraisal row for
 *          counted calls
 * Returns: { json: <parsed JSON from Claude>, remaining, pro }
 *
 * Vehicle deal analysis: body { analysis: "vehicle", listing, images }. The
 * server builds the prompt, validates the result against a schema (one
 * corrective retry) and returns { analysis, remaining, pro }. It is always
 * metered as exactly ONE free use — however many photos — and the client
 * can't opt out of that: count/useSearch are forced on.
 */
export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  // Blanket per-IP cap on every call, since extraction is open to anonymous
  // callers. Cheap, so check it before touching the DB or Anthropic.
  const ipLimit = await rateLimit(`appraise-ip:${clientKey(req)}`, { max: 30, windowMs: 15 * 60 * 1000 });
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
  let { content, useSearch = false, count = false, mode = "car" } = body || {};

  const isVehicle = body?.analysis === "vehicle";
  let vehicle = null;
  if (isVehicle) {
    vehicle = parseVehicleRequest(body);
    if (!vehicle.ok) return NextResponse.json({ error: "bad_request", detail: vehicle.error }, { status: 400 });
    count = true; // always metered, whatever the client sent
    useSearch = true;
    mode = "car";
  } else if (!content) {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }

  const user = await getCurrentUser();
  const pro = user ? user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing" : false;
  const ip = clientKey(req);

  // Free uses are FREE_LIMIT in total, for life — no time window, no reset.
  // A non-Pro metered call claims one use up front on BOTH counters: the IP
  // counter in Redis (survives clearing cookies/incognito, no account
  // needed) and, if signed in, the account's freeUsesConsumed (survives
  // switching browsers/IPs). Whichever is higher wins, so signing in doesn't
  // hand out a fresh 3. Claiming before the run, atomically, is what stops
  // parallel requests from sneaking extra runs past the limit; a failed run
  // gives the use back. Extraction (count: false) is unmetered.
  let ipReserved = false;
  let userReserved = false;
  let usedAfter = 0;
  async function refund() {
    if (ipReserved) await releaseAnonUse(ip).catch((e) => console.error("refund ip:", e));
    if (userReserved) {
      await prisma.user
        .update({ where: { id: user.id }, data: { freeUsesConsumed: { decrement: 1 } } })
        .catch((e) => console.error("refund user:", e));
    }
  }
  const limitReached = () => NextResponse.json({ error: "limit", remaining: 0, pro: false }, { status: 402 });

  if (count) {
    if (user) {
      // The free-use cap bounds free users; this per-user rate cap is what
      // actually bounds spend for Pro, which otherwise has no ceiling.
      const userLimit = await rateLimit(`appraise-user:${user.id}`, { max: 20, windowMs: 60 * 60 * 1000 });
      if (!userLimit.ok) {
        return NextResponse.json(
          { error: "rate_limited", detail: `Too many appraisals. Try again in ${Math.ceil(userLimit.retryAfter / 60)} min.` },
          { status: 429, headers: { "retry-after": String(userLimit.retryAfter) } }
        );
      }
    }
    if (!pro) {
      usedAfter = await reserveAnonUse(ip);
      ipReserved = true;
      if (usedAfter > FREE_LIMIT) {
        await refund();
        return limitReached();
      }
      if (user) {
        const claimed = await prisma.user.updateMany({
          where: { id: user.id, freeUsesConsumed: { lt: FREE_LIMIT } },
          data: { freeUsesConsumed: { increment: 1 } },
        });
        if (claimed.count === 0) {
          await refund();
          return limitReached();
        }
        userReserved = true;
        usedAfter = Math.max(usedAfter, user.freeUsesConsumed + 1);
      }
    }
  }

  let json = null;
  let analysis = null;

  if (isVehicle) {
    const out = await runVehicleAnalysis({ apiKey, listing: vehicle.listing, images: vehicle.images });
    if (!out.ok) {
      await refund();
      return NextResponse.json(out.failure.body, { status: out.failure.http });
    }
    analysis = out.analysis;
  } else {
    const res = await callAnthropic({
      apiKey,
      messages: [{ role: "user", content }],
      tools: useSearch ? [webSearchTool()] : undefined,
    });
    if (!res.ok) {
      await refund();
      const f = upstreamFailure(res.status, res.data);
      return NextResponse.json(f.body, { status: f.http });
    }

    // Extract JSON from Claude's text blocks
    const parsed = extractJson(responseText(res.data));
    if (parsed.error) {
      await refund();
      const noJson = parsed.error.startsWith("no JSON");
      return NextResponse.json({ error: noJson ? "No JSON in AI response" : "Could not parse AI response" }, { status: 502 });
    }
    json = parsed.value;
  }

  // The use was already claimed above. For signed-in free users, also keep
  // a history row; a failure to write it shouldn't fail the appraisal.
  if (count && user && !pro) {
    await prisma.appraisal
      .create({ data: { userId: user.id, mode } })
      .catch((e) => console.error("appraisal row:", e));
  }

  const remaining = count && !pro ? Math.max(0, FREE_LIMIT - usedAfter) : null;
  if (isVehicle) return NextResponse.json({ analysis, remaining, pro });
  return NextResponse.json({ json, remaining, pro });
}
