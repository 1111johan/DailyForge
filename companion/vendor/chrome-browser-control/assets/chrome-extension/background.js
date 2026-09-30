/*
 * Chrome Browser Control bridge service worker.
 *
 * The service worker is the only extension context that stores the long-lived
 * bridge token. Content scripts communicate with it using runtime messages;
 * pages never receive the token and never make requests to the loopback
 * server directly.
 */

const DEFAULT_BRIDGE_PORT = 16881;
const MAX_TEXT_LENGTH = 4000;
const MAX_RESULT_DEPTH = 8;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 16 * 1024 * 1024;
const SENSITIVE_KEY_RE = /(?:pass(?:word)?|cookie|token|secret|authorization|credential|file_?path|local_?path|outer_?html|inner_?html|html)/i;
const URL_KEY_RE = /^(?:url|href|tabUrl|newUrl|pageUrl|frameUrl)$/i;

let clientId = null;
let browserSessionId = null;
let bridgePort = null;
let bridgeToken = null;
const pageOperations = new Map();
let globalPolling = false;
const CONTENT_ACTIONS = {
  state: "get_state",
  get_state: "get_state",
  scan: "scan_elements",
  scan_elements: "scan_elements",
  find: "find_elements",
  find_elements: "find_elements",
  extract: "extract_elements",
  extract_elements: "extract_elements",
  snapshot: "snapshot",
  click_ref: "click_ref",
  highlight_ref: "highlight_ref",
  input: "input_selector",
  input_selector: "input_selector",
  type_text: "type_text",
  clear: "clear_selector",
  clear_selector: "clear_selector",
  focus: "focus_selector",
  focus_selector: "focus_selector",
  check: "check_selector",
  check_selector: "check_selector",
  drag_and_drop: "drag_and_drop",
  click: "click_selector",
  click_selector: "click_selector",
  hover: "hover_selector",
  hover_selector: "hover_selector",
  hover_text: "hover_text",
  click_text: "click_text",
  highlight: "highlight_selector",
  highlight_selector: "highlight_selector",
  wait_selector: "wait_selector",
  scroll: "scroll",
  press_key: "press_key",
  select: "select_option",
  select_option: "select_option",
  dblclick: "double_click_selector",
  double_click_selector: "double_click_selector",
  contextmenu: "context_menu_selector",
  context_menu_selector: "context_menu_selector"
};
const GLOBAL_ACTIONS = new Set([
  "open_url", "list_pages", "switch_page", "close_page", "list_windows",
  "switch_window", "close_window", "navigate", "screenshot"
]);
const BACKGROUND_ACTIONS = new Set([...GLOBAL_ACTIONS, "upload_file"]);

async function getGlobalClientId() {
  return `${await getClientId()}:global`;
}

function randomId(prefix) {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0")
    ).join("")}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function clampText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value == null ? "" : value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safePageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol.toLowerCase())) return "";
    // Query strings and fragments frequently contain credentials, tokens, or
    // personally identifying data. The only exception is the random,
    // non-secret bootstrap nonce used to correlate setup with its tab.
    let suffix = "";
    if (parsed.pathname === "/bridge-bootstrap") {
      const nonce = parsed.searchParams.get("bridge_nonce") || "";
      if (/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
        suffix = `?bridge_nonce=${encodeURIComponent(nonce)}`;
      }
    }
    return `${parsed.protocol.toLowerCase()}//${parsed.host}${parsed.pathname || "/"}${suffix}`;
  } catch (_error) {
    return "";
  }
}

function sanitizeForBridge(value, key = "", depth = 0) {
  if (depth > MAX_RESULT_DEPTH) return "[truncated]";
  const keyText = String(key || "");
  if (keyText.toLowerCase() === "value" || /value$/i.test(keyText) || SENSITIVE_KEY_RE.test(keyText)) {
    return "[redacted]";
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (keyText === "dataUrl") {
      return value.length <= MAX_SCREENSHOT_DATA_URL_LENGTH &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)
        ? value
        : "[redacted]";
    }
    if (URL_KEY_RE.test(keyText)) return safePageUrl(value);
    return clampText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => sanitizeForBridge(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 300)) {
      output[childKey] = sanitizeForBridge(childValue, childKey, depth + 1);
    }
    return output;
  }
  return String(value);
}

