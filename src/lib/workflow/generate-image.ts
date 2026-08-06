import sharp from "sharp";
import { createAiGateway } from "@/lib/ai/gateway";
import { getAiConfig } from "@/lib/config/env";
import { assetStoragePath, uploadBuffer } from "@/lib/supabase/storage";
import type { ContentJob, GeneratedAsset, JobStage } from "@/lib/types/domain";
import { WorkflowError } from "@/lib/workflow/errors";
import {
  advanceJob,
  deferJob,
  getAsset,
  getPostByJob,
  modelLogObserver,
  updateAsset,
} from "@/lib/workflow/repository";
import { nextStageAfterImage } from "@/lib/workflow/state-machine";

async function validateImage(buffer: Buffer, expectedWidth: number, expectedHeight: number) {
  if (buffer.byteLength < 10_000 || buffer.byteLength > 20 * 1024 * 1024) {
    throw new WorkflowError(
      `Generated image size ${buffer.byteLength} bytes is outside the accepted range`,
      "IMAGE_FILE_SIZE_INVALID",
      true,
    );
  }
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw new WorkflowError(
      "Generated image cannot be decoded",
      "IMAGE_DECODE_FAILED",
      true,
      { cause: error },
    );
  }
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new WorkflowError(
      "Generated image metadata is incomplete",
      "IMAGE_METADATA_INVALID",
      true,
    );
  }
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    throw new WorkflowError(
      `Generated image is ${metadata.width}x${metadata.height}; expected ${expectedWidth}x${expectedHeight}`,
      "IMAGE_DIMENSIONS_INVALID",
      true,
    );
  }
  const mimeType =
    metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new WorkflowError(
      `Generated image format ${metadata.format} is not supported`,
      "IMAGE_FORMAT_INVALID",
      false,
    );
  }
  return { width: metadata.width, height: metadata.height, mimeType };
}

async function saveReadyImage(input: {
  job: ContentJob;
  asset: GeneratedAsset;
  postId: string;
  buffer: Buffer;
}) {
  const config = getAiConfig();
  const metadata = await validateImage(
    input.buffer,
    config.imageWidth,
    config.imageHeight,
  );
  const path = assetStoragePath({
    jobDate: input.job.job_date,
    postId: input.postId,
    assetIndex: input.asset.asset_index,
    mimeType: metadata.mimeType,
  });
  const storage = await uploadBuffer({
    path,
    buffer: input.buffer,
    contentType: metadata.mimeType,
    upsert: true,
  });
  await updateAsset(input.asset.id, {
    status: "ready",
    provider: "openai-compatible",
    model: config.imageModel,
    storage_bucket: storage.bucket,
    storage_path: storage.path,
    mime_type: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
    byte_size: input.buffer.byteLength,
    error_message: null,
  });
  await advanceJob(input.job.id, nextStageAfterImage(input.asset.asset_index));
}

export async function handleGenerateImage(
  job: ContentJob,
  assetIndex: number,
  polling: boolean,
) {
  const post = await getPostByJob(job.id);
  if (!post) {
    throw new WorkflowError(
      "Generated post does not exist",
      "POST_NOT_FOUND",
      false,
    );
  }
  const asset = await getAsset(post.id, assetIndex);
  if (!asset) {
    throw new WorkflowError(
      `Generated asset ${assetIndex} does not exist`,
      "ASSET_NOT_FOUND",
      false,
    );
  }
  if (asset.status === "ready") {
    await advanceJob(job.id, nextStageAfterImage(assetIndex));
    return;
  }

  const gateway = createAiGateway(modelLogObserver(job.id, post.id));
  const config = getAiConfig();
  const pollStage = `poll_image_${assetIndex}` as JobStage;

  if (!polling && asset.external_task_id && asset.status === "processing") {
    await deferJob(job.id, pollStage, 0);
    return;
  }
  if (polling && !asset.external_task_id) {
    throw new WorkflowError(
      `Asset ${assetIndex} has no external task id`,
      "IMAGE_TASK_ID_MISSING",
      false,
    );
  }

  const result = polling
    ? await gateway.pollImageTask(asset.external_task_id!)
    : await gateway.generateImage({
        prompt: asset.prompt,
        width: config.imageWidth,
        height: config.imageHeight,
      });

  if (result.status === "pending") {
    await updateAsset(asset.id, {
      status: "processing",
      external_task_id: result.taskId,
      provider: "openai-compatible",
      model: config.imageModel,
      error_message: null,
    });
    await deferJob(job.id, pollStage, 60_000);
    return;
  }

  await saveReadyImage({ job, asset, postId: post.id, buffer: result.buffer });
}
