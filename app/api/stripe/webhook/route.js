import { NextResponse } from "next/server";
import Stripe from "stripe";
import { setSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs"; // the Stripe SDK doesn't run on edge

/** Subscription objects can carry current_period_end at the top level or,
 *  depending on API version, on the first subscription item. Check both. */
function periodEnd(sub) {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function customerEmail(stripe, customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return customer?.deleted ? null : customer?.email || null;
}

/**
 * POST /api/stripe/webhook
 * Stripe is the source of truth for subscription status. Verifies the
 * signature against the RAW body (must not be parsed first), then syncs
 * entitlement into lib/subscriptions.js.
 */
export async function POST(req) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    console.error("Stripe webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }
  const stripe = new Stripe(secretKey);

  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text(); // raw text, NOT req.json() — signature verification needs the exact bytes

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    console.error("Stripe webhook signature verification failed:", e.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Any processing error is logged but still acknowledged with 200 — a bug
  // in our handling shouldn't make Stripe retry the same event forever.
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        let status = "active";
        let currentPeriodEnd = null;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          status = sub.status;
          currentPeriodEnd = periodEnd(sub);
        }
        await setSubscription({
          email: session.customer_details?.email,
          customerId: session.customer,
          subscriptionId: session.subscription,
          status,
          currentPeriodEnd,
        });
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        await setSubscription({
          email: await customerEmail(stripe, sub.customer),
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: sub.status, // active/trialing = entitled, anything else = not
          currentPeriodEnd: periodEnd(sub),
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await setSubscription({
          email: await customerEmail(stripe, sub.customer),
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: "canceled",
          currentPeriodEnd: periodEnd(sub),
        });
        break;
      }

      case "invoice.payment_failed": {
        // Log and mark past_due — do NOT revoke. Stripe retries failed
        // payments automatically; revoking on the first failure punishes
        // subscribers whose card simply expired.
        const invoice = event.data.object;
        const email = await customerEmail(stripe, invoice.customer);
        console.warn(`Stripe: payment failed for ${email || invoice.customer}`);
        await setSubscription({
          email,
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
          status: "past_due",
        });
        break;
      }

      default:
        // Unhandled event type — acknowledge without action. Returning
        // anything but 2xx here makes Stripe retry indefinitely.
        break;
    }
  } catch (e) {
    console.error(`Stripe webhook handler error (${event.type}):`, e);
  }

  return NextResponse.json({ received: true });
}
