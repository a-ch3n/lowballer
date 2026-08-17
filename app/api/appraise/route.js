import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { FREE_LIMIT } from "@/lib/sign";

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

  // Metered calls need an account to attribute the use to, and require pro
  // or a remaining free use. Extraction (count: false) stays open to
  // anonymous callers, same as before accounts existed.
  if (count) {
    if (!user) {
      return NextResponse.json({ error: "auth_required" }, { status: 401 });
    }
    if (!pro && user.freeUsesConsumed >= FREE_LIMIT) {
      return NextResponse.json({ error: "limit", remaining: 0, pro: false }, { status: 402 });
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
  // and increment the count together, so they can't drift apart.
  let freeUsesConsumed = user?.freeUsesConsumed ?? 0;
  if (count && !pro) {
    freeUsesConsumed += 1;
    await prisma.$transaction([
      prisma.appraisal.create({ data: { userId: user.id, mode } }),
      prisma.user.update({ where: { id: user.id }, data: { freeUsesConsumed: { increment: 1 } } }),
    ]);
  }

  return NextResponse.json({
    json,
    remaining: pro ? null : Math.max(0, FREE_LIMIT - freeUsesConsumed),
    pro,
  });
}
