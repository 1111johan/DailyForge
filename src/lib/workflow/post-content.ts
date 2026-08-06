import {
  GeneratedPostSchema,
  type GeneratedPostContent,
} from "@/lib/ai/schemas";
import type { GeneratedPost } from "@/lib/types/domain";

export function postRowToContent(post: GeneratedPost): GeneratedPostContent {
  return GeneratedPostSchema.parse({
    topic: post.topic,
    content_type: post.content_type,
    target_user: post.target_user,
    title_candidates: post.title_candidates,
    selected_title: post.selected_title,
    body: post.body,
    hashtags: post.hashtags,
    cover: post.cover_copy,
    image_briefs: post.image_briefs,
  });
}
