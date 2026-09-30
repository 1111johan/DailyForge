import { NextResponse } from "next/server";
import { z } from "zod";
import { routeError } from "@/lib/http/route-error";
import { assertAdminRequest } from "@/lib/security/admin-session";
import { resetSocialDraft } from "@/lib/social/repository";
import { WorkflowError } from "@/lib/workflow/errors";

const ResetSchema = z.object({
  recordId: z.string().regex(/^rec[A-Za-z0-9]+$/),
  platform: z.enum(["xiaohongshu", "douyin"]),
});

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
    const parsed = ResetSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("重试参数无效", "INVALID_SOCIAL_RESET", false);
    }
    return NextResponse.json({
      ok: true,
      data: await resetSocialDraft(parsed.data.recordId, parsed.data.platform),
    });
  } catch (error) {
    return routeError(error);
  }
}
