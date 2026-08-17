# Build spec: accounts, database, and Stripe webhook

This is a work order for Claude Code. Do the phases in order — Phase 1 is small and independently shippable; Phase 2 depends on it.

Read `CLAUDE.md` first for architecture and conventions. Run `npm run build` after each phase and don't move on until it passes.

---

## Why this work exists

Today, usage and Pro status live entirely in signed cookies. Two consequences:

1. **A paying subscriber who clears cookies, opens incognito, or switches to their phone loses the access they paid for.** This is the expensive bug — it produces refund requests and churn.
2. **A cancelled subscriber keeps Pro for up to a year**, because nothing ever revokes the cookie.

Both are fixed by moving identity and entitlement to a database, and by listening to Stripe for subscription lifecycle events.

---

## Phase 1 — Stripe webhook

**Status: done.** `app/api/stripe/webhook/route.js` verifies the raw-body signature, runs on the Node runtime, always acknowledges with 200 except on a bad signature (400), and syncs `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.payment_failed` into `lib/subscriptions.js` (JSON-file-backed, `setSubscription` / `getSubscriptionByEmail` / `isEntitled`, with a TODO marking the Phase 2 swap point). `app/api/checkout/route.js` accepts an optional `{ email }` body and sets `metadata: { source: "lowballer_web" }`.

**Not done yet, by design:** nothing in the request-serving path reads `isEntitled()`. `/api/appraise` and `/api/usage` still gate on the `lb_uses`/`lb_pro` cookies, exactly as before. Wiring real entitlement into those routes needs a real account to key it on — that's Phase 2. Shipping Phase 1 alone gets subscription state flowing and recorded, without changing today's user-facing behavior.

Acceptance criteria (verified before Phase 2 starts):
- `stripe listen --forward-to localhost:3000/api/stripe/webhook` shows events arriving and returning 200
- `stripe trigger checkout.session.completed` records a subscription in `data/subscriptions.json`
- `stripe trigger customer.subscription.deleted` flips its status to `canceled`
- A request with a bad signature returns 400
- `npm run build` passes

---

## Phase 2 — Accounts and database

**Goal:** identity and entitlement live server-side, keyed to an email-verified account, so both work across devices and survive cookie clearing.

### 2.1 Stack

Use **Postgres + Prisma**. Neon or Vercel Postgres both work; the connection string is the only difference.

Auth: **magic link** (emailed sign-in link). No passwords — fewer failure modes, no password reset flow. Send with **Resend** (`RESEND_API_KEY`). In development, when no key is set, log the magic link to the console instead of sending.

Do not add NextAuth. The session needs are small and `lib/sign.js` already does signed cookies correctly; adding a framework here costs more than it saves.

### 2.2 Schema

```prisma
model User {
  id                 String   @id @default(cuid())
  email              String   @unique
  createdAt          DateTime @default(now())

  // Entitlement — mirrored from Stripe, never set by client code
  stripeCustomerId     String?  @unique
  stripeSubscriptionId String?
  subscriptionStatus   String?  // active | trialing | past_due | canceled | null
  currentPeriodEnd     DateTime?

  freeUsesConsumed   Int      @default(0)

  sessions           Session[]
  loginTokens        LoginToken[]
  appraisals         Appraisal[]
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
  @@index([userId])
}

model LoginToken {
  id        String   @id @default(cuid())
  tokenHash String   @unique   // store a hash, never the raw token
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime            // 15 minutes
  usedAt    DateTime?           // single use
  createdAt DateTime @default(now())
}

model Appraisal {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  mode      String   // car | item | salvage
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
}
```

`Appraisal` gives real usage analytics and a durable count instead of a cookie integer.

### 2.3 Routes to build

| Route | Purpose |
|---|---|
| `POST /api/auth/login` | `{ email }` → create user if new, mint LoginToken, email the link. Always return the same success response whether or not the email exists (don't leak which addresses have accounts). Rate limit it — this repo has no rate-limiting module yet, so add a small one (in-memory sliding window keyed by IP is enough to start) rather than assuming one exists. |
| `GET /api/auth/callback?token=` | Verify hash, check expiry and `usedAt`, mark used, create Session, set signed `lb_sess` cookie (30 days), redirect to `/`. |
| `POST /api/auth/logout` | Delete session, clear cookie. |
| `GET /api/me` | Replaces `/api/usage`. Returns `{ email, pro, remaining, freeLimit, configured }`. |

Add `lib/auth.js` with `getCurrentUser()` that reads the signed session cookie, loads the session and user, and returns null if expired.

### 2.4 Rewire existing code

- `app/api/appraise/route.js` — replace `readAccount(cookies())` with `getCurrentUser()`. Entitlement = `subscriptionStatus` is `active` or `trialing`. Free limit = `freeUsesConsumed < FREE_LIMIT`. On a successful metered call, create an `Appraisal` row and increment `freeUsesConsumed` for non-subscribers, **in a transaction**.
- `lib/subscriptions.js` — reimplement the same three functions against Prisma. Match the Stripe customer to a `User` by email; if no user exists yet, create one (someone can subscribe before signing in).
- `app/api/checkout/verify/route.js` — keep it as a fast-path UI update, but the webhook remains the source of truth. Do not let this route grant entitlement on its own.
- Delete the `lb_uses` and `lb_pro` cookie logic from `lib/sign.js` once nothing reads it. Keep `sign`/`verify` — the session cookie uses them.
- `app/page.jsx` — add a sign-in modal ("we'll email you a link"), a signed-in state to the nav (email + sign out), and handle a 401 from `/api/appraise` by opening the sign-in modal.

### 2.5 Migration

Existing users have `lb_uses`/`lb_pro` cookies but no email on file anywhere and no account — there's no identifier to reconcile against, so there's nothing to migrate. On first `/api/me` call with no session, just show them signed out. Their free-use count resets once when they eventually sign in, which is acceptable and affects a small number of people.

### 2.6 Env vars to add

```
DATABASE_URL=postgres://...
RESEND_API_KEY=re_...            # optional in dev; links log to console without it
EMAIL_FROM=Lowballer <hello@lowballer.org>
```

### 2.7 Acceptance criteria

- Sign in on Chrome, then open the site in Firefox and sign in with the same email → same account, same remaining count
- Subscribe → Pro shows in both browsers
- Cancel via Stripe customer portal → webhook fires → Pro revoked in both browsers within seconds
- Clear all cookies → sign in again → Pro still active, free-use count unchanged
- A magic link used twice fails the second time
- An expired magic link (>15 min) fails
- `npm run build` passes and `npx prisma migrate dev` runs clean

---

## Constraints that apply to both phases

- Never trust the client for entitlement. Pro status comes from the database, which comes from Stripe.
- Keep `ANTHROPIC_API_KEY` server-side only.
- Keep the deal math (offer percentages, Copart fee tiers, rebuilt-title discounts) as deterministic JavaScript in `app/page.jsx`. Do not move it into a model prompt.
- Don't add scraping or session-cookie access for third-party sites. The browser extension reads only the page the user is actively viewing; that boundary stays.
- Update `CLAUDE.md` and `README.md` as you go, including the new env vars and the webhook setup step.

---

## Suggested commit sequence

1. ~~`feat: stripe webhook for subscription lifecycle`~~ — done
2. `feat: prisma schema and database client`
3. `feat: magic link authentication`
4. `refactor: move usage metering from cookies to database`
5. `feat: sign-in UI and account state in nav`
6. `docs: update CLAUDE.md and README for accounts`
