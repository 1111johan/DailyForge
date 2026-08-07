import { getGenerationConfig } from "@/lib/config/env";
import {
  createManualBatch,
  updateGenerationBatch,
} from "@/lib/scheduling/repository";
import { PromptSettingsSchema } from "@/lib/settings/prompt-settings-schema";
import { getPromptSettings } from "@/lib/settings/prompt-settings";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  ContentJob,
  ContentTopic,
  GenerationBatch,
  Product,
  ProductMode,
} from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";

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

async function activeProducts(input: {
  productId?: string;
  productMode: ProductMode;
}) {
  const supabase = createSupabaseAdmin();
  let query = supabase.from("products").select("*").eq("is_active", true);
  if (input.productId) {
    query = query.eq("id", input.productId);
  } else if (input.productMode !== "rotate") {
    query = query.eq("level", input.productMode);
  }
  const { data, error } = await query.order("created_at");
  if (error) {
    throw new WorkflowError(
      `Failed to load active products: ${error.message}`,
      "PRODUCT_QUERY_FAILED",
      true,
    );
  }
  return (data || []) as Product[];
}

async function orderProductsByLastUse(products: Product[], jobDate: string) {
  if (products.length < 2) return products;
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_jobs")
    .select("product_id,job_date,created_at")
    .in("product_id", products.map((product) => product.id))
    .lt("job_date", jobDate)
    .neq("status", "failed")
    .order("job_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) {
    throw new WorkflowError(
      `Failed to load product rotation: ${error.message}`,
      "PRODUCT_ROTATION_QUERY_FAILED",
      true,
    );
  }
  const lastUse = new Map<string, string>();
  for (const row of data || []) {
    if (!lastUse.has(row.product_id)) lastUse.set(row.product_id, row.job_date);
  }
  return products.toSorted((a, b) => {
    const aDate = lastUse.get(a.id) || "";
    const bDate = lastUse.get(b.id) || "";
    return aDate.localeCompare(bDate) || a.created_at.localeCompare(b.created_at);
  });
}

function topicRelation(value: unknown) {
  const relation = Array.isArray(value) ? value[0] : value;
  return relation && typeof relation === "object"
    ? (relation as { module?: string | null; content_type?: string | null })
    : null;
}

function isDisplayContent(value: string | null | undefined) {
  return Boolean(value && (value.includes("展示") || value.includes("产品")));
}

