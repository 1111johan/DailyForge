import { readFile } from "node:fs/promises";

const BASE_URL = "https://open.feishu.cn/open-apis";

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
      }),
  );
}

const env = {
  ...parseEnv(await readFile(new URL("../.env.local", import.meta.url), "utf8")),
  ...process.env,
};

for (const name of [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BITABLE_APP_TOKEN",
  "FEISHU_TABLE_ID",
]) {
  if (!env[name]) throw new Error(`Missing ${name}`);
}

async function request(path, init = {}, token) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const result = await response.json();
  if (!response.ok || (result.code !== undefined && result.code !== 0)) {
    throw new Error(`Feishu ${result.code || response.status}: ${result.msg || response.statusText}`);
  }
  return result.data || result;
}

const auth = await request("/auth/v3/tenant_access_token/internal", {
  method: "POST",
  body: JSON.stringify({
    app_id: env.FEISHU_APP_ID,
    app_secret: env.FEISHU_APP_SECRET,
  }),
});
const token = auth.tenant_access_token;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

async function listTables() {
  const data = await request(
    `/bitable/v1/apps/${appToken}/tables?page_size=100`,
    {},
    token,
  );
  return data.items || [];
}

async function listFields(tableId) {
  const data = await request(
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
    {},
    token,
  );
  return data.items || [];
}

async function ensureField(tableId, field) {
  const existing = (await listFields(tableId)).find(
    (item) => item.field_name === field.field_name,
  );
  if (existing) {
    if (existing.type !== field.type) {
      throw new Error(
        `Field ${field.field_name} has type ${existing.type}; expected ${field.type}`,
      );
    }
    return existing;
  }
  const data = await request(
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    { method: "POST", body: JSON.stringify(field) },
    token,
  );
  return data.field;
}

async function ensureTable(name, fields) {
  let table = (await listTables()).find((item) => item.name === name);
  if (!table) {
    const data = await request(
      `/bitable/v1/apps/${appToken}/tables`,
      {
        method: "POST",
        body: JSON.stringify({
          table: { name, default_view_name: "\u5168\u90e8", fields },
        }),
      },
      token,
    );
    table = data.table || data;
  }
  for (const field of fields) await ensureField(table.table_id, field);
  return table.table_id;
}

const contentFields = [
  { field_name: "\u7cfb\u7edf\u6570\u636e", type: 1 },
  { field_name: "\u7cfb\u7edf\u72b6\u6001", type: 1 },
  { field_name: "\u4efb\u52a1\u9636\u6bb5", type: 1 },
  { field_name: "\u4e0b\u6b21\u6267\u884c", type: 5 },
  { field_name: "\u9501\u5b9a\u65f6\u95f4", type: 5 },
];
const scheduleFields = [
  { field_name: "\u8ba1\u5212\u540d\u79f0", type: 1 },
  { field_name: "\u8fd0\u884c\u65f6\u95f4", type: 1 },
  { field_name: "\u6267\u884c\u661f\u671f", type: 1 },
  { field_name: "\u751f\u6210\u6761\u6570", type: 2 },
  { field_name: "\u4ea7\u54c1\u6a21\u5f0f", type: 1 },
  { field_name: "\u662f\u5426\u542f\u7528", type: 7 },
  { field_name: "\u4e0b\u6b21\u8fd0\u884c", type: 5 },
  { field_name: "\u4e0a\u6b21\u8fd0\u884c", type: 5 },
];
const settingsFields = [
  { field_name: "\u8bbe\u7f6e\u952e", type: 1 },
  { field_name: "\u6587\u6848\u63d0\u793a\u8bcd", type: 1 },
  { field_name: "\u56fe\u7247\u63d0\u793a\u8bcd", type: 1 },
];

for (const field of contentFields) {
  await ensureField(env.FEISHU_TABLE_ID, field);
}
const scheduleTableId = await ensureTable(
  "DailyForge \u5b9a\u65f6\u8ba1\u5212",
  scheduleFields,
);
const settingsTableId = await ensureTable(
  "DailyForge \u7cfb\u7edf\u8bbe\u7f6e",
  settingsFields,
);

process.stdout.write(
  `${JSON.stringify({
    contentTableId: env.FEISHU_TABLE_ID,
    scheduleTableId,
    settingsTableId,
  })}\n`,
);
