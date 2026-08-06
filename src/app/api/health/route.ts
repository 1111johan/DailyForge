import { NextResponse } from "next/server";
import { getConfigurationStatus } from "@/lib/config/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "dailyforge-lite",
    time: new Date().toISOString(),
    configuration: getConfigurationStatus(),
  });
}
