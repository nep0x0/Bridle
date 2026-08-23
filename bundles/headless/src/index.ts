/**
 * bridle headless bundle — one function that wires a working harness:
 * kernel + session + tools (+ builtin safe tools) + agent loop + llm.
 */

import { Context } from "@bridle/kernel";
import type { SessionLog, SessionEvent } from "@bridle/session";
import { sessionPlugin } from "@bridle/session";
import {
  toolsPlugin,
  type ToolsService,
  type ToolDef,
} from "@bridle/tools";
import { agentPlugin } from "@bridle/agent";
import {
  openAiCompatAdapter,
  type LlmAdapter,
  type OpenAiCompatConfig,
} from "@bridle/llm";
import { securityPlugin, type SecurityOptions } from "@bridle/security";
import {
  workflowPlugin,
  type WorkflowOptions,
} from "@bridle/workflow";
import { commandPlugin, type Command, type CommandIO, type CommandsApi } from "./commands.ts";
import { turnProgressPlugin, formatProgress, type ProgressOptions } from "./progress.ts";

export { commandPlugin, turnProgressPlugin, formatProgress };
export type { Command, CommandIO, CommandsApi, ProgressOptions };

export interface BridleOptions {
  /** API-model configuration (OpenAI-compatible endpoint). */
  llm: OpenAiCompatConfig;
  /** Extra tools to register beyond the builtins. */
  tools?: Array<ToolDef>;
  /** Replace the default OpenAI-compatible adapter entirely (e.g. a
   *  web-chat adapter). */
  adapter?: LlmAdapter;
  maxSteps?: number;
  /** Permission gate configuration (M4). Absent ⇒ no gate. */
  security?: SecurityOptions;
  /** Workflow pack (plans / auto_run / scaffolds). Default: on with
   *  defaults; pass false to disable, or options to tune verify kinds,
   *  cycle limits and the rollback hook. */
  workflow?: false | WorkflowOptions;
}

export interface Bridle {
  ctx: Context;
  log: SessionLog;
  tools: ToolsService;
  run(input: string): Promise<{ steps: number; text: string; rejected?: string }>;
}

/** Built-in demo tools — deliberately sandboxed and boring, and now
 *  permission-classified for the security gate. */
function builtinTools(): Array<ToolDef> {
  return [
    {
      name: "echo",
      description: "Echo the given text back.",
      params: { text: "string" },
      permission: "read",
      execute: (a: { text: string }) => ({ ok: true, text: String(a.text) }),
    },
    {
      name: "now",
      description: "Current UTC time in ISO format.",
      permission: "read",
      execute: () => ({ ok: true, text: new Date().toISOString() }),
    },
    {
      name: "math.eval",
      description:
        "Evaluate a simple arithmetic expression of digits and + - * / ( ) . Only those characters are allowed.",
      params: { expr: "string" },
      // Runs arbitrary (charset-gated) code ⇒ execute class.
      permission: "execute",
      execute: (a: { expr: string }) => {
        const expr = String(a.expr ?? "");
        if (!/^[0-9+\-*/(). ]+$/.test(expr)) {
          return { ok: false, text: "rejected: only digits and + - * / ( ) . are allowed" };
        }
        // eslint-disable-next-line no-new-func -- gated by strict charset above
        const value = Function(`"use strict"; return (${expr});`)() as unknown;
        return { ok: true, text: String(value) };
      },
    },
  ];
}

/** Wire a complete harness. */
export async function createBridle(opts: BridleOptions): Promise<Bridle> {
  const ctx = new Context();

  await ctx.mount({ name: "session", setup: (s) => sessionPlugin(s) });
  await ctx.mount({ name: "tools", setup: (s) => toolsPlugin(s) });
  if (opts.security) await ctx.mount(securityPlugin(opts.security));
  if (opts.workflow !== false) {
    await ctx.mount(workflowPlugin(opts.workflow ?? {}));
  }

  const adapter: LlmAdapter = opts.adapter ?? openAiCompatAdapter(opts.llm);
  ctx.provide("llm", adapter);

  await ctx.mount(agentPlugin({ maxSteps: opts.maxSteps }));

  const tools = ctx.requireService("tools");
  for (const tool of [...builtinTools(), ...(opts.tools ?? [])]) {
    tools.register(tool);
  }

  const log = ctx.requireService("sessions");
  const loop = ctx.requireService("agentLoop");

  return {
    ctx,
    log,
    tools,
    run: (input: string) => loop.runTurn({ text: input }),
  };
}

export type { SessionEvent };
