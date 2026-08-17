import crypto from "crypto";

const secret = () => process.env.APP_SECRET || "dev-secret-change-me";

/** Sign a payload string -> "payload.signature" */
export function sign(payload) {
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Verify "payload.signature" -> payload string or null */
export function verify(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("hex");
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return payload;
  } catch {}
  return null;
}

export const FREE_LIMIT = 3;