async function getClientId() {
  if (clientId) return clientId;
  const saved = await chrome.storage.local.get(["clientId"]);
  clientId = String(saved.clientId || "");
  if (!clientId) {
    clientId = randomId("chrome_bridge");
    await chrome.storage.local.set({ clientId });
  }
  return clientId;
}

async function getBrowserSessionId() {
  if (browserSessionId) return browserSessionId;
  const storage = chrome.storage.session || chrome.storage.local;
  const saved = await storage.get(["browserSessionId"]);
  browserSessionId = String(saved.browserSessionId || "");
  if (!browserSessionId) {
    browserSessionId = randomId("session");
    await storage.set({ browserSessionId });
  }
  return browserSessionId;
}

async function getBridgeConfig() {
  if (bridgePort != null && bridgeToken != null) {
    return { port: bridgePort, token: bridgeToken };
  }
  const saved = await chrome.storage.local.get(["bridgePort", "bridgeToken"]);
  const rawPort = Number(saved.bridgePort || DEFAULT_BRIDGE_PORT);
  bridgePort = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
    ? rawPort
    : DEFAULT_BRIDGE_PORT;
  bridgeToken = String(saved.bridgeToken || "");
  return { port: bridgePort, token: bridgeToken };
}

async function setBridgeConfig(portValue, tokenValue) {
  const rawPort = Number(portValue || DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) {
    throw new Error("invalid_bridge_port");
  }
  const token = String(tokenValue || "").trim();
  if (!token) throw new Error("bridge_pairing_failed");
  bridgePort = rawPort;
  bridgeToken = token;
  await chrome.storage.local.set({ bridgePort, bridgeToken });
  return { configured: true, paired: true, port: bridgePort };
}

async function publicBridgeConfig() {
  const config = await getBridgeConfig();
  return { configured: Boolean(config.token), paired: Boolean(config.token), port: config.port };
}

async function bridgeBase() {
  const config = await getBridgeConfig();
  return `http://127.0.0.1:${config.port}`;
}

async function bridgeFetch(path, options = {}, { requireToken = true } = {}) {
  const config = await getBridgeConfig();
  if (requireToken && !config.token) throw new Error("bridge_not_paired");
  const base = new URL(`http://127.0.0.1:${config.port}/`);
  const origin = base.origin;
  const target = new URL(String(path || ""), base);
  if (
    target.origin !== origin
    || target.username
    || target.password
    || target.search
    || target.hash
    || !String(path || "").startsWith("/")
    || String(path || "").startsWith("//")
    || String(path || "").includes("\\")
  ) {
    throw new Error("bridge_request_origin_denied");
  }
  const headers = new Headers(options.headers || {});
  if (requireToken) headers.set("X-Chrome-Control-Token", config.token);
  const response = await fetch(target.href, {
    ...options,
    headers,
    redirect: "error",
    cache: "no-store"
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const code = payload && (payload.error_code || payload.error);
    throw new Error(String(code || `bridge_http_${response.status}`));
  }
  return payload || {};
}

async function claimPairing(code, portValue) {
  const port = Number(portValue || DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("invalid_bridge_port");
  }
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(new URL("/api/pairing/claim", `${origin}/`).href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(code || "").trim() }),
    redirect: "error",
    cache: "no-store"
  });
  let payload = {};
  try { payload = await response.json(); } catch (_error) { payload = {}; }
  const token = String(payload.bridge_token || "").trim();
  if (!response.ok || !token) {
    throw new Error(String(payload.error_code || payload.error || "pairing_code_invalid"));
  }
  await setBridgeConfig(port, token);
  // Deliberately return no token to the content script.
  return { paired: true, configured: true, port };
}

async function pageId(tabId) {
  return `bridge:${await getBrowserSessionId()}:${Number(tabId)}`;
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  const url = String(tab.url || tab.pendingUrl || "");
  if (!/^https?:\/\//i.test(url)) return false;
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), allFrames: true },
    files: ["snapshot_core.js", "content.js"]
  });
  return true;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs, errorText) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorText)), Math.max(1000, Number(timeoutMs || 1000)));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function postBridgeResult(result) {
  const payload = sanitizeForBridge(result);
  return bridgeFetch("/api/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function sendToFrame(tabId, frameId, action, params) {
  const response = await chrome.tabs.sendMessage(
    Number(tabId),
    {
      action: "execute_frame_command",
      commandAction: action,
      params: { ...(params || {}), __localOnly: true }
    },
    { frameId: Number(frameId) }
  );
  if (response && response.error) throw new Error(String(response.error));
  return response || {};
}

function getAllFrames(tabId) {
  return new Promise((resolve) => {
    if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
      resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
      return;
    }
    chrome.webNavigation.getAllFrames({ tabId: Number(tabId) }, (frames) => {
      if (chrome.runtime.lastError) {
        resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
      } else {
        resolve(Array.isArray(frames) && frames.length
          ? frames
          : [{ frameId: 0, parentFrameId: -1, url: "" }]);
      }
    });
  });
}

