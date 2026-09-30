import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "DailyForge")
  : join(homedir(), ".dailyforge");
const CONFIG_PATH = join(APP_DIR, "device.json");
const CACHE_DIR = process.env.DAILYFORGE_MEDIA_DIR || join(APP_DIR, "media");
const BUNDLED_PYTHON = join(HERE, "runtime", "python", "python.exe");
const BUNDLED_SKILL = join(HERE, "vendor", "chrome-browser-control");
const SKILL_DIR = process.env.DAILYFORGE_CHROME_SKILL ||
  (existsSync(BUNDLED_SKILL)
    ? BUNDLED_SKILL
    : join(homedir(), ".codex", "skills", "chrome-browser-control"));
const PYTHON = process.env.DAILYFORGE_PYTHON ||
  (existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : "python");
const PORT = Number(process.env.DAILYFORGE_COMPANION_PORT || 3108);
const WATCH_INTERVAL_MS = 5 * 60_000;

async function ensureDirectories() {
  await Promise.all([
    mkdir(APP_DIR, { recursive: true }),
    mkdir(CACHE_DIR, { recursive: true }),
  ]);
}

function powershell(script, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        child.kill();
        rejectPromise(new Error("PowerShell 输出超过安全限制"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolvePromise(result);
      } else {
        rejectPromise(
          new Error(result.stderr.trim() || `PowerShell 执行失败：${code}`),
        );
      }
    });
    child.stdin.end(String(input ?? ""), "utf8");
  });
}

async function protectToken(value) {
  if (platform() !== "win32") return `plain:${Buffer.from(value).toString("base64")}`;
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$value = [Console]::In.ReadToEnd()",
    "$bytes = [Text.Encoding]::UTF8.GetBytes($value)",
    "$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($encrypted)",
  ].join("; ");
  return (await powershell(script, value)).stdout.trim();
}

