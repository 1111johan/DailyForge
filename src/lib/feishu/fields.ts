import type { GeneratedPostContent } from "@/lib/ai/schemas";
import type {
  ContentJob,
  ContentTopic,
  GeneratedAsset,
  GeneratedPost,
  Product,
} from "@/lib/types/domain";

export function jobDateMilliseconds(jobDate: string) {
  return new Date(`${jobDate}T00:00:00+08:00`).getTime();
}

export function bodyWithHashtags(body: string, hashtags: string[]) {
  const normalizedBody = body.trim();
  const hashtagLine = hashtags.map((hashtag) => hashtag.trim()).join(" ");
  return hashtagLine ? `${normalizedBody}\n\n${hashtagLine}` : normalizedBody;
}

export function buildFeishuFields(input: {
  job: ContentJob;
  product: Product;
  topic: ContentTopic;
  post: GeneratedPost;
  content: GeneratedPostContent;
  assets: GeneratedAsset[];
}) {
  const { job, product, topic, post, content, assets } = input;
  const fields: Record<string, unknown> = {
    生成日期: jobDateMilliseconds(job.job_date),
    任务ID: job.id,
    产品名称: product.name,
    级别: product.level === "cet4" ? "四级" : "六级",
    内容模块: topic.module || "全科",
    内容类型: content.content_type,
    选题: content.topic,
    标题候选: content.title_candidates
      .map((title, index) => `${index + 1}. ${title}`)
      .join("\n"),
    最终标题: content.selected_title,
    正文: bodyWithHashtags(content.body, content.hashtags),
    封面主标题: content.cover.title,
    封面副标题: content.cover.subtitle,
    图片: assets
      .filter((asset) => Boolean(asset.feishu_file_token))
      .toSorted((left, right) => left.asset_index - right.asset_index)
      .map((asset) => ({ file_token: asset.feishu_file_token })),
    图片脚本: JSON.stringify(content.image_briefs, null, 2),
    生成状态: post.review_status === "approved" ? "已生成" : "需要人工检查",
    发布状态: "待发布",
    备注:
      post.review_status === "needs_review"
        ? "自动检查发现问题，请发布前复核。"
        : "",
    "Supabase ID": post.id,
  };
  return fields;
}
