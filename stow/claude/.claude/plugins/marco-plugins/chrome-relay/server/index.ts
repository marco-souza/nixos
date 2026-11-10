#!/usr/bin/env bun
// chrome-relay MCP server.
//
// Claude Code <-(stdio JSON-RPC / MCP)-> this process <-(WebSocket)-> browser extension
//
// Several Claude Code sessions share one relay: the first process to bind the port
// is the hub and owns the extension socket. Later processes connect to the hub as
// peers on SESSION_PATH and the hub forwards their calls. When the hub exits, the
// peers race for the port; one becomes the new hub and the extension reconnects.
//
// No dependencies: MCP over stdio is newline-delimited JSON-RPC, implemented by hand.
// Everything that is not protocol output goes to stderr (stdout belongs to MCP).

import { createInterface } from "node:readline";
import type { Server, ServerWebSocket } from "bun";

const PORT = Number(process.env.CHROME_RELAY_PORT ?? 18765);
// Optional: pin to one extension ID (see chrome://extensions). Otherwise any
// chrome-extension:// origin is accepted; web pages are always rejected.
const PINNED_EXTENSION_ID = process.env.CHROME_RELAY_EXTENSION_ID ?? "";
const CALL_TIMEOUT_MS = 30_000;
const SESSION_PATH = "/session";
const RETRY_MS = 500; // peer: delay (plus jitter) before retrying the hub or the port
const PEER_PING_MS = 20_000; // keeps the peer socket under the hub's idleTimeout

const NO_BROWSER =
  "No browser connected. Make sure the chrome-relay extension is installed and enabled in a Chromium-based browser (it reconnects automatically within a few seconds).";
const HUB_LOST = `Lost the connection to the chrome-relay hub on port ${PORT} (its Claude Code session probably exited). Reconnecting; try again in a moment.`;
const NO_HUB = `Port ${PORT} is in use, but no chrome-relay hub answered on it. If another program holds the port, free it or set CHROME_RELAY_PORT (and the same port in the extension popup). Retrying in the background.`;

const log = (...a: unknown[]) => console.error("[chrome-relay]", ...a);

// --- Browser connection ----------------------------------------------------

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer };
type Conn = { peer: boolean };

let role: "hub" | "peer" = "peer"; // "hub" once this process binds the port
let server: Server | null = null; // hub only
let ext: ServerWebSocket<Conn> | null = null; // hub only
let extInfo: Record<string, unknown> = {};
let hub: WebSocket | null = null; // peer only: open socket to the hub
let hubState: { connected: boolean; browser?: Record<string, unknown> } = { connected: false };
let peerError: string | null = null; // peer only: why there is no hub socket
let relayError: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function originAllowed(origin: string | null): boolean {
  if (!origin?.startsWith("chrome-extension://")) return false;
  if (!PINNED_EXTENSION_ID) return true;
  return origin === `chrome-extension://${PINNED_EXTENSION_ID}`;
}

function settle(msg: any) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
}

function failPending(reason: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

const statusMessage = () => JSON.stringify({ type: "status", connected: !!ext, browser: ext ? extInfo : undefined });
const broadcastStatus = () => server?.publish("peers", statusMessage());

function start() {
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: PORT,
      fetch(req, server) {
        const origin = req.headers.get("origin");
        // Peers are local processes, which send no Origin. Browsers always do.
        const peer = new URL(req.url).pathname === SESSION_PATH;
        if (peer ? origin !== null : !originAllowed(origin)) return new Response("forbidden", { status: 403 });
        if (server.upgrade(req, { data: { peer } })) return;
        return new Response("chrome-relay: websocket only", { status: 426 });
      },
      websocket: {
        idleTimeout: 60, // extension and peers ping every 20s; frees the slot if a browser vanishes
        open(ws: ServerWebSocket<Conn>) {
          if (ws.data.peer) {
            ws.subscribe("peers");
            ws.send(statusMessage());
            return;
          }
          // First browser wins. Replacing would make two browsers with the
          // extension kick each other out forever.
          if (ext) {
            ws.close(4001, "another browser is already connected");
            return;
          }
          ext = ws;
          log("extension connected");
          broadcastStatus();
        },
        message(ws: ServerWebSocket<Conn>, raw) {
          let msg: any;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          if (ws.data.peer) {
            // Forwarded through callBrowser, so each call gets its own hub id.
            if (typeof msg.method !== "string") return;
            callBrowser(msg.method, msg.params ?? {}).then(
              (result) => ws.send(JSON.stringify({ id: msg.id, result })),
              (e) => ws.send(JSON.stringify({ id: msg.id, error: e?.message ?? String(e) })),
            );
            return;
          }
          if (msg.type === "hello") {
            extInfo = msg.info ?? {};
            broadcastStatus();
            return;
          }
          settle(msg);
        },
        close(ws: ServerWebSocket<Conn>) {
          if (ext === ws) {
            ext = null;
            log("extension disconnected");
            failPending("browser extension disconnected");
            broadcastStatus();
          }
        },
      },
    });
    role = "hub";
    peerError = null;
    log(`listening on ws://127.0.0.1:${PORT} (hub)`);
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE") {
      relayError = `Failed to start relay: ${e?.message ?? e}`;
      log(relayError);
      return;
    }
    connectToHub();
  }
}

