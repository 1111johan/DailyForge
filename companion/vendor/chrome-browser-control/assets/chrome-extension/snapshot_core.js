(function () {
  if (window.__rpaSnapshotCore) return;

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='menuitem']",
    "[role='tab']",
    "[onclick]",
    "[contenteditable]",
    "kat-button",
    "kat-link",
    "kat-input",
    "kat-textarea",
    "kat-dropdown"
  ].join(",");

  const STATUS_SELECTOR = [
    "[role='dialog']",
    "[role='alertdialog']",
    "dialog[open]",
    "kat-modal",
    "[role='alert']",
    "[aria-live='assertive']",
    "[aria-live='polite']",
    "kat-alert",
    ".a-alert",
    "h1",
    "h2",
    "h3",
    "[role='progressbar']",
    "[aria-busy='true']",
    ".spinner",
    ".loading"
  ].join(",");

  let currentSnapshot = {
    snapshotId: "",
    refs: new Map()
  };

  function text(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function clip(value, maxLength) {
    const clean = text(value);
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
  }

  function visibleTextOf(el) {
    return clip(el.innerText || el.textContent || "", 500);
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

  function hrefOf(el) {
    const raw = text(el.getAttribute && el.getAttribute("href"));
    if (!raw) return "";
    try {
      return publicUrl(new URL(raw, document.baseURI).href);
    } catch (_error) {
      return "";
    }
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function visibleRect(el, offsetX, offsetY) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return null;
    return {
      x: Math.round(rect.left + offsetX),
      y: Math.round(rect.top + offsetY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      top: rect.top + offsetY,
      left: rect.left + offsetX,
      bottom: rect.bottom + offsetY,
      right: rect.right + offsetX
    };
  }

  function inViewport(rect) {
    return rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;
  }

  function roleOf(el) {
    const explicit = text(el.getAttribute("role")).toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = text(el.getAttribute("type")).toLowerCase();
    if (tag === "button" || tag === "kat-button") return "button";
    if (tag === "a") return "link";
    if (tag === "textarea" || tag === "kat-textarea") return "textbox";
    if (tag === "select" || tag === "kat-dropdown") return "combobox";
    if (tag === "input") {
      if (["checkbox", "radio"].includes(type)) return type;
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    if (tag === "kat-link") return "link";
    if (tag === "kat-input") return "textbox";
    return "generic";
  }

  function labelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (label) return text(label.innerText || label.textContent);
    }
    const parent = el.closest && el.closest("label");
    return parent ? text(parent.innerText || parent.textContent) : "";
  }

  function nameOf(el) {
    return clip(
      el.getAttribute("aria-label") ||
      labelText(el) ||
      el.innerText ||
      el.textContent ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      "",
      80
    );
  }

  function stateOf(el) {
    const states = [];
    const tag = el.tagName.toLowerCase();
    const value = text(el.value);
    const inputType = text(el.getAttribute("type")).toLowerCase();
    if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") states.push("checked");
    if ((tag === "input" || tag === "textarea" || tag === "kat-input") && !value) states.push("empty");
    if ((tag === "input" || tag === "textarea") && value) {
      states.push(inputType === "password" ? "non-empty (redacted)" : `non-empty (${value.length} chars)`);
    }
    if (tag === "select") {
      const selected = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      if (selected) states.push(`selected: "${clip(selected.text || "(redacted)", 40)}"`);
    }
    return states;
  }

  function lineFor(item) {
    const name = item.name ? ` "${item.name}"` : "";
    const suffix = item.states.length ? ` (${item.states.join(", ")})` : "";
    return `- ${item.role}${name} [ref=${item.ref}]${suffix}`;
  }

  const EXTRACTABLE_FIELDS = new Set([
    "visibleText",
    "href",
    "title",
    "ariaLabel",
    "role",
    "tag",
    "name"
  ]);

  function extractField(el, field) {
    if (field === "visibleText") return visibleTextOf(el);
    if (field === "href") return hrefOf(el);
    if (field === "title") return text(el.getAttribute("title"));
    if (field === "ariaLabel") return text(el.getAttribute("aria-label"));
    if (field === "role") return roleOf(el);
    if (field === "tag") return el.tagName.toLowerCase();
    if (field === "name") return nameOf(el);
    return "";
  }

  function extractionRoots(root, includeShadow) {
    const roots = [root];
    if (!includeShadow || !root.querySelectorAll) return roots;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.shadowRoot) roots.push(...extractionRoots(el.shadowRoot, true));
    }
    return roots;
  }

  function ariaLabelledByText(el) {
    const id = text(el.getAttribute("aria-labelledby"));
    if (!id) return "";
    return id.split(/\s+/)
      .map((item) => {
        const node = document.getElementById(item);
        return node ? text(node.innerText || node.textContent) : "";
      })
      .filter(Boolean)
      .join(" ");
  }

  function statusTitle(el) {
    const heading = el.querySelector && el.querySelector("h1,h2,h3,[role='heading']");
    const raw = el.getAttribute("aria-label") ||
      ariaLabelledByText(el) ||
      (heading ? heading.innerText || heading.textContent : "") ||
      el.innerText ||
      el.textContent ||
      "";
    return clip(raw, 60);
  }

  function alertLevel(el) {
    const raw = [
      el.getAttribute("variant"),
      el.getAttribute("type"),
      el.getAttribute("class")
    ].map(text).join(" ").toLowerCase();
    if (/error|danger|critical/.test(raw)) return "error";
    if (/warn/.test(raw)) return "warning";
    if (/success/.test(raw)) return "success";
    if (/info/.test(raw)) return "info";
    return "";
  }

  function statusKey(kind, value) {
    return `${kind}:${JSON.stringify(value)}`;
  }

  function collectStatusNode(el, options, context, status) {
    const rect = visibleRect(el, context.offsetX, context.offsetY);
    if (!rect) return;
    const tag = el.tagName.toLowerCase();
    const role = text(el.getAttribute("role")).toLowerCase();

    if (["h1", "h2", "h3"].includes(tag)) {
      if (options.scope === "viewport" && !inViewport(rect)) return;
      const item = { level: tag, text: clip(el.innerText || el.textContent, 60) };
      const key = statusKey("heading", item);
      if (item.text && !status.seen.has(key) && status.headings.length < 10) {
        status.seen.add(key);
        status.headings.push(item);
      }
      return;
    }

    if (role === "dialog" || role === "alertdialog" || tag === "dialog" || tag === "kat-modal") {
      const title = statusTitle(el);
      const key = statusKey("dialog", title);
      if (title && !status.seen.has(key)) {
        status.seen.add(key);
        status.dialog.push(title);
      }
      return;
    }

    const ariaLive = text(el.getAttribute("aria-live")).toLowerCase();
    if (role === "alert" || ariaLive === "assertive" || ariaLive === "polite" ||
        tag === "kat-alert" || /\ba-alert\b/.test(el.className || "")) {
      const item = {
        level: alertLevel(el),
        text: clip(el.innerText || el.textContent, 100)
      };
      const key = statusKey("alert", item);
      if (item.text && !status.seen.has(key)) {
        status.seen.add(key);
        status.alerts.push(item);
      }
      return;
    }

    const classText = text(el.getAttribute("class")).toLowerCase();
    if (role === "progressbar" || el.getAttribute("aria-busy") === "true" ||
        /spinner|loading/.test(classText)) {
      status.loading = true;
    }
  }

  function createPageStatus() {
    return {
      ready: document.readyState,
      dialog: [],
      alerts: [],
      headings: [],
      loading: false,
      seen: new Set()
    };
  }

  function statusLines(status) {
    const lines = [`ready: ${status.ready}`];
    if (status.loading) lines.push("loading: true");
    if (status.dialog.length) {
      for (const title of status.dialog) lines.push(`dialog: "${title}"`);
    } else {
      lines.push("dialog: none");
    }
    if (status.alerts.length) {
      lines.push("alerts:");
      for (const item of status.alerts) {
        const level = item.level ? `${item.level} ` : "";
        lines.push(`  - ${level}"${item.text}"`);
      }
    } else {
      lines.push("alerts: none");
    }
    if (status.headings.length) {
      lines.push("headings:");
      for (const item of status.headings) lines.push(`  - ${item.level} "${item.text}"`);
    }
    return lines;
  }

  function collect(root, options, out, context, status) {
    const nodes = [];
    if (root.querySelectorAll) {
      try {
        nodes.push(...Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)));
      } catch (_error) {
        // Ignore invalid roots.
      }
    }
    for (const el of nodes) {
      const rect = visibleRect(el, context.offsetX, context.offsetY);
      if (!rect) continue;
      if (options.scope === "viewport" && !inViewport(rect)) continue;
      out.push({ el, rect, frameNote: context.frameNote || "" });
    }
    const all = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
    if (status && root.querySelectorAll) {
      let statusNodes = [];
      try {
        statusNodes = Array.from(root.querySelectorAll(STATUS_SELECTOR));
      } catch (_error) {
        statusNodes = [];
      }
      for (const el of statusNodes) collectStatusNode(el, options, context, status);
    }
    if (!options.includeShadow) return;
    for (const el of all) {
      if (el.shadowRoot) collect(el.shadowRoot, options, out, context, status);
      if (el.tagName && el.tagName.toLowerCase() === "iframe") {
        const rect = visibleRect(el, context.offsetX, context.offsetY);
        if (!rect) continue;
        try {
          if (el.contentDocument) {
            collect(el.contentDocument, options, out, {
              offsetX: rect.left,
              offsetY: rect.top,
              frameNote: ""
            }, status);
          }
        } catch (_error) {
          out.push({ el, rect, frameNote: "cross-origin, not traversed" });
        }
      }
    }
  }

  function createSnapshot(params) {
    const options = {
      scope: params && params.scope === "full" ? "full" : "viewport",
      within: text(params && params.within),
      limit: Math.max(1, Math.min(1000, Number(params && params.limit || 120))),
      includeShadow: !(params && params.includeShadow === false)
    };
    let root = document;
    if (options.within) {
      const withinEl = document.querySelector(options.within);
      if (!withinEl) throw new Error(`selector_not_found: ${options.within}`);
      root = withinEl.shadowRoot || withinEl;
    }
    const collected = [];
    const pageStatus = createPageStatus();
    collect(root, options, collected, { offsetX: 0, offsetY: 0, frameNote: "" }, pageStatus);
    collected.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

    const snapshotId = `s_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-4)}`;
    const refs = new Map();
    const elements = [];
    for (const item of collected.slice(0, options.limit)) {
      const ref = `e${elements.length + 1}`;
      refs.set(ref, item.el);
      const states = stateOf(item.el);
      if (item.frameNote) states.push(item.frameNote);
      elements.push({
        ref,
        role: roleOf(item.el),
        name: nameOf(item.el),
        tag: item.el.tagName.toLowerCase(),
        visibleText: visibleTextOf(item.el),
        href: hrefOf(item.el),
        title: text(item.el.getAttribute("title")),
        ariaLabel: text(item.el.getAttribute("aria-label")),
        states,
        x: item.rect.x,
        y: item.rect.y,
        w: item.rect.w,
        h: item.rect.h
      });
    }
    currentSnapshot = { snapshotId, refs };
    return {
      snapshot_id: snapshotId,
      url: publicUrl(location.href),
      title: document.title,
      ready: pageStatus.ready,
      dialog: pageStatus.dialog,
      alerts: pageStatus.alerts,
      headings: pageStatus.headings,
      loading: pageStatus.loading,
      scope: options.scope,
      count: elements.length,
      elements,
      status_lines: statusLines(pageStatus),
      lines: elements.map(lineFor)
    };
  }

  function resolveRef(params) {
    const snapshotId = text(params && (params.snapshot_id || params.snapshotId));
    const ref = text(params && params.ref);
    if (!snapshotId || !ref || snapshotId !== currentSnapshot.snapshotId) {
      throw new Error("StaleElementRef: ref 已失效，请重新 snapshot");
    }
    const el = currentSnapshot.refs.get(ref);
    if (!el || !el.isConnected) {
      throw new Error("StaleElementRef: ref 已失效，请重新 snapshot");
    }
    return el;
  }

  function pointerParams(el, extras) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...(extras || {})
    };
  }

  function clickRef(params) {
    const el = resolveRef(params);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", pointerParams(el)));
    el.dispatchEvent(new MouseEvent("mousedown", pointerParams(el, { button: 0 })));
    el.dispatchEvent(new MouseEvent("mouseup", pointerParams(el, { button: 0 })));
    el.click();
    return { clicked: true, ref: params.ref, url: publicUrl(location.href), title: document.title };
  }

  function highlightRef(params) {
    const el = resolveRef(params);
    const duration = Math.max(100, Number(params && params.duration || 1600));
    const previousOutline = el.style.outline;
    const previousOffset = el.style.outlineOffset;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.style.outline = "3px solid #ff4d4f";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = previousOutline;
      el.style.outlineOffset = previousOffset;
    }, duration);
    return { highlighted: true, ref: params.ref, duration };
  }

  function find(params) {
    const queryText = text(params && params.text).toLowerCase();
    const css = text(params && params.css);
    const limit = Math.max(1, Math.min(1000, Number(params && params.limit || 20)));
    const snapshot = createSnapshot({ scope: "full", limit: 1000 });
    let elements = snapshot.elements;
    if (queryText) {
      elements = elements.filter((item) => `${item.role} ${item.name} ${item.states.join(" ")}`.toLowerCase().includes(queryText));
    }
    if (css) {
      const matched = new Set(Array.from(document.querySelectorAll(css)));
      elements = elements.filter((item) => matched.has(currentSnapshot.refs.get(item.ref)));
    }
    elements = elements.slice(0, limit);
    return {
      snapshot_id: snapshot.snapshot_id,
      url: snapshot.url,
      title: snapshot.title,
      count: elements.length,
      elements,
      lines: elements.map(lineFor)
    };
  }

  function extract(params) {
    const css = text(params && params.css);
    if (!css) throw new Error("extract requires css");
    const rawFields = Array.isArray(params && params.fields)
      ? params.fields
      : text(params && params.fields).split(",");
    const fields = rawFields.map((field) => text(field)).filter(Boolean);
    const selectedFields = fields.length
      ? fields
      : ["visibleText", "href", "title", "ariaLabel"];
    const unsupported = selectedFields.filter((field) => !EXTRACTABLE_FIELDS.has(field));
    if (unsupported.length) {
      throw new Error(`unsupported_extract_field: ${unsupported.join(",")}`);
    }
    const limit = Math.max(1, Math.min(1000, Number(params && params.limit || 100)));
    const includeHidden = Boolean(params && params.includeHidden === true);
    const includeShadow = !(params && params.includeShadow === false);
    const matches = [];
    const seen = new Set();
    for (const root of extractionRoots(document, includeShadow)) {
      let nodes;
      try {
        nodes = Array.from(root.querySelectorAll(css));
      } catch (_error) {
        throw new Error(`invalid_selector: ${css}`);
      }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        const rect = visibleRect(el, 0, 0);
        if (!includeHidden && !rect) continue;
        const row = {};
        for (const field of selectedFields) row[field] = extractField(el, field);
        row.visible = Boolean(rect);
        if (rect) {
          row.x = rect.x;
          row.y = rect.y;
          row.w = rect.w;
          row.h = rect.h;
        }
        matches.push(row);
      }
    }
    return {
      selector: css,
      fields: selectedFields,
      count: Math.min(matches.length, limit),
      elements: matches.slice(0, limit),
      meta: {
        limit,
        matched: matches.length,
        hasMore: matches.length > limit,
        includeHidden,
        includeShadow
      }
    };
  }

  window.__rpaSnapshotCore = {
    createSnapshot,
    clickRef,
    highlightRef,
    find,
    extract
  };
})();