async function frameInfo(tabId, frameId, url = "") {
  const frames = await getAllFrames(tabId);
  const frame = frames.find((item) => Number(item.frameId) === Number(frameId));
  return {
    frameId: Number(frameId),
    parentFrameId: Number(frame && frame.parentFrameId != null ? frame.parentFrameId : -1),
    url: safePageUrl(url || (frame && frame.url) || "")
  };
}

async function routeFrame(tabId, message) {
  const frameId = Math.max(0, Number(message.frameId || 0));
  const response = await sendToFrame(tabId, frameId, message.commandAction, message.params || {});
  return { response, frame: await frameInfo(tabId, frameId, message.url || "") };
}

async function executeAllFrames(tabId, message) {
  const frames = await getAllFrames(tabId);
  const results = [];
  for (const frame of frames) {
    const frameId = Number(frame.frameId || 0);
    try {
      const response = await sendToFrame(tabId, frameId, message.commandAction, message.params || {});
      results.push({
        ok: true,
        frame: {
          frameId,
          parentFrameId: Number(frame.parentFrameId == null ? -1 : frame.parentFrameId),
          url: safePageUrl(frame.url || "")
        },
        response
      });
    } catch (error) {
      results.push({
        ok: false,
        frame: {
          frameId,
          parentFrameId: Number(frame.parentFrameId == null ? -1 : frame.parentFrameId),
          url: safePageUrl(frame.url || "")
        },
        error: String(error && error.message ? error.message : error)
      });
    }
  }
  return { frames: results };
}

async function publicPage(tab, activeTabId = -1) {
  const tabId = Number(tab && tab.id);
  return {
    browserSessionId: await getBrowserSessionId(),
    pageId: await pageId(tabId),
    tabId,
    windowId: Number(tab && tab.windowId),
    url: safePageUrl(tab && (tab.url || tab.pendingUrl)),
    title: clampText((tab && tab.title) || "", 300),
    active: tabId === Number(activeTabId) || Boolean(tab && tab.active),
    status: String((tab && tab.status) || ""),
    controllable: /^https?:\/\//i.test(String(tab && (tab.url || tab.pendingUrl) || ""))
  };
}

async function pageIdentity(tabId, sender = {}) {
  const tab = await chrome.tabs.get(Number(tabId));
  return {
    ...(await publicPage(tab, Number(tabId))),
    frameId: Number(sender.frameId || 0),
    documentId: clampText(sender.documentId || "", 200),
    documentLifecycle: String(sender.documentLifecycle || "")
  };
}

async function listPages() {
  const tabs = await chrome.tabs.query({});
  const activeTab = tabs.find((tab) => tab.active);
  const activeTabId = Number(activeTab && activeTab.id);
  return {
    browserSessionId: await getBrowserSessionId(),
    pages: await Promise.all(tabs.map((tab) => publicPage(tab, activeTabId)))
  };
}

async function listWindows() {
  const pagesPayload = await listPages();
  const windows = new Map();
  for (const page of pagesPayload.pages) {
    const windowId = Number(page.windowId);
    if (!windows.has(windowId)) {
      windows.set(windowId, {
        browserSessionId: pagesPayload.browserSessionId,
        windowId,
        active: false,
        focused: false,
        pages: []
      });
    }
    const row = windows.get(windowId);
    row.pages.push(page);
    row.active = row.active || Boolean(page.active);
  }
  const chromeWindows = await chrome.windows.getAll();
  for (const item of chromeWindows) {
    const row = windows.get(Number(item.id));
    if (row) row.focused = Boolean(item.focused);
  }
  return { browserSessionId: pagesPayload.browserSessionId, windows: Array.from(windows.values()) };
}

