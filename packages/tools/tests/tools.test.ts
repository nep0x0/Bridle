import { describe, expect, it, vi } from "vitest";
import { Context } from "@bridle/kernel";
import {
  ToolsService,
  toolsPlugin,
  type PostExecutePayload,
} from "../src/index.ts";

async function setup() {
  const ctx = new Context();
  await ctx.mount({ name: "tools", setup: toolsPlugin });
  const tools = ctx.requireService("tools");
  return { ctx, tools };
}

describe("tools registry", () => {
  it("registers, lists and refuses duplicates", async () => {
    const { tools } = await setup();
    tools.register({
      name: "echo",
      description: "echo text",
      execute: (a: { text: string }) => ({ ok: true, text: a.text }),
    });
    expect(tools.list()).toEqual([{ name: "echo", description: "echo text" }]);
    expect(() =>
      tools.register({
        name: "echo",
        description: "dup",
        execute: () => ({ ok: true, text: "" }),
      }),
    ).toThrow(/already registered/);
  });

  it("executes a tool and reports unknown tools honestly", async () => {
    const { tools } = await setup();
    const exec = vi.fn(() => ({ ok: true, text: "hi" }));
    tools.register({ name: "echo", description: "", execute: exec });
    await expect(tools.execute("echo", {})).resolves.toEqual({
      ok: true,
      text: "hi",
    });
    expect(exec).toHaveBeenCalledOnce();
    const bad = await tools.execute("nope", {});
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("unknown tool");
  });

  it("tool exceptions become ok=false results, never thrown", async () => {
    const { tools } = await setup();
    tools.register({
      name: "boom",
      description: "",
      execute: () => {
        throw new Error("kaboom");
      },
    });
    await expect(tools.execute("boom", {})).resolves.toEqual({
      ok: false,
      text: "tool threw: Error: kaboom",
    });
  });
});

describe("guarded pipeline", () => {
  it("policy listener can DENY via short-circuit (execute skipped)", async () => {
    const { ctx, tools } = await setup();
    const exec = vi.fn(() => ({ ok: true, text: "ran" }));
    tools.register({ name: "danger", description: "", execute: exec });

    // A policy plugin: deny 'danger' by owning the decision.
    await ctx.mount({
      name: "policy",
      setup(s) {
        s.on("tools/pre-execute", (p, next) => {
          if (p.request.name === "danger") p.decision.deny = "blocked by policy";
          return next(); // annotate-and-delegate still honours decision
        });
      },
    });
    const out = await tools.execute("danger", {});
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Permission denied: blocked by policy/);
    expect(exec).not.toHaveBeenCalled();

    // non-targeted tool passes untouched
    tools.register({ name: "safe", description: "", execute: exec });
    await expect(tools.execute("safe", {})).resolves.toEqual({
      ok: true,
      text: "ran",
    });
  });

  it("pre-execute can MUTATE arguments before execution", async () => {
    const { ctx, tools } = await setup();
    let seen = "";
    tools.register({
      name: "shout",
      description: "",
      execute: (a: { text: string }) => {
        seen = a.text;
        return { ok: true, text: seen };
      },
    });
    await ctx.mount({
      name: "upper",
      setup(s) {
        s.on("tools/pre-execute", (p, next) => {
          if (p.request.name === "shout") {
            p.request.args = { ...p.request.args, text: "LOUD" };
          }
          return next();
        });
      },
    });
    await tools.execute("shout", { text: "quiet" });
    expect(seen).toBe("LOUD");
  });

  it("post-execute emits audit payload with elapsed time", async () => {
    const { ctx, tools } = await setup();
    const audits: PostExecutePayload[] = [];
    await ctx.mount({
      name: "auditor",
      setup(s) {
        s.on("tools/post-execute", (p) => audits.push(p));
      },
    });
    tools.register({
      name: "ok",
      description: "",
      execute: () => ({ ok: true, text: "fine" }),
    });
    await tools.execute("ok", {});
    expect(audits.length).toBe(1);
    expect(audits[0]!.output.ok).toBe(true);
    expect(typeof audits[0]!.elapsedMs).toBe("number");
  });

  it("denied calls do NOT emit post-execute (nothing executed)", async () => {
    const { ctx, tools } = await setup();
    const audits: PostExecutePayload[] = [];
    await ctx.mount({
      name: "auditor",
      setup(s) {
        s.on("tools/post-execute", (p) => audits.push(p));
      },
    });
    await ctx.mount({
      name: "blocker",
      setup(s) {
        s.on("tools/pre-execute", (p) => {
          p.decision.deny = "no";
          // no next(): short-circuit
        });
      },
    });
    tools.register({ name: "t", description: "", execute: () => ({ ok: true, text: "" }) });
    await tools.execute("t", {});
    expect(audits.length).toBe(0);
  });
});
