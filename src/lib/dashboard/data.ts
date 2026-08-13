import { PRODUCTS, productById, topicById } from "@/lib/catalog";
import { getGenerationConfig } from "@/lib/config/env";
import { listGenerationSchedules } from "@/lib/scheduling/repository";
import type { ContentJob, GeneratedAsset } from "@/lib/types/domain";
import { stringArray } from "@/lib/types/domain";
import { dateInTimeZone } from "@/lib/workflow/create-job";
import { listStoredContentStates } from "@/lib/workflow/repository";
import { progressForJob } from "@/lib/workflow/state-machine";

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
  summary: { total: number; completed: number; active: number; failed: number };
  products: Array<{ id: string; name: string; level: "cet4" | "cet6" }>;
  automation: { enabledCount: number; nextRunAt: string | null; imageConcurrency: number };
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
  const timezone = getGenerationConfig().timezone;
  const today = dateInTimeZone(new Date(), timezone);
  const [states, schedules] = await Promise.all([
    listStoredContentStates(),
    listGenerationSchedules(),
  ]);
  const dashboardJobs = states
    .toSorted((left, right) => right.job.created_at.localeCompare(left.job.created_at))
    .slice(0, 30)
    .map((state): DashboardJob => {
      const product = productById(state.job.product_id);
      const topic = state.job.topic_id ? topicById(state.job.topic_id) : null;
      return {
        id: state.job.id,
        jobDate: state.job.job_date,
        productName: product?.name || "\u672a\u77e5\u4ea7\u54c1",
        level: product?.level || "cet4",
        topic: topic?.topic || state.post?.topic || "\u672a\u9009\u62e9",
        title: state.post?.selected_title || null,
        body: state.post?.body || null,
        hashtags: state.post ? stringArray(state.post.hashtags) : [],
        status: state.job.status,
        stage: state.job.stage,
        attempts: state.job.attempts,
        progress: progressForJob(state.job),
        readyAssets: state.assets.filter((asset) => asset.status === "ready").length,
        assets: state.assets
          .toSorted((left, right) => left.asset_index - right.asset_index)
          .map((asset) => ({
            index: asset.asset_index,
            type: asset.asset_type,
            status: asset.status,
            url: asset.feishu_file_token
              ? `/api/feishu/media/${encodeURIComponent(asset.feishu_file_token)}`
              : null,
          })),
        errorCode: state.job.error_code,
        errorMessage: state.job.error_message,
        updatedAt: state.job.updated_at,
      };
    });
  const todayJobs = dashboardJobs.filter((job) => job.jobDate === today);
  return {
    generatedAt: new Date().toISOString(),
    today,
    summary: {
      total: todayJobs.length,
      completed: todayJobs.filter((job) => job.status === "completed").length,
      active: todayJobs.filter((job) => ["queued", "running", "retry"].includes(job.status)).length,
      failed: todayJobs.filter((job) => job.status === "failed").length,
    },
    products: PRODUCTS.map((product) => ({ id: product.id, name: product.name, level: product.level })),
    automation: {
      enabledCount: schedules.filter((schedule) => schedule.is_enabled).length,
      nextRunAt: schedules.find((schedule) => schedule.is_enabled && schedule.next_run_at)?.next_run_at || null,
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
