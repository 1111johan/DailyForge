import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createDevicePairing,
  listOperatorDevices,
} from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";
import { assertAdminRequest } from "@/lib/security/admin-session";
import { WorkflowError } from "@/lib/workflow/errors";

const CreateDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
    return NextResponse.json({ ok: true, data: await listOperatorDevices() });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
    const parsed = CreateDeviceSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError("请输入设备名称", "INVALID_DEVICE_NAME", false);
    }
    return NextResponse.json({
      ok: true,
      data: await createDevicePairing(parsed.data.name),
    });
  } catch (error) {
    return routeError(error);
  }
}
