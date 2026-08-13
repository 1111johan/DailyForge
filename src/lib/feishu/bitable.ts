import { getFeishuConfig } from "@/lib/config/env";
import { feishuFetch } from "@/lib/feishu/client";
import { WorkflowError } from "@/lib/workflow/errors";

export interface FeishuAttachment {
  file_token?: string;
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  tmp_url?: string;
}

export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_time?: number;
  last_modified_time?: number;
}

interface RecordPage {
  items?: FeishuRecord[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

function recordsData(result: Awaited<ReturnType<typeof feishuFetch>>) {
  return (result.data || {}) as RecordPage;
}

export async function listFeishuRecords(
  token: string,
  tableId: string,
  options: { pageSize?: number; maxRecords?: number } = {},
) {
  const config = getFeishuConfig();
  const records: FeishuRecord[] = [];
  let pageToken: string | undefined;
  const pageSize = Math.min(options.pageSize || 500, 500);

  do {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) query.set("page_token", pageToken);
    const result = await feishuFetch(
      `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records?${query}`,
      { method: "GET" },
      token,
    );
    const data = recordsData(result);
    records.push(...(data.items || []));
    if (options.maxRecords && records.length >= options.maxRecords) {
      return records.slice(0, options.maxRecords);
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return records;
}

export async function searchFeishuRecords(
  token: string,
  tableId: string,
  options: {
    filter?: Record<string, unknown>;
    sort?: Array<{ field_name: string; desc?: boolean }>;
    pageSize?: number;
    maxRecords?: number;
  },
) {
  const config = getFeishuConfig();
  const records: FeishuRecord[] = [];
  let pageToken: string | undefined;
  const pageSize = Math.min(options.pageSize || 500, 500);
  do {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) query.set("page_token", pageToken);
    const result = await feishuFetch(
      `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/search?${query}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(options.filter ? { filter: options.filter } : {}),
          ...(options.sort ? { sort: options.sort } : {}),
        }),
      },
      token,
    );
    const data = recordsData(result);
    records.push(...(data.items || []));
    if (options.maxRecords && records.length >= options.maxRecords) {
      return records.slice(0, options.maxRecords);
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return records;
}

export async function findFeishuRecordByField(
  token: string,
  tableId: string,
  fieldName: string,
  value: string,
) {
  const records = await searchFeishuRecords(token, tableId, {
    filter: {
      conjunction: "and",
      conditions: [
        { field_name: fieldName, operator: "is", value: [value] },
      ],
    },
    pageSize: 1,
    maxRecords: 1,
  });
  return records[0] || null;
}

export async function getFeishuRecord(
  token: string,
  tableId: string,
  recordId: string,
) {
  const config = getFeishuConfig();
  const result = await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/${recordId}`,
    { method: "GET" },
    token,
  );
  const data = result.data as { record?: FeishuRecord } | undefined;
  if (!data?.record) {
    throw new WorkflowError(
      "Feishu record response is empty",
      "FEISHU_RECORD_EMPTY",
      true,
    );
  }
  return data.record;
}

export async function createFeishuRecord(
  token: string,
  tableId: string,
  fields: Record<string, unknown>,
) {
  const config = getFeishuConfig();
  const result = await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    },
    token,
  );
  const data = result.data as { record?: FeishuRecord } | undefined;
  if (!data?.record?.record_id) {
    throw new WorkflowError(
      "Feishu record creation returned no record id",
      "FEISHU_RECORD_ID_EMPTY",
      false,
    );
  }
  return data.record;
}

export async function updateFeishuRecord(
  token: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
) {
  const config = getFeishuConfig();
  const result = await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/${recordId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    },
    token,
  );
  const data = result.data as { record?: FeishuRecord } | undefined;
  return data?.record || null;
}

export async function deleteFeishuRecord(
  token: string,
  tableId: string,
  recordId: string,
) {
  const config = getFeishuConfig();
  await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${tableId}/records/${recordId}`,
    { method: "DELETE" },
    token,
  );
}
