/**
 * bridle roblox domain — FakeStudio: an in-memory, deterministic Studio
 * implementing the StudioTransport contract. CI runs against this; live
 * Studio (McpStdioTransport) is opt-in and must behave identically.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  StudioResult,
  StudioTreeEntry,
  StudioScript,
  StudioTransport,
} from "./transport.ts";

export class FakeStudioTransport implements StudioTransport {
  readonly kind = "fake" as const;
  #tree = new Map<string, StudioTreeEntry>();
  #scripts = new Map<string, StudioScript>();
  #console: string[] = [];
  #playing = false;

  constructor(seed?: {
    tree?: StudioTreeEntry[];
    scripts?: StudioScript[];
    consoleLines?: string[];
  }) {
    for (const e of seed?.tree ?? []) this.#tree.set(e.fullPath, e);
    for (const s of seed?.scripts ?? []) this.#scripts.set(s.path, s);
    this.#console = [...(seed?.consoleLines ?? [])];
    // root always exists
    if (!this.#tree.has("Workspace")) {
      this.#tree.set("Workspace", {
        fullPath: "Workspace",
        name: "Workspace",
        className: "Workspace",
        parentName: "Game",
      });
    }
  }

  // ── reads ────────────────────────────────────────────────────────────

  async getState(): Promise<StudioResult> {
    return {
      ok: true,
      text: `Current Studio Mode: ${this.#playing ? "Play" : "Edit"}`,
    };
  }

  async getConsole(maxLines = 40): Promise<StudioResult> {
    const lines = this.#console.slice(-maxLines);
    return { ok: true, text: lines.join("\n") || "(console empty)" };
  }

  async searchGameTree(path: string, maxDepth: number): Promise<StudioTreeEntry[]> {
    const out: StudioTreeEntry[] = [];
    const prefix = path === "" ? "" : `${path}.`;
    for (const entry of this.#tree.values()) {
      if (!entry.fullPath.startsWith(prefix)) continue;
      if (entry.fullPath === path) continue;
      const depthDiff =
        entry.fullPath.split(".").length - path.split(".").length;
      if (depthDiff > maxDepth) continue;
      out.push(entry);
    }
    return out.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  }

  async inspectInstance(path: string): Promise<StudioResult> {
    const e = this.#tree.get(path);
    if (!e) return { ok: false, text: `instance not found: ${path}` };
    return {
      ok: true,
      text: `${e.fullPath} (${e.className}) parent=${e.parentName ?? "-"}`,
    };
  }

  async readScript(path: string): Promise<StudioScript | null> {
    return this.#scripts.get(path) ?? null;
  }

  async listStudios(): Promise<Array<{ id?: string; name?: string }>> {
    // Deterministic single instance — the seeded place's name.
    return [{ id: "fake-studio", name: "FakePlace (seeded)" }];
  }

  async listScripts(): Promise<StudioScript[]> {
    return [...this.#scripts.values()];
  }

  async grepScripts(pattern: string): Promise<
    Array<{ path: string; line: number; text: string }>
  > {
    const re = new RegExp(pattern, "i");
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const s of this.#scripts.values()) {
      s.source.split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push({ path: s.path, line: i + 1, text: line.trim() });
      });
    }
    return hits;
  }

  async screenCapture(): Promise<StudioResult> {
    return { ok: true, text: "[images: 1] (fake screenshot)" };
  }

  // ── writes / execution ───────────────────────────────────────────────

  async multiEdit(
    edits: Array<{ path: string; source: string }>,
  ): Promise<StudioResult> {
    for (const edit of edits) {
      const existing = this.#scripts.get(edit.path);
      this.#scripts.set(edit.path, {
        path: edit.path,
        className: existing?.className ?? "Script",
        source: edit.source,
      });
      // ensure the tree knows the script container
      if (!this.#tree.has(edit.path)) {
        this.#tree.set(edit.path, {
          fullPath: edit.path,
          name: edit.path.split(".").at(-1)!,
          className: existing?.className ?? "Script",
          parentName: edit.path.split(".").slice(0, -1).join(".") || "Game",
        });
      }
    }
    return { ok: true, text: `applied ${edits.length} edit(s)` };
  }

  async executeLuau(code: string): Promise<StudioResult> {
    this.#console.push(`[exec] ${(code.split("\n")[0] ?? "").slice(0, 60)}`);
    // Deterministic behaviour for verify kinds: code that prints the pass
    // marker "produces" it; anything else yields a neutral echo.
    if (code.includes("BRIDLE_TEST_PASS")) {
      return { ok: true, text: "BRIDLE_TEST_PASS" };
    }
    return { ok: true, text: "(fake luau executed)" };
  }

  async startStopPlay(start: boolean): Promise<StudioResult> {
    this.#playing = start;
    if (start) this.#console.push("[play] DataModel Client Loading");
    else this.#console.push("[play] stopped");
    return { ok: true, text: start ? "play started" : "play stopped" };
  }

  // ── test helpers ─────────────────────────────────────────────────────

  addConsole(line: string): void {
    this.#console.push(line);
  }
  isPlaying(): boolean {
    return this.#playing;
  }
}
