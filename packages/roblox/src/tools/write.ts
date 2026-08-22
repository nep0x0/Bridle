/**
 * bridle roblox domain — WRITE/EXECUTE tools (R1).
 *
 * Structural enforcement, not prompt advice:
 *   - destructive Luau patterns are REFUSED tool-side unless explicitly
 *     allowed per call (the old "NEVER DELETE BROADLY" prompt rule, made
 *     structural);
 *   - play-mode tools refuse honestly when the place is not playing
 *     (environment fact, checked against the transport).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ToolDef } from "@bridle/tools";
import type { StudioTransport } from "../transport.ts";

const DESTRUCTIVE_RE =
  /:\s*(Destroy|ClearAllChildren|Remove)\s*\(/i;

export function writeTools(t: StudioTransport): Array<ToolDef> {
  return [
    {
      name: "roblox.multi_edit",
      description:
        "Write full script sources (path -> source map). Creates or replaces scripts.",
      params: { edits: "[{path, source}]" },
      permission: "write",
      execute: async (a: {
        edits: Array<{ path: string; source: string }>;
      }) => {
        if (!Array.isArray(a.edits) || a.edits.length === 0) {
          return { ok: false, text: "multi_edit needs non-empty 'edits'" };
        }
        return t.multiEdit(a.edits);
      },
    },
    {
      name: "roblox.execute_luau",
      description:
        "Run Luau in the open place. Destructive calls (:Destroy/:ClearAllChildren/:Remove) are refused unless allow_destructive=true.",
      params: { code: "string", allow_destructive: "boolean?" },
      permission: "execute",
      execute: async (a: { code: string; allow_destructive?: boolean }) => {
        const code = String(a.code ?? "");
        if (!code.trim()) return { ok: false, text: "execute_luau needs 'code'" };
        if (DESTRUCTIVE_RE.test(code) && a.allow_destructive !== true) {
          return {
            ok: false,
            text:
              "Permission denied: destructive Luau detected (:Destroy/:ClearAllChildren/:Remove). " +
              "Re-run with allow_destructive=true ONLY if the user explicitly approved broad deletion.",
          };
        }
        return t.executeLuau(code);
      },
    },
    {
      name: "roblox.start_stop_play",
      description: "Enter or leave Play mode (playtest).",
      params: { start: "boolean" },
      permission: "write",
      execute: async (a: { start: boolean }) => {
        if (typeof a.start !== "boolean") {
          return { ok: false, text: "start_stop_play needs boolean 'start'" };
        }
        return t.startStopPlay(a.start);
      },
    },
    {
      name: "roblox.playtest_console",
      description:
        "Read console output while playing (refuses outside Play mode — environment fact, not trust).",
      params: { max_lines: "number?" },
      permission: "read",
      execute: async (a: { max_lines?: number }) => {
        const state = await t.getState();
        if (!/Play/i.test(state.text)) {
          return {
            ok: false,
            text: "place is not in Play mode — call roblox.start_stop_play first",
          };
        }
        return t.getConsole(a.max_lines);
      },
    },
  ];
}
