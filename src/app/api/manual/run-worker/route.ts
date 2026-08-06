import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import { runWorkerOnce } from "@/lib/workflow/run-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await runWorkerOnce()) });
  } catch (error) {
    return routeError(error);
  }
}
