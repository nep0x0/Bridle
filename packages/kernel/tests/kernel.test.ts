import { describe, expect, it } from "vitest";
import { Context, MissingServiceError } from "../src/context.js"
import type { PluginDef } from "../src/context.js";

describe("kernel: services", () => {
  it("provides and resolves synchronously", async () => {
    const ctx = new Context();
    ctx.provide("tools", { list: (n: number) => n });
    expect(ctx.peek("tools")!.list(5)).toBe(5);
    await expect(ctx.service("tools")).resolves.toBeDefined();
  });

  it("resolves late-provided services for waiters", async () => {
    const ctx = new Context();
    const p = ctx.service("llm");
    ctx.provide("llm", { stream: "ok" });
    await expect(p).resolves.toEqual({ stream: "ok" });
  });

  it("rejects double-provide of the same key", () => {
    const ctx = new Context();
    ctx.provide("tools", {});
    expect(() => ctx.provide("tools", {})).toThrow(/already provided/);
  });
});

describe("kernel: mounting + injection", () => {
  it("waits for required services before setup (load order via requires)", async () => {
    const ctx = new Context();
    const order: string[] = [];

    const consumer: PluginDef = {
      name: "consumer",
      requires: ["tools"],
      async setup(ctx) {
        order.push("consumer-setup");
        const tools = await ctx.service("tools");
        expect(tools).toEqual({ n: 1 });
      },
    };
    const provider: PluginDef = {
      name: "provider",
      setup(ctx) {
        order.push("provider-setup");
        ctx.provide("tools", { n: 1 });
      },
    };

    const mountOrderFirst = (async () => {
      // consumer mounted FIRST but must wait for its requirement
      await Promise.all([ctx.mount(consumer)]);
    })();
    await ctx.mount(provider);
    await mountOrderFirst;
    expect(order).toContain("provider-setup");
    expect(order).toContain("consumer-setup");
  });

  it("unmount unwinds effects LIFO and removes listeners", async () => {
    const ctx = new Context();
    const calls: string[] = [];
    const plugin: PluginDef = {
      name: "p1",
      setup(sctx) {
        sctx.effect(() => calls.push("dispose-2"));
        sctx.effect(() => calls.push("dispose-1"));
        sctx.on("ping", () => calls.push("heard"));
      },
    };
    await ctx.mount(plugin);
    ctx.emit("ping");
    expect(calls).toEqual(["heard"]);
    const n = ctx.unmount("p1");
    expect(n).toBe(3); // 2 explicit effects + 1 listener disposer
    // LIFO disposal
    expect(calls).toEqual(["heard", "dispose-1", "dispose-2"]);
    ctx.emit("ping");
    expect(calls).toEqual(["heard", "dispose-1", "dispose-2"]);
    expect(ctx.listenerCount("ping")).toBe(0);
  });

  it("failed setup leaves no residue", async () => {
    const ctx = new Context();
    const bad: PluginDef = {
      name: "bad",
      setup(sctx) {
        sctx.effect(() => {});
        throw new Error("boom");
      },
    };
    await expect(ctx.mount(bad)).rejects.toThrow("boom");
    expect(ctx.effectCount()).toBe(0);
    expect(ctx.mounted.has("bad")).toBe(false);
  });

  it("refuses double mount of the same plugin name", async () => {
    const ctx = new Context();
    const p: PluginDef = { name: "x", setup() {} };
    await ctx.mount(p);
    await expect(ctx.mount(p)).rejects.toThrow(/already mounted/);
  });
});

describe("kernel: events", () => {
  it("emit notifies in registration order", () => {
    const ctx = new Context();
    const seen: string[] = [];
    const a: PluginDef = { name: "a", setup(s) { s.on("e", () => seen.push("a")); } };
    const b: PluginDef = { name: "b", setup(s) { s.on("e", () => seen.push("b")); } };
    return (async () => {
      await ctx.mount(a);
      await ctx.mount(b);
      ctx.emit("e");
      expect(seen).toEqual(["a", "b"]);
    })();
  });

  it("waterfall wraps values; next() delegates, returning short-circuits", async () => {
    const ctx = new Context();
    await ctx.mount({
      name: "annotator",
      setup(s) {
        s.on("req", (v: number, next) => next(v + 1));
      },
    });
    await ctx.mount({
      name: "policy",
      setup(s) {
        s.on("req", (_v: number, _next) => -1); // owns the decision
      },
    });
    await ctx.mount({
      name: "observer",
      setup(s) {
        s.on("req", (v: number, next) => next(v * 100));
      },
    });
    // chain order: annotator(+1) -> policy(-1, SHORT-CIRCUIT) -> observer skipped
    expect(ctx.waterfall<number>("req", 10)).toBe(-1);

    const ctx2 = new Context();
    await ctx2.mount({ name: "plus1", setup(s) { s.on("r", (v: number, n) => n(v + 1)); } });
    await ctx2.mount({ name: "times10", setup(s) { s.on("r", (v: number, n) => n(v * 10)); } });
    expect(ctx2.waterfall<number>("r", 1)).toBe(20);
  });

  it("parallel runs all listeners concurrently", async () => {
    const ctx = new Context();
    let done = "";
    const slow = (ms: number, tag: string): PluginDef => ({
      name: tag,
      setup(s) {
        s.on("go", async () => {
          await new Promise((r) => setTimeout(r, ms));
          done += tag;
        });
      },
    });
    await ctx.mount(slow(30, "slow"));
    await ctx.mount(slow(5, "fast"));
    await ctx.parallel("go");
    expect(done).toBe("fastslow");
  });

  it("serial runs in order and collects results", async () => {
    const ctx = new Context();
    await ctx.mount({ name: "a", setup(s) { s.on("q", (n: number) => `a${n}`); } });
    await ctx.mount({ name: "b", setup(s) { s.on("q", async (n: number) => `b${n}`); } });
    await expect(ctx.serial<string>("q", 7)).resolves.toEqual(["a7", "b7"]);
  });
});

describe("kernel: guards", () => {
  it("root context refuses untagged effect/on", () => {
    const ctx = new Context();
    expect(() => ctx.effect(() => {})).toThrow(/scoped context/);
    expect(() => ctx.on("e", () => {})).toThrow(/scoped context/);
  });

  it("requireService throws MissingServiceError when absent", () => {
    const ctx = new Context();
    expect(() => ctx.requireService("nope")).toThrow(MissingServiceError);
  });
});
