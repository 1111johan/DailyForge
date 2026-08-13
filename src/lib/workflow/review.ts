import { GLOBAL_PROHIBITED_CLAIMS } from "@/lib/ai/prompts";
import type { ContentJob } from "@/lib/types/domain";
import { stringArray } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import {
  advanceJob,
  getAssets,
  getJobContext,
  getPostByJob,
  updatePost,
} from "@/lib/workflow/repository";
import { postRowToContent } from "@/lib/workflow/post-content";

export async function handleReview(job: ContentJob) {
  const [{ product }, post] = await Promise.all([
    getJobContext(job),
    getPostByJob(job.id),
  ]);
  if (!post) {
    throw new WorkflowError("Generated post does not exist", "POST_NOT_FOUND", false);
  }
  const assets = await getAssets(post.id);
  if (assets.length !== 4 || assets.some((asset) => asset.status !== "ready")) {
    throw new WorkflowError(
      "Four ready images are required before review",
      "ASSETS_INCOMPLETE",
      true,
    );
  }

  const content = postRowToContent(post);
  const searchableText = [
    content.selected_title,
    content.body,
    content.hashtags.join(" "),
    content.cover.title,
    content.cover.subtitle,
    ...content.image_briefs.flatMap((brief) => [
      brief.title,
      brief.subtitle || "",
      ...brief.key_points,
    ]),
  ].join("\n");
  const forbidden = Array.from(
    new Set([
      ...GLOBAL_PROHIBITED_CLAIMS,
      ...stringArray(product.prohibited_claims),
    ]),
  );
  const violations: string[] = forbidden
    .filter((claim) => searchableText.includes(claim))
    .map((claim) => `出现禁用词：${claim}`);

  const wrongLevelTerms = product.level === "cet4" ? ["六级", "CET-6"] : ["四级", "CET-4"];
  for (const term of wrongLevelTerms) {
    if (searchableText.includes(term)) violations.push(`疑似混入其他考试：${term}`);
  }
  if (content.body.length < 500 || content.body.length > 900) {
    violations.push(`正文长度为${content.body.length}，建议控制在500至900字`);
  }

  await updatePost(post.id, {
    review_status: violations.length === 0 ? "approved" : "needs_review",
    review_notes: violations,
  });
  await advanceJob(job.id, "sync_feishu");
}
