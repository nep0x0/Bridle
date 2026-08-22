/**
 * bridle roblox domain — READ tools (R0).
 * Every tool is an ordinary ToolDef with a permission class; the security
 * gate (@bridle/security) enforces, we only declare.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ToolDef } from "@bridle/tools";
import type { StudioTransport } from "../transport.ts";

export function readTools(t: StudioTransport): Array<ToolDef> {
  return [
    {
      name: "roblox.get_studio_state",
      description: "Current Studio mode (Edit/Play) and available datamodels.",
      permission: "read",
      execute: () => t.getState(),
    },
    {
      name: "roblox.get_console_output",
      description: "Read recent console output (errors surface here).",
      params: { max_lines: "number?" },
      permission: "read",
      execute: (a: { max_lines?: number }) => t.getConsole(a.max_lines),
    },
    {
      name: "roblox.search_game_tree",
      description:
        "Explore the place hierarchy under a path (path='' = roots). Returns fullPath/name/className entries.",
      params: { path: "string", max_depth: "number?" },
      permission: "read",
      execute: async (a: { path?: string; max_depth?: number }) => {
        const entries = await t.searchGameTree(a.path ?? "", a.max_depth ?? 3);
        return { ok: true, text: JSON.stringify(entries) };
      },
    },
    {
      name: "roblox.inspect_instance",
      description: "Inspect one instance by full path.",
      params: { path: "string" },
      permission: "read",
      execute: (a: { path: string }) => t.inspectInstance(String(a.path)),
    },
    {
      name: "roblox.script_read",
      description: "Read a script's full source by path.",
      params: { path: "string" },
      permission: "read",
      execute: async (a: { path: string }) => {
        const s = await t.readScript(String(a.path));
        if (!s) return { ok: false, text: `script not found: ${a.path}` };
        return { ok: true, text: s.source };
      },
    },
    {
      name: "roblox.script_grep",
      description: "Regex search across all cached script sources.",
      params: { pattern: "string" },
      permission: "read",
      execute: async (a: { pattern: string }) => {
        const hits = await t.grepScripts(String(a.pattern));
        if (hits.length === 0) return { ok: true, text: "(no matches)" };
        return {
          ok: true,
          text: hits
            .slice(0, 40)
            .map((h) => `${h.path}:${h.line}: ${h.text}`)
            .join("\n"),
        };
      },
    },
    {
      name: "roblox.screen_capture",
      description: "Capture the current viewport (returns image reference).",
      permission: "read",
      execute: () => t.screenCapture(),
    },
    {
      name: "roblox.list_scripts",
      description: "List all scripts in the place (path + class).",
      permission: "read",
      execute: async () => {
        const all = await t.listScripts();
        return {
          ok: true,
          text:
            all.map((s) => `${s.path} (${s.className})`).join("\n") ||
            "(no scripts)",
        };
      },
    },
  ];
}
