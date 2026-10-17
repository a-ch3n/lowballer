/* Thin wrapper around the Anthropic Messages API, shared by the generic
   /api/appraise path and the vehicle analysis. Server-side only — the key
   never leaves the server. */

export const MODEL = "claude-sonnet-4-6";

export const webSearchTool = (maxUses) => ({
  type: "web_search_20250305",
  name: "web_search",
  ...(maxUses ? { max_uses: maxUses } : {}),
});

export async function callAnthropic({ apiKey, messages, system, tools, maxTokens = 1500 }) {
  const payload = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) payload.system = system;
  if (tools) payload.tools = tools;
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
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error("Anthropic request failed:", e);
    return { ok: false, status: 0, data: null };
  }
}

/** Maps an upstream failure to the HTTP response we return. Distinguishes
 *  the cases that need different handling instead of one generic 502:
 *  bad key (our problem, not the user's), rate limiting, overload, and an
 *  exhausted credit balance (the account needs topping up). Details are
 *  logged server-side; users only get a safe message. */
export function upstreamFailure(status, data) {
  const msg = String(data?.error?.message || "");
  console.error("Anthropic error:", status, data?.error?.type || "", msg.slice(0, 300));

  if (status === 0) return { http: 502, body: { error: "AI request failed" } };
  if (status === 401 || status === 403) {
    return { http: 502, body: { error: "ai_auth", detail: "The AI service rejected our credentials. This is on our side — please try again later." } };
  }
  if (status === 429) {
    return { http: 429, body: { error: "ai_busy", detail: "The AI service is busy right now. Try again in a minute — this didn't use one of your free appraisals." } };
  }
  if (status === 529 || status === 503) {
    return { http: 503, body: { error: "ai_overloaded", detail: "The AI service is overloaded. Try again shortly — this didn't use one of your free appraisals." } };
  }
  if (status === 400 && /credit balance/i.test(msg)) {
    return { http: 503, body: { error: "ai_credits", detail: "Appraisals are temporarily unavailable. Please try again later." } };
  }
  return { http: 502, body: { error: "Upstream AI error" } };
}

/** Joined text of every text block in a Messages response. */
export function responseText(data) {
  return (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Every URL the web search tool actually returned (plus text citations).
 *  Used to confirm cited comps were really found, not invented. */
export function searchedUrls(data) {
  const urls = new Set();
  for (const b of data?.content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.url) urls.add(r.url);
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c?.url) urls.add(c.url);
    }
  }
  return urls;
}

export function searchedSources(data, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const b of data?.content || []) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      if (r?.url && !seen.has(r.url)) {
        seen.add(r.url);
        out.push({ title: String(r.title || r.url).slice(0, 120), url: r.url });
      }
    }
  }
  return out.slice(0, limit);
}

/** First {...} block out of model text (tolerates ```json fences). */
export function extractJson(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s === -1 || e === -1) return { value: null, error: "no JSON object found in the response" };
  try {
    return { value: JSON.parse(clean.slice(s, e + 1)), error: null };
  } catch (err) {
    return { value: null, error: `JSON did not parse (${err.message})` };
  }
}
