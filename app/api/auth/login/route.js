import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { sendMagicLink } from "@/lib/mail";
import { rateLimit, clientKey } from "@/lib/rateLimit";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * POST /api/auth/login  { email }
 * Creates the user if new, mints a single-use 15-minute login token, and
 * emails the sign-in link. Always the same response whether or not the
 * email already has an account, so this can't be used to enumerate users.
 */
export async function POST(req) {
  const rl = rateLimit(`login:${clientKey(req)}`, { max: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", detail: `Too many attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} min.` },
      { status: 429, headers: { "retry-after": String(rl.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const email = String(body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "invalid_email", detail: "That doesn't look like a valid email address." }, { status: 400 });
  }

  try {
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.loginToken.create({
      data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
    });
    const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    await sendMagicLink(email, `${base}/api/auth/callback?token=${token}`);
  } catch (e) {
    console.error("Login error:", e);
    // Fall through to the same success response — don't leak whether this
    // particular email hit a real failure vs. just doesn't have an account.
  }

  return NextResponse.json({ ok: true });
}
