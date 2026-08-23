/**
 * bridle webchat entry — live "brain in a browser tab" runner.
 *
 * Interactive surface auto-selects:
 *   real terminal  → Ink TUI  (dist/tui/app.js)
 *   pipes / CI     → plain readline fallback
 *
 * CONFIG: bridle.config.json (repo root, then ~/.config/bridle/config.json)
 *   {
 *     "webchat": { "roblox": true, "allow": ["…"], "verbose": false },
 *     "roblox":  { "studioMcpPath": "…", "winePrefix": "…" }
 *   }
 * With `webchat.roblox: true` (or Studio auto-detected), running is simply:
 *
 *   bridle webchat
 *
 * CLI flags always override the config. Exported as main(cliArgs).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import readline from "node:readline";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBridle } from "../dist/index.js";
import { commandPlugin, turnProgressPlugin } from "../dist/index.js";
import {
  WebchatGateway,
  EXTENSION_DEFAULT_PORT,
} from "@bridle/gateway-ws";
import { listApprover } from "@bridle/security";
import { blockingConsoleApprover } from "@bridle/security/node";
import { robloxPlugin, loadRobloxConfig } from "@bridle/roblox";

export async function main(cliArgs = []) {
  // ── config file ────────────────────────────────────────────────────────
  function readWebchatConfig() {
    const candidates = [
      join(process.cwd(), "bridle.config.json"),
      join(homedir(), ".config", "bridle", "config.json"),
    ];
    for (const file of candidates) {
      try {
        if (!existsSync(file)) continue;
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        if (raw && typeof raw.webchat === "object" && raw.webchat) return raw.webchat;
      } catch {
        /* unreadable config skipped honestly */
      }
    }
    return {};
  }
  const cfg = readWebchatConfig();

  // ── CLI flags ──────────────────────────────────────────────────────────
  const argv = [...cliArgs];
  const cliAllow = [];
  let forceRoblox = false;
  let noRoblox = false;
  let verbose = argv.includes("--verbose") || cfg.verbose === true;
  for (let i = 0; i < argv.length; ) {
    if (argv[i] === "--roblox") {
      forceRoblox = true;
      argv.splice(i, 1);
    } else if (argv[i] === "--no-roblox") {
      noRoblox = true;
      argv.splice(i, 1);
    } else if (argv[i] === "--verbose") {
      verbose = true;
      argv.splice(i, 1);
    } else if (argv[i] === "--allow") {
      const value = argv[i + 1];
      if (value) {
        for (const s of value.split(",")) {
          const t = s.trim();
          if (t) cliAllow.push(t);
        }
        argv.splice(i, 2);
      } else {
        argv.splice(i, 1);
      }
    } else {
      i++;
    }
  }

  // ── resolved settings (CLI > config > smart defaults) ──────────────────
  // ── port-reclaim (pola ZS): hanya satu proxy boleh memegang port WS ────
  // StudioMCP.exe adalah SERVER; Studio menyambung KEPADANYA. Proxy lama
  // yang masih hidup terus memegang port sehingga proxy baru tidak pernah
  // mendapat instans. Akhiri HANYA yang terbukti dari cmdline.
  function reclaimStaleProxies() {
    try {
      const out = execSync("ps -eo pid,args --no-headers", { encoding: "utf8" });
      const victims = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /StudioMCP\.exe/i.test(l))
        .map((l) => ({ pid: Number(l.split(/\s+/)[0]), line: l }))
        .filter((v) => Number.isFinite(v.pid));
      if (victims.length === 0) return;
      console.log(`[bridle] membersihkan ${victims.length} proxy StudioMCP lama …`);
      for (const v of victims) {
        try {
          process.kill(v.pid, "SIGKILL");
          console.log(`[bridle]   killed pid ${v.pid}`);
        } catch { /* sudah mati */ }
      }
    } catch { /* ps tidak tersedia — lewati */ }
  }
  reclaimStaleProxies();

  const rcfg = loadRobloxConfig(() => {}, process.env);
  const studioDetected = Boolean(rcfg.studioMcpPath);
  const mountRoblox = noRoblox
    ? false
    : forceRoblox || cfg.roblox === true || (cfg.roblox === undefined && studioDetected);

  const allowedTools = [];
  const pushAllow = (s) => {
    const t = String(s ?? "").trim();
    if (t && !allowedTools.includes(t)) allowedTools.push(t);
  };
  for (const a of Array.isArray(cfg.allow) ? cfg.allow : []) pushAllow(a);
  for (const a of cliAllow) pushAllow(a);
  if (allowedTools.length) {
    for (const builtin of ["echo", "now"]) pushAllow(builtin);
  }

  const DEFAULT_PROMPT = "What is 12*9? Use the math tool.";
  const promptArg = argv.join(" ").trim();
  const prompt = promptArg || DEFAULT_PROMPT;

  // Security policy (M4): reads flow; writes/executes ask or follow allow-list.
  const approver = allowedTools.length
    ? listApprover(allowedTools)
    : blockingConsoleApprover();

  const vlog = (...a) => {
    if (verbose) console.log(...a);
  };

  // ── harness + gateway ──────────────────────────────────────────────────
  const GATEWAY_PORT =
    Number(process.env.BRIDLE_GATEWAY_PORT) || EXTENSION_DEFAULT_PORT;

  // Construct first, listen later — capabilities frame then advertises all.
  const gw = new WebchatGateway(
    () => bridle.tools.list(),
    { port: GATEWAY_PORT, renderTimeoutMs: 300_000 },
    (m) => vlog("[gateway]", m),
  );

  console.log(`[bridle] gateway on ws://127.0.0.1:${GATEWAY_PORT}`);
  const bridle = await createBridle({
    adapter: gw.webchatAdapter(),
    maxSteps: 6,
    security: {
      modes: { read: "allow", write: "ask", execute: "ask" },
      approver,
    },
  });

  if (mountRoblox) {
    await bridle.ctx.mount(robloxPlugin({ log: (m) => vlog("[roblox]", m) }));
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

  // ── studio watch: NON-BLOCKING & bebas polusi log ──────────────────────
  // Poll dilakukan LANGSUNG lewat transport (bukan tools.execute) supaya
  // tidak menciptakan event tool/result palsu di session log — log adalah
  // konteks model, polling diagnostik tidak boleh ikut terlihat model.
  let studioName = null;
  let studioState = mountRoblox ? "checking" : "off";
  let robloxTransport = null;
  if (mountRoblox) {
    try {
      robloxTransport = bridle.ctx.requireService("roblox").transport;
    } catch { /* tidak fatal */ }
    console.log("[bridle] menunggu Studio mendaftar ke MCP proxy … (REPL tetap bisa dipakai)");
    (async () => {
      const deadline = Date.now() + 120_000; // Studio boleh dibuka belakangan
      while (Date.now() < deadline && studioState === "checking") {
        try {
          const studios = await robloxTransport.listStudios();
          if (studios.length > 0) {
            studioName = studios[0].name ?? "(unnamed)";
            studioState = "ready";
            console.log(`[bridle] studio siap: ${studioName}`);
            return;
          }
        } catch { /* proxy belum siap — coba lagi */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (studioState === "checking") {
        studioState = "unavailable";
        console.log("[bridle] Studio tidak mendaftar dalam 2 menit — buka Studio, nanti terdeteksi otomatis di sesi baru");
      }
    })();
  }

  const cleanupAll = () => {
    try { robloxTransport?.close?.(); } catch {}
  };
  process.on("exit", cleanupAll);
  const _sigint = process.listeners("SIGINT").at(-1);
  if (_sigint) { process.removeListener("SIGINT", _sigint); }
  process.on("SIGINT", () => { cleanupAll(); gw.close().finally(() => process.exit(130)); });

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
      getHeader: () => ({
        tools: bridle.tools.list().length,
        studio:
          studioName ??
          (studioState === "checking" ? "mendaftar…" : null),
      }),
      onClose: () => { cleanupAll(); },
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
