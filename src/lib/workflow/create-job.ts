import { createHash } from "node:crypto";
import { activeProducts, topicsForProduct } from "@/lib/catalog";
import { getGenerationConfig, getFeishuConfig } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  createFeishuRecord,
  findFeishuRecordByField,
} from "@/lib/feishu/bitable";
import { stateFields, type FeishuContentState } from "@/lib/feishu/content-state";
import { getPromptSettings } from "@/lib/settings/prompt-settings";
import type {
  ContentJob,
  ContentTopic,
  Product,
  ProductMode,
} from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import { listStoredContentStates } from "@/lib/workflow/repository";

export function dateInTimeZone(date = new Date(), timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function buildStaggerOffsets(
  count: number,
  random: () => number = Math.random,
) {
  const offsets: number[] = [];
  let elapsed = 0;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      const sample = Math.max(0, Math.min(0.999999, random()));
      elapsed += 1 + Math.floor(sample * 9);
    }
    offsets.push(elapsed);
  }
  return offsets;
}

export function repeatBalanced<T>(items: T[], count: number) {
  if (items.length === 0) return [];
  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function deterministicId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function orderedProducts(products: Product[]) {
  if (products.length < 2) return products;
  const states = await listStoredContentStates();
  const lastUse = new Map<string, string>();
  for (const state of states.toSorted((a, b) => b.job.created_at.localeCompare(a.job.created_at))) {
    if (!lastUse.has(state.job.product_id) && state.job.status !== "failed") {
      lastUse.set(state.job.product_id, state.job.created_at);
    }
  }
  return products.toSorted((left, right) =>
    (lastUse.get(left.id) || "").localeCompare(lastUse.get(right.id) || ""),
  );
}

function isDisplayContent(value: string | null | undefined) {
  return Boolean(value && (value.includes("\u5c55\u793a") || value.includes("\u4ea7\u54c1")));
}

async function rankTopics(productId: string, jobDate: string, topicId?: string) {
  const topics = topicsForProduct(productId);
  if (topicId) return topics.filter((topic) => topic.id === topicId);

  const cutoff = new Date(`${jobDate}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffDate = dateInTimeZone(cutoff);
  const recent = (await listStoredContentStates())
    .filter(
      (state) =>
        state.job.product_id === productId &&
        state.job.job_date >= cutoffDate &&
        state.job.job_date < jobDate &&
        state.job.status !== "failed",
    )
    .toSorted((a, b) => b.job.created_at.localeCompare(a.job.created_at));
  const usedTopicIds = new Set(recent.map((state) => state.job.topic_id));
  let pool = topics.filter((topic) => !usedTopicIds.has(topic.id));
  if (pool.length === 0) pool = topics;

  const recentTopics = recent
    .map((state) => topics.find((topic) => topic.id === state.job.topic_id))
    .filter((topic): topic is ContentTopic => Boolean(topic));
  if (isDisplayContent(recentTopics[0]?.content_type)) {
    const withoutDisplay = pool.filter((topic) => !isDisplayContent(topic.content_type));
    if (withoutDisplay.length > 0) pool = withoutDisplay;
  }

  const moduleCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const topic of recentTopics) {
    moduleCounts.set(topic.module || "", (moduleCounts.get(topic.module || "") || 0) + 1);
    typeCounts.set(topic.content_type, (typeCounts.get(topic.content_type) || 0) + 1);
  }
  return pool.toSorted((left, right) => {
    const leftCount =
      (moduleCounts.get(left.module || "") || 0) +
      (typeCounts.get(left.content_type) || 0);
    const rightCount =
      (moduleCounts.get(right.module || "") || 0) +
      (typeCounts.get(right.content_type) || 0);
    return leftCount - rightCount || right.priority - left.priority;
  });
}

function initialState(job: ContentJob): FeishuContentState {
  return { version: 1, job, post: null, assets: [] };
}

async function createJobRecord(input: {
  job: ContentJob;
  product: Product;
  topic: ContentTopic;
}) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const existing = await findFeishuRecordByField(
    token,
    config.tableId,
    "\u4efb\u52a1ID",
    input.job.id,
  );
  if (existing) return { created: false, job: input.job };
  const state = initialState(input.job);
  await createFeishuRecord(token, config.tableId, {
    "\u6700\u7ec8\u6807\u9898": `\u5f85\u751f\u6210 \u00b7 ${input.topic.topic}`,
    "\u751f\u6210\u65e5\u671f": new Date(`${input.job.job_date}T00:00:00+08:00`).getTime(),
    "\u4efb\u52a1ID": input.job.id,
    "\u4ea7\u54c1\u540d\u79f0": input.product.name,
    "\u7ea7\u522b": input.product.level === "cet4" ? "\u56db\u7ea7" : "\u516d\u7ea7",
    "\u5185\u5bb9\u6a21\u5757": input.topic.module || "\u5168\u79d1",
    "\u5185\u5bb9\u7c7b\u578b": input.topic.content_type,
    "\u9009\u9898": input.topic.topic,
    ...stateFields(state),
  });
  return { created: true, job: input.job };
}

export interface CreateJobsInput {
  jobDate?: string;
  productId?: string;
  productMode?: ProductMode;
  topicId?: string;
  count?: number;
  idempotencyKey?: string;
  customPrompt?: string;
  imagePrompt?: string;
  scheduledFor?: string;
}

export async function createDailyJobs(input: CreateJobsInput = {}) {
  const config = getGenerationConfig();
  const count = input.count || config.dailyCount;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new WorkflowError(
      "Generation count must be between 1 and 20",
      "INVALID_GENERATION_COUNT",
      false,
    );
  }
  const productMode = input.productMode || "rotate";
  const products = activeProducts({ productId: input.productId, productMode });
  if (products.length === 0) {
    throw new WorkflowError("No active product is configured", "NO_ACTIVE_PRODUCT", false);
  }
  const prompts = await getPromptSettings();
  const scheduledDate = input.scheduledFor ? new Date(input.scheduledFor) : new Date();
  const jobDate = input.jobDate || dateInTimeZone(scheduledDate, config.timezone);
  const key =
    input.idempotencyKey ||
    `daily:${jobDate}:${config.platform}:${input.productId || productMode}:${count}`;
  const sequence = repeatBalanced(await orderedProducts(products), count);
  const uniqueProducts = [...new Set(sequence.map((product) => product.id))];
  const topicEntries = await Promise.all(
    uniqueProducts.map(async (productId) => [
      productId,
      await rankTopics(productId, jobDate, input.topicId),
    ] as const),
  );
  const topicsByProduct = new Map(topicEntries);
  const usage = new Map<string, number>();
  const offsets = buildStaggerOffsets(count);
  const baseTime = Math.max(Date.now(), scheduledDate.getTime());
  const now = new Date().toISOString();
  const selections = sequence.map((product, index) => {
    const candidates = topicsByProduct.get(product.id) || [];
    if (candidates.length === 0) {
      throw new WorkflowError(
        `No active topic is available for ${product.name}`,
        "NO_ACTIVE_TOPIC",
        false,
      );
    }
    const useIndex = usage.get(product.id) || 0;
    usage.set(product.id, useIndex + 1);
    return { product, topic: candidates[useIndex % candidates.length], index };
  });

  const jobs: ContentJob[] = [];
  let createdCount = 0;
  for (const { product, topic, index } of selections) {
    const jobId = deterministicId(`${key}:${index + 1}`);
    const delay = offsets[index];
    const job: ContentJob = {
      id: jobId,
      job_date: jobDate,
      platform: config.platform,
      product_id: product.id,
      topic_id: topic.id,
      status: "queued",
      stage: "generate_copy",
      attempts: 0,
      max_attempts: 3,
      run_after: new Date(baseTime + delay * 1000).toISOString(),
      locked_at: null,
      locked_by: null,
      payload: {
        custom_prompt: input.customPrompt?.trim() || prompts.copyPrompt,
        image_prompt: input.imagePrompt?.trim() || prompts.imagePrompt,
      },
      error_code: null,
      error_message: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
      batch_id: key,
      sequence_no: index + 1,
      start_delay_seconds: delay,
    };
    const result = await createJobRecord({ job, product, topic });
    if (result.created) createdCount += 1;
    jobs.push(job);
  }
  return { created: createdCount > 0, createdCount, jobs };
}
