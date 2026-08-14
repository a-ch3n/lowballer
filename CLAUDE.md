# Lowballer.org

AI-powered marketplace deal appraiser. Users screenshot a Facebook Marketplace listing, Copart lot, or any resale listing; the app extracts details with Claude vision, researches live market comps and repair costs via Claude + web search, and outputs a verdict with an exact lowball offer or max auction bid.

## Business model
- Free tier: 3 appraisals (server-metered via signed HMAC cookies)
- Pro: $30/month unlimited, via Stripe Checkout subscription

## Stack
- Next.js 14 (App Router, JavaScript, no TypeScript)
- React 18, all styling inline + a single <style> block in `app/page.jsx` (no Tailwind, no CSS modules)
- Stripe SDK for subscriptions
- Anthropic Messages API (model `claude-sonnet-4-6`) with the `web_search_20250305` tool

## Architecture
- `app/page.jsx` — the entire UI (client component). Three modes: car, item, salvage. Each appraisal makes 1–2 POSTs to `/api/appraise`.
- `app/api/appraise/route.js` — the ONLY place the Anthropic key is used. Proxies to api.anthropic.com, parses the JSON out of Claude's text response, enforces metering. `count: true` calls consume a free use; extraction calls pass `count: false`.
- `app/api/usage/route.js` — returns `{ remaining, pro }` from cookies.
- `app/api/checkout/route.js` — creates a Stripe Checkout Session (subscription).
- `app/api/checkout/verify/route.js` — verifies session_id after redirect, sets signed `lb_pro` cookie.
- `lib/sign.js` — HMAC sign/verify for `lb_uses` and `lb_pro` cookies. FREE_LIMIT lives here.

## Conventions
- Keep the Anthropic API key server-side only. Never move AI calls to the client.
- Claude prompts always demand compact JSON with an exact schema; the server extracts the first `{...}` block. If you change a schema, change both the prompt and the UI fields that read it.
- Deal math (offer percentages, Copart fee tiers, rebuilt-title discounts, hidden-damage buffer) lives in `app/page.jsx` — it's business logic, keep it deterministic in JS rather than asking the AI for it.
- Amounts render through `fmt()`; keep money as numbers until display.

## Commands
- `npm run dev` — local dev at http://localhost:3000
- `npm run build` — production build (must pass before deploying)
- Copy `.env.example` to `.env.local` and fill in keys before running.

## Known limitations / roadmap
- Cookie-based metering resets if the user clears cookies; the durable fix is accounts + a database (e.g. Postgres + auth), checking Stripe subscription status server-side per user.
- No Stripe webhook yet — cancellations aren't detected until the pro cookie expires (1 year). Add `checkout.session.completed` / `customer.subscription.deleted` webhooks + a DB before scale.
- Add per-user rate limiting on `/api/appraise` (even Pro) to cap API spend.
- Facebook Marketplace has no API; screenshot extraction is the intended path. Do not add scraping.

## Browser extension (`extension/`)
Chrome MV3 extension that adds a "Lowball this" button to listing pages (Facebook Marketplace, Craigslist, eBay, OfferUp, Copart, IAAI).

- Reads only the page the user is actively viewing, on click. No cookie access, no background crawling, no requests to third-party sites on the user's behalf. Do NOT add scraping or session-cookie features — that is a ToS and account-risk line we don't cross.
- Handoff is via URL fragment: `https://lowballer.org/#lb=<base64url json>`. Fragments never reach the server, so no CORS, no cross-site cookies, and metering/Stripe stay first-party in the existing site session.
- `app/page.jsx` decodes the fragment on mount (payload v1), sets mode, prefills fields, clears the hash, shows an import banner.
- Extraction in `extension/content.js` is LAYERED, not selector-based: L1 JSON-LD → L2 OpenGraph meta → L3 embedded JSON field names → L4 semantic DOM (h1/itemprop/data-testid) → L5 visible text. Each field records its source layer and the payload carries a `confidence` score.
- Do NOT add generated CSS class selectors — that's what made v1 fragile. To support a new field or site, add keys to `EMBEDDED_KEYS` and/or a `content_scripts.matches` entry; extraction itself is generic.
- Visible text always ships in `rawText` as the safety net, so a low-confidence read still gives Claude enough to parse. Keep that guarantee.
- Payload is v2; `app/page.jsx` accepts v1 and v2. Bump the version and keep backward compatibility if the shape changes.
