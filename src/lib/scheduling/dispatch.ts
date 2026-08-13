import {
  listGenerationSchedules,
  markScheduleRun,
} from "@/lib/scheduling/repository";
import { classifyWorkflowError } from "@/lib/workflow/errors";
import { createDailyJobs } from "@/lib/workflow/create-job";

export async function dispatchDueSchedules() {
  const now = Date.now();
  const due = (await listGenerationSchedules())
    .filter(
      (schedule) =>
        schedule.is_enabled &&
        schedule.next_run_at &&
        new Date(schedule.next_run_at).getTime() <= now,
    )
    .slice(0, 10);
  const results = [];
  let jobsCreated = 0;
  for (const schedule of due) {
    const scheduledFor = schedule.next_run_at!;
    try {
      const generated = await createDailyJobs({
        count: schedule.post_count,
        productMode: schedule.product_mode,
        scheduledFor,
        idempotencyKey: `schedule:${schedule.id}:${scheduledFor}`,
      });
      await markScheduleRun(schedule, scheduledFor);
      jobsCreated += generated.createdCount;
      results.push({ scheduleId: schedule.id, created: generated.createdCount, status: "populated" as const });
    } catch (error) {
      const classified = classifyWorkflowError(error);
      results.push({ scheduleId: schedule.id, created: 0, status: "retry" as const, error: classified.message });
    }
  }
  return {
    schedulesClaimed: due.length,
    batchesProcessed: results.length,
    jobsCreated,
    results,
  };
}
