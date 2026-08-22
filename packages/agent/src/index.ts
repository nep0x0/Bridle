/**
 * bridle agent — the default agent-loop, itself a PLUGIN.
 *
 * Turn = zero or more steps. A step is one model request plus the tools it
 * calls. The loop derives model history EXCLUSIVELY from the durable session
 * log (invariant: model-visible means logged) — there is no side channel.
 *
 * Extension points (kernel events):
 *   'agent/pre-step'  (waterfall) — listeners receive
 *       {messages, proceed, reason}; they may rewrite `messages`, or set
 *       proceed=false to reject. A rejected first claim closes the turn
 *       having spent no step.
 *   'agent/request'   (waterfall) — final look at the outgoing request.
 */

import type { PluginContext, PluginDef } from "@bridle/kernel";
import type { SessionEvent, SessionLog } from "@bridle/session";
import type { ToolsService } from "@bridle/tools";

// ── llm seam ─────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** Present on assistant messages that request tool calls. */
  toolCalls?: LlmToolCall[];
  /** For role="tool": which call this result belongs to. */
  forCallId?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: Array<{ name: string; description: string }>;
}

/** The adapter seam. Web-chat and API providers both implement THIS. */
export interface LlmAdapter {
  complete(req: LlmRequest): Promise<{
    text: string;
    toolCalls: LlmToolCall[];
  }>;
}

// ── projection (the only sanctioned history builder) ─────────────────────

const MODEL_VISIBLE = new Set([
  "user/message",
  "assistant/message",
  "tool/result",
]);

export function projectMessages(
  events: ReadonlyArray<SessionEvent>,
): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const e of events) {
    if (!MODEL_VISIBLE.has(e.type)) continue;
    if (e.type === "user/message") {
      out.push({
        role: "user",
        text: String((e.payload as { text?: string }).text ?? ""),
      });
    } else if (e.type === "assistant/message") {
      const p = e.payload as { text?: string; toolCalls?: LlmToolCall[] };
      out.push({
        role: "assistant",
        text: String(p.text ?? ""),
        toolCalls: p.toolCalls,
      });
    } else {
      const p = e.payload as { ok?: boolean; text?: string; forCallId?: string };
      out.push({
        role: "tool",
        forCallId: p.forCallId,
        text: `[${p.ok ? "ok" : "error"}] ${p.text ?? ""}`,
      });
    }
  }
  return out;
}

// ── the loop ─────────────────────────────────────────────────────────────

export interface AgentLoop {
  runTurn(input: { text: string }): Promise<{
    steps: number;
    text: string;
    rejected?: string;
  }>;
}

export interface AgentOptions {
  maxSteps?: number; // default 8 — hard stop for runaway loops
}

// Typed service keys — the declaration-merging pattern in action.
declare module "@bridle/kernel" {
  interface ServiceMap {
    sessions: SessionLog;
    tools: ToolsService;
    llm: LlmAdapter;
    agentLoop: import("./index.js").AgentLoop;
  }
}

export async function agentSetup(
  ctx: PluginContext,
  opts: AgentOptions = {},
): Promise<void> {
  const sessions = await ctx.service("sessions");
  const tools = await ctx.service("tools");
  const llm = await ctx.service("llm");

  let turnCounter = 0;

  const loop: AgentLoop = {
    async runTurn(input) {
      const turnId = ++turnCounter;
      let steps = 0;
      let lastText = "";
      let rejected: string | undefined;

      sessions.append("turn/start", { turnId });
      sessions.append("user/message", { text: input.text });

      try {
        while (true) {
          // pre-step: what the model sees. Rewrite messages, or reject.
          const claimed = ctx.waterfall<{
            messages: ReturnType<typeof projectMessages>;
            proceed: boolean;
            reason?: string;
          }>("agent/pre-step", {
            messages: sessions.derive(projectMessages),
            proceed: true,
          });
          if (!claimed.proceed || claimed.messages.length === 0) {
            rejected = claimed.reason ?? "rejected by policy";
            break;
          }

          steps++;
          if (steps > (opts.maxSteps ?? 8)) {
            sessions.append("turn/error", {
              turnId,
              reason: `maxSteps=${opts.maxSteps ?? 8} exceeded`,
            });
            break;
          }
          sessions.append("step/start", { turnId, step: steps });

          const req = ctx.waterfall<LlmRequest>("agent/request", {
            messages: claimed.messages,
            tools: tools.list(),
          });
          const res = await llm.complete(req);
          lastText = res.text;
          sessions.append("assistant/message", {
            text: res.text,
            toolCalls: res.toolCalls,
          });

          if (res.toolCalls.length === 0) break; // nothing owed -> close turn

          for (const tc of res.toolCalls) {
            sessions.append("tool/call", { ...tc });
            const out = await tools.execute(tc.name, tc.args);
            sessions.append("tool/result", {
              forCallId: tc.id,
              ok: out.ok,
              text: out.text,
            });
          }
          // tools owed another request -> next iteration claims again
        }
      } finally {
        sessions.append("turn/end", { turnId, steps });
      }
      return { steps, text: lastText, rejected };
    },
  };

  ctx.provide("agentLoop", loop);
}

/** The mountable plugin. Requires all three seams up-front. */
export function agentPlugin(opts: AgentOptions = {}): PluginDef {
  return {
    name: "agent",
    requires: ["sessions", "tools", "llm"],
    setup(ctx) {
      return agentSetup(ctx as PluginContext, opts);
    },
  };
}
