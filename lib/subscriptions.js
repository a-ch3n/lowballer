import fs from "fs/promises";
import path from "path";

/*
  Phase 1 storage for subscription entitlement, backed by a JSON file.

  TODO(Phase 2): swap this implementation for Prisma calls against the
  `User` table (stripeCustomerId, stripeSubscriptionId, subscriptionStatus,
  currentPeriodEnd) — keep these same three exports so nothing else changes.

  Note: like the rest of the filesystem on Vercel, this file does NOT
  persist across deploys/instances. Fine for local dev and short-lived
  testing of the webhook; Phase 2's database is the real fix.
*/

const STORE_PATH = path.join(process.cwd(), "data", "subscriptions.json");

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

export async function setSubscription({ email, customerId, subscriptionId, status, currentPeriodEnd }) {
  if (!email) return;
  const key = email.trim().toLowerCase();
  const store = await readStore();
  store[key] = {
    email: key,
    customerId: customerId ?? store[key]?.customerId ?? null,
    subscriptionId: subscriptionId ?? store[key]?.subscriptionId ?? null,
    status: status ?? store[key]?.status ?? null,
    currentPeriodEnd: currentPeriodEnd ?? store[key]?.currentPeriodEnd ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
}

export async function getSubscriptionByEmail(email) {
  if (!email) return null;
  const store = await readStore();
  return store[email.trim().toLowerCase()] || null;
}

export async function isEntitled(email) {
  const sub = await getSubscriptionByEmail(email);
  return sub?.status === "active" || sub?.status === "trialing";
}
