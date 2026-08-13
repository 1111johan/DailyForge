import { getFeishuConfig } from "@/lib/config/env";
import { feishuFetch } from "@/lib/feishu/client";
import { WorkflowError } from "@/lib/workflow/errors";

let uploadQueue: Promise<void> = Promise.resolve();

async function performUpload(input: {
  token: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}) {
  const config = getFeishuConfig();
  const form = new FormData();
  form.append("file_name", input.fileName);
  form.append("parent_type", "bitable_image");
  form.append("parent_node", config.appToken);
  form.append("size", String(input.buffer.byteLength));
  form.append(
    "file",
    new Blob([Uint8Array.from(input.buffer)], { type: input.mimeType }),
    input.fileName,
  );

  const result = await feishuFetch(
    "/drive/v1/medias/upload_all",
    { method: "POST", body: form },
    input.token,
  );
  const data = result.data as { file_token?: string } | undefined;
  if (!data?.file_token) {
    throw new WorkflowError(
      "Feishu media upload returned no file token",
      "FEISHU_FILE_TOKEN_EMPTY",
      false,
    );
  }
  return data.file_token;
}

export function uploadImageToFeishu(input: {
  token: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}) {
  const upload = uploadQueue.then(() => performUpload(input));
  uploadQueue = upload.then(
    () => undefined,
    () => undefined,
  );
  return upload;
}
