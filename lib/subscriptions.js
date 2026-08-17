import { prisma } from "@/lib/db";

/*
  Phase 2 storage: subscription entitlement lives on the User row itself
  (stripeCustomerId, stripeSubscriptionId, subscriptionStatus,
  currentPeriodEnd), synced by the Stripe webhook. Matches by email; if no
  User exists yet — someone can subscribe before ever signing in — one is
  created so entitlement is ready to claim whenever they do sign in.
*/

export async function setSubscription({ email, customerId, subscriptionId, status, currentPeriodEnd }) {
  if (!email) return;
  const key = email.trim().toLowerCase();
  const periodEnd = currentPeriodEnd ? new Date(currentPeriodEnd) : undefined;
  await prisma.user.upsert({
    where: { email: key },
    update: {
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus: status ?? undefined,
      currentPeriodEnd: periodEnd,
    },
    create: {
      email: key,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subscriptionId ?? null,
      subscriptionStatus: status ?? null,
      currentPeriodEnd: periodEnd ?? null,
    },
  });
}

export async function getSubscriptionByEmail(email) {
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null;
  return {
    email: user.email,
    customerId: user.stripeCustomerId,
    subscriptionId: user.stripeSubscriptionId,
    status: user.subscriptionStatus,
    currentPeriodEnd: user.currentPeriodEnd,
  };
}

export async function isEntitled(email) {
  const sub = await getSubscriptionByEmail(email);
  return sub?.status === "active" || sub?.status === "trialing";
}
