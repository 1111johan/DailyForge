import type {
  ContentJob,
  GeneratedAsset,
  GeneratedPost,
} from "@/lib/types/domain";
import type { FeishuRecord } from "@/lib/feishu/bitable";
import { jsonValue } from "@/lib/feishu/values";

export const CONTENT_STATE_FIELD = "\u7cfb\u7edf\u6570\u636e";

export interface FeishuContentState {
  version: 1;
  job: ContentJob;
  post: GeneratedPost | null;
  assets: GeneratedAsset[];
}

export interface StoredContentState extends FeishuContentState {
  recordId: string;
}

export function parseContentState(record: FeishuRecord): StoredContentState | null {
  const state = jsonValue<FeishuContentState | null>(
    record.fields[CONTENT_STATE_FIELD],
    null,
  );
  if (
    !state ||
    state.version !== 1 ||
    !state.job ||
    typeof state.job.id !== "string" ||
    !Array.isArray(state.assets)
  ) {
    return null;
  }
  return { ...state, recordId: record.record_id };
}

export function serializeContentState(state: FeishuContentState) {
  return JSON.stringify(state);
}

export function stateFields(state: FeishuContentState) {
  return {
    [CONTENT_STATE_FIELD]: serializeContentState(state),
    "\u7cfb\u7edf\u72b6\u6001": state.job.status,
    "\u4efb\u52a1\u9636\u6bb5": state.job.stage,
    "\u4e0b\u6b21\u6267\u884c": new Date(state.job.run_after).getTime(),
    "\u9501\u5b9a\u65f6\u95f4": state.job.locked_at
      ? new Date(state.job.locked_at).getTime()
      : null,
  };
}
