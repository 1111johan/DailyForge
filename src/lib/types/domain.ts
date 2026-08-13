export type ProductLevel = "cet4" | "cet6";
export type ProductMode = "rotate" | ProductLevel;
export type JobStatus =
  | "queued"
  | "running"
  | "retry"
  | "completed"
  | "failed";

export type JobStage =
  | "generate_copy"
  | `generate_image_${1 | 2 | 3 | 4}`
  | `poll_image_${1 | 2 | 3 | 4}`
  | "review_content"
  | "sync_feishu"
  | "completed";

export interface Product {
  id: string;
  name: string;
  level: ProductLevel;
  description: string;
  selling_points: unknown;
  prohibited_claims: unknown;
  product_assets: unknown;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContentTopic {
  id: string;
  product_id: string;
  topic: string;
  content_type: string;
  module: string | null;
  target_user: string | null;
  priority: number;
  planned_date: string | null;
  used_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContentJob {
  id: string;
  job_date: string;
  platform: string;
  product_id: string;
  topic_id: string | null;
  status: JobStatus;
  stage: JobStage;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  payload: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  batch_id: string | null;
  sequence_no: number | null;
  start_delay_seconds: number;
}

export interface GenerationSchedule {
  id: string;
  name: string;
  run_time: string;
  weekdays: number[];
  post_count: number;
  product_mode: ProductMode;
  is_enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeneratedPost {
  id: string;
  job_id: string;
  product_id: string;
  topic: string;
  content_type: string;
  target_user: string;
  title_candidates: unknown;
  selected_title: string;
  body: string;
  hashtags: unknown;
  cover_copy: unknown;
  image_briefs: unknown;
  review_status: "pending" | "approved" | "needs_review";
  review_notes: unknown;
  publish_status: "unpublished" | "published";
  feishu_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeneratedAsset {
  id: string;
  post_id: string;
  asset_index: number;
  asset_type: "cover" | "content";
  prompt: string;
  provider: string | null;
  model: string | null;
  external_task_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  feishu_file_token: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
