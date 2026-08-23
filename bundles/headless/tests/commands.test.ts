/**
 * TUI-first, plugin-first: the slash-command surface is a real service
 * (commandPlugin) — so it gets real unit tests, not bin-script folklore.
 */
import { describe, expect, it } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin, type SessionLog } from "@bridle/session";
import { toolsPlugin, type ToolDef, type ToolsService } from "@bridle/tools";
import { commandPlugin, type CommandIO, type CommandsApi } from "../src/commands.ts";

async function makeHarness() {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: (s) => sessionPlugin(s) });
  await ctx.mount({ name: "tools", setup: (s) => toolsPlugin(s) });
  await ctx.mount(commandPlugin());
  const tools = ctx.requireService<ToolsService>("tools");
  const reader: ToolDef = {
    name: "echo",
    description: "Echo the given text back.",
    permission: "read",
    execute: () => ({ ok: true, text: "hi" }),
  };
  tools.register(reader);
  const commands = ctx.requireService<CommandsApi>("commands");
  const log = ctx.requireService<SessionLog>("sessions");
  return { ctx, tools, commands, log };
}

/** Capture io.log output of one dispatch. */
async function capture(cmds: CommandsApi, line: string): Promise<string[]> {
  const out: string[] = [];
  const io: CommandIO = { log: (...p: unknown[]) => out.push(p.join(" ")) };
  const known = await cmds.dispatch(line, io);
  out.push(`__known:${known}`);
  return out;
}

describe("command registry plugin", () => {
  it("registers builtins and lists them via /help", async () => {
    const h = await makeHarness();
    const out = await capture(h.commands, "/help");
    expect(out.some((l) => l.startsWith("/help"))).toBe(true);
    expect(out.some((l) => l.startsWith("/tools"))).toBe(true);
    expect(out.at(-1)).toBe("__known:true");
  });

  it("/tools prints permission classes from the tools service", async () => {
    const h = await makeHarness();
    const out = await capture(h.commands, "/tools");
    expect(out.some((l) => l.includes("echo") && l.includes("[read]"))).toBe(true);
  });

  it("/log N prints at most N durable events", async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i++) h.log.append("user/message", { text: `m${i}` });
    const out = await capture(h.commands, "/log 2");
    const lines = out.filter((l) => !l.startsWith("__known"));
    expect(lines.length).toBe(2);
    expect(out.at(-1)).toBe("__known:true");
  });

  it("unknown command returns false and names the available set", async () => {
    const h = await makeHarness();
    const out = await capture(h.commands, "/nope");
    expect(out.at(-1)).toBe("__known:false");
    expect(out.some((l) => l.includes("unknown command") && l.includes("/help"))).toBe(true);
  });

  it("non-slash lines are not commands", async () => {
    const h = await makeHarness();
    expect(await h.commands.dispatch("hello world", { log: () => {} })).toBe(false);
  });
});