async function unprotectToken(value) {
  if (value.startsWith("plain:")) {
    return Buffer.from(value.slice(6), "base64").toString("utf8");
  }
  if (platform() !== "win32") throw new Error("设备凭证来自另一台电脑");
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$value = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($value)",
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::UTF8.GetString($plain)",
  ].join("; ");
  return (await powershell(script, value)).stdout.trim();
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return {
      ...parsed,
      baseUrl: String(parsed.baseUrl || "").replace(/\/$/, ""),
      token: parsed.protectedToken
        ? await unprotectToken(parsed.protectedToken)
        : "",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveConfig(config) {
  await ensureDirectories();
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(
      {
        version: 1,
        baseUrl: config.baseUrl.replace(/\/$/, ""),
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        protectedToken: await protectToken(config.token),
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function cloudRequest(path, init = {}, configOverride) {
  const config = configOverride || (await loadConfig());
  if (!config?.baseUrl || (!config.token && path !== "/api/device/pair")) {
    throw new Error("这台电脑尚未连接 DailyForge");
  }
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init,
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error?.message || `DailyForge 请求失败：${response.status}`);
  }
  return result.data;
}

async function pairDevice({ baseUrl, code, name }) {
  const normalizedUrl = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(normalizedUrl)) throw new Error("DailyForge 地址无效");
  const data = await cloudRequest(
    "/api/device/pair",
    {
      method: "POST",
      body: JSON.stringify({ code: String(code || "").trim(), name }),
    },
    { baseUrl: normalizedUrl, token: "" },
  );
  await saveConfig({
    baseUrl: normalizedUrl,
    deviceId: data.device.id,
    deviceName: data.device.name,
    token: data.token,
  });
  return data.device;
}

async function runJson(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(parsed.error || `${basename(command)} 执行失败`);
  return parsed;
}

function setupScript() {
  return join(SKILL_DIR, "scripts", "setup.py");
}

function browserScript() {
  return join(SKILL_DIR, "scripts", "browser.py");
}

async function prepareBridge() {
  await ensureDirectories();
  const prepared = await runJson(PYTHON, [setupScript(), "prepare"]);
  await runJson(PYTHON, [setupScript(), "allow-upload-root", CACHE_DIR]);
  const doctor = await runJson(PYTHON, [setupScript(), "doctor"]);
  return {
    ...doctor,
    extensionPath:
      prepared.extension_path || join(SKILL_DIR, "assets", "chrome-extension"),
  };
}

async function enrollBridge() {
  await runJson(PYTHON, [setupScript(), "enroll", "--timeout", "60"]);
  return runJson(PYTHON, [setupScript(), "doctor"]);
}

async function browser(args, pageId) {
  return runJson(PYTHON, [
    browserScript(),
    ...(pageId ? ["--page-id", pageId] : []),
    ...args,
  ], { env: { ...process.env, PYTHONUTF8: "1" } });
}

async function browserState() {
  const doctor = await runJson(PYTHON, [setupScript(), "doctor"]);
  let pages = [];
  if (doctor.server_reachable) pages = (await browser(["pages"])).pages || [];
  return {
    bridge: doctor.status,
    serverReachable: Boolean(doctor.server_reachable),
    uploadReady: doctor.bridge?.capabilities?.includes("upload_file") || false,
    extensionPath:
      doctor.extension_path || join(SKILL_DIR, "assets", "chrome-extension"),
    xiaohongshu: pages.some((page) => page.url?.startsWith("https://creator.xiaohongshu.com/")),
    douyin: pages.some((page) => page.url?.startsWith("https://creator.douyin.com/")),
    pages: pages.map((page) => ({ url: page.url, title: page.title })),
  };
}

function extensionFor(contentType, name) {
  const known = contentType?.split(";")[0].trim().toLowerCase();
  if (known === "image/jpeg") return ".jpg";
  if (known === "image/webp") return ".webp";
  if (known === "image/png") return ".png";
  const fromName = extname(name || "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(fromName)
    ? fromName
    : ".png";
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertImage(buffer, contentType) {
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!png && !jpeg && !webp) throw new Error(`下载内容不是有效图片：${contentType || "未知类型"}`);
  if (buffer.length > 20 * 1024 * 1024) throw new Error("单张图片超过 20 MB");
}

async function downloadCandidate(candidate, config) {
  const directory = join(CACHE_DIR, candidate.recordId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const attachment of candidate.attachments) {
    const response = await fetch(new URL(attachment.downloadPath, config.baseUrl), {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!response.ok) throw new Error(`第 ${attachment.index} 张图片下载失败：${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || attachment.mimeType;
    assertImage(buffer, contentType);
    const file = join(
      directory,
      `${String(attachment.index).padStart(2, "0")}${extensionFor(contentType, attachment.name)}`,
    );
    await writeFile(file, buffer);
    files.push(file);
  }
  return { directory, files };
}

async function openPage(url) {
  await browser(["open", url, "--mode", "new_tab"]);
  await sleep(2000);
  const pages = (await browser(["pages"])).pages || [];
  const target = pages
    .filter((page) => page.url?.startsWith(new URL(url).origin))
    .at(-1);
  if (!target?.page_id) throw new Error(`无法打开 ${new URL(url).hostname}`);
  return target.page_id;
}

async function clickDraftText(pageId, texts, selector = "") {
  let lastError;
  for (const draftText of texts) {
    try {
      return await browser([
        "click-text",
        "--text",
        draftText,
        ...(selector ? ["--css", selector] : []),
        "--contains",
        "--timeout",
        "10",
      ], pageId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到保存草稿按钮");
}

async function clickXiaohongshuDraftFallback(pageId) {
  const origin = await browser(["inspect-point", "--x", "0", "--y", "0"], pageId);
  const width = Number(origin.point?.viewportWidth || 0);
  const height = Number(origin.point?.viewportHeight || 0);
  if (!width || !height) throw new Error("无法读取小红书页面尺寸");
  const target = await browser([
    "inspect-point",
    "--x",
    String(Math.round(width * 0.424)),
    "--y",
    String(Math.round(height * 0.946)),
  ], pageId);
  const element = target.point?.element;
  const text = String(element?.text || "");
  const selector = String(element?.selector || "");
  if (!text.includes("暂存离开") || !selector) {
    throw new Error("未能安全识别小红书“暂存离开”按钮");
  }
  await browser(["click", "--css", selector, "--timeout", "10"], pageId);
}

async function saveXiaohongshuDraft(pageId) {
  try {
    await clickDraftText(pageId, ["暂存离开"], "button,[role='button']");
  } catch (error) {
    try {
      await clickXiaohongshuDraftFallback(pageId);
    } catch (fallbackError) {
      throw new Error(
        `小红书内容已填写，但保存草稿失败：${
          fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : "未找到暂存按钮"
        }`,
      );
    }
  }
  await sleep(2500);
}

async function saveDouyinDraft(pageId) {
  await clickDraftText(
    pageId,
    ["存草稿", "保存草稿", "暂存"],
    "button,[role='button']",
  );
  await sleep(2500);
}

async function fillWithFallback(pageId, selectors, text) {
  let lastError;
  for (const selector of selectors) {
    try {
      await browser(["fill", "--css", selector, "--text", text], pageId);
      return selector;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到输入位置");
}

async function uploadWithFallback(pageId, selectors, files) {
  let lastError;
  for (const selector of selectors) {
    try {
      await browser([
        "upload",
        "--css",
        selector,
        ...files.flatMap((file) => ["--file", file]),
        "--timeout",
        "45",
      ], pageId);
      return selector;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到图片上传位置");
}

async function prepareXiaohongshu(candidate, files) {
  const pageId = await openPage("https://creator.xiaohongshu.com/publish/publish");
  await uploadWithFallback(pageId, [
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ], files);
  await sleep(5000);
  await fillWithFallback(pageId, [
    'input[placeholder*="标题"]',
    'input[class*="title"]',
  ], candidate.title.slice(0, 20));
  await fillWithFallback(pageId, [
    '[contenteditable="true"]',
    'textarea[placeholder*="正文"]',
    'textarea',
  ], candidate.body.slice(0, 1000));
  await saveXiaohongshuDraft(pageId);
  return {
    platform: "xiaohongshu",
    status: "draft_ready",
  };
}

async function prepareDouyin(candidate, files) {
  const pageId = await openPage("https://creator.douyin.com/creator-micro/content/upload");
  await uploadWithFallback(pageId, [
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ], files);
  await sleep(5000);
  await fillWithFallback(pageId, [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
  ], candidate.title);
  await fillWithFallback(pageId, [
    '[contenteditable="true"]',
    'textarea[placeholder*="描述"]',
    'textarea[placeholder*="简介"]',
  ], candidate.body.slice(0, 1000));
  await saveDouyinDraft(pageId);
  return {
    platform: "douyin",
    status: "draft_ready",
  };
}

async function reportFailure(candidate, message) {
  const config = await loadConfig();
  if (!config) return;
  const results = candidate.platforms.map((platformName) => ({
    platform: platformName,
    status: "needs_attention",
    error: message.slice(0, 1800),
  }));
  await cloudRequest("/api/device/social/report", {
    method: "POST",
    body: JSON.stringify({ recordId: candidate.recordId, results }),
  }, config);
}

async function runOnceCore() {
  const config = await loadConfig();
  if (!config) throw new Error("请先完成设备连接");
  await prepareBridge();
  const candidate = await cloudRequest(
    "/api/device/social/claim",
    { method: "POST", body: "{}" },
    config,
  );
  if (!candidate) return { processed: false, message: "当前没有待处理内容" };
  try {
    const { directory, files } = await downloadCandidate(candidate, config);
    const results = [];
    for (const platformName of candidate.platforms) {
      try {
        const result = platformName === "xiaohongshu"
          ? await prepareXiaohongshu(candidate, files)
          : await prepareDouyin(candidate, files);
        results.push(result);
      } catch (error) {
        results.push({
          platform: platformName,
          status: "needs_attention",
          error: error instanceof Error ? error.message : "平台页面操作失败",
        });
      }
      await sleep(3000 + Math.floor(Math.random() * 6000));
    }
    await cloudRequest("/api/device/social/report", {
      method: "POST",
      body: JSON.stringify({ recordId: candidate.recordId, results }),
    }, config);
    return { processed: true, candidate, results, cacheDirectory: directory };
  } catch (error) {
    await reportFailure(candidate, error instanceof Error ? error.message : "本机处理失败");
    throw error;
  }
}

let activeRun = null;

async function runOnce() {
  if (activeRun) {
    return { processed: false, message: "上一条内容仍在处理中" };
  }
  activeRun = runOnceCore();
  try {
    return await activeRun;
  } finally {
    activeRun = null;
  }
}

async function status() {
  const config = await loadConfig();
  let cloud = null;
  let cloudError = "";
  if (config) {
    try {
      cloud = await cloudRequest("/api/device/heartbeat", { method: "POST", body: "{}" }, config);
    } catch (error) {
      cloudError = error instanceof Error ? error.message : "云端连接失败";
    }
  }
  let chrome = null;
  let chromeError = "";
  try {
    chrome = await browserState();
  } catch (error) {
    chromeError = error instanceof Error ? error.message : "Chrome 助手不可用";
  }
  return {
    configured: Boolean(config),
    baseUrl: config?.baseUrl || "",
    deviceName: config?.deviceName || "",
    cloud,
    cloudError,
    chrome,
    chromeError,
    cacheDirectory: CACHE_DIR,
  };
}

function json(response, statusCode = 200) {
  return { statusCode, body: JSON.stringify(response), type: "application/json; charset=utf-8" };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function route(request) {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (request.method === "GET" && url.pathname === "/") {
    return {
      statusCode: 200,
      body: await readFile(join(HERE, "wizard.html"), "utf8"),
      type: "text/html; charset=utf-8",
    };
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return json({ ok: true, data: await status() });
  }
  if (request.method === "POST" && url.pathname === "/api/pair") {
    return json({ ok: true, data: await pairDevice(await readJson(request)) });
  }
  if (request.method === "POST" && url.pathname === "/api/prepare") {
    return json({ ok: true, data: await prepareBridge() });
  }
  if (request.method === "POST" && url.pathname === "/api/enroll") {
    return json({ ok: true, data: await enrollBridge() });
  }
  if (request.method === "POST" && url.pathname === "/api/open-platforms") {
    await browser(["open", "https://creator.xiaohongshu.com/publish/publish", "--mode", "new_tab"]);
    await browser(["open", "https://creator.douyin.com/creator-micro/content/upload", "--mode", "new_tab"]);
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/run") {
    return json({ ok: true, data: await runOnce() });
  }
  return json({ ok: false, error: "Not found" }, 404);
}

async function serve() {
  await ensureDirectories();
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host || "";
      if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
        response.writeHead(403).end();
        return;
      }
      const result = await route(request);
      response.writeHead(result.statusCode, {
        "Content-Type": result.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "本机助手发生错误";
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
  });
  server.listen(PORT, "127.0.0.1");
  setInterval(() => {
    runOnce().catch(() => undefined);
  }, WATCH_INTERVAL_MS).unref();
  process.stdout.write(`DailyForge companion: http://127.0.0.1:${PORT}\n`);
}

const command = process.argv[2] || "serve";
if (command === "serve") {
  await serve();
} else if (command === "once") {
  process.stdout.write(`${JSON.stringify(await runOnce())}\n`);
} else if (command === "doctor") {
  process.stdout.write(`${JSON.stringify(await status())}\n`);
} else if (command === "prepare") {
  process.stdout.write(`${JSON.stringify(await prepareBridge())}\n`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
