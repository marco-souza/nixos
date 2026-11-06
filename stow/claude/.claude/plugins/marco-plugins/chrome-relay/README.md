# chrome-relay

Let Claude Code drive your real Chromium-based browser (Chrome, Brave, Edge,
Chromium, Vivaldi…).

```
Claude Code ──stdio/MCP──▶ server/index.ts (bun) ──WebSocket 127.0.0.1:18765──▶ extension
```

- **server/**: a dependency-free MCP server. Claude Code starts it automatically when
  the plugin is enabled, and it listens on `127.0.0.1:18765`.
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
- To accept only your own copy of the extension, set
  `CHROME_RELAY_EXTENSION_ID=<id from chrome://extensions>` in the environment that
  launches Claude Code.
- Claude acts with your real cookies and sessions. Disable the extension when you're
  not using it if that worries you.

## Configuration

- `CHROME_RELAY_PORT` sets the server port. If you change it, set the same port in
  the extension popup.
- One Claude Code session owns the relay at a time. A second session reports that the
  port is busy.
- One browser at a time: the first to connect wins. If the extension is installed in
  several browsers, the others wait and retry every 30s.

## Limitations

- Clicks and typing are synthetic DOM events. A few sites that require trusted input
  may ignore them; `browser_evaluate` is the escape hatch.
- Snapshots cover the top frame only, not iframes.
