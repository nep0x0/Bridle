import { describe, expect, it } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin } from "@bridle/session";
import { toolsPlugin, type ToolsService } from "@bridle/tools";
import { workflowPlugin, type WorkflowApi } from "@bridle/workflow";
import { FakeStudioTransport, robloxPlugin } from "../src/index.ts";
import {
  lintSource,
  extractServiceTokens,
  TEST_PASS_MARKER,
} from "../src/verify/index.ts";

async function boot(consoleLines: string[] = []) {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: sessionPlugin });
  await ctx.mount({ name: "tools", setup: toolsPlugin });
  await ctx.mount(workflowPlugin());
  const fake = new FakeStudioTransport({
    consoleLines,
    scripts: [
      {
        path: "ServerScriptService.Main",
        className: "Script",
        source: 'local Players = game:GetService("Players")\nprint("boot")\n',
      },
    ],
  });
  await ctx.mount(robloxPlugin({ transport: fake, docs: false }));
  const tools = ctx.requireService("tools") as unknown as ToolsService;
  const wf = ctx.requireService("workflow") as unknown as WorkflowApi;
  return { ctx, tools, wf, fake };
}

const exec = (tools: ToolsService, name: string, args: unknown = {}) =>
  tools.execute(name, args as Record<string, unknown>);

describe("R3: deterministic lint kind", () => {
  it("flags legacy APIs and paren imbalance as errors", () => {
    const findings = lintSource(
      "X",
      'wait(1)\nlocal x = (1 + 2\nprint("dbg")\n',
    );
    expect(findings.some((f) => f.rule === "legacy-api" && f.severity === "error")).toBe(true);
    expect(findings.some((f) => f.rule === "paren-balance")).toBe(true);
    expect(findings.some((f) => f.rule === "print" && f.severity === "info")).toBe(true);
    // strings containing parens must not break the balance check
    expect(lintSource("Y", 'print(")(")').some((f) => f.rule === "paren-balance")).toBe(false);
  });

  it("lint verify kind passes a clean place and fails a dirty one via auto_run", async () => {
    const h = await boot();
    // clean: Main only has print() -> info; ok
    await h.tools.execute("plan_new", {
      goal: "g",
      tasks: [{ title: "t", verify: [{ kind: "lint" }] }],
    });
    let r = await exec(h.tools, "auto_run", { goal_id: h.wf.all()[0]!.id, seq: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("lint [PASS]");

    // dirty: inject legacy wait()
    await h.fake.multiEdit([
      { path: "ServerScriptService.Legacy", source: "wait(2)" },
    ]);
    await h.tools.execute("plan_new", {
      goal: "g2",
      tasks: [{ title: "t", verify: [{ kind: "lint" }] }],
    });
    r = await exec(h.tools, "auto_run", { goal_id: h.wf.all()[1]!.id, seq: 1 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("legacy-api");
    // task stays pending (not done)
    expect(h.wf.get(h.wf.all()[1]!.id)!.tasks[0]!.status).not.toBe("done");
  });

  it("docs kind verifies service tokens against the mirror (empty = honest skip)", async () => {
    const h = await boot();
    await h.tools.execute("plan_new", {
      goal: "g",
      tasks: [{ title: "t", verify: [{ kind: "docs" }] }],
    });
    const r = await exec(h.tools, "auto_run", { goal_id: h.wf.all()[0]!.id, seq: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("docs mirror empty");
  });

  it("unit_test kind requires the pass marker over the transport", async () => {
    const h = await boot();
    await h.tools.execute("plan_new", {
      goal: "passing",
      tasks: [
        {
          title: "t",
          verify: [
            { kind: "unit_test", code: `print("${TEST_PASS_MARKER}")` },
          ],
        },
      ],
    });
    const okRun = await exec(h.tools, "auto_run", { goal_id: h.wf.all()[0]!.id, seq: 1 });
    expect(okRun.text).toContain("unit_test [PASS]");

    await h.tools.execute("plan_new", {
      goal: "failing",
      tasks: [{ title: "t", verify: [{ kind: "unit_test", code: 'print("nope")' }] }],
    });
    const bad = await exec(h.tools, "auto_run", {
      goal_id: h.wf.all()[1]!.id,
      seq: 1,
      max_cycles: 1,
    });
    expect(bad.text).toContain(`no ${TEST_PASS_MARKER}`);
  });

  it("playtest kind: clean play passes, error console fails, play always stops", async () => {
    const h = await boot();
    await h.tools.execute("plan_new", {
      goal: "clean run",
      tasks: [{ title: "t", verify: [{ kind: "playtest" }] }],
    });
    const okRun = await exec(h.tools, "auto_run", { goal_id: h.wf.all()[0]!.id, seq: 1 });
    expect(okRun.text).toContain("playtest [PASS]");
    expect(h.fake.isPlaying()).toBe(false); // stopped even after PASS

    await h.tools.execute("plan_new", {
      goal: "dirty run",
      tasks: [{ title: "t", verify: [{ kind: "playtest" }] }],
    });
    // queue an error line that will appear AFTER baseline
    setTimeout(() => h.fake.addConsole("[play] ERROR something exploded"), 5);
    const bad = await exec(h.tools, "auto_run", {
      goal_id: h.wf.all()[1]!.id,
      seq: 1,
      max_cycles: 1,
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("console errors during play");
    expect(h.fake.isPlaying()).toBe(false);
  });

  it("cross-plugin wiring: roblox kinds are listed by the workflow pack", async () => {
    const h = await boot();
    expect(h.wf.listVerifyKinds()).toEqual(
      expect.arrayContaining(["lint", "docs", "unit_test", "playtest"]),
    );
  });
});

describe("service token extraction", () => {
  it("dedups GetService names", () => {
    const src =
      'local a = game:GetService("Players")\nlocal b = game:GetService("Players")\nlocal c = game:GetService("DataStoreService")';
    expect(extractServiceTokens(src)).toEqual(["Players", "DataStoreService"]);
  });
});
