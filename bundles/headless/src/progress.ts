/**
 * bridle headless — live turn progress plugin (TUI-first, plugin-first).
 *
 * Subscribes to the kernel's session/appended event and prints compact
 * lines so a long reasoning turn never feels like a dead terminal:
 *   · step 1
 *   → tool roblox.execute_luau
 *   ✓ result ok
 *   ■ turn end (2 steps)
 *
 * Unmount = silent again. Owner-tagged like every registration.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginContext, PluginDef } from "@bridle/kernel";
import type { SessionEvent } from "@bridle/session";

export interface ProgressOptions {
  /** Sink for progress lines (defaults to console.log). */
  log?: (line: string) => void;
}

/** Pure formatter — unit-testable without any harness. */
export function formatProgress(e: SessionEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "step/start":
      return `· step ${String(p.step)}`;
    case "tool/call":
      return `→ tool ${String(p.name)}`;
    case "tool/result": {
      const ok = Boolean(p.ok);
      return ok
        ? "✓ result ok"
        : `✗ result error: ${String(p.text ?? "").slice(0, 80)}`;
    }
    case "turn/end":
      return `■ turn end (${String(p.steps)} steps)`;
    default:
      return null; // not every durable event is worth a line
  }
}

export function turnProgressPlugin(
  opts: ProgressOptions = {},
): PluginDef {
  return {
    name: "turn-progress",
    requires: ["sessions"],
    setup(ctx) {
      return progressSetup(ctx as PluginContext, opts);
    },
  };
}

async function progressSetup(ctx: PluginContext, opts: ProgressOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const sessions = (await ctx.service("sessions")) as import("@bridle/session").SessionLog;

  let cursor = 0;

  // The session plugin emits only {id,type}; pull full events from the log.
  const onAppended = (): void => {
    for (const e of sessions.all()) {
      if (e.id <= cursor) continue;
      cursor = e.id;
      const line = formatProgress(e);
      if (line) log(line);
    }
  };
  ctx.on(
    "session/appended",
    onAppended as unknown as (...args: never[]) => unknown,
  );
}
