import { NextResponse } from "next/server";
import { assertAdminRequest } from "@/lib/security/admin-session";
import { routeError } from "@/lib/http/route-error";

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
    return NextResponse.json({ ok: true, authenticated: true });
  } catch (error) {
    return routeError(error);
  }
}
