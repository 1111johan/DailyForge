import type { ContentJob, JobStage } from "@/lib/types/domain";

export const PIPELINE_STAGES: JobStage[] = [
  "generate_copy",
  "generate_image_1",
  "generate_image_2",
  "generate_image_3",
  "generate_image_4",
  "review_content",
  "sync_feishu",
  "completed",
];

export function imageIndexFromStage(stage: JobStage) {
  const match = stage.match(/^(?:generate|poll)_image_([1-4])$/);
  return match ? Number(match[1]) : null;
}

export function nextStageAfterImage(index: number): JobStage {
  if (index >= 1 && index < 4) {
    return `generate_image_${(index + 1) as 2 | 3 | 4}`;
  }
  return "review_content";
}

export function progressForJob(job: Pick<ContentJob, "stage" | "status">) {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return 0;

  const normalized = job.stage.startsWith("poll_image_")
    ? job.stage.replace("poll_", "generate_")
    : job.stage;
  const index = PIPELINE_STAGES.indexOf(normalized as JobStage);
  return index < 0
    ? 0
    : Math.round((index / (PIPELINE_STAGES.length - 1)) * 100);
}
