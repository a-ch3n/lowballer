import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { FREE_LIMIT } from "@/lib/sign";
import { rateLimit, clientKey, anonUsageCount, incrAnonUsage } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 120; // web-search calls can take a while

/**
 * POST /api/appraise
 * Body: { content: string | ContentBlock[], useSearch: boolean, count: boolean, mode: string }
 *  - content: the user message for Claude (text, or blocks incl. base64 images)
 *  - useSearch: attach the web search tool
 *  - count: whether this call consumes a free use (extraction calls pass
 *           false; the final appraisal call passes true) — also requires
 *           being signed in, since a free use has to be attributed to an
 *           account now, not a cookie
 *  - mode: "car" | "item" | "salvage" — recorded on the Appraisal row for
 *          counted calls
 * Returns: { json: <parsed JSON from Claude>, remaining, pro }
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
  const { content, useSearch = false, count = false, mode = "car" } = body || {};
  if (!content) return NextResponse.json({ error: "Missing content" }, { status: 400 });

  const user = await getCurrentUser();
  const pro = user ? user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing" : false;
  const ip = clientKey(req);

  // Metered calls consume either an account's free use / pro entitlement,
  // or — before any account exists — an anonymous use tracked by IP rather
  // than a cookie, so the first FREE_LIMIT tries survive incognito/clearing
  // cookies without needing an email. Extraction (count: false) stays open
  // to anonymous callers either way, same as before accounts existed.
  let anonUses = 0;
  if (count) {
    if (!user) {
      anonUses = await anonUsageCount(ip);
      if (anonUses >= FREE_LIMIT) {
        return NextResponse.json({ error: "auth_required" }, { status: 401 });
      }
    } else {
      if (!pro && user.freeUsesConsumed >= FREE_LIMIT) {
        return NextResponse.json({ error: "limit", remaining: 0, pro: false }, { status: 402 });
      }
      // Free users are already bounded by FREE_LIMIT; this per-user cap is
      // what actually bounds spend for Pro, which otherwise has none.
      const userLimit = await rateLimit(`appraise-user:${user.id}`, { max: 20, windowMs: 60 * 60 * 1000 });
      if (!userLimit.ok) {
        return NextResponse.json(
          { error: "rate_limited", detail: `Too many appraisals. Try again in ${Math.ceil(userLimit.retryAfter / 60)} min.` },
          { status: 429, headers: { "retry-after": String(userLimit.retryAfter) } }
        );
      }
    }
  }

  const payload = {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content }],
  };
  if (useSearch) payload.tools = [{ type: "web_search_20250305", name: "web_search" }];

  let data;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    data = await res.json();
    if (!res.ok) {
      console.error("Anthropic error:", data);
      return NextResponse.json({ error: "Upstream AI error" }, { status: 502 });
    }
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "AI request failed" }, { status: 502 });
  }

  // Extract JSON from Claude's text blocks
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s === -1 || e === -1) {
    return NextResponse.json({ error: "No JSON in AI response" }, { status: 502 });
  }
  let json;
  try {
    json = JSON.parse(clean.slice(s, e + 1));
  } catch {
    return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
  }

  // Consume a use only on successful, counted calls — record the appraisal
  // and increment the count together, so they can't drift apart. Anonymous
  // calls have no account to attach an Appraisal row to, so just bump the
  // IP counter instead.
  let freeUsesConsumed = user?.freeUsesConsumed ?? 0;
  if (count && user && !pro) {
    freeUsesConsumed += 1;
    await prisma.$transaction([
      prisma.appraisal.create({ data: { userId: user.id, mode } }),
      prisma.user.update({ where: { id: user.id }, data: { freeUsesConsumed: { increment: 1 } } }),
    ]);
  } else if (count && !user) {
    anonUses = await incrAnonUsage(ip);
  }

  return NextResponse.json({
    json,
    remaining: pro ? null : user ? Math.max(0, FREE_LIMIT - freeUsesConsumed) : Math.max(0, FREE_LIMIT - anonUses),
    pro,
  });
}
