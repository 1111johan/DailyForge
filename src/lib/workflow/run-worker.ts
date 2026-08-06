import { randomUUID } from "node:crypto";
import { handleGenerateCopy } from "@/lib/workflow/generate-copy";
import { handleGenerateImage } from "@/lib/workflow/generate-image";
import { handleReview } from "@/lib/workflow/review";
import { handleFeishuSync } from "@/lib/workflow/sync-feishu";
import {
  claimJob,
  recordJobFailure,
} from "@/lib/workflow/repository";
import {
  classifyWorkflowError,
  retryDelayMs,
  WorkflowError,
} from "@/lib/workflow/errors";
import { imageIndexFromStage } from "@/lib/workflow/state-machine";

export async function runWorkerOnce() {
  const workerId = `vercel-${randomUUID()}`;
  const job = await claimJob(workerId);
  if (!job) return { processed: false as const };

  try {
    if (job.stage === "generate_copy") {
      await handleGenerateCopy(job);
    } else if (job.stage.startsWith("generate_image_")) {
      await handleGenerateImage(job, imageIndexFromStage(job.stage)!, false);
    } else if (job.stage.startsWith("poll_image_")) {
      await handleGenerateImage(job, imageIndexFromStage(job.stage)!, true);
    } else if (job.stage === "review_content") {
      await handleReview(job);
    } else if (job.stage === "sync_feishu") {
      await handleFeishuSync(job);
    } else {
      throw new WorkflowError(
        `Unknown job stage: ${job.stage}`,
        "UNKNOWN_JOB_STAGE",
        false,
      );
    }

    return {
      processed: true as const,
      jobId: job.id,
      stage: job.stage,
      status: "advanced" as const,
    };
  } catch (error) {
    const classified = classifyWorkflowError(error);
    const attempt = job.attempts + 1;
    const failure = await recordJobFailure({
      job,
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable,
      nextRunAt: new Date(Date.now() + retryDelayMs(attempt)).toISOString(),
    });
    return {
      processed: true as const,
      jobId: job.id,
      stage: job.stage,
      status: failure.willRetry ? ("retry" as const) : ("failed" as const),
      error: {
        code: classified.code,
        message: classified.message,
        attempts: failure.attempts,
      },
    };
  }
}
