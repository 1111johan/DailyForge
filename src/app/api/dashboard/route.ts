import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/lib/dashboard/data";
import { routeError } from "@/lib/http/route-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await getDashboardSnapshot() });
  } catch (error) {
    return routeError(error);
  }
}
