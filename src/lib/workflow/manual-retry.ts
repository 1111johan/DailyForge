import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { ContentJob } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";

export async function retryFailedJob(jobId: string) {
  const supabase = createSupabaseAdmin();
  const { data: job, error: readError } = await supabase
    .from("content_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (readError) {
    throw new WorkflowError(
      `Failed to load job: ${readError.message}`,
      "JOB_QUERY_FAILED",
      true,
    );
  }
  if (!job) {
    throw new WorkflowError("Job was not found", "JOB_NOT_FOUND", false);
  }
  const typedJob = job as ContentJob;
  if (!['failed', 'retry'].includes(typedJob.status)) {
    throw new WorkflowError(
      `Job in status ${typedJob.status} cannot be retried manually`,
      "JOB_NOT_RETRYABLE",
      false,
    );
  }
  const { data, error } = await supabase
    .from("content_jobs")
    .update({
      status: "queued",
      attempts: 0,
      run_after: new Date().toISOString(),
      error_code: null,
      error_message: null,
      finished_at: null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", jobId)
    .select("*")
    .single();
  if (error) {
    throw new WorkflowError(
      `Failed to retry job: ${error.message}`,
      "JOB_RETRY_FAILED",
      true,
    );
  }
  return data as ContentJob;
}
