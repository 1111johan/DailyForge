import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  ContentJob,
  ContentTopic,
  GeneratedAsset,
  GeneratedPost,
  JobStage,
  Product,
} from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import type { AiCallObservation } from "@/lib/ai/types";

function databaseError(message: string, error: { message: string; code?: string }) {
  const permanentCodes = new Set([
    "22P02",
    "23503",
    "23505",
    "23514",
    "PGRST116",
    "PGRST204",
  ]);
  return new WorkflowError(
    `${message}: ${error.message}`,
    `DATABASE_${error.code || "ERROR"}`,
    !error.code || !permanentCodes.has(error.code),
    { cause: error instanceof Error ? error : undefined },
  );
}

export async function claimJob(workerId: string): Promise<ContentJob | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_content_job", {
    p_worker_id: workerId,
    p_stale_after: "00:06:00",
    p_image_concurrency: 2,
  });
  if (error) throw databaseError("Failed to claim job", error);
  const rows = (data || []) as ContentJob[];
  return rows[0] || null;
}

export async function advanceJob(
  jobId: string,
  stage: JobStage,
  payload?: Record<string, unknown>,
) {
  const supabase = createSupabaseAdmin();
  const update: Record<string, unknown> = {
    status: stage === "completed" ? "completed" : "queued",
    stage,
    attempts: 0,
    run_after: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    error_code: null,
    error_message: null,
  };
  if (payload) update.payload = payload;
  if (stage === "completed") update.finished_at = new Date().toISOString();

  const { error } = await supabase.from("content_jobs").update(update).eq("id", jobId);
  if (error) throw databaseError("Failed to advance job", error);
}

export async function deferJob(jobId: string, stage: JobStage, delayMs: number) {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("content_jobs")
    .update({
      status: "queued",
      stage,
      run_after: new Date(Date.now() + delayMs).toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq("id", jobId);
  if (error) throw databaseError("Failed to defer job", error);
}

export async function recordJobFailure(input: {
  job: ContentJob;
  code: string;
  message: string;
  retryable: boolean;
  nextRunAt?: string;
}) {
  const attempts = input.job.attempts + 1;
  const willRetry = input.retryable && attempts <= input.job.max_attempts;
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("content_jobs")
    .update({
      status: willRetry ? "retry" : "failed",
      attempts,
      run_after: input.nextRunAt || new Date().toISOString(),
      error_code: input.code,
      error_message: input.message.slice(0, 4000),
      locked_at: null,
      locked_by: null,
      finished_at: willRetry ? null : new Date().toISOString(),
    })
    .eq("id", input.job.id);
  if (error) throw databaseError("Failed to record job failure", error);
  return { willRetry, attempts };
}

export async function getJobContext(job: ContentJob) {
  const supabase = createSupabaseAdmin();
  const [productResult, topicResult] = await Promise.all([
    supabase.from("products").select("*").eq("id", job.product_id).single(),
    job.topic_id
      ? supabase.from("content_topics").select("*").eq("id", job.topic_id).single()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (productResult.error || !productResult.data) {
    throw databaseError(
      "Product is missing",
      productResult.error || { message: "No product data", code: "PGRST116" },
    );
  }
  if (topicResult.error || !topicResult.data) {
    throw databaseError(
      "Topic is missing",
      topicResult.error || { message: "No topic data", code: "PGRST116" },
    );
  }

  return {
    product: productResult.data as Product,
    topic: topicResult.data as ContentTopic,
  };
}

export async function getRecentTopics(productId: string, beforeDate: string) {
  const supabase = createSupabaseAdmin();
  const since = new Date(`${beforeDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 30);
  const { data, error } = await supabase
    .from("content_jobs")
    .select("topic_id, content_topics(topic)")
    .eq("product_id", productId)
    .gte("job_date", since.toISOString().slice(0, 10))
    .lt("job_date", beforeDate)
    .in("status", ["running", "queued", "retry", "completed"])
    .order("job_date", { ascending: false });
  if (error) throw databaseError("Failed to load recent topics", error);

  return (data || [])
    .map((row) => {
      const relation = row.content_topics as unknown;
      if (Array.isArray(relation)) return relation[0]?.topic;
      return (relation as { topic?: string } | null)?.topic;
    })
    .filter((topic): topic is string => typeof topic === "string");
}

export async function getPostByJob(jobId: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generated_posts")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw databaseError("Failed to load generated post", error);
  return (data as GeneratedPost | null) || null;
}

export async function insertPost(input: Omit<GeneratedPost, "id" | "created_at" | "updated_at" | "review_status" | "review_notes" | "publish_status" | "feishu_record_id">) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generated_posts")
    .insert(input)
    .select("*")
    .single();
  if (error) throw databaseError("Failed to save generated post", error);
  return data as GeneratedPost;
}

export async function ensureAssets(
  postId: string,
  assets: Array<{
    asset_index: number;
    asset_type: "cover" | "content";
    prompt: string;
  }>,
) {
  const supabase = createSupabaseAdmin();
  const rows = assets.map((asset) => ({ post_id: postId, ...asset }));
  const { error } = await supabase
    .from("generated_assets")
    .upsert(rows, { onConflict: "post_id,asset_index", ignoreDuplicates: true });
  if (error) throw databaseError("Failed to prepare generated assets", error);
}

export async function getAsset(postId: string, assetIndex: number) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generated_assets")
    .select("*")
    .eq("post_id", postId)
    .eq("asset_index", assetIndex)
    .maybeSingle();
  if (error) throw databaseError("Failed to load generated asset", error);
  return (data as GeneratedAsset | null) || null;
}

export async function getAssets(postId: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("generated_assets")
    .select("*")
    .eq("post_id", postId)
    .order("asset_index");
  if (error) throw databaseError("Failed to load generated assets", error);
  return (data || []) as GeneratedAsset[];
}

export async function updateAsset(
  assetId: string,
  update: Partial<GeneratedAsset>,
) {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("generated_assets")
    .update(update)
    .eq("id", assetId);
  if (error) throw databaseError("Failed to update generated asset", error);
}

export async function updatePost(postId: string, update: Partial<GeneratedPost>) {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("generated_posts")
    .update(update)
    .eq("id", postId);
  if (error) throw databaseError("Failed to update generated post", error);
}

export async function markTopicUsed(topicId: string) {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("content_topics")
    .update({ used_at: new Date().toISOString() })
    .eq("id", topicId);
  if (error) throw databaseError("Failed to mark topic used", error);
}

export function modelLogObserver(jobId: string, postId?: string) {
  return async (observation: AiCallObservation) => {
    const supabase = createSupabaseAdmin();
    await supabase.from("model_call_logs").insert({
      job_id: jobId,
      post_id: postId || null,
      call_type: observation.callType,
      provider: observation.provider,
      model: observation.model,
      request_id: observation.requestId || null,
      input_tokens: observation.inputTokens || null,
      output_tokens: observation.outputTokens || null,
      latency_ms: observation.latencyMs,
      status: observation.status,
      error_message: observation.errorMessage || null,
    });
  };
}
