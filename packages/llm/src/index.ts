/**
 * bridle llm — the canonical adapter seam.
 *
 * Web-chat providers and API providers both implement `LlmAdapter`.
 * From the agent loop's point of view they are indistinguishable.
 *
 * Also ships the first real adapter: OpenAI-compatible /chat/completions
 * (works with OpenAI, DeepSeek API, Groq, Ollama, LM Studio, vLLM, ...).
 */

import type { PluginDef } from "@bridle/kernel";

// ── canonical seam types (single source of truth) ────────────────────────

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: LlmToolCall[];
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

export interface LlmAdapter {
  complete(req: LlmRequest): Promise<{
    text: string;
    toolCalls: LlmToolCall[];
  }>;
}

// ── OpenAI-compatible adapter ────────────────────────────────────────────

export interface OpenAiCompatConfig {
  baseUrl: string; // e.g. https://api.deepseek.com  (no trailing slash)
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export function openAiCompatAdapter(cfg: OpenAiCompatConfig): LlmAdapter {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete(req) {
      const body = {
        model: cfg.model,
        messages: req.messages.map((m) => {
          if (m.role === "tool") {
            return { role: "tool", content: m.text, tool_call_id: m.forCallId };
          }
          if (m.role === "assistant" && m.toolCalls?.length) {
            return {
              role: "assistant",
              content: m.text || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args ?? {}),
                },
              })),
            };
          }
          return { role: m.role, content: m.text };
        }),
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description },
        })),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 60_000);
      let json: {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: OpenAiToolCall[];
          };
        }>;
      };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        json = (await res.json()) as typeof json;
      } finally {
        clearTimeout(timer);
      }
      const msg = json.choices?.[0]?.message ?? {};
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}") as Record<
            string,
            unknown
          >;
        } catch {
          args = {}; // malformed arguments degrade to empty, never throw
        }
        return {
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? "",
          args,
        };
      });
      return { text, toolCalls };
    },
  };
}

/** Plugin form: provides the "llm" service. */
export function llmOpenAiCompatPlugin(cfg: OpenAiCompatConfig): PluginDef {
  return {
    name: "llm",
    setup(ctx) {
      ctx.provide("llm", openAiCompatAdapter(cfg));
    },
  };
}
