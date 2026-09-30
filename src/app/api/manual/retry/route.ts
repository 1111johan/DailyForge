import { NextResponse } from "next/server";
import { z } from "zod";
import { routeError } from "@/lib/http/route-error";
import { WorkflowError } from "@/lib/workflow/errors";
import { retryFailedJob } from "@/lib/workflow/manual-retry";
import { assertAdminRequest } from "@/lib/security/admin-session";

const RetrySchema = z.object({ jobId: z.string().trim().min(1).max(200) });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
    const parsed = RetrySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("Invalid job id", "INVALID_REQUEST", false);
    }
    return NextResponse.json({
      ok: true,
      job: await retryFailedJob(parsed.data.jobId),
    });
  } catch (error) {
    return routeError(error);
  }
}
