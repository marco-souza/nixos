// Chrome Relay — page helpers, injected into the tab's isolated world.
// Re-injection is a no-op; background.js calls __chromeRelay.run(method, params).

if (!globalThis.__chromeRelay) {
  const REF_ATTR = "data-relay-ref";
  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=tab]", "[role=menuitem]",
    "[contenteditable=''], [contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const MAX_ELEMENTS = 400;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const clip = (s, n = 80) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    let kind = role || tag;
    if (tag === "input") kind = `input[${type || "text"}]`;
    const label =
      el.getAttribute("aria-label") ||
      (el.labels && el.labels[0]?.innerText) ||
      el.innerText ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("name") ||
      "";
    let d = `${kind} "${clip(label)}"`;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (type === "checkbox" || type === "radio") d += el.checked ? " (checked)" : " (unchecked)";
      else if (el.value && type !== "password") d += ` value="${clip(el.value, 40)}"`;
    }
    if (tag === "a") d += ` -> ${clip(el.getAttribute("href"), 100)}`;
    if (el.disabled) d += " (disabled)";
    return d;
  }

  function find({ selector, ref }) {
    let el = null;
    if (ref !== undefined) {
      el = document.querySelector(`[${REF_ATTR}="${Number(ref)}"]`);
      if (!el) throw new Error(`ref ${ref} not found; take a new browser_snapshot`);
    } else if (selector) {
      el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches ${selector}`);
    } else {
      throw new Error("pass either ref or selector");
    }
    return el;
  }

  const methods = {
    snapshot({ maxTextLength = 20000 }) {
      document.querySelectorAll(`[${REF_ATTR}]`).forEach((e) => e.removeAttribute(REF_ATTR));
      const elements = [];
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (!visible(el)) continue;
        const ref = elements.length + 1;
        el.setAttribute(REF_ATTR, String(ref));
        elements.push({ ref, desc: describe(el) });
      }
      const full = document.body?.innerText || "";
      return {
        title: document.title,
        url: location.href,
        elements,
        text: full.slice(0, maxTextLength),
        truncated: full.length > maxTextLength,
      };
    },

    click(p) {
      const el = find(p);
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.focus?.();
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.click();
      return `clicked ${describe(el)}`;
    },

    type({ text, append = false, submit = false, ...p }) {
      const el = find(p);
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (el.isContentEditable) {
        if (!append) document.execCommand("selectAll");
        document.execCommand("insertText", false, text);
      } else if ("value" in el) {
        // Use the native setter so frameworks like React see the change.
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        const value = append ? el.value + text : text;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        throw new Error(`element is not editable: ${describe(el)}`);
      }
      if (submit) {
        const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", key));
        el.dispatchEvent(new KeyboardEvent("keypress", key));
        el.dispatchEvent(new KeyboardEvent("keyup", key));
        if (notHandled && el.form) el.form.requestSubmit();
      }
      return `typed into ${describe(el)}${submit ? " and submitted" : ""}`;
    },

    scroll({ deltaY = 600, ...p }) {
      if (p.ref !== undefined || p.selector) {
        const el = find(p);
        el.scrollIntoView({ block: "center" });
        return `scrolled to ${describe(el)}`;
      }
      window.scrollBy(0, deltaY);
      return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight };
    },

    async waitFor({ selector, text, timeoutMs = 10000 }) {
      if (!selector && !text) throw new Error("pass selector or text");
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (selector) {
          const el = document.querySelector(selector);
          if (el && visible(el)) return `found ${selector} after ${Date.now() - start}ms`;
        } else if (document.body?.innerText.includes(text)) {
          return `found text after ${Date.now() - start}ms`;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${selector || JSON.stringify(text)}`);
    },
  };

  globalThis.__chromeRelay = {
    async run(method, params) {
      try {
        if (!methods[method]) throw new Error(`unknown page method: ${method}`);
        return { ok: true, value: await methods[method](params || {}) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
  };
}
