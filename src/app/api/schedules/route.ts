import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import {
  createGenerationSchedule,
  listGenerationSchedules,
} from "@/lib/scheduling/repository";
import { ScheduleInputSchema } from "@/lib/scheduling/schedule-schema";
import { WorkflowError } from "@/lib/workflow/errors";
import { assertAdminRequest } from "@/lib/security/admin-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
    return NextResponse.json({
      ok: true,
      data: await listGenerationSchedules(),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
    const parsed = ScheduleInputSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
        "INVALID_SCHEDULE",
        false,
      );
    }
    return NextResponse.json({
      ok: true,
      data: await createGenerationSchedule(parsed.data),
    });
  } catch (error) {
    return routeError(error);
  }
}
