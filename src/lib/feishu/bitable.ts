import { getFeishuConfig } from "@/lib/config/env";
import { feishuFetch } from "@/lib/feishu/client";
import { WorkflowError } from "@/lib/workflow/errors";

interface FeishuRecord {
  record_id: string;
  fields?: Record<string, unknown>;
}

export async function findFeishuRecordByJobId(token: string, jobId: string) {
  const config = getFeishuConfig();
  const result = await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_size: 1,
        filter: {
          conjunction: "and",
          conditions: [
            {
              field_name: "任务ID",
              operator: "is",
              value: [jobId],
            },
          ],
        },
      }),
    },
    token,
  );
  const data = result.data as { items?: FeishuRecord[] } | undefined;
  return data?.items?.[0]?.record_id || null;
}

export async function createFeishuRecord(
  token: string,
  fields: Record<string, unknown>,
) {
  const config = getFeishuConfig();
  const result = await feishuFetch(
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
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
  return data.record.record_id;
}
