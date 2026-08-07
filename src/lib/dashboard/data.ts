import { getConfigurationStatus, getGenerationConfig } from "@/lib/config/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSignedAssetUrls } from "@/lib/supabase/storage";
import { listGenerationSchedules } from "@/lib/scheduling/repository";
import { dateInTimeZone } from "@/lib/workflow/create-job";
import { progressForJob } from "@/lib/workflow/state-machine";
import type {
  ContentJob,
  ContentTopic,
  GeneratedAsset,
  GeneratedPost,
  Product,
} from "@/lib/types/domain";
import { stringArray } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";

export interface DashboardJob {
  id: string;
  jobDate: string;
  productName: string;
  level: "cet4" | "cet6";
  topic: string;
  title: string | null;
  body: string | null;
  hashtags: string[];
  status: ContentJob["status"];
  stage: ContentJob["stage"];
  attempts: number;
  progress: number;
  readyAssets: number;
  assets: Array<{
    index: number;
    type: "cover" | "content";
    status: GeneratedAsset["status"];
    url: string | null;
  }>;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  today: string;
  summary: {
    total: number;
    completed: number;
    active: number;
    failed: number;
  };
  products: Array<{
    id: string;
    name: string;
    level: "cet4" | "cet6";
  }>;
  automation: {
    enabledCount: number;
    nextRunAt: string | null;
    imageConcurrency: number;
  };
  schedules: Array<{
    id: string;
    name: string;
    runTime: string;
    weekdays: number[];
    postCount: number;
    productMode: "rotate" | "cet4" | "cet6";
    isEnabled: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
  }>;
  jobs: DashboardJob[];
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const configuration = getConfigurationStatus();
  if (!configuration.supabase) {
    throw new WorkflowError(
      "Supabase is not configured",
      "SUPABASE_NOT_CONFIGURED",
      false,
    );
  }
  const supabase = createSupabaseAdmin();
  const timezone = getGenerationConfig().timezone;
  const today = dateInTimeZone(new Date(), timezone);
  const [productsResult, jobsResult, schedules] = await Promise.all([
    supabase
      .from("products")
      .select("*")
      .order("created_at"),
    supabase
      .from("content_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30),
    listGenerationSchedules(),
  ]);
  if (productsResult.error || jobsResult.error) {
    throw new WorkflowError(
      `Failed to load dashboard: ${productsResult.error?.message || jobsResult.error?.message}`,
      "DASHBOARD_QUERY_FAILED",
      true,
    );
  }

  const products = (productsResult.data || []) as Product[];
  const jobs = (jobsResult.data || []) as ContentJob[];
  const postResult = jobs.length
    ? await supabase
        .from("generated_posts")
        .select("*")
        .in("job_id", jobs.map((job) => job.id))
    : { data: [], error: null };
  if (postResult.error) {
    throw new WorkflowError(
      `Failed to load dashboard posts: ${postResult.error.message}`,
      "DASHBOARD_POST_QUERY_FAILED",
      true,
    );
  }
  const posts = (postResult.data || []) as GeneratedPost[];
  const postIds = posts.map((post) => post.id);
  const [assetsResult, topicsResult] = await Promise.all([
    postIds.length
      ? supabase.from("generated_assets").select("*").in("post_id", postIds)
      : Promise.resolve({ data: [], error: null }),
    jobs.some((job) => job.topic_id)
      ? supabase
          .from("content_topics")
          .select("*")
          .in(
            "id",
            jobs.flatMap((job) => (job.topic_id ? [job.topic_id] : [])),
          )
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (assetsResult.error || topicsResult.error) {
    throw new WorkflowError(
      `Failed to load dashboard relations: ${assetsResult.error?.message || topicsResult.error?.message}`,
      "DASHBOARD_RELATION_QUERY_FAILED",
      true,
    );
  }

  const assets = (assetsResult.data || []) as GeneratedAsset[];
  const signedAssetUrls = await createSignedAssetUrls(assets);
  const topics = (topicsResult.data || []) as ContentTopic[];
  const productMap = new Map(products.map((product) => [product.id, product]));
  const postMap = new Map(posts.map((post) => [post.job_id, post]));
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));

  const dashboardJobs: DashboardJob[] = jobs.map((job) => {
    const product = productMap.get(job.product_id);
    const post = postMap.get(job.id);
    return {
      id: job.id,
      jobDate: job.job_date,
      productName: product?.name || "已删除的产品",
      level: product?.level || "cet4",
      topic: (job.topic_id && topicMap.get(job.topic_id)?.topic) || post?.topic || "未选择",
      title: post?.selected_title || null,
      body: post?.body || null,
      hashtags: post ? stringArray(post.hashtags) : [],
      status: job.status,
      stage: job.stage,
      attempts: job.attempts,
      progress: progressForJob(job),
      readyAssets: post
        ? assets.filter((asset) => asset.post_id === post.id && asset.status === "ready")
            .length
        : 0,
      assets: post
        ? assets
            .filter((asset) => asset.post_id === post.id)
            .toSorted((a, b) => a.asset_index - b.asset_index)
            .map((asset) => ({
              index: asset.asset_index,
              type: asset.asset_type,
              status: asset.status,
              url: signedAssetUrls.get(asset.id) || null,
            }))
        : [],
      errorCode: job.error_code,
      errorMessage: job.error_message,
      updatedAt: job.updated_at,
    };
  });
  const todayJobs = dashboardJobs.filter((job) => job.jobDate === today);

  return {
    generatedAt: new Date().toISOString(),
    today,
    summary: {
      total: todayJobs.length,
      completed: todayJobs.filter((job) => job.status === "completed").length,
      active: todayJobs.filter((job) =>
        ["queued", "running", "retry"].includes(job.status),
      ).length,
      failed: todayJobs.filter((job) => job.status === "failed").length,
    },
    products: products
      .filter((product) => product.is_active)
      .map((product) => ({
        id: product.id,
        name: product.name,
        level: product.level,
      })),
    automation: {
      enabledCount: schedules.filter((schedule) => schedule.is_enabled).length,
      nextRunAt:
        schedules.find(
          (schedule) => schedule.is_enabled && schedule.next_run_at,
        )?.next_run_at || null,
      imageConcurrency: 2,
    },
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      runTime: schedule.run_time.slice(0, 5),
      weekdays: schedule.weekdays,
      postCount: schedule.post_count,
      productMode: schedule.product_mode,
      isEnabled: schedule.is_enabled,
      nextRunAt: schedule.next_run_at,
      lastRunAt: schedule.last_run_at,
    })),
    jobs: dashboardJobs,
  };
}
