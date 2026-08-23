/**
 * bridle roblox domain — live Studio transport over MCP stdio (R4).
 *
 * Speaks newline-delimited JSON-RPC 2.0 to StudioMCP.exe (optionally under
 * wine). Handshake facts learned from the field, courtesy of ZeroScript's
 * bridge logs:
 *   - initialize → notifications/initialized, protocolVersion "2024-11-05"
 *   - StudioMCP advertises ZERO tools right after initialize because its
 *     backend (the running Studio) attaches a moment later ⇒ tools/list
 *     must be retried for a few seconds before giving up
 *   - results arrive as result.content[] ({type:"text"|"image"}); errors as
 *     JSON-RPC error objects or result.isError
 *
 * Tool ARGUMENT SHAPES are centralised in the METHOD_TOOLS table below so
 * the first live run can correct reality in exactly one place.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  StudioResult,
  StudioTreeEntry,
  StudioScript,
  StudioTransport,
} from "./transport.ts";

export interface McpStdioOptions {
  /** Program to run (wine, or the exe itself on Windows). */
  command: string;
  /** Arguments after the program (usually [studioMcpPath]). */
  args?: string[];
  /** Extra environment (e.g. WINEPREFIX for a vinegar prefix). */
  env?: Record<string, string>;
  requestTimeoutMs?: number; // default 30_000
  toolsReadyTimeoutMs?: number; // default 15_000 (backend attach window)
  log?: (m: string) => void;
}

