import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sign, readAccount, cookieOpts, FREE_LIMIT } from "@/lib/sign";

export const runtime = "nodejs";
export const maxDuration = 120; // web-search calls can take a while

/**
 * POST /api/appraise
 * Body: { content: string | ContentBlock[], useSearch: boolean, count: boolean }
 *  - content: the user message for Claude (text, or blocks incl. base64 images)
 *  - useSearch: attach the web search tool
 *  - count: whether this call consumes a free use (extraction calls pass false;
 *           the final appraisal call passes true)
 * Returns: { json: <parsed JSON from Claude>, remaining, pro }
 */
export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server missing ANTHROPIC_API_KEY" }, { status: 500 });
  }

  const cookieStore = cookies();
  const { uses, pro } = readAccount(cookieStore);
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { content, useSearch = false, count = false } = body || {};
  if (!content) return NextResponse.json({ error: "Missing content" }, { status: 400 });

  // Gate: metered calls require pro or remaining free uses
  if (count && !pro && uses >= FREE_LIMIT) {
    return NextResponse.json(
      { error: "limit", remaining: 0, pro: false },
      { status: 402 }
    );
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

  // Consume a use only on successful, counted calls
  let nextUses = uses;
  if (count && !pro) nextUses = uses + 1;

  const resp = NextResponse.json({
    json,
    remaining: pro ? null : Math.max(0, FREE_LIMIT - nextUses),
    pro,
  });
  if (count && !pro) {
    resp.cookies.set("lb_uses", sign(String(nextUses)), cookieOpts);
  }
  return resp;
}