async function rankTopics(input: {
  productId: string;
  jobDate: string;
  topicId?: string;
}) {
  const supabase = createSupabaseAdmin();
  let topicQuery = supabase
    .from("content_topics")
    .select("*")
    .eq("product_id", input.productId)
    .eq("is_active", true);
  if (input.topicId) topicQuery = topicQuery.eq("id", input.topicId);

  const cutoff = new Date(`${input.jobDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const [topicResult, recentResult] = await Promise.all([
    topicQuery.order("priority", { ascending: false }),
    supabase
      .from("content_jobs")
      .select("job_date,content_topics(module,content_type)")
      .eq("product_id", input.productId)
      .gte("job_date", cutoffDate)
      .lt("job_date", input.jobDate)
      .neq("status", "failed")
      .order("job_date", { ascending: false }),
  ]);
  if (topicResult.error || recentResult.error) {
    throw new WorkflowError(
      `Failed to load topics: ${topicResult.error?.message || recentResult.error?.message}`,
      "TOPIC_QUERY_FAILED",
      true,
    );
  }

  const topics = (topicResult.data || []) as ContentTopic[];
  if (input.topicId) return topics;

  const candidates = topics.filter(
    (topic) => !topic.planned_date || topic.planned_date <= input.jobDate,
  );
  const cutoffTimestamp = `${cutoffDate}T00:00:00.000Z`;
  const freshTopics = candidates.filter(
    (topic) => !topic.used_at || topic.used_at < cutoffTimestamp,
  );
  let pool = freshTopics.length > 0 ? freshTopics : candidates;

  const recentRelations = (recentResult.data || [])
    .map((row) => topicRelation(row.content_topics))
    .filter((relation) => relation !== null);
  const lastRelation = recentRelations[0] || null;
  if (isDisplayContent(lastRelation?.content_type)) {
    const withoutDisplay = pool.filter(
      (topic) => !isDisplayContent(topic.content_type),
    );
    if (withoutDisplay.length > 0) pool = withoutDisplay;
  }

  const moduleCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const relation of recentRelations) {
    if (relation.module) {
      moduleCounts.set(relation.module, (moduleCounts.get(relation.module) || 0) + 1);
    }
    if (relation.content_type) {
      typeCounts.set(
        relation.content_type,
        (typeCounts.get(relation.content_type) || 0) + 1,
      );
    }
  }

  return pool.toSorted((a, b) => {
    const aPlanned = a.planned_date === input.jobDate ? 1 : 0;
    const bPlanned = b.planned_date === input.jobDate ? 1 : 0;
    if (aPlanned !== bPlanned) return bPlanned - aPlanned;
    if (a.used_at === null && b.used_at !== null) return -1;
    if (a.used_at !== null && b.used_at === null) return 1;
    const aBalance =
      (moduleCounts.get(a.module || "") || 0) +
      (typeCounts.get(a.content_type) || 0);
    const bBalance =
      (moduleCounts.get(b.module || "") || 0) +
      (typeCounts.get(b.content_type) || 0);
    if (aBalance !== bBalance) return aBalance - bBalance;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (a.used_at || "").localeCompare(b.used_at || "");
  });
}

async function jobsForBatch(batchId: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_jobs")
    .select("*")
    .eq("batch_id", batchId)
    .order("sequence_no");
  if (error) {
    throw new WorkflowError(
      `Failed to load batch jobs: ${error.message}`,
      "JOB_QUERY_FAILED",
      true,
    );
  }
  return (data || []) as ContentJob[];
}

function promptSnapshot(batch: GenerationBatch) {
  const parsed = PromptSettingsSchema.safeParse(batch.prompt_snapshot);
  return parsed.success ? parsed.data : null;
}

export async function populateGenerationBatch(
  batch: GenerationBatch,
  input: { jobDate?: string; topicId?: string } = {},
) {
  if (batch.status === "populated") {
    return { created: false, batch, jobs: await jobsForBatch(batch.id) };
  }

  const config = getGenerationConfig();
  const scheduledDate = batch.scheduled_for
    ? new Date(batch.scheduled_for)
    : new Date();
  const jobDate =
    input.jobDate || dateInTimeZone(scheduledDate, config.timezone);
  const products = await activeProducts({
    productId: batch.product_id || undefined,
    productMode: batch.product_mode,
  });
  if (products.length === 0) {
    throw new WorkflowError(
      "No active product is configured for this schedule",
      "NO_ACTIVE_PRODUCT",
      false,
    );
  }

  const orderedProducts = batch.product_id
    ? products
    : await orderProductsByLastUse(products, jobDate);
  const productSequence = repeatBalanced(orderedProducts, batch.requested_count);
  const uniqueProductIds = [...new Set(productSequence.map((product) => product.id))];
  const topicEntries = await Promise.all(
    uniqueProductIds.map(async (productId) => [
      productId,
      await rankTopics({ productId, jobDate, topicId: input.topicId }),
    ] as const),
  );
  const topicsByProduct = new Map(topicEntries);
  const topicUse = new Map<string, number>();
  const selections = productSequence.map((product) => {
    const topics = topicsByProduct.get(product.id) || [];
    if (topics.length === 0) {
      throw new WorkflowError(
        `No active topic is available for ${product.name}`,
        "NO_ACTIVE_TOPIC",
        false,
      );
    }
    const useIndex = topicUse.get(product.id) || 0;
    topicUse.set(product.id, useIndex + 1);
    return { product, topic: topics[useIndex % topics.length] };
  });

  const prompts = promptSnapshot(batch) || (await getPromptSettings());
  const offsets = buildStaggerOffsets(batch.requested_count);
  const baseTime = Math.max(Date.now(), scheduledDate.getTime());
  const rows = selections.map(({ product, topic }, index) => ({
    batch_id: batch.id,
    sequence_no: index + 1,
    start_delay_seconds: offsets[index],
    job_date: jobDate,
    platform: config.platform,
    product_id: product.id,
    topic_id: topic.id,
    status: "queued",
    stage: "generate_copy",
    attempts: 0,
    run_after: new Date(baseTime + offsets[index] * 1000).toISOString(),
    payload: {
      custom_prompt: prompts.copyPrompt,
      image_prompt: prompts.imagePrompt,
    },
  }));

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_jobs")
    .upsert(rows, {
      onConflict: "batch_id,sequence_no",
      ignoreDuplicates: true,
    })
    .select("*");
  if (error) {
    throw new WorkflowError(
      `Failed to create batch jobs: ${error.message}`,
      "JOB_CREATE_FAILED",
      true,
    );
  }

  const jobs = (data || []) as ContentJob[];
  const allJobs = jobs.length === rows.length ? jobs : await jobsForBatch(batch.id);
  await updateGenerationBatch(batch.id, {
    created_count: allJobs.length,
    status: "populated",
    error_message: null,
  });
  return {
    created: jobs.length > 0,
    batch: { ...batch, created_count: allJobs.length, status: "populated" as const },
    jobs: allJobs,
  };
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

  const savedPrompts = await getPromptSettings();
  const prompts = {
    copyPrompt: input.customPrompt?.trim() || savedPrompts.copyPrompt,
    imagePrompt: input.imagePrompt?.trim() || savedPrompts.imagePrompt,
  };
  const jobDate =
    input.jobDate || dateInTimeZone(new Date(), config.timezone);
  const productMode = input.productMode || "rotate";
  const idempotencyKey =
    input.idempotencyKey ||
    `daily:${jobDate}:${config.platform}:${input.productId || productMode}:${count}`;
  const batch = await createManualBatch({
    idempotencyKey,
    requestedCount: count,
    productMode,
    productId: input.productId,
    promptSnapshot: prompts,
  });
  return populateGenerationBatch(batch, {
    jobDate,
    topicId: input.topicId,
  });
}