interface JsonRpcResponse {
  id?: number | string | null;
  method?: string;
  result?: {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
  error?: { message?: string };
}

type Pending = {
  resolve: (msg: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpStdioTransport implements StudioTransport {
  readonly kind = "live" as const;

  #spawnOpts: McpStdioOptions;

  #proc: ChildProcess;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #toolNames: string[] = [];
  #captureSeq = 0;
  #stderrTail: string[] = [];
  #opts: Required<Pick<McpStdioOptions, "requestTimeoutMs" | "toolsReadyTimeoutMs">> & {
    log: (m: string) => void;
  };
  #exited = false;

  private constructor(opts: McpStdioOptions) {
    this.#spawnOpts = { ...opts };
    this.#opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      toolsReadyTimeoutMs: opts.toolsReadyTimeoutMs ?? 15_000,
      log: opts.log ?? (() => {}),
    };
    this.#proc = spawn(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    this.#proc.stdout!.setEncoding("utf8");
    this.#proc.stdout!.on("data", (chunk: string) => this.#onData(chunk));
    this.#proc.stderr!.setEncoding("utf8");
    this.#proc.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
      }
    });
    this.#proc.on("exit", () => {
      this.#exited = true;
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`StudioMCP exited. stderr tail:\n${this.#stderrTail.join("\n")}`));
      }
      this.#pending.clear();
    });
  }

  /** Spawn + MCP handshake + wait until the tool list is populated. */
  static async connect(opts: McpStdioOptions): Promise<McpStdioTransport> {
    const t = new McpStdioTransport(opts);
    try {
      await t.#request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bridle-bridge", version: "0.1.0" },
      });
      t.#notify("notifications/initialized");
      await t.#waitToolsReady();
      return t;
    } catch (err) {
      t.close();
      throw err;
    }
  }

  /** Tool names advertised by the server (diagnostics/tests). */
  advertisedTools(): string[] {
    return [...this.#toolNames];
  }

  /** Last stderr lines from the proxy — diagnostics when upstream dies. */
  stderrTail(lines = 4): string[] {
    return this.#stderrTail.slice(-lines);
  }

  /** Kill the current child and start a FRESH proxy (same options),
   *  re-running handshake + tools wait. Returns this instance replaced
   *  semantics: caller should reassign if it holds the reference. */
  async respawn(): Promise<McpStdioTransport> {
    this.close();
    await new Promise((r) => setTimeout(r, 1500));
    return McpStdioTransport.connect({ ...this.#spawnOpts });
  }

  close(): void {
    if (this.#exited) return;
    try {
      this.#proc.kill();
    } catch {
      /* already gone */
    }
  }

  // ── json-rpc plumbing ────────────────────────────────────────────────

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // tolerate junk lines honestly
      }
      const id = typeof msg.id === "number" ? msg.id : undefined;
      if (id === undefined) continue; // notification — nothing pending
      const p = this.#pending.get(id);
      if (!p) continue;
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.#exited) return Promise.reject(new Error("StudioMCP process has exited"));
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.#opts.requestTimeoutMs}ms`));
      }, this.#opts.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#proc.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(new Error(`stdin write failed: ${err.message}`));
        }
      });
    });
  }

  #notify(method: string): void {
    this.#proc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n",
    );
  }

  /** tools/list retries until non-empty — StudioMCP attaches its backend
   *  slightly after the stdio handshake (documented gotcha). */
  async #waitToolsReady(): Promise<void> {
    const deadline = Date.now() + this.#opts.toolsReadyTimeoutMs;
    for (;;) {
      const msg = await this.#request("tools/list", {});
      this.#toolNames = (msg.result?.tools ?? []).map((t) => t.name);
      if (this.#toolNames.length > 0) {
        this.#opts.log(`StudioMCP ready: ${this.#toolNames.length} tools`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `StudioMCP advertised 0 tools within ${Math.round(this.#opts.toolsReadyTimeoutMs / 1000)}s — ` +
            `is Roblox Studio open with its MCP server enabled?`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  #resolveTool(...candidates: string[]): string {
    for (const c of candidates) if (this.#toolNames.includes(c)) return c;
    throw new Error(
      `none of [${candidates.join(", ")}] advertised by StudioMCP. Available: ${this.#toolNames.join(", ")}`,
    );
  }

  async #callTool(tool: string, args: Record<string, unknown>): Promise<StudioResult> {
    // NOTE: despite "required" in the advertised schema, StudioMCP does NOT
    // enforce studio_id — ZeroScript's proven bridge sends arguments WITHOUT
    // it and works. We do the same; extra keys only risk strict rejection.
    let msg: JsonRpcResponse;
    try {
      msg = await this.#request("tools/call", { name: tool, arguments: args });
    } catch (err) {
      return { ok: false, text: String((err as Error).message) };
    }
    if (msg.error) {
      return { ok: false, text: `${tool}: ${msg.error.message ?? JSON.stringify(msg.error)}` };
    }
    const content = msg.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const images = content.filter((c) => c.type === "image").length;
    const composed =
      (text || (images ? "" : JSON.stringify(content).slice(0, 500))) +
      (images > 0 ? `\n[images: ${images}]` : "");
    return {
      ok: msg.result?.isError !== true && Boolean(msg.result),
      text: composed.trim(),
    };
  }

  // ── StudioTransport ──────────────────────────────────────────────────

  async getState(): Promise<StudioResult> {
    return this.#callTool(this.#resolveTool("get_studio_state"), {});
  }

  async getConsole(maxLines = 40): Promise<StudioResult> {
    // Schema only accepts studio_id — max_lines is not a server parameter,
    // so the argument is intentionally NOT sent (kept in the seam for fake).
    void maxLines;
    return this.#callTool(this.#resolveTool("get_console_output"), {});
  }

  async searchGameTree(path: string, maxDepth: number): Promise<StudioTreeEntry[]> {
    const res = await this.#callTool(this.#resolveTool("search_game_tree"), {
      datamodel_type: "Edit",
      ...(path ? { path } : {}),
      max_depth: Math.min(maxDepth, 10),
    });
    return this.#parseMaybeJsonArray<StudioTreeEntry>(res.text);
  }

  async inspectInstance(path: string): Promise<StudioResult> {
    return this.#callTool(this.#resolveTool("inspect_instance"), { path });
  }

  async readScript(path: string): Promise<StudioScript | null> {
    const res = await this.#callTool(this.#resolveTool("script_read"), {
      target_file: path,
      should_read_entire_file: true,
    });
    if (!res.ok) return null;
    const parsed = this.#parseMaybeJsonObject<{ path?: string; className?: string; source?: string; Name?: string; Source?: string; ClassName?: string }>(
      res.text,
    );
    if (parsed?.source !== undefined || parsed?.Source !== undefined) {
      return {
        path: parsed.path ?? parsed.Name ?? path,
        className: parsed.className ?? parsed.ClassName ?? "Script",
        source: parsed.source ?? parsed.Source ?? "",
      };
    }
    if (/not\s*found|does not exist|no script/i.test(res.text)) return null;
    // Tolerant fallback: the body IS the source.
    return res.text ? { path, className: "Script", source: res.text } : null;
  }

  async listStudios(): Promise<Array<{ id?: string; name?: string }>> {
    const res = await this.#callTool("list_roblox_studios", {});
    const arr = this.#parseMaybeJsonArray<{ id?: string; name?: string; studio_id?: string }>(res.text);
    return arr.map((s0) => ({ id: s0.id ?? s0.studio_id, name: s0.name }));
  }

  async listScripts(): Promise<StudioScript[]> {
    // No guaranteed "list scripts" tool: derive from the tree.
    const entries = await this.searchGameTree("", 12);
    const scriptPaths = entries
      .filter((e) => /Script$/.test(e.className))
      .slice(0, 50)
      .map((e) => e.fullPath);
    const out: StudioScript[] = [];
    for (const p of scriptPaths) {
      const s = await this.readScript(p);
      if (s) out.push(s);
    }
    return out;
  }

  async grepScripts(pattern: string): Promise<Array<{ path: string; line: number; text: string }>> {
    // StudioMCP's key is "query", not "pattern".
    const res = await this.#callTool(this.#resolveTool("script_grep"), { query: pattern });
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const line of res.text.split("\n")) {
      const m = /^(.+?):(\d+):\s?(.*)$/.exec(line.trim());
      if (m) hits.push({ path: m[1]!, line: Number(m[2]), text: m[3] ?? "" });
    }
    return hits;
  }

  async screenCapture(): Promise<StudioResult> {
    // capture_id is required — an incrementing label like "ScreenCapture_1".
    this.#captureSeq += 1;
    return this.#callTool(this.#resolveTool("screen_capture"), {
      capture_id: `ScreenCapture_${this.#captureSeq}`,
    });
  }

  /**
   * Whole-file semantics over multi_edit's edit-list API:
   *  - new file  → create form (first edit old_string:"")
   *  - existing  → single edit replacing the ENTIRE current source
   * Both need the current source, hence the readScript first.
   */
  async multiEdit(edits: Array<{ path: string; source: string }>): Promise<StudioResult> {
    const tool = this.#resolveTool("multi_edit");
    const echoes: string[] = [];
    for (const edit of edits) {
      const current = await this.readScript(edit.path);
      // Real schema: file_path (dot-path, auto-created), datamodel_type,
      // edits[{old_string,new_string,replace_all?}] — whole-file strategy
      // rides on old_string being the ENTIRE current source.
      const args: Record<string, unknown> = {
        file_path: edit.path,
        datamodel_type: "Edit",
        edits: [
          {
            old_string: current ? current.source : "",
            new_string: edit.source,
          },
        ],
      };
      if (!current) args.className = "Script";
      const res = await this.#callTool(tool, args);
      if (!res.ok) return res;
      // Surface each server response — doubles as an argument echo for tests
      // and as first-line diagnostics on a live run.
      echoes.push(`[${edit.path}] ${res.text}`);
    }
    return { ok: true, text: echoes.join("\n") };
  }

  async executeLuau(code: string): Promise<StudioResult> {
    return this.#callTool(this.#resolveTool("execute_luau"), {
      code,
      datamodel_type: "Edit",
    });
  }

  async startStopPlay(start: boolean): Promise<StudioResult> {
    return this.#callTool(this.#resolveTool("start_stop_play"), {
      is_start: start,
    });
  }

  // ── parsing helpers ──────────────────────────────────────────────────

  #parseMaybeJsonArray<T>(text: string): T[] {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) return v as T[];
    } catch {
      /* fall through to line parsing */
    }
    // Tolerant line form: "FullPath (ClassName)" per line.
    return text
      .split("\n")
      .map((l) => /^\s*(\S+)\s*\(([^)]+)\)\s*$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        fullPath: m[1]!,
        name: m[1]!.split(".").at(-1)!,
        className: m[2]!,
      })) as unknown as T[];
  }

  #parseMaybeJsonObject<T>(text: string): T | null {
    const start = text.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start)) as T;
    } catch {
      return null;
    }
  }
}
