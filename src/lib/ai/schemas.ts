import { z } from "zod";

export const ImageBriefSchema = z.object({
  index: z.number().int().min(1).max(4),
  type: z.enum(["cover", "content"]),
  title: z.string().trim().min(2).max(40),
  subtitle: z.string().trim().max(60).optional(),
  key_points: z.array(z.string().trim().min(1).max(40)).max(8),
});

export const GeneratedPostSchema = z
  .object({
    topic: z.string().trim().min(4).max(80),
    content_type: z.string().trim().min(2).max(30),
    target_user: z.string().trim().min(4).max(120),
    title_candidates: z
      .array(z.string().trim().min(4).max(60))
      .min(3)
      .max(5),
    selected_title: z.string().trim().min(4).max(60),
    body: z.string().trim().min(300).max(1000),
    hashtags: z
      .array(z.string().trim().regex(/^#[^#\s]+$/))
      .min(5)
      .max(12),
    cover: z.object({
      title: z.string().trim().min(2).max(24),
      subtitle: z.string().trim().min(2).max(40),
    }),
    image_briefs: z.array(ImageBriefSchema).length(4),
  })
  .superRefine((value, context) => {
    if (!value.title_candidates.includes(value.selected_title)) {
      context.addIssue({
        code: "custom",
        path: ["selected_title"],
        message: "selected_title must be one of title_candidates",
      });
    }

    const indexes = value.image_briefs.map((brief) => brief.index);
    if (new Set(indexes).size !== 4 || ![1, 2, 3, 4].every((n) => indexes.includes(n))) {
      context.addIssue({
        code: "custom",
        path: ["image_briefs"],
        message: "image_briefs must contain indexes 1 through 4 exactly once",
      });
    }

    const cover = value.image_briefs.find((brief) => brief.index === 1);
    if (cover?.type !== "cover") {
      context.addIssue({
        code: "custom",
        path: ["image_briefs", 0, "type"],
        message: "image 1 must be the cover",
      });
    }
  });

export type GeneratedPostContent = z.infer<typeof GeneratedPostSchema>;
export type ImageBrief = z.infer<typeof ImageBriefSchema>;
