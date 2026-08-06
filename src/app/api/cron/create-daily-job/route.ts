import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import { assertBearerSecret } from "@/lib/security/verify-secret";
import { createDailyJobs } from "@/lib/workflow/create-job";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    assertBearerSecret(request, "CRON_SECRET");
    const result = await createDailyJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return routeError(error);
  }
}
