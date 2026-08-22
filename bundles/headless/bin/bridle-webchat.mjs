#!/usr/bin/env node
/**
 * bridle-webchat — LIVE test runner (M3).
 *
 * Wires a full harness whose "brain" is a real web-chat tab:
 *
 *   gateway (ws://127.0.0.1:8642)  ◀── the bridle bridge extension
 *        ▲                                    │
 *        └── render_request/render_result ────┘   chat.deepseek.com tab
 *
 * Usage:
 *   node bundles/headless/bin/bridle-webchat.mjs ["prompt"]
 *
 * No API key needed — the model is whatever you are logged into in the tab.
 * The extension must be loaded unpacked (see extension/README.md) and the
 * chat tab open; this script waits for the adapter before sending.
 */

import { createBridle } from "../dist/index.js";
import {
  WebchatGateway,
  EXTENSION_DEFAULT_PORT,
} from "@bridle/gateway-ws";

const prompt =
  process.argv.slice(2).join(" ").trim() ||
  "What is 12*9? Use the math tool.";

// Construct first, listen later — so the capabilities frame pushed when the
// adapter connects already lists every registered tool.
const gw = new WebchatGateway(
  () => bridle.tools.list(),
  { port: EXTENSION_DEFAULT_PORT },
  (m) => console.log("[gateway]", m),
);

console.log(`[bridle] starting harness; gateway will listen on ws://127.0.0.1:${EXTENSION_DEFAULT_PORT}`);
const bridle = await createBridle({ adapter: gw.webchatAdapter(), maxSteps: 6 });
await gw.listen();
console.log("[bridle] tools:", bridle.tools.list().map((t) => t.name).join(", "));
console.log("[bridle] waiting for a chat tab to attach (load the extension, then open or REFRESH chat.deepseek.com) …");

// Wait until a content adapter announces itself (`adapter_ready`), not just
// until the service worker's socket is up — the socket alone does NOT mean
// any chat tab is wired. Bail after 90s with an honest message.
const adapterDeadline = Date.now() + 90_000;
while (!gw.hasReadyAdapter()) {
  if (Date.now() > adapterDeadline) {
    console.error(
      "[bridle] no chat tab attached within 90s. Checklist:\n" +
        "  1. extension loaded unpacked from ./extension (chrome://extensions)\n" +
        "  2. a chat.deepseek.com tab opened or REFRESHED after loading it\n" +
        "  3. that tab's DevTools console shows: [bridle] adapter ready\n" +
        "See extension/README.md for details.",
    );
    await gw.close();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (gw.readyAdapter?.url) {
  console.log(`[bridle] adapter ready: ${gw.readyAdapter.url}`);
}
console.log("[bridle] adapter connected — running turn through the browser …\n");

process.on("SIGINT", () => gw.close().finally(() => process.exit(130)));

try {
  const res = await bridle.run(prompt);
  console.log("─".repeat(60));
  if (res.rejected) {
    console.error(`rejected: ${res.rejected}`);
  } else {
    console.log(`steps: ${res.steps}`);
    console.log(`final: ${res.text || "(empty response)"}`);
    console.log("\nsession log:");
    for (const e of bridle.log.all()) {
      const p = JSON.stringify(e.payload);
      console.log(`  ${String(e.id).padStart(3)} ${e.type.padEnd(18)} ${p.slice(0, 100)}`);
    }
  }
} catch (err) {
  console.error("[bridle] turn failed honestly:", err?.message ?? err);
} finally {
  await gw.close();
}
