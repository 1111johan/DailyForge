import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleGateway } from "@/lib/ai/gateway";
import { GeneratedPostSchema } from "@/lib/ai/schemas";
import { validGeneratedPost } from "@/test/fixtures";

function jsonResponse(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("OpenAiCompatibleGateway", () => {
  beforeEach(() => {
    process.env.AI_RELAY_BASE_URL = "https://relay.example.test";
    process.env.AI_RELAY_API_KEY = "test-key";
    process.env.AI_TEXT_MODEL = "text-test";
    process.env.AI_IMAGE_MODEL = "image-test";
    process.env.AI_TEXT_PATH = "/v1/chat/completions";
    process.env.AI_IMAGE_PATH = "/v1/images/generations";
    process.env.AI_IMAGE_POLL_PATH = "/v1/images/tasks/{taskId}";
  });

  it("repairs malformed structured output and reports both attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "not-json" } }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "req-2",
          choices: [{ message: { content: JSON.stringify(validGeneratedPost()) } }],
          usage: { prompt_tokens: 100, completion_tokens: 500 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const observations: Array<{ status: string }> = [];
    const gateway = new OpenAiCompatibleGateway((observation) => {
      observations.push(observation);
    });

    const result = await gateway.generateJson({
      schema: GeneratedPostSchema,
      systemPrompt: "system",
      userPrompt: "user",
      maxRepairAttempts: 1,
    });

    expect(result.selected_title).toBe(validGeneratedPost().selected_title);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observations.map((item) => item.status)).toEqual(["error", "success"]);
  });

  it("decodes synchronous base64 image responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
      ),
    );
    const gateway = new OpenAiCompatibleGateway();
    const result = await gateway.generateImage({ prompt: "image", width: 1024, height: 1536 });

    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.buffer.toString()).toBe("image-bytes");
  });

  it("returns asynchronous task ids without waiting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ task_id: "img_123", status: "queued" })),
    );
    const gateway = new OpenAiCompatibleGateway();
    await expect(
      gateway.generateImage({ prompt: "image", width: 1024, height: 1536 }),
    ).resolves.toMatchObject({ status: "pending", taskId: "img_123" });
  });
});
