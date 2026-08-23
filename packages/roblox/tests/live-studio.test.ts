/**
 * Live Studio suite — opt-in only:
 *
 *   BRIDLE_LIVE_STUDIO=1 pnpm --filter @bridle/roblox test
 *
 * Requires Roblox Studio open with its MCP server enabled and
 * BRIDLE_STUDIO_MCP (or bridle.config.json) pointing at StudioMCP.
 * Everywhere else the whole suite skips — honestly visible as skipped,
 * never as a fake pass. This is the §8 gate "vs live Studio" plus the §7
 * structural-destructive-gate check against a real place.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRobloxConfig } from "../src/config.ts";
import { McpStdioTransport } from "../src/mcp-stdio.ts";
import { writeTools } from "../src/tools/write.ts";
import type { StudioTransport } from "../src/transport.ts";

const live = process.env.BRIDLE_LIVE_STUDIO === "1";
const cfg = live
  ? loadRobloxConfig((m) => console.log(`[live] ${m}`))
  : loadRobloxConfig(() => {}, {}); // resolve quietly for the skip note

if (live && !cfg.studioMcpPath) {
  console.warn(
    "[live] BRIDLE_LIVE_STUDIO=1 but no StudioMCP path resolved — suite will skip. " +
      "Set BRIDLE_STUDIO_MCP or bridle.config.json {roblox:{studioMcpPath}}.",
  );
}

const isWindows = process.platform === "win32";

async function connectLive(): Promise<StudioTransport> {
  const command = isWindows ? cfg!.studioMcpPath : cfg!.wineCmd || "wine";
  const args = isWindows ? [] : [cfg!.studioMcpPath];
  const env =
    !isWindows && cfg!.winePrefix ? { WINEPREFIX: cfg!.winePrefix } : undefined;
  return McpStdioTransport.connect({
    command,
    args,
    env,
    requestTimeoutMs: 45_000,
    toolsReadyTimeoutMs: 60_000,
    log: (m) => console.log(`[live] ${m}`),
  });
}

/** Wait until a Studio instance registers with the proxy (seconds-scale,
 *  proven live) — otherwise the first real call fails with "No Roblox
 *  Studio instances are connected". */
async function waitForInstance(t: StudioTransport): Promise<void> {
  const deadline = Date.now() + 45_000;
  let state = { ok: false, text: "(not polled)" };
  for (;;) {
    state = await t.getState();
    if (state.ok) return;
    if (Date.now() > deadline) break;
    console.log(`[live] waiting for Studio instance … (${state.text.slice(0, 80)})`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`no Studio instance attached: ${state.text.slice(0, 120)}`);
}

describe.skipIf(!live || !cfg.studioMcpPath)("LIVE: StudioMCP over stdio", () => {
  let t: StudioTransport;

  // ONE connection shared by all tests — every extra proxy spawn races the
  // instance-registration window and produces phantom failures.
  beforeAll(async () => {
    t = await connectLive();
    await waitForInstance(t);
    console.log("[live] studio state:", (await t.getState()).text.slice(0, 100));
  }, 120_000);

  afterAll(() => {
    try {
      t?.close();
    } catch { /* already gone */ }
  });

  it(
    "advertises tools and reads live state",
    async () => {
      expect(t.advertisedTools().length).toBeGreaterThan(0);
      const state = await t.getState();
      expect(state.ok).toBe(true);
      expect(state.text).toMatch(/Studio Mode/i);
    },
    60_000,
  );

  it(
    "destructive Luau is refused tool-side unless explicitly allowed (§7)",
    async () => {
      const exec = writeTools(t).find((x) => x.name === "roblox.execute_luau")!;

      // 1) refusal WITHOUT touching the transport
      const refused = await exec.execute({
        code: 'game:GetService("Workspace"):ClearAllChildren()',
        allow_destructive: false,
      });
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/destructive Luau detected/i);

      // 2) explicit allowance reaches the real place
      const allowed = await exec.execute({
        code: 'print("bridle-live-allow-ok")',
        allow_destructive: false,
      });
      expect(allowed.ok).toBe(true);
    },
    60_000,
  );

  it(
    "end-to-end proof: creates AND verifies a real Part in the open place",
    async () => {
      const exec = writeTools(t).find((x) => x.name === "roblox.execute_luau")!;
      const create = await exec.execute({
        code: [
          'local p = Instance.new("Part")',
          'p.Name = "BridleYellow"',
          'p.BrickColor = BrickColor.new("Bright yellow")',
          'p.Position = Vector3.new(0, 10, 0)',
          'p.Anchored = true',
          'p.Parent = workspace',
          'return "CREATED"',
        ].join("\n"),
      });
      expect(create.ok).toBe(true);

      const verify = await exec.execute({
        code: [
          'local p = workspace:FindFirstChild("BridleYellow")',
          'if p == nil then return "MISSING" end',
          'return "FOUND " .. p.Name .. " color=" .. p.BrickColor.Name',
        ].join("\n"),
      });
      expect(verify.ok).toBe(true);
      expect(verify.text).toMatch(/FOUND BridleYellow/i);
    },
    60_000,
  );
});
