import { NextResponse } from "next/server";
import { routeError } from "@/lib/http/route-error";
import {
  deleteGenerationSchedule,
  updateGenerationSchedule,
} from "@/lib/scheduling/repository";
import { SchedulePatchSchema } from "@/lib/scheduling/schedule-schema";
import { WorkflowError } from "@/lib/workflow/errors";

type ScheduleRouteContext = { params: Promise<{ id: string }> };

function scheduleId(value: string) {
  if (!/^rec[A-Za-z0-9]+$/.test(value)) {
    throw new WorkflowError("Invalid schedule id", "INVALID_SCHEDULE_ID", false);
  }
  return value;
}

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: ScheduleRouteContext,
) {
  try {
    const { id } = await context.params;
    const parsed = SchedulePatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new WorkflowError(
        parsed.error.issues.map((issue) => issue.message).join("; "),
        "INVALID_SCHEDULE",
        false,
      );
    }
    return NextResponse.json({
      ok: true,
      data: await updateGenerationSchedule(scheduleId(id), parsed.data),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: ScheduleRouteContext,
) {
  try {
    const { id } = await context.params;
    await deleteGenerationSchedule(scheduleId(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError(error);
  }
}
