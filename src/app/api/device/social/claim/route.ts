import { NextResponse } from "next/server";
import {
  authenticateOperatorDevice,
  markDeviceSeen,
} from "@/lib/devices/repository";
import { routeError } from "@/lib/http/route-error";
import { claimSocialDraft } from "@/lib/social/repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const device = await authenticateOperatorDevice(request);
    const candidate = await claimSocialDraft(device);
    await markDeviceSeen(device);
    return NextResponse.json({ ok: true, data: candidate });
  } catch (error) {
    return routeError(error);
  }
}
