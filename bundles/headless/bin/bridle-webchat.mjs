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
import { listApprover } from "@bridle/security";
import { blockingConsoleApprover } from "@bridle/security/node";
import { robloxPlugin } from "@bridle/roblox";

// ── CLI flags ────────────────────────────────────────────────────────────
// Single left-to-right pass: splice each flag the moment it is consumed so
// indexes never go stale (the earlier collect-then-splice version let
// "--allow" leak into the prompt when --roblox shifted every index).
const argv = process.argv.slice(2);
const allowedTools = [];
let robloxFlag = false;
const verbose = argv.includes("--verbose");
for (let i = 0; i < argv.length; ) {
  if (argv[i] === "--roblox") {
    robloxFlag = true;
    argv.splice(i, 1);
  } else if (argv[i] === "--verbose") {
    argv.splice(i, 1);
  } else if (argv[i] === "--allow") {
    const value = argv[i + 1];
    if (value) {
      for (const s of value.split(",")) {
        const t = s.trim();
        if (t) allowedTools.push(t);
      }
      argv.splice(i, 2);
    } else {
      argv.splice(i, 1); // --allow with no value: drop, don't misparse
    }
  } else {
    i++;
  }
}
if (allowedTools.length) {
  for (const builtin of ["echo", "now"]) {
    if (!allowedTools.includes(builtin)) allowedTools.push(builtin); // builtins stay usable
  }
}

const prompt = argv.join(" ").trim() || "What is 12*9? Use the math tool.";

// Security policy (M4): reads flow; writes/executes need approval —
// via the --allow list when given, otherwise interactively in this terminal.
const approver = allowedTools.length ? listApprover(allowedTools) : blockingConsoleApprover();

// Construct first, listen later — so the capabilities frame pushed when the
// adapter connects already lists every registered tool.
const gw = new WebchatGateway(
  () => bridle.tools.list(),
  { port: EXTENSION_DEFAULT_PORT },
  (m) => console.log("[gateway]", m),
);

console.log(`[bridle] starting harness; gateway will listen on ws://127.0.0.1:${EXTENSION_DEFAULT_PORT}`);
const bridle = await createBridle({
  adapter: gw.webchatAdapter(),
  maxSteps: 6,
  security: {
    modes: { read: "allow", write: "ask", execute: "ask" },
    approver,
  },
});

// ── Roblox domain (--roblox) ────────────────────────────────────────────
// Mounted AFTER createBridle so workflow/security exist, BEFORE listening so
// the capabilities frame already advertises the roblox tools.
if (robloxFlag) {
  await bridle.ctx.mount(
    robloxPlugin({
      log: (m) => console.log("[roblox]", m),
      // live transport resolves from config automatically (BRIDLE_STUDIO_MCP
      // or detected vinegar path); without it → deterministic FakeStudio.
    }),
  );
  console.log("[bridle] roblox domain mounted");
}

await gw.listen();
console.log("[bridle] tools:", bridle.tools.list().map((t) => t.name).join(", "));
console.log("[bridle] waiting for a chat tab to attach (load the extension, then open or REFRESH chat.deepseek.com) …");

// Wait until a content adapter announces itself (`adapter_ready`), not just
// until the service worker's socket is up — the socket alone does NOT mean
// any chat tab is wired. Bail after 90s with an honest message.
// BRIDLE_SKIP_ADAPTER_WAIT=1 skips the gate (offline tinkering: slash
// commands work; turns will fail honestly until a tab attaches).
const skipWait = process.env.BRIDLE_SKIP_ADAPTER_WAIT === "1";
const adapterDeadline = Date.now() + 90_000;
while (!skipWait && !gw.hasReadyAdapter()) {
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
// Register early so Ctrl+C works even while waiting for the adapter.

// ── REPL: one harness, many turns, consistent thread/log ────────────────
// The site thread already holds earlier turns; the adapter only injects
// what is NEW since the last assistant message, so back-to-back prompts in
// one session stay coherent (no duplicate-directive soup).
//
// Plugin-first: progress lines come from turnProgressPlugin, slash commands
// from the command registry service — this runner only wires readline.

import readline from "node:readline";
import { commandPlugin, turnProgressPlugin } from "../dist/index.js";

await bridle.ctx.mount(turnProgressPlugin({ log: (l) => console.log(l) }));
await bridle.ctx.mount(commandPlugin());
const commands = bridle.ctx.requireService("commands");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.setPrompt("bridle> ");
rl.prompt(true);

let running = false;
const queue = [];

async function runTurn(text) {
  running = true;
  console.log("─".repeat(60));
  try {
    const res = await bridle.run(text);
    if (res.rejected) {
      console.error(`rejected: ${res.rejected}`);
    } else {
      console.log(`steps: ${res.steps}`);
      console.log(`final: ${res.text || "(empty response)"}`);
      if (verbose) {
        for (const e of bridle.log.all()) {
          console.log(
            `  ${String(e.id).padStart(3)} ${e.type.padEnd(18)} ${JSON.stringify(e.payload).slice(0, 110)}`,
          );
        }
      }
    }
  } catch (err) {
    console.error("[bridle] turn failed honestly:", err?.message ?? err);
  }
  running = false;
  if (queue.length) runTurn(queue.shift());
  else rl.prompt(true);
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt(true);
    return;
  }
  if (/^(exit|quit|keluar)$/i.test(text)) {
    gw.close().finally(() => process.exit(0));
    return;
  }
  // Slash → command registry service; everything else → a harness turn.
  if (text.startsWith("/")) {
    commands
      .dispatch(text, { log: (...p) => console.log(...p) })
      .finally(() => rl.prompt(true));
    return;
  }
  if (running) {
    queue.push(text);
    console.log("[bridle] queued — turn in progress");
    return;
  }
  runTurn(text);
});

console.log(
  "\n[bridle] REPL ready — type a prompt and Enter. /help for commands. 'exit' to quit.\n" +
    "[bridle] same harness + same log for every turn; the chat thread stays coherent.",
);

// One-shot callers (`bridle-webchat.mjs "do X"`) land their task as the
// FIRST REPL turn instead of a separate fire-once path.
if (prompt) runTurn(prompt);


