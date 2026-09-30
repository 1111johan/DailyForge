import type { FeishuAttachment } from "@/lib/feishu/bitable";

export type SocialPlatform = "xiaohongshu" | "douyin";
export type SocialDraftStatus =
  | "pending"
  | "processing"
  | "draft_ready"
  | "needs_attention";

export interface SocialPlatformState {
  status: SocialDraftStatus;
  attempts: number;
  updatedAt: string;
  error: string | null;
}

export interface SocialRecordState {
  version: 1;
  lockedBy: string | null;
  lockedAt: string | null;
  platforms: Record<SocialPlatform, SocialPlatformState>;
}

export interface SocialAttachment extends FeishuAttachment {
  file_token: string;
  index: number;
}

export interface SocialDraftCandidate {
  recordId: string;
  title: string;
  body: string;
  platforms: SocialPlatform[];
  attachments: Array<{
    index: number;
    name: string;
    mimeType: string | null;
    downloadPath: string;
  }>;
  reviewRequired: boolean;
  updatedAt: string;
}

export interface SocialDraftReport {
  recordId: string;
  results: Array<{
    platform: SocialPlatform;
    status: Extract<SocialDraftStatus, "draft_ready" | "needs_attention">;
    error?: string;
  }>;
}
