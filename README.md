# Lowballer.org

Know your number before you make the offer. Screenshot any Facebook Marketplace listing or Copart lot — Lowballer pulls live comps, prices the repairs, and hands you the exact lowball offer or max bid to make.

Three modes: **Car** (market value − repairs = your offer) · **Any item** (eBay sold comps → flip profit) · **Copart/Salvage** (rebuild cost → your max bid).

## Quick start

1. **Install** (Node.js 18+):
   ```bash
   npm install
   ```
2. **Configure** — copy the env template and fill in your keys:
   ```bash
   cp .env.example .env.local
   ```
   - `ANTHROPIC_API_KEY` — from https://console.anthropic.com (powers all appraisals)
   - `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID` — create a recurring **$30/month** price in https://dashboard.stripe.com, use test keys first
   - `APP_SECRET` — any long random string (`openssl rand -hex 32`)
3. **Run**:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. You get 3 free appraisals; the 4th prompts Stripe checkout (use Stripe test card `4242 4242 4242 4242` in test mode).

## Deploy

Easiest path is Vercel: push this repo to GitHub, import it at https://vercel.com, add the four env vars (set `NEXT_PUBLIC_BASE_URL` to your live URL), deploy, then point the lowballer.org domain at it. Switch Stripe to live keys when ready.

## Working on this with Claude Code

This repo ships with a `CLAUDE.md` so Claude Code understands the architecture immediately.

```bash
npm install -g @anthropic-ai/claude-code
cd lowballer
claude
```

Then just describe what you want: "add a Stripe webhook for cancellations", "add a history page of past appraisals", "make the hero animate on load". Docs: https://docs.claude.com/en/docs/claude-code/overview

## Before real customers (in rough order)

1. Stripe webhook (`customer.subscription.deleted`) so cancellations actually revoke Pro
2. Accounts + database so usage/Pro survive cookie clears and work across devices
3. Rate limit `/api/appraise` to cap your Anthropic API spend
4. Terms of service + "estimates only" disclaimer page

## How it works

- The browser never sees your Anthropic key — all AI calls go through `app/api/appraise`, which calls Claude (`claude-sonnet-4-6`) with the web search tool and returns parsed JSON.
- Free usage is metered server-side with HMAC-signed cookies; Pro is granted after verifying the Stripe Checkout session.
- Listing screenshots are read by Claude vision (base64 images in the message content) — that's how Facebook Marketplace listings work despite having no API.
# lowballer
# lowballer
