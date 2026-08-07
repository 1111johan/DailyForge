import { NextResponse } from "next/server";
import { z } from "zod";
import { routeError } from "@/lib/http/route-error";
import { createDailyJobs } from "@/lib/workflow/create-job";
import { WorkflowError } from "@/lib/workflow/errors";

const ManualGenerateSchema = z
  .object({
    jobDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    productId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
    customPrompt: z.string().trim().max(5000).optional(),
    imagePrompt: z.string().trim().max(5000).optional(),
  })
  .refine((value) => !value.topicId || value.productId, {
    message: "productId is required when topicId is provided",
  });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const parsed = ManualGenerateSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
        "INVALID_REQUEST",
        false,
      );
    }
    const result = await createDailyJobs(parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return routeError(error);
  }
}
