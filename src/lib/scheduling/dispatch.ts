import {
  claimDueGenerationBatches,
  listPendingGenerationBatches,
  updateGenerationBatch,
} from "@/lib/scheduling/repository";
import type { GenerationBatch } from "@/lib/types/domain";
import { classifyWorkflowError } from "@/lib/workflow/errors";
import { populateGenerationBatch } from "@/lib/workflow/create-job";

export async function dispatchDueSchedules() {
  const [pending, claimed] = await Promise.all([
    listPendingGenerationBatches(),
    claimDueGenerationBatches(),
  ]);
  const unique = new Map<string, GenerationBatch>();
  for (const batch of [...pending, ...claimed]) unique.set(batch.id, batch);

  const results = await Promise.all(
    [...unique.values()].map(async (batch) => {
      try {
        const result = await populateGenerationBatch(batch);
        return {
          batchId: batch.id,
          created: result.created,
          jobs: result.jobs.length,
          status: "populated" as const,
        };
      } catch (error) {
        const classified = classifyWorkflowError(error);
        const attempts = batch.attempts + 1;
        const failed = !classified.retryable || attempts >= 3;
        await updateGenerationBatch(batch.id, {
          attempts,
          status: failed ? "failed" : "pending",
          error_message: classified.message.slice(0, 4000),
        });
        return {
          batchId: batch.id,
          created: false,
          jobs: 0,
          status: failed ? ("failed" as const) : ("retry" as const),
          error: classified.message,
        };
      }
    }),
  );

  return {
    schedulesClaimed: claimed.length,
    batchesProcessed: results.length,
    jobsCreated: results.reduce((total, result) => total + result.jobs, 0),
    results,
  };
}
