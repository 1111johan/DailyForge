import { getFeishuConfig } from "@/lib/config/env";
import type { AuthenticatedDevice } from "@/lib/devices/types";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  getFeishuRecord,
  listFeishuRecords,
  updateFeishuRecord,
  type FeishuRecord,
} from "@/lib/feishu/bitable";
import {
  attachmentValues,
  dateField,
  dateValue,
  jsonValue,
  textValue,
} from "@/lib/feishu/values";
import type {
  SocialAttachment,
  SocialDraftCandidate,
  SocialDraftReport,
  SocialDraftStatus,
  SocialPlatform,
  SocialRecordState,
} from "@/lib/social/types";
import { WorkflowError } from "@/lib/workflow/errors";

const SOCIAL_STATE_FIELD = "社媒数据";
const LOCK_TTL_MS = 20 * 60_000;
const PLATFORMS: SocialPlatform[] = ["xiaohongshu", "douyin"];

const STATUS_LABELS: Record<SocialDraftStatus, string> = {
  pending: "等待建立",
  processing: "正在建立",
  draft_ready: "草稿完成",
  needs_attention: "需要处理",
};

function nowIso() {
  return new Date().toISOString();
}

function platformState(status: SocialDraftStatus = "pending") {
  return { status, attempts: 0, updatedAt: nowIso(), error: null };
}

export function defaultSocialState(record?: FeishuRecord): SocialRecordState {
  const xiaohongshu = textValue(record?.fields["小红书草稿状态"]);
  const douyin = textValue(record?.fields["抖音草稿状态"]);
  return {
    version: 1,
    lockedBy: null,
    lockedAt: null,
    platforms: {
      xiaohongshu: platformState(
        xiaohongshu === "草稿完成" ? "draft_ready" : "pending",
      ),
      douyin: platformState(douyin === "草稿完成" ? "draft_ready" : "pending"),
    },
  };
}

export function socialStateFromRecord(record: FeishuRecord) {
  const parsed = jsonValue<SocialRecordState | null>(
    record.fields[SOCIAL_STATE_FIELD],
    null,
  );
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.platforms?.xiaohongshu ||
    !parsed.platforms?.douyin
  ) {
    return defaultSocialState(record);
  }
  return parsed;
}

export function socialAttachments(record: FeishuRecord): SocialAttachment[] {
  const unified = attachmentValues(record.fields["图片"]);
  const source = unified.length >= 4
    ? unified
    : [1, 2, 3, 4].flatMap((index) =>
        attachmentValues(record.fields[`图片${index}`]),
      );
  return source
    .filter(
      (attachment): attachment is typeof attachment & { file_token: string } =>
        Boolean(attachment.file_token),
    )
    .slice(0, 4)
    .map((attachment, index) => ({ ...attachment, index: index + 1 }));
}

function recordTimestamp(record: FeishuRecord) {
  return (
    dateValue(record.fields["生成日期"]) ||
    (record.last_modified_time
      ? new Date(
          Number(record.last_modified_time) < 10_000_000_000
            ? Number(record.last_modified_time) * 1000
            : Number(record.last_modified_time),
        ).toISOString()
      : new Date(0).toISOString())
  );
}

function eligibleRecord(record: FeishuRecord) {
  const title = textValue(record.fields["最终标题"]);
  const body = textValue(record.fields["正文"]);
  const publishStatus = textValue(record.fields["发布状态"]);
  return (
    Boolean(title && body) &&
    publishStatus !== "已发布" &&
    socialAttachments(record).length === 4
  );
}

function socialFields(state: SocialRecordState) {
  const errors = PLATFORMS.flatMap((platform) => {
    const value = state.platforms[platform];
    return value.error ? [`${platform}: ${value.error}`] : [];
  });
  return {
    [SOCIAL_STATE_FIELD]: JSON.stringify(state),
    "小红书草稿状态": STATUS_LABELS[state.platforms.xiaohongshu.status],
    "抖音草稿状态": STATUS_LABELS[state.platforms.douyin.status],
    "社媒锁定设备": state.lockedBy || "",
    "社媒锁定时间": dateField(state.lockedAt),
    "社媒更新时间": dateField(nowIso()),
    "社媒错误": errors.join("\n").slice(0, 4000),
  };
}

function lockIsAvailable(state: SocialRecordState, deviceId: string) {
  if (!state.lockedBy || !state.lockedAt || state.lockedBy === deviceId) return true;
  return new Date(state.lockedAt).getTime() < Date.now() - LOCK_TTL_MS;
}

function lockIsExpired(state: SocialRecordState) {
  return Boolean(
    state.lockedBy &&
      state.lockedAt &&
      new Date(state.lockedAt).getTime() < Date.now() - LOCK_TTL_MS,
  );
}

