import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { readAccount, FREE_LIMIT } from "@/lib/sign";

export const runtime = "nodejs";

/** GET /api/usage -> { remaining, pro } */
export async function GET() {
  const { uses, pro } = readAccount(cookies());
  return NextResponse.json({
    remaining: pro ? null : Math.max(0, FREE_LIMIT - uses),
    pro,
    freeLimit: FREE_LIMIT,
  });
}
