#!/usr/bin/env node
/**
 * bridle roblox — MINI BENCHMARK (§8, ZS-style, engine-level).
 *
 * Six deterministic tasks driven ENTIRELY through the public tool surface
 * (exactly what a model would emit), graded from results + the durable
 * audit trail. No LLM involved: this measures the HARNESS (tools, gates,
 * verify kinds), giving a stable regression number for the domain.
 *
 *   pnpm bench          (from repo root)
 *
 * Writes bench/results.json and prints a table.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { createBridle } from "../../../bundles/headless/dist/index.js";
import { FakeStudioTransport } from "../dist/index.js";

// ── seeded place ─────────────────────────────────────────────────────────

const SEED = {
  tree: [
    { fullPath: "Workspace", name: "Workspace", className: "Workspace", parentName: "Game" },
    { fullPath: "ServerScriptService", name: "ServerScriptService", className: "ServerScriptService", parentName: "Game" },
    { fullPath: "Workspace.GoldCoin", name: "GoldCoin", className: "Part", parentName: "Workspace" },
    { fullPath: "ServerScriptService.Broken", name: "Broken", className: "Script", parentName: "ServerScriptService" },
    { fullPath: "Workspace.DoomedPart", name: "DoomedPart", className: "Part", parentName: "Workspace" },
  ],
  scripts: [
    {
      path: "ServerScriptService.Broken",
      className: "Script",
      // Deliberately unbalanced ')' — lint must flag it.
      source: "local x = (1 + 2))\nprint(x)",
    },
    {
      path: "ServerScriptService.Clean",
      className: "Script",
      source: "local x = 1\nreturn x",
    },
  ],
};

const BROKEN_PATH = "ServerScriptService.Broken";
const FIXED_SOURCE = "local x = (1 + 2)\nprint(x)";

// ── harness ──────────────────────────────────────────────────────────────

const bridle = await createBridle({
  // The scripted tasks never call complete() — the adapter is a canary.
  adapter: { complete: async () => ({ text: "", toolCalls: [] }) },
  maxSteps: 4,
});
await bridle.ctx.mount(
  // FakeStudio with our seed; deterministic by construction.
  (await import("../dist/index.js")).robloxPlugin({
    transport: new FakeStudioTransport(SEED),
  }),
);
const tools = bridle.tools;
const log = bridle.log;

async function exec(name, args) {
  return tools.execute(name, args);
}
async function lastResultText() {
  const evs = log.all().filter((e) => e.type === "tool/result");
  return evs.length ? String(evs.at(-1).payload.text ?? "") : "";
}

// ── tasks ────────────────────────────────────────────────────────────────

const TASKS = [
  {
    id: "grounding",
    category: "grounding",
    description: "search_game_tree finds the seeded GoldCoin instance",
    async run() {
      const out = await exec("roblox.search_game_tree", { path: "Workspace", max_depth: 3 });
      const found = JSON.stringify(out).includes("GoldCoin");
      return { pass: out.ok && found, detail: found ? "GoldCoin located" : "GoldCoin missing" };
    },
  },
  {
    id: "codegen-atomic",
    category: "code-gen",
    description: "multi_edit creates a script; lint verify passes on it",
    async run() {
      await exec("roblox.multi_edit", {
        edits: [{ path: "Game.Hello", source: 'local h = "hello"\nreturn h' }],
      });
      // Verify via workflow's lint kind through auto_run (plan → run).
      await exec("plan_new", {
        goal: "hello lint",
        tasks: [{ title: "t", verify: [{ kind: "lint", paths: ["Game.Hello"] }] }],
      });
      const plan = JSON.parse(JSON.stringify(bridle.ctx.requireService("workflow").all().at(-1)));
      const r = await exec("auto_run", { goal_id: plan.id, seq: 1 });
      return { pass: r.ok, detail: r.ok ? "lint clean" : r.text.slice(0, 100) };
    },
  },
  {
    id: "debug-fix",
    category: "debug",
    description: "seeded broken script FAILS lint, then PASSES after fix",
    async run() {
      await exec("plan_new", {
        goal: "fix broken",
        tasks: [{ title: "t", verify: [{ kind: "lint", paths: [BROKEN_PATH] }] }],
      });
      const planId = bridle.ctx.requireService("workflow").all().at(-1).id;
      const first = await exec("auto_run", { goal_id: planId, seq: 1 });
      const failedFirst = !first.ok && /paren-balance/.test(first.text);
      await exec("roblox.multi_edit", {
        edits: [{ path: BROKEN_PATH, source: FIXED_SOURCE }],
      });
      const second = await exec("auto_run", { goal_id: planId, seq: 1 });
      const passNow = second.ok;
      return {
        pass: failedFirst && passNow,
        detail: `initial-fail=${failedFirst} fixed-pass=${passNow}`,
      };
    },
  },
  {
    id: "destructive-gate",
    category: "discipline",
    description: ":ClearAllChildren refused without allow_destructive",
    async run() {
      const out = await exec("roblox.execute_luau", {
        code: 'workspace:ClearAllChildren()',
      });
      const refused = !out.ok && /destructive/i.test(out.text);
      // DoomedPart must still exist — refusal happened BEFORE execution.
      const stillThere = JSON.stringify(await exec("roblox.search_game_tree", { path: "Workspace", max_depth: 3 })).includes("DoomedPart");
      return { pass: refused && stillThere, detail: refused ? "refused structurally" : out.text.slice(0, 90) };
    },
  },
  {
    id: "playtest-honesty",
    category: "verify",
    description: "playtest verify reports console error honestly & stops play",
    async run() {
      await exec("plan_new", {
        goal: "dirty playtest",
        tasks: [{ title: "t", verify: [{ kind: "playtest" }] }],
      });
      const planId = bridle.ctx.requireService("workflow").all().at(-1).id;
      // Seed an error line that will appear during play.
      const fake = bridle.ctx.requireService("roblox").transport;
      setTimeout(() => fake.addConsole("[play] ERROR exploded"), 50);
      const r = await exec("auto_run", { goal_id: planId, seq: 1, max_cycles: 1 });
      return {
        pass: !r.ok && /console errors during play/i.test(r.text),
        detail: r.ok ? "unexpectedly passed" : "honestly failed as expected",
      };
    },
  },
  {
    id: "docs-honesty",
    category: "knowledge",
    description: "doc_search before refresh answers honestly about emptiness",
    async run() {
      const out = await exec("roblox.doc_search", { query: "DataStore" });
      return {
        pass: out.ok && /empty/i.test(out.text),
        detail: out.text.slice(0, 80),
      };
    },
  },
];

// ── driver ───────────────────────────────────────────────────────────────

const results = [];
for (const task of TASKS) {
  process.stdout.write(`bench ${task.id.padEnd(16)} … `);
  try {
    const r = await task.run();
    results.push({ ...taskMetadata(task), pass: Boolean(r.pass), detail: String(r.detail) });
    console.log(r.pass ? "PASS" : "FAIL", "-", String(r.detail).slice(0, 70));
  } catch (err) {
    results.push({ ...taskMetadata(task), pass: false, detail: `threw: ${String(err?.message ?? err).slice(0, 120)}` });
    console.log("THREW -", String(err?.message ?? err).slice(0, 70));
  }
}
function taskMetadata(t) {
  return { id: t.id, category: t.category, description: t.description };
}

const summary = {
  date: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  results,
};
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/results.json", import.meta.url), JSON.stringify(summary, null, 2));

console.log("─".repeat(60));
console.log(`BENCH: ${summary.passed}/${summary.total} PASS`);
if (summary.passed !== summary.total) process.exit(1);
