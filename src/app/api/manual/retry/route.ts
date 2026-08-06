import { NextResponse } from "next/server";
import { z } from "zod";
import { routeError } from "@/lib/http/route-error";
import { WorkflowError } from "@/lib/workflow/errors";
import { retryFailedJob } from "@/lib/workflow/manual-retry";

const RetrySchema = z.object({ jobId: z.string().uuid() });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
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
