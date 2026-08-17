import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { createSessionCookieValue, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * GET /api/auth/callback?token=...
 * Verifies the login token, marks it used (atomically, so a link clicked
 * twice only ever succeeds once), creates a session, and redirects home.
 */
export async function GET(req) {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.redirect(`${base}/?auth=invalid`);

  const tokenHash = hashToken(token);
  const loginToken = await prisma.loginToken.findUnique({ where: { tokenHash } });
  if (!loginToken || loginToken.expiresAt < new Date()) {
    return NextResponse.redirect(`${base}/?auth=invalid`);
  }

  // Atomic claim: only succeeds if usedAt is still null, so concurrent or
  // repeated requests with the same token can't both pass.
  const claimed = await prisma.loginToken.updateMany({
    where: { id: loginToken.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return NextResponse.redirect(`${base}/?auth=invalid`);

  const cookieValue = await createSessionCookieValue(loginToken.userId);
  const res = NextResponse.redirect(`${base}/?auth=ok`);
  res.cookies.set(SESSION_COOKIE, cookieValue, sessionCookieOptions());
  return res;
}
