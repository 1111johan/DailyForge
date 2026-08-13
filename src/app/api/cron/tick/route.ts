import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import { dispatchDueSchedules } from "@/lib/scheduling/dispatch";
import { assertBearerSecret } from "@/lib/security/verify-secret";
import { runWorkerOnce } from "@/lib/workflow/run-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertBearerSecret(request, "CRON_SECRET");
    const schedules = await dispatchDueSchedules();
    const worker = await runWorkerOnce();
    return NextResponse.json({ ok: true, schedules, worker });
  } catch (error) {
    return routeError(error);
  }
}
