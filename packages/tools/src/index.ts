/**
 * bridle tools — the scoped tool registry and guarded execution pipeline.
 *
 * Pipeline per call:
 *   tools/pre-execute  (waterfall)  — wrap/mutate the request, or DENY by
 *                                     short-circuiting (permission gates and
 *                                     policies are ordinary listeners)
 *   execute            — the tool's own implementation
 *   tools/post-execute (emit)       — audit/observe the outcome
 */

import type { PluginContext } from "@bridle/kernel";

export interface ToolDef<A = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON-schema-ish param description for prompt assembly (M2+). */
  params?: Record<string, string>;
  /** Declared permission class. The security gate (@bridle/security, when
   *  mounted) reads this; undeclared tools fall back to its default class.
   *  Convention: read = observes, write = mutates state, execute = runs
   *  code / arbitrary instructions. */
  permission?: "read" | "write" | "execute";
  execute(args: A): Promise<ToolOutput> | ToolOutput;
}

export interface ToolOutput {
  ok: boolean;
  text: string;
}

export interface ToolRequest {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDecision {
  deny?: string; // set => pipeline short-circuits with a permission error
}

export type PreExecutePayload = {
  request: ToolRequest;
  decision: ToolDecision;
};

export interface PostExecutePayload {
  request: ToolRequest;
  output: ToolOutput;
  elapsedMs: number;
}

const DENIED_PREFIX = "Permission denied: ";

export class ToolsService {
  #tools = new Map<string, ToolDef>();

  constructor(private readonly ctx: PluginContext) {}

  register<A extends Record<string, unknown>>(tool: ToolDef<A>): Disposable {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool as unknown as ToolDef);
    return () => this.#tools.delete(tool.name);
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  list(): Array<Pick<ToolDef, "name" | "description" | "params">> {
    return [...this.#tools.values()].map(({ name, description, params }) => ({
      name,
      description,
      params,
    }));
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Full definition lookup (incl. the declared permission class) for the
   *  security gate. Defensive copy — callers cannot mutate the registry. */
  describe(name: string):
    | { name: string; description: string; params?: Record<string, string>; permission?: "read" | "write" | "execute" }
    | undefined {
    const t = this.#tools.get(name);
    if (!t) return undefined;
    const { name: n, description, params, permission } = t as ToolDef;
    return { name: n, description, params, permission };
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const request: ToolRequest = { name, args };
    const payload: PreExecutePayload = { request, decision: {} };

    // Guard phase: waterfall listeners may mutate the request or own the
    // decision by returning WITHOUT next() after setting decision.deny.
    const wrapped = this.ctx.waterfall<PreExecutePayload>(
      "tools/pre-execute",
      payload,
    );
    if (wrapped.decision.deny !== undefined) {
      return {
        ok: false,
        text: `${DENIED_PREFIX}${wrapped.decision.deny}`,
      };
    }

    const tool = this.#tools.get(wrapped.request.name);
    if (!tool) {
      return { ok: false, text: `unknown tool '${wrapped.request.name}'` };
    }
    const t0 = Date.now();
    let output: ToolOutput;
    try {
      output = await tool.execute(wrapped.request.args);
    } catch (err) {
      output = { ok: false, text: `tool threw: ${String(err)}` };
    }
    const elapsedMs = Date.now() - t0;

    this.ctx.emit("tools/post-execute", {
      request: wrapped.request,
      output,
      elapsedMs,
    } satisfies PostExecutePayload);
    return output;
  }
}

type Disposable = () => void;

/** bridle plugin: provides the "tools" service. */
export async function toolsPlugin(ctx: PluginContext): Promise<void> {
  ctx.provide("tools", new ToolsService(ctx));
}
