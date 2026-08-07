import { getSupabaseConfig } from "@/lib/config/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { WorkflowError } from "@/lib/workflow/errors";
import type { GeneratedAsset } from "@/lib/types/domain";

export function assetStoragePath(input: {
  jobDate: string;
  postId: string;
  assetIndex: number;
  mimeType: string;
}) {
  const [year, month, day] = input.jobDate.split("-");
  const extension = input.mimeType.includes("jpeg")
    ? "jpg"
    : input.mimeType.includes("webp")
      ? "webp"
      : "png";
  const filename = input.assetIndex === 1 ? "cover" : `image-${input.assetIndex}`;
  return `${year}/${month}/${day}/${input.postId}/${filename}.${extension}`;
}

export async function uploadBuffer(input: {
  path: string;
  buffer: Buffer;
  contentType: string;
  upsert?: boolean;
}) {
  const supabase = createSupabaseAdmin();
  const { storageBucket } = getSupabaseConfig();
  const { error } = await supabase.storage
    .from(storageBucket)
    .upload(input.path, input.buffer, {
      contentType: input.contentType,
      upsert: input.upsert ?? true,
      cacheControl: "31536000",
    });

  if (error) {
    throw new WorkflowError(
      `Supabase Storage upload failed: ${error.message}`,
      "STORAGE_UPLOAD_FAILED",
      true,
      { cause: error },
    );
  }
  return { bucket: storageBucket, path: input.path };
}

export async function downloadBuffer(bucket: string, path: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new WorkflowError(
      `Supabase Storage download failed: ${error?.message || "empty file"}`,
      "STORAGE_DOWNLOAD_FAILED",
      true,
      { cause: error || undefined },
    );
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function createSignedAssetUrls(
  assets: GeneratedAsset[],
  expiresInSeconds = 3600,
) {
  const eligible = assets.filter(
    (asset) =>
      asset.status === "ready" &&
      Boolean(asset.storage_bucket) &&
      Boolean(asset.storage_path),
  );
  const grouped = new Map<string, GeneratedAsset[]>();
  for (const asset of eligible) {
    const bucket = asset.storage_bucket!;
    grouped.set(bucket, [...(grouped.get(bucket) || []), asset]);
  }

  const supabase = createSupabaseAdmin();
  const signedEntries = await Promise.all(
    [...grouped.entries()].map(async ([bucket, bucketAssets]) => {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(
          bucketAssets.map((asset) => asset.storage_path!),
          expiresInSeconds,
        );
      if (error) {
        throw new WorkflowError(
          `Supabase Storage signing failed: ${error.message}`,
          "STORAGE_SIGNING_FAILED",
          true,
          { cause: error },
        );
      }
      return bucketAssets.flatMap((asset, index) => {
        const signedUrl = data?.[index]?.signedUrl;
        return signedUrl ? [[asset.id, signedUrl] as const] : [];
      });
    }),
  );

  return new Map(signedEntries.flat());
}
