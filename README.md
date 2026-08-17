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
   - `STRIPE_WEBHOOK_SECRET` — see **Stripe webhook (dev)** below
   - `APP_SECRET` — any long random string (`openssl rand -hex 32`)
   - `DATABASE_URL` — a Postgres connection string (Neon, Railway, or Vercel Postgres free tiers all work). Also copy it into a plain `.env` file (Prisma CLI's convention, separate from Next's `.env.local`) so `npx prisma migrate dev` works without manually passing it.
   - `RESEND_API_KEY` + `EMAIL_FROM` — optional in dev. Without a key, magic-sign-in links print to the server console instead of emailing, so local sign-in still works.
3. **Set up the database**:
   ```bash
   npx prisma migrate dev --name init
   ```
4. **Run**:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. Sign in with any email (a link prints to the console in dev). You get 3 free appraisals; the 4th prompts Stripe checkout (use Stripe test card `4242 4242 4242 4242` in test mode).

## Stripe webhook (dev)

Subscription status (new subscriptions, cancellations, failed payments) is synced by `app/api/stripe/webhook/route.js`. To exercise it locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

This prints a `whsec_...` value — put it in `STRIPE_WEBHOOK_SECRET`. Then, in another terminal:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

In production, add the endpoint in the Stripe dashboard (Developers → Webhooks) pointed at `https://<your-domain>/api/stripe/webhook`, subscribed to `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed` — then put that endpoint's own signing secret in `STRIPE_WEBHOOK_SECRET` on the host.

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

1. ~~Stripe webhook so cancellations actually revoke Pro~~ — done (`app/api/stripe/webhook/route.js`)
2. ~~Accounts + database so usage/Pro survive cookie clears and work across devices~~ — done (magic-link sign-in, Postgres/Prisma, see `BUILD_SPEC.md` Phase 2)
3. Rate limit `/api/appraise` to cap your Anthropic API spend — `lib/rateLimit.js` currently only guards `/api/auth/login`
4. Terms of service + "estimates only" disclaimer page

## How it works

- The browser never sees your Anthropic key — all AI calls go through `app/api/appraise`, which calls Claude (`claude-sonnet-4-6`) with the web search tool and returns parsed JSON.
- Sign-in is a magic link (no password) — free-use count and Pro status live on your account in Postgres, not a cookie, so they follow you across browsers and survive clearing cookies.
- Pro is granted by the Stripe webhook (`app/api/stripe/webhook/route.js`) syncing subscription status onto your account; `app/api/checkout/verify` is just a fast-path UI nudge, not the real source of truth.
- Listing screenshots are read by Claude vision (base64 images in the message content) — that's how Facebook Marketplace listings work despite having no API.
