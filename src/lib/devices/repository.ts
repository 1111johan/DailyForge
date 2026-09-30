import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getFeishuConfig, getSecret } from "@/lib/config/env";
import { getFeishuTenantToken } from "@/lib/feishu/auth";
import {
  createFeishuRecord,
  findFeishuRecordByField,
  getFeishuRecord,
  listFeishuRecords,
  updateFeishuRecord,
  type FeishuRecord,
} from "@/lib/feishu/bitable";
import {
  booleanValue,
  dateField,
  dateValue,
  textValue,
} from "@/lib/feishu/values";
import type {
  AuthenticatedDevice,
  OperatorDevice,
} from "@/lib/devices/types";
import { UnauthorizedError } from "@/lib/security/verify-secret";
import { WorkflowError } from "@/lib/workflow/errors";

const PAIRING_TTL_MS = 20 * 60_000;

function digest(value: string) {
  return createHmac("sha256", getSecret("ADMIN_ACCESS_KEY"))
    .update(value)
    .digest("hex");
}

function deviceFromRecord(record: FeishuRecord): AuthenticatedDevice {
  const fields = record.fields;
  return {
    recordId: record.record_id,
    id: textValue(fields["设备ID"]),
    name: textValue(fields["设备名称"], "未命名设备"),
    enabled: booleanValue(fields["是否启用"], true),
    worker: booleanValue(fields["是否执行设备"], false),
    paired: Boolean(textValue(fields["凭证哈希"])),
    tokenHash: textValue(fields["凭证哈希"]),
    lastSeenAt: dateValue(fields["最近在线"]),
    lastError: textValue(fields["最近错误"]) || null,
    createdAt:
      dateValue(fields["创建时间"]) ||
      (record.created_time
        ? new Date(Number(record.created_time) * 1000).toISOString()
        : new Date().toISOString()),
  };
}

export async function listOperatorDevices(): Promise<OperatorDevice[]> {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  return (await listFeishuRecords(token, config.deviceTableId, { maxRecords: 200 }))
    .map(deviceFromRecord)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((device) => ({
      recordId: device.recordId,
      id: device.id,
      name: device.name,
      enabled: device.enabled,
      worker: device.worker,
      paired: device.paired,
      lastSeenAt: device.lastSeenAt,
      lastError: device.lastError,
      createdAt: device.createdAt,
    }));
}

function pairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

export async function createDevicePairing(name: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const code = pairingCode();
  const now = new Date();
  const existing = await listOperatorDevices();
  const worker = !existing.some((device) => device.enabled && device.worker);
  const record = await createFeishuRecord(token, config.deviceTableId, {
    "设备名称": name,
    "设备ID": randomUUID(),
    "连接码哈希": digest(code),
    "连接码过期": dateField(
      new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    ),
    "凭证哈希": "",
    "是否启用": true,
    "是否执行设备": worker,
    "最近在线": null,
    "最近错误": "",
    "创建时间": dateField(now.toISOString()),
  });
  return {
    device: deviceFromRecord(record),
    pairingCode: code,
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
  };
}

export async function pairOperatorDevice(code: string, reportedName?: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await findFeishuRecordByField(
    token,
    config.deviceTableId,
    "连接码哈希",
    digest(code.trim().toUpperCase()),
  );
  if (!record) throw new UnauthorizedError();
  const expiresAt = dateValue(record.fields["连接码过期"]);
  if (
    !booleanValue(record.fields["是否启用"], true) ||
    !expiresAt ||
    new Date(expiresAt).getTime() <= Date.now() ||
    textValue(record.fields["凭证哈希"])
  ) {
    throw new UnauthorizedError();
  }
  const rawToken = `dfd_${randomBytes(32).toString("base64url")}`;
  await updateFeishuRecord(token, config.deviceTableId, record.record_id, {
    ...(reportedName?.trim() ? { "设备名称": reportedName.trim() } : {}),
    "凭证哈希": digest(rawToken),
    "连接码哈希": "",
    "连接码过期": null,
    "最近在线": dateField(new Date().toISOString()),
    "最近错误": "",
  });
  const updated = deviceFromRecord(
    await getFeishuRecord(token, config.deviceTableId, record.record_id),
  );
  return { device: updated, token: rawToken };
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

export async function authenticateOperatorDevice(request: Request) {
  const rawToken = bearerToken(request);
  if (!rawToken.startsWith("dfd_")) throw new UnauthorizedError();
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  const record = await findFeishuRecordByField(
    token,
    config.deviceTableId,
    "凭证哈希",
    digest(rawToken),
  );
  if (!record) throw new UnauthorizedError();
  const device = deviceFromRecord(record);
  if (!device.enabled || !device.paired) throw new UnauthorizedError();
  return device;
}

export async function markDeviceSeen(device: AuthenticatedDevice, error?: string) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  await updateFeishuRecord(token, config.deviceTableId, device.recordId, {
    "最近在线": dateField(new Date().toISOString()),
    "最近错误": error?.slice(0, 2000) || "",
  });
}

export async function updateOperatorDevice(
  recordId: string,
  update: { enabled?: boolean; worker?: boolean },
) {
  const token = await getFeishuTenantToken();
  const config = getFeishuConfig();
  if (update.worker) {
    const records = await listFeishuRecords(token, config.deviceTableId, {
      maxRecords: 200,
    });
    await Promise.all(
      records
        .filter((record) => record.record_id !== recordId)
        .map((record) =>
          updateFeishuRecord(token, config.deviceTableId, record.record_id, {
            "是否执行设备": false,
          }),
        ),
    );
  }
  const fields: Record<string, unknown> = {};
  if (update.enabled !== undefined) fields["是否启用"] = update.enabled;
  if (update.worker !== undefined) fields["是否执行设备"] = update.worker;
  if (Object.keys(fields).length === 0) {
    throw new WorkflowError("没有需要修改的设备设置", "INVALID_DEVICE_UPDATE", false);
  }
  await updateFeishuRecord(token, config.deviceTableId, recordId, fields);
  return deviceFromRecord(
    await getFeishuRecord(token, config.deviceTableId, recordId),
  );
}
