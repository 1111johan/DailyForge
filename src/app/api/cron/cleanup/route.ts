import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import { cleanupArchivedContent } from "@/lib/maintenance/cleanup";
import { assertBearerSecret } from "@/lib/security/verify-secret";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    assertBearerSecret(request, "CRON_SECRET");
    return NextResponse.json({ ok: true, ...(await cleanupArchivedContent()) });
  } catch (error) {
    return routeError(error);
  }
}
