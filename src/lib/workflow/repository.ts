import { getFeishuConfig } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  findFeishuRecordByField,
  getFeishuRecord,
  searchFeishuRecords,
  updateFeishuRecord,
} from "@/lib/feishu/bitable";
import {
  parseContentState,
  stateFields,
  type StoredContentState,
} from "@/lib/feishu/content-state";
import { productById, topicById } from "@/lib/catalog";
import type {
  ContentJob,
  GeneratedAsset,
  GeneratedPost,
  JobStage,
} from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";

const STALE_LOCK_MS = 6 * 60_000;

function nowIso() {
  return new Date().toISOString();
}

async function allStoredStates(limit = 500) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const records = await searchFeishuRecords(token, config.tableId, {
    filter: {
      conjunction: "or",
      conditions: ["queued", "running", "retry", "completed", "failed"].map(
        (status) => ({
          field_name: "\u7cfb\u7edf\u72b6\u6001",
          operator: "is",
          value: [status],
        }),
      ),
    },
    sort: [{ field_name: "\u751f\u6210\u65e5\u671f", desc: true }],
    pageSize: 500,
    maxRecords: limit,
  });
  return records
    .map(parseContentState)
    .filter((state): state is StoredContentState => state !== null);
}

export async function listStoredContentStates(limit = 500) {
  return allStoredStates(limit);
}

export async function getStoredContentState(jobId: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await findFeishuRecordByField(
    token,
    config.tableId,
    "\u4efb\u52a1ID",
    jobId,
  );
  return record ? parseContentState(record) : null;
}

async function writeState(
  state: StoredContentState,
  extraFields: Record<string, unknown> = {},
) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  await updateFeishuRecord(token, config.tableId, state.recordId, {
    ...stateFields(state),
    ...extraFields,
  });
  return state;
}

async function requireState(jobId: string) {
  const state = await getStoredContentState(jobId);
  if (!state) {
    throw new WorkflowError("Job was not found in Feishu", "JOB_NOT_FOUND", false);
  }
  return state;
}

export async function claimJob(workerId: string): Promise<ContentJob | null> {
  const now = Date.now();
  const states = await allStoredStates();
  const activeImageJobIds = new Set(states.filter((state) => {
    const lockTime = state.job.locked_at ? new Date(state.job.locked_at).getTime() : 0;
    return (
      state.assets.some((asset) => asset.status === "processing") ||
      (state.job.status === "running" &&
        lockTime >= now - STALE_LOCK_MS &&
        /^(?:generate|poll)_image_/.test(state.job.stage))
    );
  }).map((state) => state.job.id));

  const candidate = states
    .filter((state) => {
      const due = new Date(state.job.run_after).getTime() <= now;
      const stale =
        state.job.status === "running" &&
        Boolean(state.job.locked_at) &&
        new Date(state.job.locked_at!).getTime() < now - STALE_LOCK_MS;
      const queued = ["queued", "retry"].includes(state.job.status) && due;
      const imageAllowed =
        !/^(?:generate|poll)_image_/.test(state.job.stage) ||
        activeImageJobIds.has(state.job.id) ||
        activeImageJobIds.size < 2;
      return (queued || stale) && imageAllowed;
    })
    .toSorted(
      (left, right) =>
        left.job.run_after.localeCompare(right.job.run_after) ||
        left.job.created_at.localeCompare(right.job.created_at),
    )[0];

  if (!candidate) return null;
  const lockedAt = nowIso();
  candidate.job = {
    ...candidate.job,
    status: "running",
    locked_at: lockedAt,
    locked_by: workerId,
    started_at: candidate.job.started_at || lockedAt,
    error_code: null,
    error_message: null,
    updated_at: lockedAt,
  };
  await writeState(candidate);

  // Bitable has no compare-and-swap. Verify the lock owner before doing paid work.
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const confirmed = parseContentState(
    await getFeishuRecord(token, config.tableId, candidate.recordId),
  );
  return confirmed?.job.locked_by === workerId ? confirmed.job : null;
}

export async function advanceJob(
  jobId: string,
  stage: JobStage,
  payload?: Record<string, unknown>,
) {
  const state = await requireState(jobId);
  const now = nowIso();
  state.job = {
    ...state.job,
    status: stage === "completed" ? "completed" : "queued",
    stage,
    attempts: 0,
    run_after: now,
    locked_at: null,
    locked_by: null,
    error_code: null,
    error_message: null,
    payload: payload || state.job.payload,
    finished_at: stage === "completed" ? now : state.job.finished_at,
    updated_at: now,
  };
  await writeState(state);
}

export async function deferJob(jobId: string, stage: JobStage, delayMs: number) {
  const state = await requireState(jobId);
  state.job = {
    ...state.job,
    status: "queued",
    stage,
    run_after: new Date(Date.now() + delayMs).toISOString(),
    locked_at: null,
    locked_by: null,
    updated_at: nowIso(),
  };
  await writeState(state);
}

export async function recordJobFailure(input: {
  job: ContentJob;
  code: string;
  message: string;
  retryable: boolean;
  nextRunAt?: string;
}) {
  const state = await requireState(input.job.id);
  const attempts = state.job.attempts + 1;
  const willRetry = input.retryable && attempts <= state.job.max_attempts;
  const now = nowIso();
  state.job = {
    ...state.job,
    status: willRetry ? "retry" : "failed",
    attempts,
    run_after: input.nextRunAt || now,
    error_code: input.code,
    error_message: input.message.slice(0, 4000),
    locked_at: null,
    locked_by: null,
    finished_at: willRetry ? null : now,
    updated_at: now,
  };
  await writeState(state);
  return { willRetry, attempts };
}

