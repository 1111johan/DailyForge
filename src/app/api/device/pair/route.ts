import { NextResponse } from "next/server";
import { z } from "zod";
import { pairOperatorDevice } from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";
import { WorkflowError } from "@/lib/workflow/errors";

const PairSchema = z.object({
  code: z.string().trim().min(8).max(32),
  name: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = PairSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("连接码格式无效", "INVALID_PAIRING_CODE", false);
    }
    return NextResponse.json({
      ok: true,
      data: await pairOperatorDevice(parsed.data.code, parsed.data.name),
    });
  } catch (error) {
    return routeError(error);
  }
}
