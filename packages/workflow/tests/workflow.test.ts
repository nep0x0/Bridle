import { describe, expect, it, vi } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin } from "@bridle/session";
import { toolsPlugin } from "@bridle/tools";
import {
  workflowPlugin,
  type WorkflowApi,
} from "../src/index.ts";

async function setup(
  workflowOpts?: Parameters<typeof workflowPlugin>[0],
  security?: { modes: Record<string, string> },
) {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: sessionPlugin });
  await ctx.mount({ name: "tools", setup: toolsPlugin });

  if (security) {
    // Minimal inline gate with the same contract as @bridle/security:
    // deny by short-circuiting pre-execute with decision.deny.
    await ctx.mount({
      name: "gate",
      setup(s) {
        s.on("tools/pre-execute", (p) => {
          const cls = p.request.name === "plan_new" || p.request.name === "plan_status"
            ? "write" : undefined;
          if (cls && security.modes[cls] === "deny") {
            p.decision.deny = `${cls} is denied by policy`;
          }
        });
      },
    });
  }

  await ctx.mount(workflowPlugin(workflowOpts));
  const tools = ctx.requireService("tools");
  const wf = ctx.requireService("workflow") as unknown as WorkflowApi;
  const log = ctx.requireService("sessions");
  return { ctx, tools, wf, log };
}

async function makePlan(
  h: Awaited<ReturnType<typeof setup>>,
  tasks?: Array<{ title: string; verify?: Array<Record<string, unknown>> }>,
  decision?: Record<string, unknown>,
): Promise<{ id: string; out: string }> {
  const out = await h.tools.execute("plan_new", {
    goal: "ship the feature",
    tasks: tasks ?? [{ title: "do the thing", verify: [{ kind: "static", note: "eyeballed" }] }],
    decision,
  });
  expect(out.ok).toBe(true);
  const id = /plan_[0-9a-f]+/.exec(out.text)![0];
  return { id, out };
}

describe("workflow pack (M4 completion)", () => {
  it("plan lifecycle: new -> list (with DECISION) -> status -> done", async () => {
    const h = await setup();
    const { id } = await makePlan(h, undefined, {
      chosen: "vanilla GUI",
      reason: "no deps",
      alternatives: ["Vide"],
    });

    const listed = await h.tools.execute("plan_list", {});
    expect(listed.text).toContain("DECISION: chosen: vanilla GUI vs Vide");
    expect(listed.text).toContain("reason: no deps");

    const st = await h.tools.execute("plan_status", {
      goal_id: id,
      seq: 1,
      status: "in_progress",
    });
    expect(st.ok).toBe(true);

    const done = await h.tools.execute("plan_status", {
      goal_id: id,
      seq: 1,
      status: "done",
      result: "shipped",
    });
    expect(done.text).toContain("[done]");
  });

  it("validates honestly: missing goal, empty tasks, bad status", async () => {
    const h = await setup();
    expect((await h.tools.execute("plan_new", { goal: "", tasks: [{ title: "x" }] })).ok).toBe(false);
    expect((await h.tools.execute("plan_new", { goal: "g", tasks: [] })).ok).toBe(false);
    await makePlan(h);
    const bad = await h.tools.execute("plan_status", {
      goal_id: h.wf.all()[0]!.id,
      seq: 1,
      status: "yolo",
    });
    expect(bad.text).toContain("status must be one of");
  });

  it("auto_run PASS marks done with proof (static + tool verify)", async () => {
    const h = await setup();
    h.tools.register({
      name: "probe",
      description: "",
      execute: () => ({ ok: true, text: "all good" }),
    });
    const { id } = await makePlan(h, [
      {
        title: "verified task",
        verify: [
          { kind: "static", note: "spec exists" },
          { kind: "tool", name: "probe", args: {} },
        ],
      },
    ]);
    const r = await h.tools.execute("auto_run", { goal_id: id, seq: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("VERDICT PASS");
    expect(r.text).toContain("[done]");
    expect(h.wf.get(id)!.tasks[0]!.status).toBe("done");
  });

  it("auto_run FAIL counts cycles then BLOCKS the task honestly", async () => {
    const h = await setup({ maxCycles: 2 });
    h.tools.register({
      name: "failing",
      description: "",
      execute: () => ({ ok: false, text: "still broken" }),
    });
    const { id } = await makePlan(h, [
      { title: "t", verify: [{ kind: "tool", name: "failing" }] },
    ]);

    const r1 = await h.tools.execute("auto_run", { goal_id: id, seq: 1 });
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain("cycle 1/2");

    const r2 = await h.tools.execute("auto_run", { goal_id: id, seq: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain("BLOCKED");
    expect(h.wf.get(id)!.tasks[0]!.status).toBe("blocked");
  });

  it("unknown verify kind FAILs honestly (never skipped silently)", async () => {
    const h = await setup();
    const { id } = await makePlan(h, [
      { title: "t", verify: [{ kind: "playtest" }] },
    ]);
    const r = await h.tools.execute("auto_run", { goal_id: id, seq: 1, max_cycles: 1 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("unknown verify kind");
  });

  it("custom verify kinds can be injected (domain extension point)", async () => {
    const h = await setup({
      verifyKinds: {
        docs: async () => ({ ok: true, detail: "docs checked" }),
      },
    });
    const { id } = await makePlan(h, [
      { title: "t", verify: [{ kind: "docs" }] },
    ]);
    const r = await h.tools.execute("auto_run", { goal_id: id, seq: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("docs [PASS]: docs checked");
  });

  it("security gate integration: write=deny blocks plan_new", async () => {
    const h = await setup(undefined, { modes: { write: "deny" } });
    const out = await h.tools.execute("plan_new", {
      goal: "g",
      tasks: [{ title: "t" }],
    });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Permission denied");
  });

  it("mutations mirror durable workflow/* session events", async () => {
    const h = await setup();
    const { id } = await makePlan(h);
    await h.tools.execute("plan_status", { goal_id: id, seq: 1, status: "done" });
    const types = h.log.all().map((e) => e.type);
    expect(types).toContain("workflow/plan-created");
    expect(types).toContain("workflow/task-status");
  });
});