async function switchWindow(message) {
  const windowId = Number(message.windowId);
  if (!Number.isInteger(windowId) || windowId < 0) throw new Error("window_not_found");
  await chrome.windows.update(windowId, { focused: true });
  const tabs = await chrome.tabs.query({ windowId });
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (active) await chrome.tabs.update(Number(active.id), { active: true });
  return {
    browserSessionId: await getBrowserSessionId(),
    windowId,
    focused: true,
    activePage: active ? await publicPage(active, Number(active.id)) : null
  };
}

async function closeWindow(message) {
  const windowId = Number(message.windowId);
  if (!Number.isInteger(windowId) || windowId < 0) throw new Error("window_not_found");
  await chrome.windows.get(windowId);
  await chrome.windows.remove(windowId);
  return {
    closed: true,
    browserSessionId: await getBrowserSessionId(),
    closedWindowId: windowId
  };
}

async function navigateTab(tabId, message) {
  const action = String(message.navigationAction || "");
  if (action === "reload") await chrome.tabs.reload(Number(tabId), {});
  else if (action === "back") await chrome.tabs.goBack(Number(tabId));
  else if (action === "forward") await chrome.tabs.goForward(Number(tabId));
  else throw new Error(`unsupported_navigation: ${action}`);
  return publicPage(await chrome.tabs.get(Number(tabId)), Number(tabId));
}

async function switchPage(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("page_not_found");
  if (String(message.pageId || "") !== await pageId(tabId)) throw new Error("page_session_expired");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(String(tab.url || tab.pendingUrl || ""))) {
    throw new Error("target_page_not_controllable");
  }
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await ensureContentScript(tabId);
  return publicPage(await chrome.tabs.get(tabId), tabId);
}

async function closePage(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("page_not_found");
  if (String(message.pageId || "") !== await pageId(tabId)) throw new Error("page_session_expired");
  const closedPageId = await pageId(tabId);
  await chrome.tabs.get(tabId);
  await chrome.tabs.remove(tabId);
  const remaining = await listPages();
  return {
    closed: true,
    closedPageId,
    closedTabId: tabId,
    activePage: remaining.pages.find((page) => page.active) || null
  };
}

function prunePageOperations() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [operationId, operation] of pageOperations.entries()) {
    if (Number(operation.createdAt || 0) < cutoff) pageOperations.delete(operationId);
  }
}

async function openUrl(tabId, message) {
  let parsedUrl = null;
  try { parsedUrl = new URL(String(message.url || "").trim()); } catch (_error) { /* rejected below */ }
  if (
    !parsedUrl
    || !["http:", "https:"].includes(parsedUrl.protocol.toLowerCase())
    || parsedUrl.username
    || parsedUrl.password
  ) {
    throw new Error("Only credential-free http and https URLs are supported.");
  }
  const url = parsedUrl.href;
  const openMode = String(message.openMode || "new_tab").trim();
  const operationId = String(message.operationId || "").trim();
  if (!["new_tab", "current_tab", "new_window"].includes(openMode)) {
    throw new Error(`Unsupported open mode: ${openMode}`);
  }
  const timeoutMs = Math.max(1000, Number(message.timeoutMs || 20000));
  prunePageOperations();
  if (operationId && pageOperations.has(operationId)) {
    const existing = pageOperations.get(operationId);
    return existing.response || existing.promise;
  }
  const execute = async () => {
    // The polling tab is part of the command's routing identity.  Falling
    // back to whichever tab is active can open a URL in the wrong page.
    const sourceTab = await withTimeout(
      chrome.tabs.get(Number(tabId)),
      5000,
      "page_not_found"
    );
    if (!sourceTab) throw new Error("page_not_found");
    let targetTab = null;
    if (openMode === "current_tab") {
      targetTab = await withTimeout(
        chrome.tabs.update(Number(sourceTab.id), { url, active: true }),
        5000,
        "page_create_failed"
      );
    } else if (openMode === "new_window") {
      const created = await withTimeout(chrome.windows.create({ url, focused: true }), 5000, "page_create_failed");
      targetTab = created && created.tabs && created.tabs[0];
    } else {
      targetTab = await withTimeout(
        chrome.tabs.create({ url, active: true, windowId: sourceTab.windowId }),
        5000,
        "page_create_failed"
      );
    }
    const targetTabId = Number(targetTab && targetTab.id);
    if (!Number.isInteger(targetTabId) || targetTabId < 0) throw new Error("page_create_failed");
    return {
      operationId,
      targetTabId,
      pageId: await pageId(targetTabId),
      browserSessionId: await getBrowserSessionId(),
      targetWindowId: Number(targetTab.windowId),
      openMode,
      active: Boolean(targetTab.active),
      url: safePageUrl(targetTab.url || targetTab.pendingUrl || url)
    };
  };
  if (!operationId) return execute();
  const operation = { createdAt: Date.now(), promise: null, response: null };
  operation.promise = execute();
  pageOperations.set(operationId, operation);
  try {
    operation.response = await operation.promise;
    return operation.response;
  } catch (error) {
    pageOperations.delete(operationId);
    throw error;
  }
}

