// Chrome Relay — background service worker.
// Connects to the local chrome-relay MCP server and executes its commands.

const DEFAULT_PORT = 18765;
const PING_MS = 20_000; // keeps the MV3 service worker alive while connected (Chrome 116+)
const LOAD_TIMEOUT_MS = 15_000;

let ws = null;
let connecting = false;
let retryMs = 1000;

async function getPort() {
  const { port } = await chrome.storage.local.get("port");
  return Number(port) || DEFAULT_PORT;
}

function setConnected(on) {
  chrome.action.setBadgeText({ text: on ? "on" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#1a7f37" : "#777" });
  chrome.storage.session.set({ connected: on }).catch(() => {});
}

async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  const port = await getPort();
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    connecting = false;
    return scheduleReconnect();
  }
  ws = sock;
  sock.onopen = () => {
    connecting = false;
    retryMs = 1000;
    setConnected(true);
    const ua = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ");
    sock.send(JSON.stringify({ type: "hello", info: { browser: ua || navigator.userAgent, extension: chrome.runtime.getManifest().version } }));
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onerror = () => {}; // onclose follows
  sock.onclose = (ev) => {
    connecting = false;
    if (ws === sock) ws = null;
    setConnected(false);
    // 4001: another browser holds the relay; check back slowly.
    scheduleReconnect(ev.code === 4001 ? 30_000 : undefined);
  };
}

function scheduleReconnect(delay) {
  setTimeout(connect, delay ?? retryMs);
  retryMs = Math.min(retryMs * 2, 10_000);
}

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
}, PING_MS);

// Alarms wake the worker if Chrome suspended it while disconnected.
chrome.alarms.create("chrome-relay-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "reconnect") {
    retryMs = 1000;
    ws?.close();
    connect();
    sendResponse(true);
  }
});
connect();

// --- Command dispatch -------------------------------------------------------

async function onMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "pong" || msg.id === undefined) return;
  const handler = handlers[msg.method];
  try {
    if (!handler) throw new Error(`unknown method: ${msg.method}`);
    const result = await handler(msg.params || {});
    sock.send(JSON.stringify({ id: msg.id, result: result ?? null }));
  } catch (e) {
    sock.send(JSON.stringify({ id: msg.id, error: String(e?.message || e) }));
  }
}

const tabInfo = (t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status });

async function resolveTab(tabId) {
  if (tabId !== undefined) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

// Resolves once the tab reports status "complete" (or after a timeout, for
// same-document navigations that never fire it). Call before triggering navigation.
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Run a function from page.js inside the tab (isolated world, top frame).
async function inPage(tabId, method, params) {
  const tab = await resolveTab(tabId);
  const target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target, files: ["page.js"] });
  const [res] = await chrome.scripting.executeScript({
    target,
    func: (m, p) => globalThis.__chromeRelay.run(m, p),
    args: [method, params],
  });
  const out = res?.result;
  if (!out) throw new Error("script returned nothing (page may have navigated)");
  if (!out.ok) throw new Error(out.error);
  return out.value;
}

const handlers = {
  async tabs() {
    return (await chrome.tabs.query({})).map(tabInfo);
  },

  async open({ url, active = true }) {
    const tab = await chrome.tabs.create({ url: "about:blank", active });
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loaded;
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  async navigate({ url, tabId }) {
    const tab = await resolveTab(tabId);
    const loaded = waitForLoad(tab.id);
    if (url === "back") await chrome.tabs.goBack(tab.id);
    else if (url === "forward") await chrome.tabs.goForward(tab.id);
    else if (url === "reload") await chrome.tabs.reload(tab.id);
    else await chrome.tabs.update(tab.id, { url });
    await loaded;
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  async activate_tab({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async close_tab({ tabId }) {
    await chrome.tabs.remove(tabId);
    return `closed tab ${tabId}`;
  },

  async screenshot({ tabId }) {
    const tab = await resolveTab(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, 200)); // let it paint
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { dataUrl };
  },

  snapshot: ({ tabId, maxTextLength }) => inPage(tabId, "snapshot", { maxTextLength }),
  click: ({ tabId, ...p }) => inPage(tabId, "click", p),
  type: ({ tabId, ...p }) => inPage(tabId, "type", p),
  scroll: ({ tabId, ...p }) => inPage(tabId, "scroll", p),
  wait_for: ({ tabId, ...p }) => inPage(tabId, "waitFor", p),

  // DevTools protocol: bypasses page CSP, awaits promises.
  async evaluate({ expression, tabId }) {
    const tab = await resolveTab(tabId);
    const target = { tabId: tab.id };
    await chrome.debugger.attach(target, "1.3");
    try {
      const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(d.exception?.description || d.text || "evaluation failed");
      }
      return res.result.value === undefined ? res.result.description ?? "undefined" : res.result.value;
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
  },
};
