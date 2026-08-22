# bridle bridge (browser extension, M3 — work in progress)

Turns a normal web-chat tab into the **render adapter** of a local bridle
harness. The harness owns the agent loop; this extension only renders turns:
it types one message into the chat, waits for the reply, reads it back.

```
harness (@bridle/agent) ──render_request──▶ gateway-ws ──ws──▶ service worker
        ▲                                              ──port──▶ content adapter (chat page)
        └──────────────── turn result ◀── render_result ◀──────────────┘
```

## Install (unpacked)

1. Build & start a gateway on the fixed port the extension expects:

   ```sh
   pnpm --filter @bridle/gateway-ws build
   node -e 'import("./packages/gateway-ws/dist/index.js").then(async m => {
     const gw = new m.WebchatGateway(() => [], { port: 8642 }, console.log);
     const port = await gw.listen();
     console.log("gateway on", port); // wire webchatAdapter() into your harness here
   })'
   ```

   (`8642` = `EXTENSION_DEFAULT_PORT`; override later via `chrome.storage`.)
2. `chrome://extensions` → Developer mode → **Load unpacked** → select
   `extension/`.
3. Open <https://chat.deepseek.com>. The adapter attaches automatically when
   the service worker's socket is up; renders fail honestly otherwise.

## Files

| File | Role |
|---|---|
| `background/service-worker.js` | Owns the single WebSocket to the gateway; relays frames to adapter ports; watchdog timeouts |
| `content/bridle-wire.js` | DOM-free tool wire format (encode directive / parse fenced `bridle-tool` blocks) — unit-tested in Node by the headless E2E |
| `content/deepseek.js` | DeepSeek DOM adapter: composer injection, stability-window completion detection, reasoning-container exclusion |

## Tool wire format

Web chats have no function-calling channel, so tool calls ride inside the
reply as a fenced block:

~~~
```bridle-tool
{"name": "math.eval", "args": {"expr": "12*9"}}
```
~~~

Multi-call replies use `{"calls": [...]}`. Results are fed back wrapped in
`⟦TOOL ok|error name⟧…⟦/TOOL⟧`. Provenance: concept adopted from
ZeroScript-Free (GPL-3.0), original expression — see
`docs/architecture.md#provenance`.

## Known MVP limits

- Only DeepSeek is wired; other providers need sibling adapters.
- Only the newest message since the last assistant turn is injected (the site
  thread already holds earlier turns).
- No popup/config UI yet: the gateway URL is the compiled-in default.
- Completion detection is heuristic (stability window + stop-glyph probe);
  site redeployments may require selector updates in `deepseek.js`.
