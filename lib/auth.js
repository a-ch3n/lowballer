import { cookies } from "next/headers";
import { sign, verify } from "@/lib/sign";
import { prisma } from "@/lib/db";

export const SESSION_COOKIE = "lb_sess";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

export async function createSessionCookieValue(userId) {
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + SESSION_MAX_AGE * 1000) },
  });
  return sign(session.id);
}

/** Reads the signed session cookie, loads the session + user, returns null
 *  if there's no cookie, the signature is bad, or the session has expired. */
export async function getCurrentUser() {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  const sessionId = verify(raw);
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
