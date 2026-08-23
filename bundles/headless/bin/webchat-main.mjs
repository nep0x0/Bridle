/**
 * bridle webchat entry — live "brain in a browser tab" runner.
 *
 * Interactive surface auto-selects:
 *   real terminal  → Ink TUI  (dist/tui/app.js)
 *   pipes / CI     → plain readline fallback
 *
 * Exported as main(cliArgs); bin/bridle.mjs routes `webchat` here and
 * bin/bridle-webchat.mjs stays as a thin alias.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import readline from "node:readline";
import { createBridle } from "../dist/index.js";
import { commandPlugin, turnProgressPlugin } from "../dist/index.js";
import {
  WebchatGateway,
  EXTENSION_DEFAULT_PORT,
} from "@bridle/gateway-ws";
import { listApprover } from "@bridle/security";
import { blockingConsoleApprover } from "@bridle/security/node";
import { robloxPlugin } from "@bridle/roblox";

export async function main(cliArgs = []) {
  // ── CLI flags ──────────────────────────────────────────────────────────
  // Single left-to-right pass; splice each flag when consumed so indexes
  // never go stale.
  const argv = [...cliArgs];
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
        argv.splice(i, 1);
      }
    } else {
      i++;
    }
  }
  if (allowedTools.length) {
    for (const builtin of ["echo", "now"]) {
      if (!allowedTools.includes(builtin)) allowedTools.push(builtin);
    }
  }

  const DEFAULT_PROMPT = "What is 12*9? Use the math tool.";
  const promptArg = argv.join(" ").trim();
  const prompt = promptArg || DEFAULT_PROMPT;

  // Security policy (M4): reads flow; writes/executes ask or follow --allow.
  const approver = allowedTools.length
    ? listApprover(allowedTools)
    : blockingConsoleApprover();

  // Quiet startup unless --verbose.
  const vlog = (...a) => {
    if (verbose) console.log(...a);
  };

  // ── harness + gateway ──────────────────────────────────────────────────
  // Construct first, listen later — capabilities frame then advertises all.
  // Port override untuk sesi kedua (extension default tetap 8642).
const GATEWAY_PORT = Number(process.env.BRIDLE_GATEWAY_PORT) || EXTENSION_DEFAULT_PORT;

const gw = new WebchatGateway(
    () => bridle.tools.list(),
    { port: GATEWAY_PORT, renderTimeoutMs: 300_000 },
    (m) => vlog("[gateway]", m),
  );

  console.log(`[bridle] gateway on ws://127.0.0.1:${GATEWAY_PORT}${GATEWAY_PORT === EXTENSION_DEFAULT_PORT ? "" : "  (non-default — extension needs matching config)"}`);
  const bridle = await createBridle({
    adapter: gw.webchatAdapter(),
    maxSteps: 6,
    security: {
      modes: { read: "allow", write: "ask", execute: "ask" },
      approver,
    },
  });

  if (robloxFlag) {
    await bridle.ctx.mount(
      robloxPlugin({
        log: (m) => vlog("[roblox]", m),
        // live transport resolves from config automatically (vinegar path on
        // this machine); without config → deterministic FakeStudio.
      }),
    );
    console.log("[bridle] roblox domain mounted");
  }

  await gw.listen();
  vlog("[bridle] tools:", bridle.tools.list().map((t) => t.name).join(", "));
  console.log("[bridle] waiting for a chat tab to attach (load the extension, then open or REFRESH chat.deepseek.com) …");

  // ── wait for a REAL chat-tab attachment ────────────────────────────────
  // BRIDLE_SKIP_ADAPTER_WAIT=1 skips the gate (offline tinkering).
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

  process.on("SIGINT", () => gw.close().finally(() => process.exit(130)));

  // ── shared interactive plumbing (both surfaces are plugin-first) ───────
  const sinkRef = { current: () => {} };
  await bridle.ctx.mount(turnProgressPlugin({
    log: (l) => sinkRef.current("info", l),
  }));
  await bridle.ctx.mount(commandPlugin());
  const commands = bridle.ctx.requireService("commands");

  // ── surface selection ──────────────────────────────────────────────────
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (isTty) {
    // Compiled TUI lives under dist/tui/ — bin/ is not part of the graph.
    const { runTuiRepl } = await import("../dist/tui/app.js");
    await runTuiRepl({
      bridle,
      commands,
      initialPrompt: promptArg || undefined,
      verbose,
      sinkRef,
      onClose: () => {},
    });
    await gw.close().catch(() => {});
    return;
  }

  // ── legacy readline fallback (pipes / CI) ──────────────────────────────
  console.log("[bridle] REPL (readline fallback) ready — /help for commands. 'exit' to quit.");
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
    if (queue.length) await runTurn(queue.shift());
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
    if (text.startsWith("/")) {
      void commands
        .dispatch(text, { log: (...p) => console.log(...p) })
        .finally(() => rl.prompt(true));
      return;
    }
    if (running) {
      queue.push(text);
      console.log("[bridle] queued — turn in progress");
      return;
    }
    void runTurn(text);
  });

  if (promptArg) await runTurn(promptArg);
}
