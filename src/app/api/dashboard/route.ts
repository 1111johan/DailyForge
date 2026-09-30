import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/lib/dashboard/data";
import { routeError } from "@/lib/http/route-error";
import { assertAdminRequest } from "@/lib/security/admin-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
    return NextResponse.json({ ok: true, data: await getDashboardSnapshot() });
  } catch (error) {
    return routeError(error);
  }
}
