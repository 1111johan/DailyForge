import { NextResponse } from "next/server";
import { expiredAdminCookie } from "@/lib/security/admin-session";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", expiredAdminCookie(request));
  return response;
}
