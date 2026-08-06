import { getGenerationConfig } from "@/lib/config/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { ContentJob, ContentTopic, Product } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";

export function dateInTimeZone(date = new Date(), timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function activeProducts(productId?: string) {
  const supabase = createSupabaseAdmin();
  let query = supabase.from("products").select("*").eq("is_active", true);
  if (productId) query = query.eq("id", productId);
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
    .select("product_id,job_date")
    .in("product_id", products.map((product) => product.id))
    .lt("job_date", jobDate)
    .neq("status", "failed")
    .order("job_date", { ascending: false })
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

async function selectTopic(input: {
  productId: string;
  jobDate: string;
  topicId?: string;
}) {
  const supabase = createSupabaseAdmin();
  let query = supabase
    .from("content_topics")
    .select("*")
    .eq("product_id", input.productId)
    .eq("is_active", true);
  if (input.topicId) query = query.eq("id", input.topicId);
  const cutoff = new Date(`${input.jobDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const [topicResult, recentResult] = await Promise.all([
    query.order("priority", { ascending: false }),
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
  if (input.topicId) return topics[0] || null;

  const planned = topics.find((topic) => topic.planned_date === input.jobDate);
  if (planned) return planned;

  const cutoffTimestamp = `${cutoffDate}T00:00:00.000Z`;
  let eligible = topics.filter(
    (topic) =>
      (!topic.planned_date || topic.planned_date <= input.jobDate) &&
      (!topic.used_at || topic.used_at < cutoffTimestamp),
  );
  const recentRelations = (recentResult.data || [])
    .map((row) => topicRelation(row.content_topics))
    .filter((relation) => relation !== null);
  const lastRelation = recentRelations[0] || null;
  if (isDisplayContent(lastRelation?.content_type)) {
    const withoutDisplay = eligible.filter(
      (topic) => !isDisplayContent(topic.content_type),
    );
    if (withoutDisplay.length > 0) eligible = withoutDisplay;
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
  return eligible.toSorted((a, b) => {
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
  })[0] || null;
}

export interface CreateJobsInput {
  jobDate?: string;
  productId?: string;
  topicId?: string;
  customPrompt?: string;
}

export async function createDailyJobs(input: CreateJobsInput = {}) {
  const config = getGenerationConfig();
  const jobDate = input.jobDate || dateInTimeZone(new Date(), config.timezone);
  const products = await activeProducts(input.productId);
  if (products.length === 0) {
    throw new WorkflowError(
      "No active product is configured",
      "NO_ACTIVE_PRODUCT",
      false,
    );
  }

  const orderedProducts = input.productId
    ? products
    : await orderProductsByLastUse(products, jobDate);
  const selectedProducts = orderedProducts.slice(0, input.productId ? 1 : config.dailyCount);
  const selections = await Promise.all(
    selectedProducts.map(async (product) => ({
      product,
      topic: await selectTopic({
        productId: product.id,
        jobDate,
        topicId: input.topicId,
      }),
    })),
  );
  const missingTopic = selections.find((selection) => !selection.topic);
  if (missingTopic) {
    throw new WorkflowError(
      `No active topic is available for ${missingTopic.product.name}`,
      "NO_ACTIVE_TOPIC",
      false,
    );
  }

  const rows = selections.map(({ product, topic }) => ({
    job_date: jobDate,
    platform: config.platform,
    product_id: product.id,
    topic_id: topic!.id,
    status: "queued",
    stage: "generate_copy",
    attempts: 0,
    run_after: new Date().toISOString(),
    payload: input.customPrompt?.trim()
      ? { custom_prompt: input.customPrompt.trim() }
      : {},
  }));

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("content_jobs")
    .upsert(rows, {
      onConflict: "job_date,platform,product_id",
      ignoreDuplicates: true,
    })
    .select("*");
  if (error) {
    throw new WorkflowError(
      `Failed to create daily jobs: ${error.message}`,
      "JOB_CREATE_FAILED",
      true,
    );
  }

  const created = (data || []) as ContentJob[];
  if (created.length === rows.length) {
    return { created: true, jobs: created };
  }

  const { data: existing, error: existingError } = await supabase
    .from("content_jobs")
    .select("*")
    .eq("job_date", jobDate)
    .eq("platform", config.platform)
    .in("product_id", rows.map((row) => row.product_id));
  if (existingError) {
    throw new WorkflowError(
      `Failed to load existing jobs: ${existingError.message}`,
      "JOB_QUERY_FAILED",
      true,
    );
  }
  return { created: created.length > 0, jobs: (existing || []) as ContentJob[] };
}
