# chrome-relay

Let Claude Code drive your real Chromium-based browser (Chrome, Brave, Edge,
Chromium, Vivaldi…).

```
Claude Code A ──stdio/MCP──▶ server (hub) ──WebSocket 127.0.0.1:18765──▶ extension
                                  ▲
                                  │ WebSocket 127.0.0.1:18765/session
                                  │
Claude Code B ──stdio/MCP──▶ server (peer)
Claude Code C ──stdio/MCP──▶ server (peer)
```

- **server/**: a dependency-free MCP server. Claude Code starts one per session when
  the plugin is enabled. The first one listens on `127.0.0.1:18765` and becomes the
  hub; the others connect to it as peers and the hub forwards their calls.
- **extension/**: a Manifest V3 extension. It connects to the server, executes
  commands and sends back the results. It reconnects on its own and its badge shows
  `on` while connected.
- **skills/chrome-relay**: tells Claude how and when to use the tools safely.

## Install

Requires [bun](https://bun.sh) on your `PATH`.

1. **Plugin** (inside Claude Code):
   ```
   /plugin marketplace add ~/.claude/plugins/marco-plugins
   /plugin install chrome-relay@marco-plugins
   ```
   Restart Claude Code. `/mcp` should then list `chrome-relay`.
2. **Extension**: open `chrome://extensions` (or `brave://extensions`, etc.), turn on
   **Developer mode**, click **Load unpacked** and select the `extension/` folder.
   Firefox/Safari aren't supported.

Then ask Claude something like "open news.ycombinator.com and summarise the top 5".

## Tools

| Tool | What it does |
| --- | --- |
| `browser_status` | Shows whether a browser is connected |
| `browser_tabs` | Lists open tabs |
| `browser_open` / `browser_navigate` | Opens a URL in a new tab, or navigates a tab (also `back`/`forward`/`reload`) and waits for the load |
| `browser_activate_tab` / `browser_close_tab` | Focuses or closes a tab |
| `browser_snapshot` | Returns the page text plus numbered interactive elements (refs) |
| `browser_click` / `browser_type` / `browser_scroll` | Interacts with an element by ref or CSS selector |
| `browser_wait_for` | Waits for a selector or for text to appear |
| `browser_screenshot` | Captures the visible tab as a PNG |
| `browser_evaluate` | Runs JS through the DevTools protocol (works with strict CSP) |

## Security

- The server binds to `127.0.0.1` only. It rejects any WebSocket whose `Origin`
  isn't `chrome-extension://…`, so websites can't connect to it.
- The `/session` path, which peer sessions use, only accepts local connections that
  send no `Origin` header. Browsers always send one, so web pages get a 403 there too.
- To accept only your own copy of the extension, set
  `CHROME_RELAY_EXTENSION_ID=<id from chrome://extensions>` in the environment that
  launches Claude Code.
- Claude acts with your real cookies and sessions. Disable the extension when you're
  not using it if that worries you.

## Configuration

- `CHROME_RELAY_PORT` sets the server port. If you change it, set the same port in
  the extension popup.
- Several Claude Code sessions can use the browser at once. The first session's
  server binds the port and is the hub; later sessions find the port in use and
  connect to the hub as peers. `browser_status` shows each session's `role`
  (`hub` or `peer`). All sessions share the same browser and tabs.
- When the hub's session exits, its peers fail any call that was in flight and
  race for the port within about a second. One becomes the new hub, the rest
  reconnect to it as peers, and the extension reconnects on its own. If the port
  is held by a program that isn't the relay, tool calls say so and the server
  keeps retrying.
- One browser at a time: the first to connect wins. If the extension is installed in
  several browsers, the others wait and retry every 30s.

## Limitations

- Clicks and typing are synthetic DOM events. A few sites that require trusted input
  may ignore them; `browser_evaluate` is the escape hatch.
- Snapshots cover the top frame only, not iframes.
