/**
 * bridle roblox domain — configuration resolution.
 *
 * Precedence (highest wins):
 *   1. explicit opts / environment (BRIDLE_STUDIO_MCP, BRIDLE_WINE)
 *   2. config file (./bridle.config.json, then ~/.config/bridle/config.json)
 *   3. auto-detection (known vinegar path) with honest fallbacks
 *
 * Every resolution decision is logged so debugging is never guesswork.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RobloxConfig {
  /** Absolute path to StudioMCP.exe. */
  studioMcpPath: string;
  /** Command used to run the exe (wine on Linux/macOS; undefined = run directly). */
  wineCmd?: string;
  /** Transport type. M5: "stdio" only. */
  transport: "stdio";
  /** Where each value came from — for honest logging. */
  source: { studioMcpPath: string; wineCmd: string };
}

const KNOWN_VINEGAR_PATHS = [
  `${homedir()}/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/latest-version/StudioMCP.exe`,
  `${homedir()}/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/StudioMCP.exe`,
];

export interface ConfigSourceInfo {
  env?: string;
  file?: string;
  detected?: string;
}

function readConfigFile(path: string): {
  studioMcpPath?: string;
  wineCmd?: string;
} {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      roblox?: { studioMcpPath?: string; wineCmd?: string };
    };
    return raw.roblox ?? {};
  } catch {
    return {}; // unreadable config is skipped honestly, never fatal
  }
}

/** Resolve the roblox domain configuration. */
export function loadRobloxConfig(
  log: (m: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): RobloxConfig {
  const source: RobloxConfig["source"] = {
    studioMcpPath: "none",
    wineCmd: "none",
  };

  // 1) environment
  let studioMcpPath = env.BRIDLE_STUDIO_MCP || undefined;
  let wineCmd = env.BRIDLE_WINE || undefined;
  if (studioMcpPath) source.studioMcpPath = "env";
  if (wineCmd) source.wineCmd = "env";

  // 2) config files
  if (!studioMcpPath || !wineCmd) {
    const candidates = [
      join(process.cwd(), "bridle.config.json"),
      join(homedir(), ".config", "bridle", "config.json"),
    ];
    for (const file of candidates) {
      const cfg = readConfigFile(file);
      if (!studioMcpPath && cfg.studioMcpPath) {
        studioMcpPath = cfg.studioMcpPath;
        source.studioMcpPath = `file:${file}`;
      }
      if (!wineCmd && cfg.wineCmd) {
        wineCmd = cfg.wineCmd;
        source.wineCmd = `file:${file}`;
      }
      if (studioMcpPath && wineCmd) break;
    }
  }

  // 3) auto-detection
  if (!studioMcpPath) {
    const hit = KNOWN_VINEGAR_PATHS.find((p) => existsSync(p));
    if (hit) {
      studioMcpPath = hit;
      source.studioMcpPath = "detected";
    }
  }
  if (!wineCmd) {
    wineCmd = "wine"; // harmless even when running the exe directly later
    source.wineCmd = "default";
  }

  if (!studioMcpPath) {
    log(
      "roblox config: StudioMCP.exe NOT found — set BRIDLE_STUDIO_MCP or " +
        "bridle.config.json {roblox:{studioMcpPath}}; live transport disabled",
    );
    source.studioMcpPath = "missing";
  } else {
    log(`roblox config: studioMcpPath from ${source.studioMcpPath}`);
  }
  log(`roblox config: wineCmd from ${source.wineCmd}`);

  return {
    studioMcpPath: studioMcpPath ?? "",
    wineCmd,
    transport: "stdio",
    source,
  };
}
