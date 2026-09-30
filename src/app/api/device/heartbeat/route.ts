import { NextResponse } from "next/server";
import {
  authenticateOperatorDevice,
  markDeviceSeen,
} from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";

export async function POST(request: Request) {
  try {
    const device = await authenticateOperatorDevice(request);
    await markDeviceSeen(device);
    return NextResponse.json({
      ok: true,
      data: {
        id: device.id,
        name: device.name,
        worker: device.worker,
        enabled: device.enabled,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