async function screenshot(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!/^https?:\/\//i.test(String(tab.url || tab.pendingUrl || ""))) {
    throw new Error("target_page_not_controllable");
  }
  const activeTabs = await chrome.tabs.query({ active: true, windowId: Number(tab.windowId) });
  if (!tab.active || !activeTabs.some((candidate) => Number(candidate.id) === Number(tabId))) {
    throw new Error("target_page_not_active: switch to the target page before taking a screenshot");
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(Number(tab.windowId), { format: "png" });
  const activeAfterCapture = await chrome.tabs.query({ active: true, windowId: Number(tab.windowId) });
  if (!activeAfterCapture.some((candidate) => Number(candidate.id) === Number(tabId))) {
    throw new Error("screenshot_target_changed: discard the captured image and retry after observing pages");
  }
  if (String(dataUrl || "").length > MAX_SCREENSHOT_DATA_URL_LENGTH) {
    throw new Error("screenshot_too_large");
  }
  return { dataUrl: String(dataUrl || ""), url: safePageUrl(tab.url || tab.pendingUrl || "") };
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`debugger_attach_failed: ${error.message}`));
      else resolve();
    });
  });
}

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`debugger_command_failed: ${error.message}`));
      else resolve(response || {});
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function absoluteUploadPath(value) {
  const path = String(value || "");
  if (!path || path.includes("\0") || path.length > 32767) return false;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.startsWith("/") && !path.startsWith("//");
}

function attributesObject(attributes) {
  const result = {};
  const values = Array.isArray(attributes) ? attributes : [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    result[String(values[index] || "").toLowerCase()] = String(values[index + 1] || "");
  }
  return result;
}

async function uploadFiles(tabId, message) {
  const selector = String(message.selector || "").trim();
  const filePaths = Array.isArray(message.filePaths)
    ? message.filePaths.map((value) => String(value || ""))
    : [];
  if (!selector || selector.length > 2000) throw new Error("upload_selector_invalid");
  if (!filePaths.length || filePaths.length > 20 || !filePaths.every(absoluteUploadPath)) {
    throw new Error("upload_file_paths_invalid");
  }
  const tab = await chrome.tabs.get(Number(tabId));
  if (!/^https?:\/\//i.test(String(tab.url || tab.pendingUrl || ""))) {
    throw new Error("target_page_not_controllable");
  }
  const target = { tabId: Number(tabId) };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "DOM.enable");
    const documentResult = await debuggerSend(target, "DOM.getDocument", {
      depth: -1,
      pierce: true
    });
    const rootNodeId = Number(documentResult && documentResult.root && documentResult.root.nodeId);
    if (!Number.isInteger(rootNodeId) || rootNodeId <= 0) {
      throw new Error("upload_document_unavailable");
    }
    const queryResult = await debuggerSend(target, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector
    });
    const nodeId = Number(queryResult && queryResult.nodeId);
    if (!Number.isInteger(nodeId) || nodeId <= 0) {
      throw new Error("upload_input_not_found");
    }
    const described = await debuggerSend(target, "DOM.describeNode", { nodeId, depth: 0 });
    const node = described && described.node || {};
    const attributes = attributesObject(node.attributes);
    if (String(node.nodeName || "").toUpperCase() !== "INPUT" || String(attributes.type || "").toLowerCase() !== "file") {
      throw new Error("upload_target_not_file_input");
    }
    if (filePaths.length > 1 && !Object.prototype.hasOwnProperty.call(attributes, "multiple")) {
      throw new Error("upload_input_does_not_allow_multiple_files");
    }
    await debuggerSend(target, "DOM.setFileInputFiles", {
      files: filePaths,
      nodeId
    });
    return {
      uploaded: true,
      fileCount: filePaths.length,
      multiple: filePaths.length > 1
    };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function sendBackgroundResult(tabId, message, response, error = null) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const result = {
    client_id: String(message.clientId || ""),
    command_id: String(message.commandId || ""),
    ok: !error,
    data: error ? null : {
      tabUrl: safePageUrl(tab && (tab.url || tab.pendingUrl) || ""),
      tabTitle: clampText(tab && tab.title || "", 300),
      response
    },
    error: error ? String(error && error.message ? error.message : error) : "",
    source: "background_service_worker"
  };
  await postBridgeResult(result);
}

