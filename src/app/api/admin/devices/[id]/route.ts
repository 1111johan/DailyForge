import { NextResponse } from "next/server";
import { z } from "zod";
import { updateOperatorDevice } from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";
import { assertAdminRequest } from "@/lib/security/admin-session";
import { WorkflowError } from "@/lib/workflow/errors";

const DeviceUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    worker: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

function recordId(value: string) {
  if (!/^rec[A-Za-z0-9]+$/.test(value)) {
    throw new WorkflowError("设备记录编号无效", "INVALID_DEVICE_ID", false);
  }
  return value;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertAdminRequest(request);
    const { id } = await context.params;
    const parsed = DeviceUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("设备设置无效", "INVALID_DEVICE_UPDATE", false);
    }
    return NextResponse.json({
      ok: true,
      data: await updateOperatorDevice(recordId(id), parsed.data),
    });
  } catch (error) {
    return routeError(error);
  }
}
