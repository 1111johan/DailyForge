import { getFeishuConfig } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import { updateFeishuRecord } from "@/lib/feishu/bitable";
import { buildFeishuFields } from "@/lib/feishu/fields";
import type { ContentJob } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import {
  advanceJob,
  getAssets,
  getJobContext,
  getPostByJob,
} from "@/lib/workflow/repository";
import { postRowToContent } from "@/lib/workflow/post-content";

export async function handleFeishuSync(job: ContentJob) {
  const [{ product, topic }, post] = await Promise.all([
    getJobContext(job),
    getPostByJob(job.id),
  ]);
  if (!post) {
    throw new WorkflowError("Generated post does not exist", "POST_NOT_FOUND", false);
  }
  const assets = await getAssets(post.id);
  if (
    assets.length !== 4 ||
    assets.some((asset) => asset.status !== "ready" || !asset.feishu_file_token)
  ) {
    throw new WorkflowError(
      "Four uploaded images are required for Feishu sync",
      "ASSETS_INCOMPLETE",
      true,
    );
  }
  if (!post.feishu_record_id) {
    throw new WorkflowError(
      "Content record id is missing",
      "FEISHU_RECORD_ID_EMPTY",
      false,
    );
  }
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  await updateFeishuRecord(
    token,
    config.tableId,
    post.feishu_record_id,
    buildFeishuFields({
      job,
      product,
      topic,
      post,
      content: postRowToContent(post),
      assets,
    }),
  );
  await advanceJob(job.id, "completed");
}
