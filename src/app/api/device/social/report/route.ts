import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateOperatorDevice,
  markDeviceSeen,
} from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";
import { reportSocialDraft } from "@/lib/social/repository";
import { WorkflowError } from "@/lib/workflow/errors";

const ReportSchema = z.object({
  recordId: z.string().regex(/^rec[A-Za-z0-9]+$/),
  results: z
    .array(
      z.object({
        platform: z.enum(["xiaohongshu", "douyin"]),
        status: z.enum(["draft_ready", "needs_attention"]),
        error: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(2),
});

export async function POST(request: Request) {
  try {
    const device = await authenticateOperatorDevice(request);
    const parsed = ReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("草稿结果格式无效", "INVALID_SOCIAL_REPORT", false);
    }
    const state = await reportSocialDraft(device, parsed.data);
    await markDeviceSeen(
      device,
      parsed.data.results.find((result) => result.error)?.error,
    );
    return NextResponse.json({ ok: true, data: state });
  } catch (error) {
    return routeError(error);
  }
}