function connectToHub() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${SESSION_PATH}`);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    hub = ws;
    peerError = null;
    log(`connected to the hub on port ${PORT} (peer)`);
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "status") hubState = { connected: !!msg.connected, browser: msg.browser };
    else if (msg.id !== undefined) settle(msg);
  };
  ws.onerror = () => {}; // onclose follows
  ws.onclose = () => {
    hub = null;
    hubState = { connected: false };
    const reason = opened ? HUB_LOST : NO_HUB;
    if (reason !== peerError) log(reason);
    peerError = reason;
    failPending(reason);
    // Jitter so racing peers don't retry in lockstep. Only one bind can win.
    setTimeout(start, RETRY_MS + Math.random() * RETRY_MS);
  };
}

start();
setInterval(() => hub?.send(JSON.stringify({ type: "ping" })), PEER_PING_MS);

function callBrowser(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (relayError) return Promise.reject(new Error(relayError));
  let target: { send(data: string): unknown };
  if (role === "hub") {
    if (!ext) return Promise.reject(new Error(NO_BROWSER));
    target = ext;
  } else {
    if (!hub)
      return Promise.reject(new Error(peerError ?? `Connecting to the chrome-relay hub on port ${PORT}; try again in a moment.`));
    target = hub;
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ id, method, params }));
  });
}

// --- Tools -----------------------------------------------------------------

const tabId = { type: "number", description: "Tab ID (defaults to the active tab of the focused window)" };
const target = {
  selector: { type: "string", description: "CSS selector" },
  ref: { type: "number", description: "Element ref number from browser_snapshot" },
};

type Tool = { name: string; description: string; inputSchema: any };

const tools: Tool[] = [
  {
    name: "browser_status",
    description: "Check whether a browser is connected to the relay.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_tabs",
    description: "List open tabs (id, title, url, active, windowId).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_open",
    description: "Open a URL in a new tab and wait for it to load. Returns the new tab.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, active: { type: "boolean", default: true } },
      required: ["url"],
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate a tab to a URL (or 'back' / 'forward' / 'reload') and wait for it to load.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, tabId }, required: ["url"] },
  },
  {
    name: "browser_activate_tab",
    description: "Focus a tab and its window.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "browser_close_tab",
    description: "Close a tab.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the page: title, url, visible text, and a numbered list of interactive elements (links, buttons, inputs). Use the ref numbers with browser_click / browser_type. Refs are invalidated by navigation; take a new snapshot after the page changes.",
    inputSchema: {
      type: "object",
      properties: { tabId, maxTextLength: { type: "number", default: 20000 } },
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture the visible area of a tab as a PNG (the tab is brought to front first).",
    inputSchema: { type: "object", properties: { tabId } },
  },
  {
    name: "browser_click",
    description: "Click an element by ref (from browser_snapshot) or CSS selector.",
    inputSchema: { type: "object", properties: { ...target, tabId } },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input/textarea/contenteditable by ref or CSS selector. Replaces existing value unless append is true. submit=true presses Enter / submits the form afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        tabId,
        text: { type: "string" },
        append: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page by a pixel amount, or scroll an element (ref/selector) into view.",
    inputSchema: {
      type: "object",
      properties: { ...target, tabId, deltaY: { type: "number", default: 600 } },
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait until a CSS selector exists (and is visible) or text appears on the page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        selector: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "number", default: 10000 },
      },
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in the page (via the DevTools protocol, so it works on pages with strict CSP) and return its JSON-serialisable result. Promises are awaited. Chrome shows a 'being debugged' bar while it runs.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, tabId },
      required: ["expression"],
    },
  },
];

async function runTool(name: string, args: any) {
  if (name === "browser_status") {
    const status = relayError
      ? { connected: false, error: relayError }
      : role === "hub"
        ? { connected: !!ext, port: PORT, role, browser: ext ? extInfo : undefined }
        : hub
          ? { connected: hubState.connected, port: PORT, role, browser: hubState.connected ? hubState.browser : undefined }
          : { connected: false, port: PORT, role, error: peerError ?? "connecting to the hub" };
    return [{ type: "text", text: JSON.stringify(status, null, 2) }];
  }
  if (!tools.some((t) => t.name === name)) throw new Error(`unknown tool: ${name}`);

  const method = name.replace(/^browser_/, "");
  const result = await callBrowser(method, args ?? {});

  if (name === "browser_screenshot") {
    const data = String(result.dataUrl).replace(/^data:image\/png;base64,/, "");
    return [{ type: "image", data, mimeType: "image/png" }];
  }
  if (name === "browser_snapshot") {
    const lines = [`# ${result.title}`, result.url, "", "## Interactive elements"];
    for (const el of result.elements) lines.push(`[${el.ref}] ${el.desc}`);
    lines.push("", "## Text", result.text);
    if (result.truncated) lines.push("", "(text truncated)");
    return [{ type: "text", text: lines.join("\n") }];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }];
}

// --- MCP over stdio ---------------------------------------------------------

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const replyError = (id: unknown, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: any) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "chrome-relay", version: "0.2.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools });
    case "tools/call":
      try {
        const content = await runTool(params?.name, params?.arguments);
        return reply(id, { content });
      } catch (e: any) {
        return reply(id, { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
      }
    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "parse error");
  }
  handle(msg).catch((e) => log("handler error", e));
});
rl.on("close", () => process.exit(0));