async function runCommandForContent(tabId, message) {
  const action = String(message.action || "");
  const operation = action === "navigate" ? navigateTab(tabId, message) :
    action === "open_url" ? openUrl(tabId, message) :
    action === "list_pages" ? listPages() :
    action === "switch_page" ? switchPage(message) :
    action === "close_page" ? closePage(message) :
    action === "list_windows" ? listWindows() :
    action === "switch_window" ? switchWindow(message) :
    action === "close_window" ? closeWindow(message) :
    action === "screenshot" ? screenshot(tabId) :
    action === "upload_file" ? uploadFiles(tabId, message) :
    Promise.reject(new Error(`Unsupported background action: ${action}`));
  try {
    const response = await operation;
    if (message.commandId) await sendBackgroundResult(tabId, message, response);
    return message.commandId ? { accepted: true } : response;
  } catch (error) {
    if (message.commandId) {
      try { await sendBackgroundResult(tabId, message, null, error); } catch (_postError) { /* bridge may be offline */ }
      return { accepted: true };
    }
    throw error;
  }
}

async function handleBridgePoll(tabId, payload) {
  const tab = await chrome.tabs.get(Number(tabId));
  const page = await publicPage(tab, Number(tabId));
  const identity = payload && payload.identity && typeof payload.identity === "object"
    ? payload.identity
    : {};
  const clean = {
    client_id: clampText(payload && payload.client_id || await getClientId(), 200),
    tab_id: Number(tabId),
    page_id: page.pageId,
    browser_session_id: page.browserSessionId,
    window_id: page.windowId,
    client_scope: String(payload && (payload.client_scope || payload.scope) || "document"),
    url: safePageUrl(payload && payload.url || tab.url || tab.pendingUrl || ""),
    title: clampText(payload && payload.title || tab.title || "", 300),
    ready_state: clampText(payload && payload.ready_state || "", 40),
    document_id: clampText(identity.documentId || payload && payload.document_id || "", 200),
    document_lifecycle: clampText(identity.documentLifecycle || payload && payload.document_lifecycle || "", 40),
    extension_version: clampText(payload && payload.extension_version || chrome.runtime.getManifest().version, 40),
    protocol_version: Number(payload && payload.protocol_version || 4)
  };
  return bridgeFetch("/api/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clean)
  });
}

async function dispatchGlobalCommand(tabId, command) {
  const globalClientId = await getGlobalClientId();
  const message = {
    ...(command.params || {}),
    action: String(command.action || ""),
    commandId: String(command.id || ""),
    clientId: globalClientId
  };
  if (message.action === "state" || message.action === "get_state") {
    const tab = await chrome.tabs.get(Number(tabId));
    const page = await publicPage(tab, Number(tabId));
    await sendBackgroundResult(tabId, message, {
      url: page.url,
      title: page.title,
      readyState: String(tab.status || ""),
      frame: { frameId: 0, parentFrameId: -1, url: page.url },
      identity: {
        ...page,
        frameId: 0,
        documentId: "",
        documentLifecycle: "active"
      }
    });
    return;
  }
  if (!GLOBAL_ACTIONS.has(message.action)) {
    await sendBackgroundResult(
      tabId,
      message,
      null,
      new Error("global_client_dom_forbidden: the global client may receive browser-level commands only")
    );
    return;
  }
  await runCommandForContent(tabId, message);
}

