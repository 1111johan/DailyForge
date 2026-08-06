import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import { assertBearerSecret } from "@/lib/security/verify-secret";
import { runWorkerOnce } from "@/lib/workflow/run-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertBearerSecret(request, "WORKER_SECRET");
    const result = await runWorkerOnce();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return routeError(error);
  }
}