export async function getJobContext(job: ContentJob) {
  const product = productById(job.product_id);
  const topic = job.topic_id ? topicById(job.topic_id) : null;
  if (!product) {
    throw new WorkflowError("Product is missing", "PRODUCT_NOT_FOUND", false);
  }
  if (!topic) {
    throw new WorkflowError("Topic is missing", "TOPIC_NOT_FOUND", false);
  }
  return { product, topic };
}

export async function getRecentTopics(productId: string, beforeDate: string) {
  const cutoff = new Date(`${beforeDate}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() - 30);
  return (await allStoredStates())
    .filter(
      (state) =>
        state.job.product_id === productId &&
        state.job.job_date < beforeDate &&
        state.job.job_date >= cutoff.toISOString().slice(0, 10) &&
        state.job.status !== "failed",
    )
    .map((state) => state.post?.topic)
    .filter((topic): topic is string => Boolean(topic));
}

export async function getPostByJob(jobId: string) {
  return (await requireState(jobId)).post;
}

export async function insertPost(
  input: Omit<
    GeneratedPost,
    | "id"
    | "created_at"
    | "updated_at"
    | "review_status"
    | "review_notes"
    | "publish_status"
    | "feishu_record_id"
  >,
) {
  const state = await requireState(input.job_id);
  const now = nowIso();
  const post: GeneratedPost = {
    ...input,
    id: `${input.job_id}:post`,
    review_status: "pending",
    review_notes: [],
    publish_status: "unpublished",
    feishu_record_id: state.recordId,
    created_at: now,
    updated_at: now,
  };
  state.post = post;
  await writeState(state);
  return post;
}

export async function ensureAssets(
  postId: string,
  assets: Array<{
    asset_index: number;
    asset_type: "cover" | "content";
    prompt: string;
  }>,
) {
  const jobId = postId.replace(/:post$/, "");
  const state = await requireState(jobId);
  const existing = new Map(state.assets.map((asset) => [asset.asset_index, asset]));
  const now = nowIso();
  state.assets = assets.map((asset) =>
    existing.get(asset.asset_index) || {
      id: `${postId}:asset:${asset.asset_index}`,
      post_id: postId,
      ...asset,
      provider: null,
      model: null,
      external_task_id: null,
      storage_bucket: null,
      storage_path: null,
      mime_type: null,
      width: null,
      height: null,
      byte_size: null,
      feishu_file_token: null,
      status: "pending" as const,
      error_message: null,
      created_at: now,
      updated_at: now,
    },
  );
  await writeState(state);
}

function jobIdFromPostId(postId: string) {
  return postId.replace(/:post$/, "");
}

function jobIdFromAssetId(assetId: string) {
  return assetId.replace(/:post:asset:\d+$/, "");
}

export async function getAsset(postId: string, assetIndex: number) {
  const state = await requireState(jobIdFromPostId(postId));
  return state.assets.find((asset) => asset.asset_index === assetIndex) || null;
}

export async function getAssets(postId: string) {
  const state = await requireState(jobIdFromPostId(postId));
  return state.assets.toSorted((a, b) => a.asset_index - b.asset_index);
}

export async function updateAsset(
  assetId: string,
  update: Partial<GeneratedAsset>,
) {
  const state = await requireState(jobIdFromAssetId(assetId));
  const index = state.assets.findIndex((asset) => asset.id === assetId);
  if (index < 0) {
    throw new WorkflowError("Generated asset is missing", "ASSET_NOT_FOUND", false);
  }
  state.assets[index] = {
    ...state.assets[index],
    ...update,
    updated_at: nowIso(),
  };
  const attachments = state.assets
    .filter((asset) => asset.feishu_file_token)
    .toSorted((a, b) => a.asset_index - b.asset_index)
    .map((asset) => ({ file_token: asset.feishu_file_token }));
  await writeState(state, { "\u56fe\u7247": attachments });
}

export async function updatePost(postId: string, update: Partial<GeneratedPost>) {
  const state = await requireState(jobIdFromPostId(postId));
  if (!state.post) {
    throw new WorkflowError("Generated post is missing", "POST_NOT_FOUND", false);
  }
  state.post = { ...state.post, ...update, updated_at: nowIso() };
  await writeState(state);
}

export async function markTopicUsed() {
  // Topic freshness is derived from content records, so no separate write is needed.
}

export function modelLogObserver() {
  return async () => {
    // Feishu stores actionable job errors; verbose model telemetry is intentionally omitted.
  };
}

export async function retryStoredJob(jobId: string) {
  const state = await requireState(jobId);
  if (!["failed", "retry"].includes(state.job.status)) {
    throw new WorkflowError(
      `Job in status ${state.job.status} cannot be retried manually`,
      "JOB_NOT_RETRYABLE",
      false,
    );
  }
  const now = nowIso();
  state.job = {
    ...state.job,
    status: "queued",
    attempts: 0,
    run_after: now,
    error_code: null,
    error_message: null,
    finished_at: null,
    locked_at: null,
    locked_by: null,
    updated_at: now,
  };
  await writeState(state);
  return state.job;
}
