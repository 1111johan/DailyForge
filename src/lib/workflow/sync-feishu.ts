import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  createFeishuRecord,
  findFeishuRecordByJobId,
} from "@/lib/feishu/bitable";
import { buildFeishuFields } from "@/lib/feishu/fields";
import { uploadImageToFeishu } from "@/lib/feishu/media";
import { downloadBuffer } from "@/lib/supabase/storage";
import type { ContentJob, GeneratedAsset } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import {
  advanceJob,
  getAssets,
  getJobContext,
  getPostByJob,
  updateAsset,
  updatePost,
} from "@/lib/workflow/repository";
import { postRowToContent } from "@/lib/workflow/post-content";

async function ensureFeishuFileToken(token: string, asset: GeneratedAsset) {
  if (asset.feishu_file_token) return asset.feishu_file_token;
  if (!asset.storage_bucket || !asset.storage_path || !asset.mime_type) {
    throw new WorkflowError(
      `Asset ${asset.asset_index} has no stored file`,
      "ASSET_STORAGE_MISSING",
      false,
    );
  }
  const buffer = await downloadBuffer(asset.storage_bucket, asset.storage_path);
  const extension = asset.mime_type.includes("jpeg")
    ? "jpg"
    : asset.mime_type.split("/")[1] || "png";
  const fileToken = await uploadImageToFeishu({
    token,
    fileName: `dailyforge-${asset.post_id}-${asset.asset_index}.${extension}`,
    buffer,
    mimeType: asset.mime_type,
  });
  await updateAsset(asset.id, { feishu_file_token: fileToken });
  return fileToken;
}

export async function handleFeishuSync(job: ContentJob) {
  const [{ product, topic }, post] = await Promise.all([
    getJobContext(job),
    getPostByJob(job.id),
  ]);
  if (!post) {
    throw new WorkflowError("Generated post does not exist", "POST_NOT_FOUND", false);
  }
  if (post.feishu_record_id) {
    await advanceJob(job.id, "completed");
    return;
  }

  const assets = await getAssets(post.id);
  if (assets.length !== 4 || assets.some((asset) => asset.status !== "ready")) {
    throw new WorkflowError(
      "Four ready images are required for Feishu sync",
      "ASSETS_INCOMPLETE",
      true,
    );
  }

  const token = await getFeishuTenantToken();
  const fileTokens = await Promise.all(
    assets.map((asset) => ensureFeishuFileToken(token, asset)),
  );
  const assetsWithTokens = assets.map((asset, index) => ({
    ...asset,
    feishu_file_token: fileTokens[index],
  }));

  let recordId = await findFeishuRecordByJobId(token, job.id);
  if (!recordId) {
    recordId = await createFeishuRecord(
      token,
      buildFeishuFields({
        job,
        product,
        topic,
        post,
        content: postRowToContent(post),
        assets: assetsWithTokens,
      }),
    );
  }
  await updatePost(post.id, { feishu_record_id: recordId });
  await advanceJob(job.id, "completed");
}