async function globalPollOnce() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallback = tabs.length ? tabs : await chrome.tabs.query({ active: true });
  const tab = fallback[0];
  if (!tab || !Number.isInteger(Number(tab.id))) {
    await delay(1000);
    return;
  }
  const globalClientId = await getGlobalClientId();
  const payload = await handleBridgePoll(Number(tab.id), {
    client_id: globalClientId,
    url: safePageUrl(tab.url || tab.pendingUrl || ""),
    title: tab.title || "",
    ready_state: tab.status || "",
    client_scope: "browser",
    extension_version: chrome.runtime.getManifest().version,
    protocol_version: 4
  });
  const commands = Array.isArray(payload && payload.commands) ? payload.commands : [];
  for (const command of commands) {
    try {
      if (command.lease) {
        const lease = await handleLeaseValidation({ lease: command.lease });
        if (!(lease && lease.current === true)) {
          await sendBackgroundResult(Number(tab.id), {
            commandId: command.id,
            clientId: globalClientId
          }, null, new Error("stale_page_lease: fencing token is no longer current"));
          continue;
        }
      }
      await dispatchGlobalCommand(Number(tab.id), command);
    } catch (error) {
      try {
        await sendBackgroundResult(Number(tab.id), {
          commandId: command.id,
          clientId: globalClientId
        }, null, error);
      } catch (_postError) { /* bridge may be offline */ }
    }
  }
}

async function startGlobalPolling() {
  if (globalPolling) return;
  globalPolling = true;
  while (globalPolling) {
    try {
      const config = await getBridgeConfig();
      if (!config.token) {
        await delay(1500);
        continue;
      }
      await globalPollOnce();
    } catch (_error) {
      await delay(1000);
    }
  }
}

async function handleBridgeResult(message) {
  const result = message && message.result && typeof message.result === "object" ? message.result : {};
  return postBridgeResult(result);
}

async function handleLeaseValidation(message) {
  const lease = message && message.lease && typeof message.lease === "object" ? message.lease : {};
  return bridgeFetch("/api/lease/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resource: clampText(lease.resource || "", 200),
      owner_id: clampText(lease.owner_id || "", 200),
      epoch: Number(lease.epoch || 0),
      page_id: clampText(lease.page_id || "", 300),
      client_id: clampText(lease.client_id || "", 200),
      tab_id: Number(lease.tab_id == null ? -1 : lease.tab_id)
    })
  });
}

chrome.runtime.onInstalled.addListener(() => {
  getClientId();
  getBrowserSessionId();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") return;
  const action = message.action;
  const tabId = sender && sender.tab && Number(sender.tab.id);
  const hasTab = Number.isInteger(tabId) && tabId >= 0;

  // These messages are the only path from a content script to the loopback
  // server. The server token is never included in any response here.
  if (action === "claim_pairing") {
    claimPairing(message.code, message.port)
      .then((result) => {
        startGlobalPolling();
        sendResponse(result);
      })
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "get_bridge_config") {
    publicBridgeConfig()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "bridge_poll") {
    if (!hasTab) { sendResponse({ error: "Unable to resolve the current Chrome tab." }); return; }
    handleBridgePoll(tabId, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "bridge_result") {
    handleBridgeResult(message)
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "bridge_validate_lease") {
    handleLeaseValidation(message)
      .then((result) => sendResponse(result || { current: false }))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "get_tab_id") {
    if (!hasTab) { sendResponse({ error: "Unable to resolve the current Chrome tab." }); return; }
    sendResponse({ tabId });
    return;
  }
  if (action === "get_page_identity") {
    if (!hasTab) { sendResponse({ error: "Unable to resolve the current Chrome tab." }); return; }
    pageIdentity(tabId, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "route_frame" || action === "execute_all_frames") {
    if (!hasTab) { sendResponse({ error: "Unable to resolve the current Chrome tab." }); return; }
    const operation = action === "route_frame" ? routeFrame(tabId, message) : executeAllFrames(tabId, message);
    operation
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (BACKGROUND_ACTIONS.has(action)) {
    if (!hasTab) { sendResponse({ error: "Unable to resolve the current Chrome tab." }); return; }
    runCommandForContent(tabId, message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
    return true;
  }
  if (action === "ping") { sendResponse({ ok: true }); return; }
});

// A global poller handles lifecycle commands even when the active tab is a
// Chrome internal page. Normal pages still run their own per-document poller
// so targeted commands remain pinned to the requested page.
getBridgeConfig().then((config) => {
  if (config.token) startGlobalPolling();
}).catch(() => { /* setup has not paired the extension yet */ });
