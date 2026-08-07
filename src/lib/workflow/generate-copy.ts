import { createAiGateway } from "@/lib/ai/gateway";
import {
  buildImagePrompt,
  buildPostUserPrompt,
  POST_SYSTEM_PROMPT,
} from "@/lib/ai/prompts";
import {
  GeneratedPostSchema,
  type GeneratedPostContent,
} from "@/lib/ai/schemas";
import type { ContentJob, Product } from "@/lib/types/domain";
import { stringArray } from "@/lib/types/domain";
import {
  advanceJob,
  ensureAssets,
  getJobContext,
  getPostByJob,
  getRecentTopics,
  insertPost,
  markTopicUsed,
  modelLogObserver,
} from "@/lib/workflow/repository";
import { postRowToContent } from "@/lib/workflow/post-content";
import { WorkflowError } from "@/lib/workflow/errors";

function assertProductKnowledge(product: Product) {
  if (!product.description.trim() || stringArray(product.selling_points).length === 0) {
    throw new WorkflowError(
      `Product knowledge is empty for ${product.name}`,
      "PRODUCT_KNOWLEDGE_EMPTY",
      false,
    );
  }
}

function customPromptFromJob(job: ContentJob) {
  const value = job.payload.custom_prompt;
  return typeof value === "string" ? value : undefined;
}

function imagePromptFromJob(job: ContentJob) {
  const value = job.payload.image_prompt;
  return typeof value === "string" ? value : undefined;
}

async function prepareAssets(
  postId: string,
  product: Product,
  content: GeneratedPostContent,
  imagePrompt?: string,
) {
  await ensureAssets(
    postId,
    content.image_briefs.map((brief) => ({
      asset_index: brief.index,
      asset_type: brief.type,
      prompt: buildImagePrompt({
        product,
        post: content,
        brief,
        customPrompt: imagePrompt,
      }),
    })),
  );
}

export async function handleGenerateCopy(job: ContentJob) {
  const { product, topic } = await getJobContext(job);
  assertProductKnowledge(product);

  const existing = await getPostByJob(job.id);
  if (existing) {
    await prepareAssets(
      existing.id,
      product,
      postRowToContent(existing),
      imagePromptFromJob(job),
    );
    await markTopicUsed(topic.id);
    await advanceJob(job.id, "generate_image_1");
    return;
  }

  const recentTopics = await getRecentTopics(product.id, job.job_date);
  const gateway = createAiGateway(modelLogObserver(job.id));
  const content = await gateway.generateJson({
    schema: GeneratedPostSchema,
    systemPrompt: POST_SYSTEM_PROMPT,
    userPrompt: buildPostUserPrompt({
      product,
      topic,
      recentTopics,
      customPrompt: customPromptFromJob(job),
    }),
    temperature: 0.8,
    maxRepairAttempts: 2,
  });
  const post = await insertPost({
    job_id: job.id,
    product_id: product.id,
    topic: content.topic,
    content_type: content.content_type,
    target_user: content.target_user,
    title_candidates: content.title_candidates,
    selected_title: content.selected_title,
    body: content.body,
    hashtags: content.hashtags,
    cover_copy: content.cover,
    image_briefs: content.image_briefs,
  });
  await prepareAssets(post.id, product, content, imagePromptFromJob(job));
  await markTopicUsed(topic.id);
  await advanceJob(job.id, "generate_image_1");
}
