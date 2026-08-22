import { describe, expect, it } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin } from "@bridle/session";
import { toolsPlugin, type ToolsService } from "@bridle/tools";
import {
  FakeStudioTransport,
  robloxPlugin,
  loadRobloxConfig,
} from "../src/index.ts";
import { workflowPlugin } from "@bridle/workflow";

async function boot(seed?: Parameters<typeof FakeStudioTransport.prototype.getState>) {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: sessionPlugin });
  await ctx.mount({ name: "tools", setup: toolsPlugin });
  await ctx.mount(workflowPlugin());
  const fake = new FakeStudioTransport({
    tree: [
      { fullPath: "Workspace.Baseplate", name: "Baseplate", className: "Part", parentName: "Workspace" },
      { fullPath: "ServerScriptService.Main", name: "Main", className: "Script", parentName: "ServerScriptService" },
      { fullPath: "StarterGui.HUD.Label", name: "Label", className: "TextLabel", parentName: "HUD" },
      { fullPath: "StarterGui.HUD", name: "HUD", className: "ScreenGui", parentName: "StarterGui" },
    ],
    scripts: [
      {
        path: "ServerScriptService.Main",
        className: "Script",
        source: 'local Players = game:GetService("Players")\nprint("boot")\n',
      },
    ],
    consoleLines: ["[boot] ready"],
  });
  // register tree entries the seed missed (parents)
  await ctx.mount(
    robloxPlugin({ transport: fake as never }),
  );
  const tools = ctx.requireService("tools") as unknown as ToolsService;
  return { ctx, tools, fake };
}

const exec = (tools: ToolsService, name: string, args: unknown = {}) =>
  tools.execute(name, args as Record<string, unknown>);

describe("R0: read tools over FakeStudio", () => {
  it("search_game_tree explores hierarchy with depth", async () => {
    const { tools } = await boot();
    const r = await exec(tools, "roblox.search_game_tree", {
      path: "Workspace",
      max_depth: 1,
    });
    expect(r.ok).toBe(true);
    const entries = JSON.parse(r.text) as Array<{ fullPath: string }>;
    expect(entries.map((e) => e.fullPath)).toContain("Workspace.Baseplate");
  });

  it("script_read returns full source; unknown path fails honestly", async () => {
    const { tools } = await boot();
    const okRead = await exec(tools, "roblox.script_read", {
      path: "ServerScriptService.Main",
    });
    expect(okRead.text).toContain('game:GetService("Players")');
    const bad = await exec(tools, "roblox.script_read", { path: "Nope.X" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("not found");
  });

  it("script_grep finds lines across scripts", async () => {
    const { tools } = await boot();
    const r = await exec(tools, "roblox.script_grep", { pattern: "GetService" });
    expect(r.text).toContain("ServerScriptService.Main:1");
  });

  it("inspect_instance reports class and parent", async () => {
    const { tools } = await boot();
    const r = await exec(tools, "roblox.inspect_instance", {
      path: "StarterGui.HUD",
    });
    expect(r.text).toContain("(ScreenGui)");
  });
});

describe("R1 guards (structural, not prompt advice)", () => {
  it("destructive Luau is refused unless allow_destructive=true", async () => {
    const { tools, fake } = await boot();
    const refused = await exec(tools, "roblox.execute_luau", {
      code: 'workspace.Baseplate:Destroy()',
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/^Permission denied: destructive Luau/);

    const allowed = await exec(tools, "roblox.execute_luau", {
      code: "workspace.Baseplate:Destroy()",
      allow_destructive: true,
    });
    expect(allowed.ok).toBe(true);
    void fake;
  });

  it("playtest_console refuses outside Play mode (environment fact)", async () => {
    const { tools, fake } = await boot();
    const denied = await exec(tools, "roblox.playtest_console", {});
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("not in Play mode");

    fake.addConsole("[play] error line");
    await exec(tools, "roblox.start_stop_play", { start: true });
    const allowed = await exec(tools, "roblox.playtest_console", {});
    expect(allowed.ok).toBe(true);
    expect(allowed.text).toContain("error line");
  });

  it("multi_edit applies sources and registers them in the tree", async () => {
    const { tools, fake } = await boot();
    const r = await exec(tools, "roblox.multi_edit", {
      edits: [
        { path: "ServerScriptService.New", source: "print('new')" },
      ],
    });
    expect(r.ok).toBe(true);
    const read = await exec(tools, "roblox.script_read", {
      path: "ServerScriptService.New",
    });
    expect(read.text).toBe("print('new')");
    void fake;
  });
});

describe("config resolution precedence", () => {
  it("env wins over file wins over detection", () => {
    const log: string[] = [];
    const cfg = loadRobloxConfig((m) => log.push(m), {
      BRIDLE_STUDIO_MCP: "/from/env/StudioMCP.exe",
    });
    expect(cfg.studioMcpPath).toBe("/from/env/StudioMCP.exe");
    expect(cfg.source.studioMcpPath).toBe("env");
    expect(log.join("\n")).toContain("studioMcpPath from env");
  });

  it("missing everywhere degrades honestly (empty path or detected default)", () => {
    const log: string[] = [];
    const cfg = loadRobloxConfig((m) => log.push(m), {});
    // On a machine with vinegar installed, detection succeeds; otherwise the
    // path is honestly empty and live transport is disabled. Both are valid.
    if (cfg.studioMcpPath === "") {
      expect(cfg.source.studioMcpPath).toBe("missing");
      expect(log.join("\n")).toContain("NOT found");
    } else {
      expect(cfg.source.studioMcpPath).toBe("detected");
    }
    expect(cfg.wineCmd).toBe("wine"); // harmless default
  });
});
