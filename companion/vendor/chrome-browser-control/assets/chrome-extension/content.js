(function () {
  const CONTENT_VERSION = "0.2.0";
  const PROTOCOL_VERSION = 4;
  if (window.__rpaChromeBridgeVersion === CONTENT_VERSION) return;
  window.__rpaChromeBridgeInstalled = true;
  window.__rpaChromeBridgeVersion = CONTENT_VERSION;

  const DEFAULT_BRIDGE_PORT = 16881;
  let documentClientId = "";
  const IS_TOP_FRAME = window === window.top;
  let bridgePort = 0;

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

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function publicUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (!["http:", "https:"].includes(parsed.protocol.toLowerCase())) return "";
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

  const ELEMENT_SELECTOR = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[placeholder]",
    "[role='button']",
    "[aria-label]",
    "[data-testid]",
    "[data-cy]",
    "[data-test-tag]"
  ].join(",");
  const STABLE_SELECTOR_ATTRIBUTES = [
    "name",
    "aria-label",
    "title",
    "type",
    "placeholder"
  ];
  const FINDABLE_ATTRIBUTES = new Set([
    "id",
    "name",
    "aria-label",
    "title",
    "type",
    "placeholder",
    "data-testid",
    "data-cy",
    "data-test-tag",
    "href"
  ]);
  const IMPLICIT_ROLES = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox"
  };

  function normalizedText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function cssAttributeValue(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\d ")
      .replace(/\n/g, "\\a ");
  }

  function attributeSelector(tag, name, value) {
    return `${tag}[${name}="${cssAttributeValue(value)}"]`;
  }

  function visibleRect(el) {
    if (!el || !el.isConnected || el.hidden) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(el);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      Number.parseFloat(style.opacity || "1") <= 0
    ) {
      return null;
    }
    return rect;
  }

  function elementRole(el) {
    const explicit = normalizedText(el.getAttribute("role")).toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return IMPLICIT_ROLES[tag] || "";
  }

  function rootQueryAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function selectorMatchCount(root, selector) {
    return rootQueryAll(root, selector).length;
  }

  function structuralSelector(el, root) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1) {
      const tag = current.tagName.toLowerCase();
      if (current.id) {
        const idSelector = `#${cssEscape(current.id)}`;
        if (selectorMatchCount(root, idSelector) === 1) {
          parts.unshift(idSelector);
          break;
        }
      }
      let segment = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (item) => item.tagName === current.tagName
        );
        if (siblings.length > 1) {
          segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(segment);
      if (!parent || current.parentNode === root) break;
      current = parent;
    }
    return parts.join(" > ");
  }

  function selectorInfo(el, root = document) {
    const tag = el.tagName.toLowerCase();
    const candidates = [];
    if (el.id) {
      candidates.push({ selector: `#${cssEscape(el.id)}`, strategy: "id" });
    }
    for (const name of ["data-testid", "data-cy", "data-test-tag"]) {
      const value = el.getAttribute(name);
      if (value) {
        candidates.push({
          selector: attributeSelector(tag, name, value),
          strategy: name
        });
      }
    }
    for (const name of STABLE_SELECTOR_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value) {
        candidates.push({
          selector: attributeSelector(tag, name, value),
          strategy: name
        });
      }
    }
    const stableValues = STABLE_SELECTOR_ATTRIBUTES
      .map((name) => [name, el.getAttribute(name)])
      .filter((item) => item[1]);
    for (let left = 0; left < stableValues.length; left += 1) {
      for (let right = left + 1; right < stableValues.length; right += 1) {
        const [leftName, leftValue] = stableValues[left];
        const [rightName, rightValue] = stableValues[right];
        candidates.push({
          selector:
            `${tag}[${leftName}="${cssAttributeValue(leftValue)}"]` +
            `[${rightName}="${cssAttributeValue(rightValue)}"]`,
          strategy: `${leftName}+${rightName}`
        });
      }
    }

    let firstValid = null;
    for (const candidate of candidates) {
      const matchCount = selectorMatchCount(root, candidate.selector);
      if (!matchCount) continue;
      if (!firstValid) firstValid = { ...candidate, matchCount };
      if (matchCount === 1) return { ...candidate, matchCount };
    }

    const path = structuralSelector(el, root);
    const pathCount = selectorMatchCount(root, path);
    if (pathCount) {
      return {
        selector: path,
        strategy: "structural_path",
        matchCount: pathCount
      };
    }
    return firstValid || {
      selector: tag,
      strategy: "tag_fallback",
      matchCount: selectorMatchCount(root, tag)
    };
  }

  function collectRoots(root = document, shadowPath = [], includeShadow = true, out = []) {
    out.push({ root, shadowPath });
    if (!includeShadow) return out;
    for (const el of rootQueryAll(root, "*")) {
      if (!el.shadowRoot) continue;
      const hostInfo = selectorInfo(el, root);
      collectRoots(
        el.shadowRoot,
        [...shadowPath, hostInfo.selector],
        includeShadow,
        out
      );
    }
    return out;
  }

  function resolveRoot(shadowPath) {
    let root = document;
    for (const hostSelector of Array.isArray(shadowPath) ? shadowPath : []) {
      const host = root.querySelector(hostSelector);
      if (!host) throw new Error(`Shadow host not found: ${hostSelector}`);
      if (!host.shadowRoot) throw new Error(`Shadow root is not open: ${hostSelector}`);
      root = host.shadowRoot;
    }
    return root;
  }

  function findElement(selector, shadowPath = []) {
    if (!selector) throw new Error("Missing selector.");
    const root = resolveRoot(shadowPath);
    const matches = rootQueryAll(root, selector);
    if (!matches.length) throw new Error(`Element not found: ${selector}`);
    const el = matches.find((candidate) => visibleRect(candidate));
    if (!el) throw new Error(`element_not_visible: ${selector}`);
    return { el, root };
  }

  function frameSummary(frameId = IS_TOP_FRAME ? 0 : -1) {
    return {
      frameId,
      parentFrameId: IS_TOP_FRAME ? -1 : null,
      url: publicUrl(location.href)
    };
  }

  function elementSummary(el, score = 0, root = document, shadowPath = []) {
    const rect = el.getBoundingClientRect();
    const selector = selectorInfo(el, root);
    return {
      tag: el.tagName.toLowerCase(),
      role: elementRole(el),
      text: normalizedText(el.innerText || el.textContent || "").slice(0, 120),
      aria: el.getAttribute("aria-label"),
      title: el.getAttribute("title"),
      id: el.id || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      testid: el.getAttribute("data-testid"),
      datacy: el.getAttribute("data-cy"),
      testtag: el.getAttribute("data-test-tag"),
      href: (() => {
        try { return publicUrl(new URL(el.getAttribute("href") || "", document.baseURI).href); }
        catch (_error) { return ""; }
      })(),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      pageX: Math.round(rect.left + window.scrollX),
      pageY: Math.round(rect.top + window.scrollY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      selector: selector.selector,
      selectorHint: selector.selector,
      selectorStrategy: selector.strategy,
      matchCount: selector.matchCount,
      shadowPath: [...shadowPath],
      frame: frameSummary(),
      score,
      // Never return outerHTML: it can contain hidden inputs, tokens, or
      // other page secrets unrelated to the requested browser action.
    };
  }

  function searchableTexts(el) {
    return [
      normalizedText(el.innerText || el.textContent || ""),
      normalizedText(el.getAttribute("aria-label")),
      normalizedText(el.getAttribute("title")),
      normalizedText(el.getAttribute("placeholder")),
      // Current input values are deliberately not searchable or extractable.
    ].filter(Boolean);
  }

  function normalizeScanParams(params) {
    return {
      maxTop: Number(params.maxTop ?? 260),
      offsetTop: Math.max(0, Number(params.offsetTop ?? 0)),
      segmentHeight: Math.max(0, Number(params.segmentHeight ?? 0)),
      limit: Math.max(1, Math.min(1000, Number(params.limit ?? 80))),
      includeShadow: params.includeShadow !== false
    };
  }

  function scanElementsLocal(params) {
    const options = normalizeScanParams(params || {});
    const upperBound = options.segmentHeight > 0
      ? options.offsetTop + options.segmentHeight
      : options.maxTop > 0
        ? options.maxTop
        : Number.POSITIVE_INFINITY;
    const out = [];
    let matchedBeforeLimit = 0;
    for (const rootInfo of collectRoots(document, [], options.includeShadow)) {
      for (const el of rootQueryAll(rootInfo.root, ELEMENT_SELECTOR)) {
        const rect = visibleRect(el);
        if (!rect) continue;
        const pageTop = rect.top + window.scrollY;
        if (pageTop < options.offsetTop || pageTop > upperBound) continue;
        matchedBeforeLimit += 1;
        if (out.length < options.limit) {
          out.push(elementSummary(el, 0, rootInfo.root, rootInfo.shadowPath));
        }
      }
    }
    return {
      elements: out,
      meta: {
        offsetTop: options.offsetTop,
        segmentHeight: options.segmentHeight,
        maxTop: options.maxTop,
        limit: options.limit,
        returned: out.length,
        matched: matchedBeforeLimit,
        hasMore: matchedBeforeLimit > out.length,
        documentHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        )
      }
    };
  }

  function validateFindParams(params) {
    const text = normalizedText(params.text);
    const exact = params.exact === true;
    const role = normalizedText(params.role).toLowerCase();
    const tag = normalizedText(params.tag).toLowerCase();
    const attrs = params.attr && typeof params.attr === "object" ? params.attr : {};
    const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 10)));
    if (tag && !/^[a-z][a-z0-9-]*$/.test(tag)) {
      throw new Error(`Invalid tag: ${tag}`);
    }
    for (const name of Object.keys(attrs)) {
      if (!FINDABLE_ATTRIBUTES.has(name)) {
        throw new Error(`Unsupported find attribute: ${name}`);
      }
    }
    if (!text && !role && !tag && !Object.keys(attrs).length) {
      throw new Error("find requires text, role, tag, or attr.");
    }
    return {
      text,
      exact,
      role,
      tag,
      attrs,
      limit,
      includeShadow: params.includeShadow !== false
    };
  }

  function findElementsLocal(params) {
    const options = validateFindParams(params || {});
    const matches = [];
    let documentOrder = 0;
    for (const rootInfo of collectRoots(document, [], options.includeShadow)) {
      const baseSelector = options.tag ||
        (options.text && !options.role && !Object.keys(options.attrs).length
          ? ELEMENT_SELECTOR
          : "*");
      for (const el of rootQueryAll(rootInfo.root, baseSelector)) {
        documentOrder += 1;
        if (!visibleRect(el)) continue;
        const actualRole = elementRole(el);
        if (options.role && actualRole !== options.role) continue;
        if (Object.entries(options.attrs).some(
          ([name, expected]) =>
            String(el.getAttribute(name) || "") !== String(expected ?? "")
        )) {
          continue;
        }

        const texts = searchableTexts(el);
        const exactTextMatch = options.text && texts.some((value) => value === options.text);
        const containsTextMatch = options.text && texts.some(
          (value) => value.includes(options.text)
        );
        if (
          options.text &&
          ((options.exact && !exactTextMatch) || (!options.exact && !containsTextMatch))
        ) {
          continue;
        }

        const selector = selectorInfo(el, rootInfo.root);
        let score = 0;
        if (exactTextMatch) score += 50;
        else if (containsTextMatch) score += 30;
        if (options.role) score += 25;
        if (options.tag) score += 15;
        score += Object.keys(options.attrs).length * 20;
        if (selector.matchCount === 1) score += 15;
        if (["id", "data-testid", "data-cy", "data-test-tag"].includes(selector.strategy)) {
          score += 10;
        }
        matches.push({
          summary: elementSummary(
            el,
            score,
            rootInfo.root,
            rootInfo.shadowPath
          ),
          order: documentOrder
        });
      }
    }
    matches.sort(
      (left, right) =>
        right.summary.score - left.summary.score ||
        left.order - right.order
    );
    return {
      elements: matches.slice(0, options.limit).map((item) => item.summary),
      meta: {
        limit: options.limit,
        matched: matches.length,
        hasMore: matches.length > options.limit
      }
    };
  }

  function attachFrameToResponse(response, frame) {
    if (!response || typeof response !== "object") return response;
    const cloned = { ...response };
    if (Array.isArray(cloned.elements)) {
      cloned.elements = cloned.elements.map((item) => ({ ...item, frame }));
    }
    for (const key of [
      "clicked",
      "hovered",
      "input",
      "highlighted",
      "selected",
      "doubleClicked",
      "contextMenu",
      "waited",
      "keyPressed",
      "scrolled"
    ]) {
      if (cloned[key] && typeof cloned[key] === "object") {
        cloned[key] = { ...cloned[key], frame };
      }
    }
    return cloned;
  }

  function mergeFrameResponses(payload, limit, sortByScore = false) {
    const frames = Array.isArray(payload && payload.frames) ? payload.frames : [];
    const elements = [];
    const frameResults = [];
    let matched = 0;
    let hasMore = false;
    for (const item of frames) {
      if (!item.ok || !item.response) {
        frameResults.push(item);
        continue;
      }
      const response = attachFrameToResponse(item.response, item.frame);
      if (Array.isArray(response.elements)) elements.push(...response.elements);
      if (response.meta) {
        matched += Number(response.meta.matched || 0);
        hasMore = hasMore || Boolean(response.meta.hasMore);
      }
      frameResults.push({ ...item, response });
    }
    if (sortByScore) {
      elements.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    }
    const requestedLimit = Math.max(1, Math.min(1000, Number(limit || elements.length || 1)));
    const returnedElements = elements.slice(0, requestedLimit);
    return {
      elements: returnedElements,
      frames: frameResults,
      meta: {
        frameCount: frames.length,
        returned: returnedElements.length,
        matched,
        hasMore: hasMore || elements.length > returnedElements.length
      }
    };
  }

  function runtimeMessage(message) {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      return Promise.reject(new Error("Chrome extension runtime is unavailable."));
    }
    return chrome.runtime.sendMessage(message).then((response) => {
      if (response && response.error) throw new Error(response.error);
      return response;
    });
  }

  async function getBridgeConfig() {
    const params = new URLSearchParams(location.search);
    const pairingCode = params.get("pairing_code") || "";
    const bridgeNonce = params.get("bridge_nonce") || "";
    const rawPort = Number(params.get("bridge_port") || location.port || DEFAULT_BRIDGE_PORT);
    const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
      ? rawPort
      : DEFAULT_BRIDGE_PORT;
    if (pairingCode && location.hostname === "127.0.0.1" && location.pathname === "/bridge-bootstrap") {
      const paired = await runtimeMessage({
        action: "claim_pairing",
        code: pairingCode,
        port
      });
      bridgePort = Number(paired && paired.port || port);
      // Remove the one-time code from the visible URL as soon as it is claimed.
      try {
        const suffix = /^[A-Za-z0-9_-]{8,128}$/.test(bridgeNonce)
          ? `?bridge_nonce=${encodeURIComponent(bridgeNonce)}`
          : "";
        window.history.replaceState({}, document.title, `/bridge-bootstrap${suffix}`);
      } catch (_error) { /* ignore */ }
      document.title = "Chrome Browser Control paired";
      const status = document.querySelector("p");
      if (status) {
        status.textContent = "Chrome Browser Control is paired. You may close this tab.";
      }
      return { port: bridgePort };
    }
    if (bridgePort) return { port: bridgePort };
    const response = await runtimeMessage({ action: "get_bridge_config" });
    const responsePort = Number(response && response.port || DEFAULT_BRIDGE_PORT);
    bridgePort = Number.isInteger(responsePort) && responsePort > 0 && responsePort <= 65535
      ? responsePort
      : DEFAULT_BRIDGE_PORT;
    if (!(response && response.configured)) throw new Error("bridge_not_paired");
    return { port: bridgePort };
  }

  async function optionalPageIdentity() {
    try {
      return await runtimeMessage({ action: "get_page_identity" });
    } catch (_error) {
      return {};
    }
  }

  async function routeAction(action, params, localHandler, allowAllFrames = false) {
    if (params.__localOnly || !IS_TOP_FRAME) return localHandler(params);
    if (allowAllFrames && params.allFrames === true) {
      const payload = await runtimeMessage({
        action: "execute_all_frames",
        commandAction: action,
        params: { ...params, allFrames: false }
      });
      return mergeFrameResponses(
        payload,
        params.limit,
        action === "find_elements"
      );
    }
    const frameId = Number(params.frameId || 0);
    if (frameId > 0) {
      const payload = await runtimeMessage({
        action: "route_frame",
        frameId,
        commandAction: action,
        params
      });
      return attachFrameToResponse(payload.response, payload.frame);
    }
    return localHandler(params);
  }

  function dispatchHover(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const eventParams = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    for (const target of [el, el.parentElement].filter(Boolean)) {
      for (const type of [
        "pointerover",
        "pointerenter",
        "mouseover",
        "mouseenter",
        "mousemove"
      ]) {
        const EventClass =
          type.startsWith("pointer") && window.PointerEvent
            ? PointerEvent
            : MouseEvent;
        target.dispatchEvent(new EventClass(type, eventParams));
      }
    }
  }

  function pointerEventParams(el, extras = {}) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      ...extras
    };
  }

  function clickSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", pointerEventParams(el)));
    el.dispatchEvent(new MouseEvent("mousedown", pointerEventParams(el, { button: 0 })));
    el.click();
    el.dispatchEvent(new MouseEvent("mouseup", pointerEventParams(el, { button: 0 })));
    return { clicked: elementSummary(el, 0, root, params.shadowPath) };
  }

  function hoverSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    dispatchHover(el);
    return { hovered: elementSummary(el, 0, root, params.shadowPath) };
  }

  function elementValue(el) {
    if (el.isContentEditable) {
      return String(typeof el.innerText === "string" ? el.innerText : el.textContent || "");
    }
    return String(el.value ?? "");
  }

  function normalizedEditableText(value) {
    return String(value ?? "")
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function elementValueMatches(el, value, expected) {
    if (!el.isContentEditable) return value === expected;
    return normalizedEditableText(value) === normalizedEditableText(expected);
  }

  function assertSafeInputElement(el) {
    const type = String(el.getAttribute("type") || "text").trim().toLowerCase();
    const autocomplete = String(el.getAttribute("autocomplete") || "").trim().toLowerCase();
    if (
      type === "password" ||
      autocomplete.split(/\s+/).some((token) =>
        ["current-password", "new-password", "one-time-code"].includes(token)
      )
    ) {
      throw new Error("sensitive_input_blocked");
    }
  }

  async function settleElementPaint() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await delay(40);
  }

  async function inputSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    assertSafeInputElement(el);
    const text = String(params.text ?? "");
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      if (document.execCommand("insertText", false, text)) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await settleElementPaint();
        const value = elementValue(el);
        if (!visibleRect(el)) throw new Error(`element_not_visible: ${params.selector}`);
        if (!elementValueMatches(el, value, text)) {
          throw new Error(`input_value_mismatch: ${params.selector}`);
        }
        return {
          input: {
            ...elementSummary(el, 0, root, params.shadowPath),
            valueLength: value.length,
            visible: true,
            valueMatches: true
          }
        };
      }
      el.textContent = text;
    } else {
      const prototype = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, text);
      else el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settleElementPaint();
    const value = elementValue(el);
    if (!visibleRect(el)) throw new Error(`element_not_visible: ${params.selector}`);
    if (!elementValueMatches(el, value, text)) {
      throw new Error(`input_value_mismatch: ${params.selector}`);
    }
    return {
      input: {
        ...elementSummary(el, 0, root, params.shadowPath),
        valueLength: value.length,
        visible: true,
        valueMatches: true
      }
    };
  }

  function setElementValue(el, text) {
    if (el.isContentEditable) {
      el.textContent = text;
      return;
    }
    const prototype = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, text);
    else el.value = text;
  }

  async function typeTextLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    assertSafeInputElement(el);
    const text = String(params.text ?? "");
    const delayMs = Math.max(0, Math.min(1000, Number(params.delayMs || 40)));
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    for (const character of text) {
      const current = el.isContentEditable ? String(el.textContent || "") : String(el.value || "");
      setElementValue(el, current + character);
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: character
      }));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settleElementPaint();
    const value = elementValue(el);
    if (!visibleRect(el)) throw new Error(`element_not_visible: ${params.selector}`);
    return {
      typed: {
        ...elementSummary(el, 0, root, params.shadowPath),
        characters: text.length,
        synthetic: true,
        valueLength: value.length,
        visible: true
      }
    };
  }

  function clearSelectorLocal(params) {
    return inputSelectorLocal({ ...(params || {}), text: "" });
  }

  function focusSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    return { focused: elementSummary(el, 0, root, params.shadowPath) };
  }

  function checkSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    const type = String(el.type || "").toLowerCase();
    if (!['checkbox', 'radio'].includes(type)) throw new Error("Element is not checkable.");
    const checked = params.checked !== false;
    if (Boolean(el.checked) !== checked) el.click();
    if (Boolean(el.checked) !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {
      checked: {
        ...elementSummary(el, 0, root, params.shadowPath),
        checkedState: Boolean(el.checked)
      }
    };
  }

  function dragAndDropLocal(params) {
    const source = findElement(params.sourceSelector, params.sourceShadowPath || params.shadowPath);
    const target = findElement(params.targetSelector, params.targetShadowPath || params.shadowPath);
    source.el.scrollIntoView({ block: "center", inline: "center" });
    target.el.scrollIntoView({ block: "center", inline: "center" });
    const transfer = new DataTransfer();
    for (const type of ["dragstart", "drag", "dragenter", "dragover", "drop", "dragend"]) {
      const eventTarget = ["dragstart", "drag", "dragend"].includes(type) ? source.el : target.el;
      eventTarget.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
    }
    return {
      dragged: true,
      synthetic: true,
      source: elementSummary(source.el, 0, source.root, params.sourceShadowPath || params.shadowPath),
      target: elementSummary(target.el, 0, target.root, params.targetShadowPath || params.shadowPath)
    };
  }

  function highlightSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    const previous = el.style.outline;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.style.outline = "3px solid #ff3b30";
    setTimeout(() => {
      el.style.outline = previous;
    }, Number(params.duration || 1600));
    return { highlighted: elementSummary(el, 0, root, params.shadowPath) };
  }

  function clickPointLocal(params) {
    const root = resolveRoot(params.shadowPath);
    if (!params.selector) throw new Error("selector_not_found");
    const matches = rootQueryAll(root, params.selector);
    if (!matches.length) throw new Error("selector_not_found");
    if (params.requireUnique && matches.length !== 1) {
      throw new Error("selector_not_unique");
    }
    const el = matches[0];
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = visibleRect(el);
    if (!rect) throw new Error(`Element is not visible: ${params.selector}`);
    return {
      point: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        selector: params.selector,
        shadowPath: Array.isArray(params.shadowPath) ? params.shadowPath : [],
        element: elementSummary(el, 0, root, params.shadowPath)
      }
    };
  }

  function inspectPointLocal(params) {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("point_coordinates_invalid");
    }
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      throw new Error("point_outside_viewport");
    }
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length) throw new Error("point_element_not_found");
    const direct = stack[0];
    const interactive = direct.closest(ELEMENT_SELECTOR);
    const target = interactive || direct;
    return {
      point: {
        x: Math.round(x),
        y: Math.round(y),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        element: elementSummary(target),
        directElement: target === direct ? null : elementSummary(direct),
        stack: stack.slice(0, 8).map((element) => elementSummary(element))
      }
    };
  }

  function scrollLocal(params) {
    const behavior = ["auto", "smooth"].includes(params.behavior)
      ? params.behavior
      : "auto";
    if (params.selector) {
      const { el, root } = findElement(params.selector, params.shadowPath);
      const block = ["start", "center", "end", "nearest"].includes(params.block)
        ? params.block
        : "center";
      el.scrollIntoView({ behavior, block, inline: "nearest" });
      return {
        scrolled: {
          ...elementSummary(el, 0, root, params.shadowPath),
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      };
    }
    window.scrollTo({
      left: Number(params.x || 0),
      top: Number(params.y || 0),
      behavior
    });
    return {
      scrolled: {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        frame: frameSummary()
      }
    };
  }

  function pressKeyLocal(params) {
    const key = String(params.key || "");
    if (!key) throw new Error("Missing key.");
    const target = params.selector
      ? findElement(params.selector, params.shadowPath).el
      : document.activeElement || document.body;
    if (!target) throw new Error("No keyboard target is available.");
    assertSafeInputElement(target);
    target.focus();
    const eventParams = {
      key,
      code: String(params.code || key),
      bubbles: true,
      cancelable: true,
      ctrlKey: params.ctrl === true,
      altKey: params.alt === true,
      shiftKey: params.shift === true,
      metaKey: params.meta === true
    };
    const keydownEvent = new KeyboardEvent("keydown", eventParams);
    target.dispatchEvent(keydownEvent);
    target.dispatchEvent(new KeyboardEvent("keypress", eventParams));
    target.dispatchEvent(new KeyboardEvent("keyup", eventParams));
    return {
      keyPressed: {
        key,
        code: eventParams.code,
        accepted: true,
        dispatched: true,
        defaultPrevented: keydownEvent.defaultPrevented,
        outcome: "dispatched_unverified",
        selector: params.selector || "",
        shadowPath: Array.isArray(params.shadowPath) ? params.shadowPath : [],
        frame: frameSummary()
      }
    };
  }

  function selectOptionLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    if (el.tagName.toLowerCase() !== "select") {
      throw new Error(`Element is not a select: ${params.selector}`);
    }
    const options = Array.from(el.options || []);
    let option = null;
    if (String(params.value || "")) {
      option = options.find((item) => item.value === String(params.value));
    } else if (String(params.label || "")) {
      option = options.find(
        (item) => normalizedText(item.textContent) === normalizedText(params.label)
      );
    } else if (Number(params.index) >= 0) {
      option = options[Number(params.index)] || null;
    }
    if (!option) throw new Error("Select option not found.");
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      selected: {
        ...elementSummary(el, 0, root, params.shadowPath),
        selectedLabel: normalizedText(option.textContent),
        selectedIndex: option.index
      }
    };
  }

  function doubleClickSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    el.scrollIntoView({ block: "center", inline: "center" });
    for (let detail = 1; detail <= 2; detail += 1) {
      el.dispatchEvent(new MouseEvent("mousedown", pointerEventParams(el, {
        button: 0,
        buttons: 1,
        detail
      })));
      el.dispatchEvent(new MouseEvent("mouseup", pointerEventParams(el, {
        button: 0,
        buttons: 0,
        detail
      })));
      el.dispatchEvent(new MouseEvent("click", pointerEventParams(el, {
        button: 0,
        buttons: 0,
        detail
      })));
    }
    el.dispatchEvent(new MouseEvent("dblclick", pointerEventParams(el, {
      button: 0,
      buttons: 1,
      detail: 2
    })));
    return { doubleClicked: elementSummary(el, 0, root, params.shadowPath) };
  }

  function contextMenuSelectorLocal(params) {
    const { el, root } = findElement(params.selector, params.shadowPath);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("contextmenu", pointerEventParams(el, {
      button: 2,
      buttons: 2
    })));
    return { contextMenu: elementSummary(el, 0, root, params.shadowPath) };
  }

  async function waitSelectorLocal(params) {
    const state = String(params.state || "visible").toLowerCase();
    if (!["attached", "visible", "hidden", "detached"].includes(state)) {
      throw new Error(`Unsupported wait state: ${state}`);
    }
    const timeoutMs = Math.max(0, Number(params.timeoutMs ?? 10000));
    const pollMs = Math.max(20, Number(params.pollMs ?? 100));
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let found = null;
      try {
        found = findElement(params.selector, params.shadowPath);
      } catch (_error) {
        found = null;
      }
      const visible = found ? Boolean(visibleRect(found.el)) : false;
      const satisfied =
        (state === "attached" && found) ||
        (state === "visible" && visible) ||
        (state === "hidden" && (!found || !visible)) ||
        (state === "detached" && !found);
      if (satisfied) {
        return {
          waited: found
            ? {
                ...elementSummary(found.el, 0, found.root, params.shadowPath),
                state
              }
            : {
                selector: params.selector,
                shadowPath: Array.isArray(params.shadowPath) ? params.shadowPath : [],
                state,
                frame: frameSummary()
              }
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timeout waiting for ${params.selector} to be ${state}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  function findElementByText(params) {
    const text = normalizedText(params.text);
    if (!text) throw new Error("Missing text.");
    const selector = params.selector || [
      "button",
      "a",
      "li",
      "span",
      "div",
      "[role='button']",
      "[class*='menu']",
      "[class*='dropdown']"
    ].join(",");
    const exact = params.exact !== false;
    const matches = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = visibleRect(el);
      if (!rect) continue;
      const value = normalizedText(el.innerText || el.textContent || "");
      if ((exact && value === text) || (!exact && value.includes(text))) {
        matches.push({ el, area: rect.width * rect.height });
      }
    }
    if (!matches.length) throw new Error(`Element text not found: ${text}`);
    matches.sort((left, right) => left.area - right.area);
    return matches[0].el;
  }

  function hoverTextLocal(params) {
    const el = findElementByText(params);
    dispatchHover(el);
    return { hovered: elementSummary(el) };
  }

  function clickTextLocal(params) {
    const el = findElementByText(params);
    dispatchHover(el);
    el.dispatchEvent(new MouseEvent("mousedown", pointerEventParams(el, { button: 0 })));
    el.click();
    el.dispatchEvent(new MouseEvent("mouseup", pointerEventParams(el, { button: 0 })));
    return { clicked: elementSummary(el) };
  }

  const COMMAND_HANDLERS = {
    get_state: async () => ({
      url: publicUrl(location.href),
      title: document.title,
      readyState: document.readyState,
      frame: frameSummary(),
      identity: await optionalPageIdentity()
    }),
    open_url: (params) => runtimeMessage({
      action: "open_url",
      ...(params || {})
    }),
    list_pages: (params) => runtimeMessage({
      action: "list_pages",
      ...(params || {})
    }),
    switch_page: (params) => runtimeMessage({
      action: "switch_page",
      ...(params || {})
    }),
    close_page: (params) => runtimeMessage({
      action: "close_page",
      ...(params || {})
    }),
    list_windows: (params) => runtimeMessage({
      action: "list_windows",
      ...(params || {})
    }),
    switch_window: (params) => runtimeMessage({
      action: "switch_window",
      ...(params || {})
    }),
    close_window: (params) => runtimeMessage({
      action: "close_window",
      ...(params || {})
    }),
    navigate: (params) => runtimeMessage({
      action: "navigate",
      ...(params || {})
    }),
    scan_elements: (params) => routeAction(
      "scan_elements",
      params,
      scanElementsLocal,
      true
    ),
    find_elements: (params) => routeAction(
      "find_elements",
      params,
      findElementsLocal,
      true
    ),
    extract_elements: (params) => routeAction(
      "extract_elements",
      params,
      (localParams) => {
        if (!window.__rpaSnapshotCore) throw new Error("snapshot_core_not_loaded");
        return window.__rpaSnapshotCore.extract(localParams || {});
      },
      true
    ),
    snapshot: (params) => {
      if (!window.__rpaSnapshotCore) throw new Error("snapshot_core_not_loaded");
      return window.__rpaSnapshotCore.createSnapshot(params || {});
    },
    click_ref: (params) => {
      if (!window.__rpaSnapshotCore) throw new Error("snapshot_core_not_loaded");
      return window.__rpaSnapshotCore.clickRef(params || {});
    },
    highlight_ref: (params) => {
      if (!window.__rpaSnapshotCore) throw new Error("snapshot_core_not_loaded");
      return window.__rpaSnapshotCore.highlightRef(params || {});
    },
    screenshot: (params) => runtimeMessage({
      action: "screenshot",
      ...(params || {})
    }),
    click_selector: (params) => routeAction(
      "click_selector",
      params,
      clickSelectorLocal
    ),
    hover_selector: (params) => routeAction(
      "hover_selector",
      params,
      hoverSelectorLocal
    ),
    hover_text: (params) => hoverTextLocal(params),
    click_text: (params) => clickTextLocal(params),
    input_selector: (params) => routeAction(
      "input_selector",
      params,
      inputSelectorLocal
    ),
    type_text: (params) => routeAction("type_text", params, typeTextLocal),
    clear_selector: (params) => routeAction("clear_selector", params, clearSelectorLocal),
    focus_selector: (params) => routeAction("focus_selector", params, focusSelectorLocal),
    check_selector: (params) => routeAction("check_selector", params, checkSelectorLocal),
    drag_and_drop: (params) => routeAction("drag_and_drop", params, dragAndDropLocal),
    highlight_selector: (params) => routeAction(
      "highlight_selector",
      params,
      highlightSelectorLocal
    ),
    wait_selector: (params) => routeAction(
      "wait_selector",
      params,
      waitSelectorLocal
    ),
    scroll: (params) => routeAction("scroll", params, scrollLocal),
    press_key: (params) => routeAction("press_key", params, pressKeyLocal),
    select_option: (params) => routeAction(
      "select_option",
      params,
      selectOptionLocal
    ),
    double_click_selector: (params) => routeAction(
      "double_click_selector",
      params,
      doubleClickSelectorLocal
    ),
    context_menu_selector: (params) => routeAction(
      "context_menu_selector",
      params,
      contextMenuSelectorLocal
    ),
    get_click_point: (params) => clickPointLocal(params),
    inspect_point: (params) => inspectPointLocal(params)
  };

  function executeLocalCommand(action, params) {
    const handler = COMMAND_HANDLERS[action];
    if (!handler) throw new Error(`Unsupported action: ${action}`);
    return handler(params || {});
  }

  window.__rpaChromeBridgeTestApi = {
    collectRoots,
    elementRole,
    elementSummary,
    findElements: (params) => findElementsLocal(params).elements,
    findElementsLocal,
    extract: (params) => window.__rpaSnapshotCore.extract(params || {}),
    resolveRoot,
    scanElements: (params) => scanElementsLocal(params).elements,
    scanElementsLocal,
    snapshot: (params) => window.__rpaSnapshotCore.createSnapshot(params || {}),
    selectorInfo,
    executeLocalCommand
  };

  async function postBridgeResult(result) {
    await runtimeMessage({ action: "bridge_result", result });
  }

  async function commandLeaseIsCurrent(command) {
    const lease = command && command.lease;
    if (!lease) return true;
    const payload = await runtimeMessage({ action: "bridge_validate_lease", lease });
    return payload && payload.current === true;
  }

  function getClientId() {
    if (!documentClientId) documentClientId = randomId("content_bridge");
    return documentClientId;
  }

  async function currentTabId() {
    const response = await runtimeMessage({ action: "get_tab_id" });
    const tabId = Number(response && response.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error("Unable to resolve the current Chrome tab.");
    }
    return tabId;
  }

  function normalizedDocumentUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname || "/"}`;
    } catch (_error) {
      return "";
    }
  }

  async function isCurrentTabDocument() {
    const identity = await optionalPageIdentity();
    const lifecycle = String(identity && identity.documentLifecycle || "").toLowerCase();
    if (lifecycle && lifecycle !== "active") return false;
    if (Number(identity && identity.frameId || 0) !== 0) return false;
    const tabUrl = normalizedDocumentUrl(identity && identity.url);
    const documentUrl = normalizedDocumentUrl(location.href);
    if (!tabUrl || !documentUrl) return true;
    return tabUrl === documentUrl;
  }

  let polling = false;
  async function pollBridge() {
    if (!IS_TOP_FRAME || polling) return;
    if (location.protocol === "chrome:" || location.protocol === "edge:") return;
    polling = true;
    const clientId = getClientId();
    try {
      // Chrome may keep a hidden search warmup/prerender document under the
      // same tab id. Only the document matching chrome.tabs may claim work.
      if (!(await isCurrentTabDocument())) {
        await delay(500);
        return;
      }
      const tabId = await currentTabId();
      const identity = await optionalPageIdentity();
      const payload = await runtimeMessage({
        action: "bridge_poll",
        payload: {
          client_id: clientId,
          url: publicUrl(location.href),
          title: String(document.title || "").slice(0, 300),
          ready_state: String(document.readyState || ""),
          document_id: String(identity.documentId || ""),
          document_lifecycle: String(identity.documentLifecycle || ""),
          extension_version: chrome.runtime.getManifest().version,
          protocol_version: PROTOCOL_VERSION
        }
      });
      const commands = Array.isArray(payload.commands) ? payload.commands : [];
      for (const command of commands) {
        if (!(await commandLeaseIsCurrent(command))) {
          await postBridgeResult({
            client_id: clientId,
            command_id: command.id,
            ok: false,
            data: null,
            error: "stale_page_lease: fencing token is no longer current",
            source: "content_script"
          });
          continue;
        }
        if ([
          "open_url",
          "list_pages",
          "switch_page",
          "close_page",
          "list_windows",
          "switch_window",
          "close_window",
          "navigate",
          "upload_file"
        ].includes(command.action)) {
          runtimeMessage({
            action: command.action,
            ...(command.params || {}),
            commandId: command.id,
            clientId
          }).catch(() => {
            // The background reports success or failure directly to the bridge.
          });
          continue;
        }
        const result = {
          client_id: clientId,
          command_id: command.id,
          ok: false,
          data: null,
          error: "",
          source: "content_script"
        };
        try {
          result.data = {
            tabUrl: publicUrl(location.href),
            tabTitle: document.title,
            response: await Promise.resolve(
              executeLocalCommand(command.action, command.params || {})
            )
          };
          result.ok = true;
        } catch (error) {
          result.error = String(error && error.message ? error.message : error);
        }
        await postBridgeResult(result);
      }
    } catch (_error) {
      // The local bridge may be offline. Keep polling quietly.
      await delay(1000);
    } finally {
      polling = false;
    }
  }

  if (IS_TOP_FRAME) {
    (async function bridgeLoop() {
      // On the local bootstrap page this claims the single-use pairing code.
      // On ordinary pages it only checks whether the extension is already paired.
      try { await getBridgeConfig(); } catch (_error) { /* setup may not be complete */ }
      while (true) {
        await pollBridge();
      }
    })();
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.action === "ping") {
        sendResponse({ ok: true });
        return;
      }
      if (message.action === "execute_frame_command") {
        Promise.resolve(
          executeLocalCommand(message.commandAction, message.params || {})
        )
          .then((response) => sendResponse(response))
          .catch((error) => sendResponse({
            error: String(error && error.message ? error.message : error)
          }));
        return true;
      }
      Promise.resolve(executeLocalCommand(message.action, message.params || {}))
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({
          error: String(error && error.message ? error.message : error)
        }));
      return true;
    });
  }
})();
