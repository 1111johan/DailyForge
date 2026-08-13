import { retryStoredJob } from "@/lib/workflow/repository";

export function retryFailedJob(jobId: string) {
  return retryStoredJob(jobId);
}
