/**
 * M4 gate: the permission-class gate as an ordinary pre-execute listener.
 *
 * Secure defaults are the point: writes and executes are REFUSED unless a
 * policy explicitly allows (or approves) them — enforcement over hope.
 */
import { describe, expect, it } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin, type SessionLog } from "@bridle/session";
import { toolsPlugin, type ToolDef, type ToolsService } from "@bridle/tools";
import {
  listApprover,
  securityPlugin,
  type SecurityOptions,
} from "../src/index.ts";

async function makeHarness(opts: SecurityOptions, tools: ToolDef[]) {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: (s) => sessionPlugin(s) });
  await ctx.mount({ name: "tools", setup: (s) => toolsPlugin(s) });
  await ctx.mount(securityPlugin(opts));
  const svc = ctx.requireService<ToolsService>("tools");
  for (const t of tools) svc.register(t);
  return {
    ctx,
    tools: svc,
    log: ctx.requireService<SessionLog>("sessions"),
  };
}

const reader: ToolDef = {
  name: "read_thing",
  description: "observes",
  permission: "read",
  execute: () => ({ ok: true, text: "peeked" }),
};
const writer: ToolDef = {
  name: "write_thing",
  description: "mutates",
  permission: "write",
  execute: () => ({ ok: true, text: "wrote" }),
};

describe("security gate", () => {
  it("allows declared read calls under secure defaults", async () => {
    const h = await makeHarness({}, [reader]);
    const out = await h.tools.execute("read_thing", {});
    expect(out).toEqual({ ok: true, text: "peeked" });
  });

  it("denies writes by default WITHOUT executing and without post-audit", async () => {
    let ran = false;
    const h = await makeHarness({}, [
      { ...writer, execute: () => ((ran = true), { ok: true, text: "wrote" }) },
    ]);
    const out = await h.tools.execute("write_thing", {});
    expect(ran).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Permission denied:/);
    const types = h.log.all().map((e) => e.type);
    expect(types).toContain("audit/gate");
    expect(types).not.toContain("audit/result"); // nothing executed ⇒ no result audit
  });

  it("treats undeclared tools as the cautious default class (execute)", async () => {
    let ran = false;
    const h = await makeHarness({}, [
      { name: "mystery", description: "", execute: () => ((ran = true), { ok: true, text: "" }) },
    ]);
    const out = await h.tools.execute("mystery", {});
    expect(ran).toBe(false);
    expect(out.text).toMatch(/classified execute/);
  });

  it("rules take precedence over declarations", async () => {
    let ran = false;
    const h = await makeHarness(
      { rules: [{ match: "math*", cls: "write" }], modes: { write: "allow" } },
      [
        {
          name: "math.eval",
          description: "",
          permission: "execute",
          execute: () => ((ran = true), { ok: true, text: "108" }),
        },
      ],
    );
    const out = await h.tools.execute("math.eval", { expr: "12*9" });
    expect(ran).toBe(true);
    expect(out.text).toBe("108");
  });

  it("ask mode consults the sync approver — both verdicts audited", async () => {
    let verdict = true;
    const asked: string[] = [];
    const h = await makeHarness(
      { modes: { write: "ask" }, approver: (req) => (asked.push(req.name), verdict) },
      [writer],
    );

    const yes = await h.tools.execute("write_thing", {});
    expect(yes.ok).toBe(true);
    verdict = false;
    const no = await h.tools.execute("write_thing", {});
    expect(no.ok).toBe(false);
    expect(no.text).toMatch(/was not approved/);
    expect(asked).toEqual(["write_thing", "write_thing"]);

    const gates = h.log.all().filter((e) => e.type === "audit/gate");
    expect(gates.map((e) => (e.payload as { allowed: boolean }).allowed)).toEqual([true, false]);
  });

  it("ask mode with NO approver refuses honestly", async () => {
    const h = await makeHarness({ modes: { write: "ask" } }, [writer]);
    const out = await h.tools.execute("write_thing", {});
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/no approver is installed/);
  });

  it("successful executions land in the result audit", async () => {
    const h = await makeHarness({}, [reader]);
    await h.tools.execute("read_thing", {});
    const results = h.log.all().filter((e) => e.type === "audit/result");
    expect(results.length).toBe(1);
    const p = results[0]!.payload as { tool: string; ok: boolean; elapsedMs: number };
    expect(p.tool).toBe("read_thing");
    expect(p.ok).toBe(true);
    expect(typeof p.elapsedMs).toBe("number");
  });

  it("listApprover allows exactly the listed names", () => {
    const a = listApprover(["math.eval"]);
    expect(a({ name: "math.eval", args: {} }, "execute")).toBe(true);
    expect(a({ name: "rm_rf", args: {} }, "execute")).toBe(false);
  });
});
