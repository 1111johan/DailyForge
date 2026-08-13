import { getCleanupConfig, getSupabaseConfig } from "@/lib/config/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { WorkflowError } from "@/lib/workflow/errors";

interface CleanupCandidate {
  job_id: string;
  job_date: string;
  post_id: string;
}

interface CleanupAsset {
  storage_bucket: string | null;
  storage_path: string | null;
}

function cleanupError(message: string, error: { message: string; code?: string }) {
  return new WorkflowError(
    `${message}: ${error.message}`,
    `CLEANUP_${error.code || "ERROR"}`,
    true,
  );
}

export function contentSnapshotPath(jobDate: string, postId: string) {
  return `${jobDate.replaceAll("-", "/")}/${postId}/content.json`;
}

export function groupStoragePaths(input: {
  candidates: CleanupCandidate[];
  assets: CleanupAsset[];
  defaultBucket: string;
}) {
  const paths = new Map<string, Set<string>>();
  const add = (bucket: string, path: string) => {
    const bucketPaths = paths.get(bucket) || new Set<string>();
    bucketPaths.add(path);
    paths.set(bucket, bucketPaths);
  };
  for (const candidate of input.candidates) {
    add(
      input.defaultBucket,
      contentSnapshotPath(candidate.job_date, candidate.post_id),
    );
  }
  for (const asset of input.assets) {
    if (asset.storage_bucket && asset.storage_path) {
      add(asset.storage_bucket, asset.storage_path);
    }
  }

  return new Map(
    [...paths].map(([bucket, bucketPaths]) => [bucket, [...bucketPaths]]),
  );
}

export async function cleanupArchivedContent() {
  const supabase = createSupabaseAdmin();
  const { retentionDays, batchSize } = getCleanupConfig();
  const { storageBucket } = getSupabaseConfig();
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: candidateRows, error: candidatesError } = await supabase.rpc(
    "list_archived_content_jobs",
    { p_finished_before: cutoff, p_limit: batchSize },
  );
  if (candidatesError) {
    throw cleanupError("Failed to load cleanup candidates", candidatesError);
  }

  const candidates = (candidateRows || []) as CleanupCandidate[];
  if (candidates.length === 0) {
    return { retentionDays, cutoff, candidates: 0, deletedJobs: 0, deletedBatches: 0 };
  }
  const { data: assetRows, error: assetsError } = await supabase
    .from("generated_assets")
    .select("storage_bucket,storage_path")
    .in("post_id", candidates.map((candidate) => candidate.post_id));
  if (assetsError) throw cleanupError("Failed to load archived assets", assetsError);

  const storagePaths = groupStoragePaths({
    candidates,
    assets: (assetRows || []) as CleanupAsset[],
    defaultBucket: storageBucket,
  });
  for (const [bucket, paths] of storagePaths) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) throw cleanupError(`Failed to remove files from ${bucket}`, error);
  }

  const { data: resultRows, error: deleteError } = await supabase.rpc(
    "delete_archived_content_jobs",
    {
      p_job_ids: candidates.map((candidate) => candidate.job_id),
      p_finished_before: cutoff,
    },
  );
  if (deleteError) throw cleanupError("Failed to delete archived records", deleteError);

  const result = (resultRows || [])[0] as
    | { deleted_jobs: number; deleted_batches: number }
    | undefined;
  return {
    retentionDays,
    cutoff,
    candidates: candidates.length,
    deletedJobs: result?.deleted_jobs || 0,
    deletedBatches: result?.deleted_batches || 0,
  };
}
