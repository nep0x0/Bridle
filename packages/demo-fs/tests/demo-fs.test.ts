/**
 * The reference domain plugin, tested the way third parties should test
 * theirs: fixture harness + public tool surface + reversibility check.
 */
import { describe, expect, it } from "vitest";
import { Context } from "@bridle/kernel";
import { toolsPlugin, type ToolsService } from "@bridle/tools";
import { demoFsPlugin, VirtualFS } from "../src/index.ts";

async function makeHarness(seed?: VirtualFS) {
  const ctx = new Context();
  await ctx.mount({ name: "tools", setup: (s) => toolsPlugin(s) });
  const before = new Set(ctx.requireService<ToolsService>("tools").list().map((t) => t.name));
  await ctx.mount(demoFsPlugin(seed ? { fs: seed } : {}));
  const tools = ctx.requireService<ToolsService>("tools");
  return { ctx, tools, before };
}

describe("demo-fs (reference domain plugin)", () => {
  it("write → read → ls roundtrip", async () => {
    const h = await makeHarness();
    const w = await h.tools.execute("demo-fs.write", {
      path: "/docs/guide.md",
      content: "# hello",
    });
    expect(w.ok).toBe(true);
    expect((await h.tools.execute("demo-fs.read", { path: "/docs/guide.md" })).text).toBe("# hello");
    const ls = await h.tools.execute("demo-fs.ls", { dir: "/" });
    expect(ls.text).toContain("d docs"); // implied directory surfaces in ls
  });

  it("normalisation refuses traversal and relative paths structurally", async () => {
    const h = await makeHarness();
    for (const bad of ["../escape", "relative/path", "/", "."]) {
      const out = await h.tools.execute("demo-fs.write", { path: bad, content: "x" });
      expect(out.ok, `expected refusal for ${bad}`).toBe(false);
      expect(out.text).toMatch(/invalid path/);
    }
  });

  it("remove deletes; reads afterwards fail honestly", async () => {
    const h = await makeHarness();
    await h.tools.execute("demo-fs.write", { path: "/tmp/a.txt", content: "x" });
    expect((await h.tools.execute("demo-fs.remove", { path: "/tmp/a.txt" })).ok).toBe(true);
    const gone = await h.tools.execute("demo-fs.read", { path: "/tmp/a.txt" });
    expect(gone.ok).toBe(false);
    expect(gone.text).toMatch(/not found/);
  });

  it("declares permission classes the gate can read", async () => {
    const h = await makeHarness();
    expect(h.tools.describe("demo-fs.write")?.permission).toBe("write");
    expect(h.tools.describe("demo-fs.read")?.permission).toBe("read");
    expect(h.tools.describe("demo-fs.remove")?.permission).toBe("write");
  });

  it("unmount unwinds EVERY registration — reversible effects kept honest", async () => {
    const h = await makeHarness();
    const names = h.tools.list().map((t) => t.name).filter((n) => n.startsWith("demo-fs."));
    expect(names.length).toBe(4);
    h.ctx.unmount("demo-fs");
    const after = h.tools.list().map((t) => t.name).filter((n) => n.startsWith("demo-fs."));
    expect(after).toEqual([]); // the host never notices we existed
  });

  it("accepts an injected VirtualFS so tests can pre-seed state", async () => {
    const seed = new VirtualFS();
    seed.write("/seeded.txt", "from seed");
    const h = await makeHarness(seed);
    expect((await h.tools.execute("demo-fs.read", { path: "/seeded.txt" })).text).toBe("from seed");
  });
});
