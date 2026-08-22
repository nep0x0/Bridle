/**
 * Live Studio suite — opt-in only:
 *
 *   BRIDLE_LIVE_STUDIO=1 pnpm --filter @bridle/roblox test
 *
 * Requires Roblox Studio open with its MCP server enabled and
 * BRIDLE_STUDIO_MCP (or bridle.config.json) pointing at StudioMCP.
 * Everywhere else the whole suite skips — honestly visible as skipped,
 * never as a fake pass. This is the §8 gate "vs live Studio".
 */
import { describe, expect, it } from "vitest";
import { loadRobloxConfig } from "../src/config.ts";
import { McpStdioTransport } from "../src/mcp-stdio.ts";

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

describe.skipIf(!live || !cfg.studioMcpPath)("LIVE: StudioMCP over stdio", () => {
  it(
    "connects through the late-tools handshake and reads studio state",
    async () => {
      const command = isWindows ? cfg!.studioMcpPath : cfg!.wineCmd || "wine";
      const args = isWindows ? [] : [cfg!.studioMcpPath];
      const env =
        !isWindows && cfg!.winePrefix ? { WINEPREFIX: cfg!.winePrefix } : undefined;
      const t = await McpStdioTransport.connect({
        command,
        args,
        env,
        requestTimeoutMs: 45_000,
        toolsReadyTimeoutMs: 60_000,
        log: (m) => console.log(`[live] ${m}`),
      });
      try {
        expect(t.advertisedTools().length).toBeGreaterThan(0);
        // The proxy registers the running Studio a few seconds after its own
        // start (proven live: first poll empty, next poll lists the place).
        // Retry patiently instead of failing on the first "no instances".
        const deadline = Date.now() + 45_000;
        let state = { ok: false, text: "(not polled)" };
        for (;;) {
          state = await t.getState();
          if (state.ok) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 2500));
          console.log(`[live] waiting for Studio instance … (${state.text.slice(0, 80)})`);
        }
        expect(state.ok).toBe(true);
        expect(state.text).toMatch(/Studio Mode/i);
      } finally {
        t.close();
      }
    },
    120_000,
  );
});
