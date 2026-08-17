# Lowballer.org

AI-powered marketplace deal appraiser. Users screenshot a Facebook Marketplace listing, Copart lot, or any resale listing; the app extracts details with Claude vision, researches live market comps and repair costs via Claude + web search, and outputs a verdict with an exact lowball offer or max auction bid.

## Business model
- Free tier: 3 appraisals per account (server-metered in Postgres, keyed to a signed-in user — not cookies, so it survives incognito/different browsers)
- Pro: $30/month unlimited, via Stripe Checkout subscription

## Stack
- Next.js 14 (App Router, JavaScript, no TypeScript)
- React 18, all styling inline + a single <style> block in `app/page.jsx` (no Tailwind, no CSS modules)
- Postgres + Prisma (accounts, sessions, entitlement, appraisal history) — hosted on Railway in this project
- Stripe SDK for subscriptions
- Anthropic Messages API (model `claude-sonnet-4-6`) with the `web_search_20250305` tool
- Resend for magic-link emails (optional in dev — see Auth section)

## Architecture
- `app/page.jsx` — the entire UI (client component). Three modes: car, item, salvage. Each appraisal makes 1–2 POSTs to `/api/appraise`. Sign-in modal, nav auth state (email + sign out), and a 401-from-appraise handler that opens the sign-in modal live here too.
- `app/api/appraise/route.js` — the ONLY place the Anthropic key is used. Proxies to api.anthropic.com, parses the JSON out of Claude's text response. `count: true` calls (the metered analysis step) require a signed-in user — 401 if not — and check `FREE_LIMIT` against that user's `freeUsesConsumed`; on success, create an `Appraisal` row and increment the counter in one transaction. `count: false` (extraction) calls stay open to anonymous callers, same as before accounts existed.
- `lib/auth.js` — `getCurrentUser()` (reads the signed `lb_sess` cookie, loads the Session + User, null if missing/expired), session cookie helpers. This is what replaced the old `readAccount(cookies())` cookie-only check.
- `app/api/auth/login/route.js` — `{ email }` → upserts a User, mints a single-use 15-minute LoginToken (only the hash is stored), emails the link via `lib/mail.js`. Always the same response whether or not the email has an account. Rate-limited via `lib/rateLimit.js`.
- `app/api/auth/callback/route.js` — verifies the token (atomic claim so a link used twice only ever succeeds once), creates a Session, sets the signed `lb_sess` cookie (30 days), redirects to `/?auth=ok` (or `/?auth=invalid`).
- `app/api/auth/logout/route.js` — deletes the Session row server-side (not just the cookie) and clears it.
- `app/api/me/route.js` — replaces the old `/api/usage`. Returns `{ email, pro, remaining, freeLimit, configured }` from `getCurrentUser()`.
- `lib/mail.js` — `sendMagicLink()` via the Resend REST API; logs the link to the console instead when `RESEND_API_KEY` isn't set, so local dev needs no email provider.
- `lib/rateLimit.js` — minimal in-memory sliding-window limiter, per-serverless-instance only. Used by the login route today.
- `app/api/checkout/route.js` — creates a Stripe Checkout Session. Requires a signed-in user (401 if not) and always uses their real email for `customer_email` — never trust one from the request body.
- `app/api/checkout/verify/route.js` — fast-path UI signal only (checks the session with Stripe, returns `{pro}`). Grants nothing itself; sets no cookie. The webhook writing to the `User` row is the actual source of truth.
- `app/api/stripe/webhook/route.js` — Stripe is the source of truth for subscription status. Verifies the signature against the **raw** request body (`req.text()`, never `req.json()`), then syncs `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.payment_failed` into `lib/subscriptions.js`. Always acknowledges with 200 except on bad signature (400) — an unhandled event type or an internal processing error still returns 200, or Stripe retries the event forever. `invoice.payment_failed` marks `past_due` but does NOT revoke access (Stripe retries failed payments; revoking on the first failure punishes an expired card, not a real cancellation).
- `lib/subscriptions.js` — `setSubscription` / `getSubscriptionByEmail` / `isEntitled`, now backed by Prisma (the `User` row's `stripeCustomerId`/`subscriptionStatus`/etc.) rather than the Phase 1 JSON file. Matches by email; creates a `User` if none exists yet, since someone can subscribe before ever signing in.
- `lib/db.js` — Prisma client singleton (reused across hot reloads in dev so edits don't exhaust the connection limit).
- `lib/sign.js` — HMAC sign/verify (used for both the session cookie and login/session tokens) and `FREE_LIMIT`.
- `prisma/schema.prisma` — `User` (identity + entitlement + `freeUsesConsumed`), `Session`, `LoginToken` (hash stored, never the raw token), `Appraisal` (usage history, one row per successful metered call).

## Auth (magic link, no passwords)
- Sign-in is email-only: request a link, click it, done. No passwords, no password-reset flow.
- In dev, if `RESEND_API_KEY` isn't set, the link is printed to the server console instead of emailed — sign-in still works end to end, just copy the URL from the terminal.
- Sessions last 30 days (`lb_sess`, HMAC-signed, httpOnly). Signing out deletes the `Session` row server-side, not just the cookie.
- Do not add NextAuth or another auth framework here — the session needs are small and `lib/sign.js` + this setup already cover them; a framework would cost more than it saves.

## Conventions
- Keep the Anthropic API key server-side only. Never move AI calls to the client.
- Claude prompts always demand compact JSON with an exact schema; the server extracts the first `{...}` block. If you change a schema, change both the prompt and the UI fields that read it.
- Deal math (offer percentages, Copart fee tiers, rebuilt-title discounts, hidden-damage buffer) lives in `app/page.jsx` — it's business logic, keep it deterministic in JS rather than asking the AI for it.
- Amounts render through `fmt()`; keep money as numbers until display.
- Never trust the client for entitlement or for which email a request belongs to — always resolve it server-side from the session (`getCurrentUser()`).

## Commands
- `npm run dev` — local dev at http://localhost:3000
- `npm run build` — production build (must pass before deploying)
- Copy `.env.example` to `.env.local` and fill in keys before running.
- Prisma CLI reads `.env`, not `.env.local` (Next.js's convention) — keep a `.env` with just `DATABASE_URL` mirrored in it for `npx prisma migrate dev` / `npx prisma studio` to work without manually prefixing the env var. `.env` is gitignored, same as `.env.local`.
- `npx prisma migrate dev --name <name>` — create and apply a migration after changing `prisma/schema.prisma`.
- `stripe listen --forward-to localhost:3000/api/stripe/webhook` — forwards Stripe events to the local webhook in dev; it prints the `whsec_...` signing secret to put in `STRIPE_WEBHOOK_SECRET`. `stripe trigger checkout.session.completed` / `stripe trigger customer.subscription.deleted` simulate events.
- In production, add the webhook endpoint in the Stripe dashboard (Developers → Webhooks) pointed at `https://<your-domain>/api/stripe/webhook`, subscribed to `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, and put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET` on the host.

## Known limitations / roadmap
- Rate limiting only covers `/api/auth/login`. Add it to `/api/appraise` (even Pro) to cap Anthropic spend — `lib/rateLimit.js` is a starting point but is per-instance/in-memory, so swap it for Redis/Upstash before it needs to hold up across multiple serverless instances.
- Facebook Marketplace has no API; screenshot extraction is the intended path. Do not add scraping.
- Prisma installs the latest major by default (7.x at time of writing), which requires a `prisma.config.ts` for `DATABASE_URL` instead of the classic schema-file `url`. This project pins `prisma`/`@prisma/client` to 6.19.3 deliberately, to stay on the plain-schema pattern and avoid needing TypeScript config in a JS-only project. Don't casually `npm update` past the 6.x line without checking what that migration actually requires.

## Browser extension (`extension/`)
Chrome MV3 extension that adds a "Lowball this" button to listing pages (Facebook Marketplace, Craigslist, eBay, OfferUp, Copart, IAAI).

- Reads only the page the user is actively viewing, on click. No cookie access, no background crawling, no requests to third-party sites on the user's behalf. Do NOT add scraping or session-cookie features — that is a ToS and account-risk line we don't cross.
- Handoff is via URL fragment: `https://lowballer.org/#lb=<base64url json>`. Fragments never reach the server, so no CORS, no cross-site cookies, and metering/Stripe stay first-party in the existing site session.
- `app/page.jsx` decodes the fragment on mount (payload v1), sets mode, prefills fields, clears the hash, shows an import banner.
- Extraction in `extension/content.js` is LAYERED, not selector-based: L1 JSON-LD → L2 OpenGraph meta → L3 embedded JSON field names → L4 semantic DOM (h1/itemprop/data-testid) → L5 visible text. Each field records its source layer and the payload carries a `confidence` score.
- Do NOT add generated CSS class selectors — that's what made v1 fragile. To support a new field or site, add keys to `EMBEDDED_KEYS` and/or a `content_scripts.matches` entry; extraction itself is generic.
- Visible text always ships in `rawText` as the safety net, so a low-confidence read still gives Claude enough to parse. Keep that guarantee.
- Payload is v2; `app/page.jsx` accepts v1 and v2. Bump the version and keep backward compatibility if the shape changes.
