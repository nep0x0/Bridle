import { describe, expect, it, vi } from "vitest";
import { Context } from "@bridle/kernel";
import { SessionLog } from "@bridle/session";
import { ToolsService, toolsPlugin } from "@bridle/tools";
import {
  agentPlugin,
  projectMessages,
  type LlmAdapter,
  type LlmRequest,
  type LlmToolCall,
} from "../src/index.ts";


function makeLlm(script: Array<{ text: string; toolCalls: LlmToolCall[] }>) {
  const requests: LlmRequest[] = [];
  let i = 0;
  const adapter: LlmAdapter = {
    async complete(req) {
      requests.push(req);
      const step = script[Math.min(i++, script.length - 1)]!;
      return { text: step.text, toolCalls: step.toolCalls };
    },
  };
  return { adapter, requests };
}

async function boot(
  script: Array<{ text: string; toolCalls: LlmToolCall[] }>,
): Promise<{
  ctx: Context;
  log: SessionLog;
  tools: ToolsService;
  requests: LlmRequest[];
  runTurn: (text: string) => Promise<{ steps: number; text: string; rejected?: string }>;
}> {
  const ctx = new Context();
  const log = new SessionLog();
  ctx.provide("sessions", log);
  await ctx.mount({ name: "tools", setup: toolsPlugin });

  const realTools = ctx.requireService("tools");
  const { adapter, requests } = makeLlm(script);
  ctx.provide("llm", adapter);

  // agent must be mounted AFTER seams exist (or via requires)
  await ctx.mount(agentPlugin());
  const loop = ctx.requireService("agentLoop");
  return {
    ctx,
    log,
    tools: realTools,
    requests,
    runTurn: (text: string) => loop.runTurn({ text }),
  };
}

describe("agent loop plugin", () => {
  it("tool-free turn: one step, model history derived only from the log", async () => {
    const h = await boot([{ text: "Hello!", toolCalls: [] }]);
    const r = await h.runTurn("what is 2+2?");
    expect(r.steps).toBe(1);
    expect(r.text).toBe("Hello!");

    // INVARIANT: each request saw a PREFIX of the final derived history
    // (the log grows monotonically; model-visible means logged).
    const finalHist = h.log.derive(projectMessages);
    h.requests.forEach((req) => {
      expect(finalHist.slice(0, req.messages.length)).toEqual(req.messages);
    });
    // durable trail
    const types = h.log.all().map((e) => e.type);
    expect(types).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "turn/end",
    ]);
  });

  it("tool turn: call -> result logged -> second request sees the result -> close", async () => {
    let calls = 0;
    const h = await boot([
      { text: "", toolCalls: [{ id: "t1", name: "add", args: { a: 2, b: 3 } }] },
      { text: "5", toolCalls: [] },
    ]);
    h.tools.register({
      name: "add",
      description: "adds",
      execute: (a: { a: number; b: number }) => {
        calls++;
        return { ok: true, text: String(a.a + a.b) };
      },
    });
    const r = await h.runTurn("add 2 and 3");
    expect(r.steps).toBe(2);
    expect(calls).toBe(1);

    // second request MUST contain the tool result message
    const last = h.requests[1]!.messages;
    expect(last.at(-1)).toEqual({ role: "tool", forCallId: "t1", text: "[ok] 5" });

    // INVARIANT holds on every request (prefix property)
    const finalHist = h.log.derive(projectMessages);
    for (const req of h.requests) {
      expect(finalHist.slice(0, req.messages.length)).toEqual(req.messages);
    }
    const types = h.log.all().map((e) => e.type);
    expect(types).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/start",
      "assistant/message",
      "turn/end",
    ]);
  });

  it("pre-step policy can reject the first claim: zero steps spent, turn still closed", async () => {
    const h = await boot([{ text: "should never be called", toolCalls: [] }]);
    const complete = vi.spyOn(h.requests, "push");
    await h.ctx.mount({
      name: "blocker",
      setup(s) {
        s.on("agent/pre-step", (p) => {
          if (p.messages.at(-1)?.text.includes("SECRET")) {
            p.proceed = false;
            p.reason = "blocked input";
          }
        });
      },
    });
    const r = await h.runTurn("give me the SECRET");
    expect(r.rejected).toBe("blocked input");
    expect(r.steps).toBe(0);
    expect(complete).not.toHaveBeenCalled(); // no model request at all
    const types = h.log.all().map((e) => e.type);
    expect(types).toEqual(["turn/start", "user/message", "turn/end"]);
  });

  it("pre-step can REWRITE messages before they reach the model", async () => {
    const h = await boot([{ text: "ack", toolCalls: [] }]);
    await h.ctx.mount({
      name: "rewriter",
      setup(s) {
        s.on("agent/pre-step", (p) => {
          p.messages = p.messages.map((m) =>
            m.role === "user" ? { ...m, text: m.text.toUpperCase() } : m,
          );
        });
      },
    });
    await h.runTurn("quiet please");
    expect(h.requests[0]!.messages[0]!.text).toBe("QUIET PLEASE");
  });

  it("maxSteps stops runaway loops with a durable error", async () => {
    const ctx = new Context();
    const log = new SessionLog();
    ctx.provide("sessions", log);
    await ctx.mount({ name: "tools", setup: toolsPlugin });
    const forever: LlmToolCall = { id: "x", name: "loop", args: {} };
    const { adapter, requests } = makeLlm([
      { text: "", toolCalls: [forever] },
    ]);
    void requests;
    ctx.provide("llm", adapter);
    await ctx.mount({ name: "tools2", setup() {} }); // noop
    ctx.requireService("tools").register({
      name: "loop",
      description: "",
      execute: () => ({ ok: true, text: "still here" }),
    });
    await ctx.mount(agentPlugin({ maxSteps: 3 }));
    const loop = ctx.requireService("agentLoop");
    const r = await loop.runTurn({ text: "go" });
    expect(r.steps).toBe(4); // steps 1..3 ran, 4th exceeded
    expect(log.all().some((e) => e.type === "turn/error")).toBe(true);
    expect(log.all().at(-1)!.type).toBe("turn/end");
  });

  it("fork replay: a forked log re-derives identical history", async () => {
    const h = await boot([{ text: "done", toolCalls: [] }]);
    await h.runTurn("remember this");
    const child = h.log.fork();
    expect(child.derive(projectMessages)).toEqual(
      h.log.derive(projectMessages),
    );
  });
});
