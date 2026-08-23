/**
 * bridle demo-fs — a tiny in-memory filesystem domain.
 *
 * This package exists to be READ: it is the reference implementation for
 * writing a bridle domain plugin. Study it alongside docs/plugin-cookbook.md
 * — every pattern the cookbook teaches appears here in ~120 lines:
 *
 *   1. tools with permission classes (read/write)
 *   2. a domain service provided under its own key
 *   3. REVERSIBLE registration: every tool's disposer is collected and
 *      unwound via ctx.effect, so unmount("demo-fs") leaves the shared
 *      registry exactly as it found it
 *   4. structural safety (path normalisation) instead of prompt advice
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginContext, PluginDef } from "@bridle/kernel";


// ── virtual filesystem ──────────────────────────────────────────────────

export class VirtualFS {
  /** path (normalised, absolute) -> file content. Directories are implied
   *  by path prefixes; there are no directory nodes to get out of sync. */
  #files = new Map<string, string>();

  /** Normalise to "/a/b/c"; refuse traversal and relative nonsense. */
  static normalize(raw: string): string | null {
    if (typeof raw !== "string") return null;
    let p = raw.trim();
    if (!p.startsWith("/")) return null; // absolute paths only
    const parts: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") return null; // no escaping the root
      if (/[\0]/.test(seg)) return null;
      parts.push(seg);
    }
    if (parts.length === 0) return null; // the root itself is not a file
    return "/" + parts.join("/");
  }

  write(path: string, content: string): { ok: boolean; text: string } {
    const norm = VirtualFS.normalize(path);
    if (!norm) return { ok: false, text: `invalid path: ${JSON.stringify(path)}` };
    const existed = this.#files.has(norm);
    this.#files.set(norm, String(content ?? ""));
    return { ok: true, text: `${existed ? "overwrote" : "created"} ${norm} (${String(content ?? "").length} bytes)` };
  }

  read(path: string): { ok: boolean; text: string } {
    const norm = VirtualFS.normalize(path);
    if (!norm) return { ok: false, text: `invalid path: ${JSON.stringify(path)}` };
    const content = this.#files.get(norm);
    if (content === undefined) {
      return { ok: false, text: `not found: ${norm}` };
    }
    return { ok: true, text: content };
  }

  ls(dir = "/"): { ok: boolean; text: string } {
    const normDir = dir === "/" || dir === "" ? "/" : VirtualFS.normalize(dir);
    if (!normDir) return { ok: false, text: `invalid path: ${JSON.stringify(dir)}` };
    const prefix = normDir === "/" ? "/" : `${normDir}/`;
    const entries = new Map<string, "file" | "dir">();
    for (const p of this.#files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) entries.set(rest, "file");
      else entries.set(rest.slice(0, slash), "dir");
    }
    if (entries.size === 0) return { ok: true, text: `(empty under ${prefix})` };
    const lines = [...entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, kind]) => `${kind === "dir" ? "d" : "-"} ${name}`);
    return { ok: true, text: lines.join("\n") };
  }

  remove(path: string): { ok: boolean; text: string } {
    const norm = VirtualFS.normalize(path);
    if (!norm) return { ok: false, text: `invalid path: ${JSON.stringify(path)}` };
    if (!this.#files.has(norm)) return { ok: false, text: `not found: ${norm}` };
    this.#files.delete(norm);
    return { ok: true, text: `removed ${norm}` };
  }

  size(): number {
    return this.#files.size;
  }
}

// ── the plugin ───────────────────────────────────────────────────────────

export interface DemoFsOptions {
  /** Inject an existing VirtualFS (tests). Default: fresh instance. */
  fs?: VirtualFS;
}

declare module "@bridle/kernel" {
  interface ServiceMap {
    // tools is declared by its owning packages too; duplicate compatible
    // declarations merge (same pattern @bridle/security uses).
    tools: import("@bridle/tools").ToolsService;
    demoFs: VirtualFS;
  }
}

export function demoFsPlugin(opts: DemoFsOptions = {}): PluginDef {
  return {
    name: "demo-fs",
    requires: ["tools"],
    setup(ctx) {
      return demoFsSetup(ctx as PluginContext, opts);
    },
  };
}

async function demoFsSetup(ctx: PluginContext, opts: DemoFsOptions): Promise<void> {
  const fs = opts.fs ?? new VirtualFS();
  const tools = await ctx.service("tools");

  // REVERSIBILITY: collect every registration's disposer and unwind them on
  // unmount via ctx.effect. After `unmount("demo-fs")` the shared registry
  // contains none of our tools — the host never notices we existed.
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: "demo-fs.write",
      description: "Create or overwrite a file in the sandboxed virtual filesystem.",
      params: { path: "string", content: "string" },
      permission: "write",
      execute: async (a: { path: string; content?: string }) => fs.write(a.path, String(a.content ?? "")),
    }),
  );
  disposers.push(
    tools.register({
      name: "demo-fs.read",
      description: "Read a file from the virtual filesystem.",
      params: { path: "string" },
      permission: "read",
      execute: async (a: { path: string }) => fs.read(a.path),
    }),
  );
  disposers.push(
    tools.register({
      name: "demo-fs.ls",
      description: "List entries under a directory ('/' = everything).",
      params: { dir: "string?" },
      permission: "read",
      execute: async (a: { dir?: string }) => fs.ls(a.dir ?? "/"),
    }),
  );
  disposers.push(
    tools.register({
      name: "demo-fs.remove",
      description: "Delete one file from the virtual filesystem.",
      params: { path: "string" },
      permission: "write",
      execute: async (a: { path: string }) => fs.remove(a.path),
    }),
  );

  ctx.effect(() => {
    for (const d of disposers.splice(0)) d();
  });

  ctx.provide("demoFs", fs);
}
