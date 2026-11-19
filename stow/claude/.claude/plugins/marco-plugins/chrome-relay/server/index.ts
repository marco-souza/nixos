#!/usr/bin/env bun
// chrome-relay MCP server.
//
// Claude Code <-(stdio JSON-RPC / MCP)-> this process <-(WebSocket)-> browser extension
//
// No dependencies: MCP over stdio is newline-delimited JSON-RPC, implemented by hand.
// Everything that is not protocol output goes to stderr (stdout belongs to MCP).

import { createInterface } from "node:readline";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.CHROME_RELAY_PORT ?? 18765);
// Optional: pin to one extension ID (see chrome://extensions). Otherwise any
// chrome-extension:// origin is accepted; web pages are always rejected.
const PINNED_EXTENSION_ID = process.env.CHROME_RELAY_EXTENSION_ID ?? "";
const CALL_TIMEOUT_MS = 30_000;

const log = (...a: unknown[]) => console.error("[chrome-relay]", ...a);

// --- Browser connection ----------------------------------------------------

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer };

let ext: ServerWebSocket<WsData> | null = null;
let extInfo: Record<string, unknown> = {};
let relayError: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function originAllowed(origin: string | null): boolean {
  if (!origin?.startsWith("chrome-extension://")) return false;
  if (!PINNED_EXTENSION_ID) return true;
  return origin === `chrome-extension://${PINNED_EXTENSION_ID}`;
}

// Multi-session design: the first server process to bind PORT is the "owner" and
// holds the extension socket. Every later process finds the port busy and attaches
// to the owner as a "client" over ws://127.0.0.1:PORT/client; the owner executes
// its calls on the browser and replies on that client's own socket, so results
// are routed per session. If the owner exits, a client promotes itself to owner.

type Role = "owner" | "client" | "starting";
let role: Role = "starting";
let clientWs: WebSocket | null = null;
const clientPending = new Map<number, Pending>();
let nextClientId = 1;

type WsData = { kind: "ext" | "client" };

function startOwner(): boolean {
  try {
    Bun.serve<WsData>({
      hostname: "127.0.0.1",
      port: PORT,
      fetch(req, server) {
        const origin = req.headers.get("origin");
        if (new URL(req.url).pathname === "/client") {
          // Local relay processes are not browsers: they send no Origin header.
          // Any web page does, so pages are still rejected.
          if (origin) return new Response("forbidden", { status: 403 });
          if (server.upgrade(req, { data: { kind: "client" } })) return;
        } else {
          if (!originAllowed(origin)) return new Response("forbidden", { status: 403 });
          if (server.upgrade(req, { data: { kind: "ext" } })) return;
        }
        return new Response("chrome-relay: websocket only", { status: 426 });
      },
      websocket: {
        idleTimeout: 60, // extension pings every 20s; frees the slot if a browser vanishes
        open(ws) {
          if (ws.data.kind === "client") return;
          // First browser wins. Replacing would make two browsers with the
          // extension kick each other out forever.
          if (ext) {
            ws.close(4001, "another browser is already connected");
            return;
          }
          ext = ws;
          log("extension connected");
        },
        message(ws, raw) {
          let msg: any;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (ws.data.kind === "client") {
            // Request from another session: run it and answer on this socket only.
            if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
            const answer = (body: object) => {
              try {
                ws.send(JSON.stringify({ id: msg.id, ...body }));
              } catch {}
            };
            const run =
              msg.method === "__status"
                ? Promise.resolve({ connected: !!ext, port: PORT, browser: ext ? extInfo : undefined })
                : callBrowser(msg.method, msg.params ?? {});
            run.then(
              (result) => answer({ result: result ?? null }),
              (e) => answer({ error: String(e?.message ?? e) }),
            );
            return;
          }
          if (msg.type === "hello") {
            extInfo = msg.info ?? {};
            return;
          }
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        },
        close(ws) {
          if (ws.data.kind === "ext" && ext === ws) {
            ext = null;
            log("extension disconnected");
            for (const [id, p] of pending) {
              clearTimeout(p.timer);
              p.reject(new Error("browser extension disconnected"));
              pending.delete(id);
            }
          }
        },
      },
    });
  } catch (e: any) {
    if (e?.code === "EADDRINUSE") return false;
    relayError = `Failed to start relay: ${e?.message ?? e}`;
    log(relayError);
    role = "owner"; // nothing more to try; callBrowser reports relayError
    return true;
  }
  role = "owner";
  relayError = null;
  log(`listening on ws://127.0.0.1:${PORT} (owner)`);
  return true;
}

function failClientPending(reason: string) {
  for (const [id, p] of clientPending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    clientPending.delete(id);
  }
}

function attachAsClient() {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/client`);
  let opened = false;
  sock.onopen = () => {
    opened = true;
    clientWs = sock;
    role = "client";
    relayError = null;
    log(`attached to relay owner on port ${PORT} (client)`);
  };
  sock.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const p = clientPending.get(msg.id);
    if (!p) return;
    clientPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  sock.onerror = () => {};
  sock.onclose = () => {
    if (clientWs === sock) clientWs = null;
    failClientPending("relay owner disconnected");
    if (!opened) {
      relayError = `Port ${PORT} is in use by something that is not a chrome-relay owner (or an old chrome-relay without multi-session support; restart that session). Set CHROME_RELAY_PORT to use another port.`;
      log(relayError);
    }
    // Owner went away (or never was usable): try to become the owner, else re-attach.
    role = "starting";
    setTimeout(connectOrOwn, 200 + Math.random() * 600);
  };
}

function connectOrOwn() {
  if (!startOwner()) attachAsClient();
}
connectOrOwn();

function callOwner(method: string, params: Record<string, unknown>): Promise<any> {
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error(relayError ?? "relay owner not reachable yet; retrying"));
  const id = nextClientId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clientPending.delete(id);
      reject(new Error(`relay did not answer "${method}" within ${(CALL_TIMEOUT_MS + 5000) / 1000}s`));
    }, CALL_TIMEOUT_MS + 5000);
    clientPending.set(id, { resolve, reject, timer });
    clientWs!.send(JSON.stringify({ id, method, params }));
  });
}

function callBrowser(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (role === "client") return callOwner(method, params);
  if (relayError) return Promise.reject(new Error(relayError));
  if (!ext)
    return Promise.reject(
      new Error(
        "No browser connected. Make sure the chrome-relay extension is installed and enabled in a Chromium-based browser (it reconnects automatically within a few seconds).",
      ),
    );
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ext!.send(JSON.stringify({ id, method, params }));
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
    let status: any;
    if (role === "client") {
      try {
        status = { ...(await callOwner("__status", {})), role: "client" };
      } catch (e: any) {
        status = { connected: false, error: String(e?.message ?? e) };
      }
    } else {
      status = relayError
        ? { connected: false, error: relayError }
        : { connected: !!ext, port: PORT, role, browser: ext ? extInfo : undefined };
    }
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
        serverInfo: { name: "chrome-relay", version: "0.1.0" },
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