export function recoverExpiredSocialClaim(state: SocialRecordState) {
  if (!lockIsExpired(state)) return state;
  const updatedAt = nowIso();
  for (const platform of PLATFORMS) {
    if (state.platforms[platform].status === "processing") {
      state.platforms[platform] = {
        ...state.platforms[platform],
        status: "pending",
        updatedAt,
        error: "上次本机处理未完成，已自动重新排队",
      };
    }
  }
  state.lockedBy = null;
  state.lockedAt = null;
  return state;
}

function candidateFromRecord(
  record: FeishuRecord,
  platforms: SocialPlatform[],
): SocialDraftCandidate {
  const attachments = socialAttachments(record);
  return {
    recordId: record.record_id,
    title: textValue(record.fields["最终标题"]),
    body: textValue(record.fields["正文"]),
    platforms,
    attachments: attachments.map((attachment) => ({
      index: attachment.index,
      name: attachment.name || `dailyforge-${record.record_id}-${attachment.index}.png`,
      mimeType: attachment.type || null,
      downloadPath: `/api/device/social/media/${record.record_id}/${encodeURIComponent(attachment.file_token)}`,
    })),
    reviewRequired: textValue(record.fields["生成状态"]) === "需要人工检查",
    updatedAt: recordTimestamp(record),
  };
}

export async function claimSocialDraft(device: AuthenticatedDevice) {
  if (!device.worker) {
    throw new WorkflowError(
      "这台电脑不是当前草稿执行设备",
      "DEVICE_NOT_WORKER",
      false,
    );
  }
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const records = (await listFeishuRecords(token, config.tableId, {
    maxRecords: 500,
  }))
    .filter(eligibleRecord)
    .toSorted((left, right) =>
      recordTimestamp(right).localeCompare(recordTimestamp(left)),
    );

  for (const record of records) {
    const state = recoverExpiredSocialClaim(socialStateFromRecord(record));
    if (!lockIsAvailable(state, device.id)) continue;
    const platforms = PLATFORMS.filter(
      (platform) => state.platforms[platform].status === "pending",
    );
    if (platforms.length === 0) continue;

    const lockedAt = nowIso();
    state.lockedBy = device.id;
    state.lockedAt = lockedAt;
    for (const platform of platforms) {
      state.platforms[platform] = {
        ...state.platforms[platform],
        status: "processing",
        attempts: state.platforms[platform].attempts + 1,
        updatedAt: lockedAt,
        error: null,
      };
    }
    await updateFeishuRecord(
      token,
      config.tableId,
      record.record_id,
      socialFields(state),
    );
    const confirmed = await getFeishuRecord(token, config.tableId, record.record_id);
    const confirmedState = socialStateFromRecord(confirmed);
    if (confirmedState.lockedBy !== device.id || confirmedState.lockedAt !== lockedAt) {
      continue;
    }
    return candidateFromRecord(confirmed, platforms);
  }
  return null;
}

export async function reportSocialDraft(
  device: AuthenticatedDevice,
  report: SocialDraftReport,
) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await getFeishuRecord(token, config.tableId, report.recordId);
  const state = socialStateFromRecord(record);
  if (state.lockedBy !== device.id) {
    throw new WorkflowError(
      "草稿任务已不属于这台电脑",
      "SOCIAL_CLAIM_LOST",
      false,
    );
  }
  const updatedAt = nowIso();
  for (const result of report.results) {
    state.platforms[result.platform] = {
      ...state.platforms[result.platform],
      status: result.status,
      updatedAt,
      error: result.error?.slice(0, 2000) || null,
    };
  }
  state.lockedBy = null;
  state.lockedAt = null;
  await updateFeishuRecord(
    token,
    config.tableId,
    record.record_id,
    socialFields(state),
  );
  return state;
}

export async function resetSocialDraft(
  recordId: string,
  platform: SocialPlatform,
) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await getFeishuRecord(token, config.tableId, recordId);
  const state = socialStateFromRecord(record);
  state.platforms[platform] = {
    ...state.platforms[platform],
    status: "pending",
    updatedAt: nowIso(),
    error: null,
  };
  state.lockedBy = null;
  state.lockedAt = null;
  await updateFeishuRecord(token, config.tableId, recordId, socialFields(state));
  return state;
}

export async function deviceCanDownloadMedia(
  device: AuthenticatedDevice,
  recordId: string,
  fileToken: string,
) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await getFeishuRecord(token, config.tableId, recordId);
  const state = socialStateFromRecord(record);
  return state.lockedBy === device.id && socialAttachments(record).some(
    (attachment) => attachment.file_token === fileToken,
  );
}
