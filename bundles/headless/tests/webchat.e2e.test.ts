/**
 * M3 gate (webchat): a full harness turn rendered through the gateway by an
 * adapter that speaks the extension protocol — capabilities push, then
 * render_request → render_result round trips — using the SHIPPED wire parser
 * from extension/content/bridle-wire.js.
 *
 * This is the browser-free half of the live-chat E2E: everything except the
 * actual DOM driving is real (gateway ws frames, agent loop, tools pipeline,
 * session log, and the tool-call wire format).
 */
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
// Side-effect import: registers globalThis.BridleWire. We deliberately test
// the exact file the extension ships, not a copy of it.
import "../../../extension/content/bridle-wire.js";
import { createBridle } from "../src/index.ts";
import { WebchatGateway } from "@bridle/gateway-ws";

type Frame = Record<string, any>;
const Wire = () => (globalThis as { BridleWire?: any }).BridleWire!;

/** A fake content adapter: connects like the extension does and answers
 *  render_requests from a script, parsing its own replies with the real
 *  BridleWire parser before sending them back — exactly what deepseek.js
 *  does between reading the page and posting adapter_result. */
function fakeAdapter(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const opened = new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  const firstFrame = new Promise<Frame>((res) =>
    ws.once("message", (raw) => res(JSON.parse(String(raw)))),
  );

  let renders = 0;
  let lastRequest: Frame | undefined;

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type !== "render_request") return;
    renders++;
    lastRequest = msg;
    // Scripted "model" reply; deliberately messy on turn 1 to exercise the
    // parser: prose around the block + an unterminated closing fence.
    const text =
      renders === 1
        ? 'Sure, computing locally.\n\n```bridle-tool\n{"name":"math.eval","args":{"expr":"12*9"}}\n'
        : "12*9 equals 108. No further calls needed.";
    setTimeout(() => {
      const parsed = Wire().parseToolCalls(text);
      ws.send(
        JSON.stringify({
          type: "render_result",
          id: msg.id,
          ok: true,
          text: parsed.text,
          toolCalls: parsed.toolCalls.map((tc: Frame, i: number) => ({
            id: `web_${renders}_${i}`,
            name: tc.name,
            args: tc.args,
          })),
        }),
      );
    }, 5);
  });

  return {
    ws,
    opened,
    firstFrame,
    get renderCount() {
      return renders;
    },
    get lastReq() {
      return lastRequest;
    },
  };
}

describe("M3 gate: harness turns over the webchat gateway", () => {
  it("capabilities list the registered tools on connect", async () => {
    const gw = new WebchatGateway(() => [{ name: "echo", description: "echo" }], {}, () => {});
    const port = await gw.listen();
    const client = fakeAdapter(port);
    await client.opened;
    const caps = await client.firstFrame;
    expect(caps.type).toBe("capabilities");
    expect(caps.tools).toEqual([{ name: "echo", description: "echo" }]);
    await gw.close();
    client.ws.close();
  });

  it("tool-call round trip through the shipped wire parser", async () => {
    const gw = new WebchatGateway(() => bridle.tools.list(), {}, () => {});
    const port = await gw.listen();

    // createBridle BEFORE connecting so capabilities already list math.eval.
    const bridle = await createBridle({ adapter: gw.webchatAdapter(), maxSteps: 4 });
    const client = fakeAdapter(port);
    await client.opened;

    const caps = await client.firstFrame;
    expect(caps.type).toBe("capabilities");
    expect(caps.tools.map((t: Frame) => t.name)).toContain("math.eval");

    const res = await bridle.run("What is 12*9? Use the math tool.");

    expect(res.rejected).toBeUndefined();
    expect(res.steps).toBe(2);
    expect(res.text).toBe("12*9 equals 108. No further calls needed.");

    // exactly two renders happened; the second carried the tool result
    expect(client.renderCount).toBe(2);
    const lastMessages = client.lastReq.messages as Array<Frame>;
    // Second claim's derived history: user prompt, the assistant's tool-call
    // turn, then the tool result fed back. The final assistant text is only
    // appended after this request completes.
    expect(lastRoles(lastMessages)).toEqual(["user", "assistant", "tool"]);
    const toolMsg = lastMessages.find((m) => m.role === "tool");
    expect(String(toolMsg?.text)).toContain("108");

    // durable log recorded the execution honestly (model-visible means logged)
    const toolResult = bridle.log.all().find((e) => e.type === "tool/result");
    expect(toolResult).toBeDefined();
    const payload = toolResult!.payload as { ok: boolean; text: string };
    expect(payload.ok).toBe(true);
    expect(payload.text).toBe("108");

    await gw.close();
    client.ws.close();
  });

  it("a reply whose tool block fails to parse closes the turn honestly with no calls", async () => {
    const gw = new WebchatGateway(() => bridle2.tools.list(), {}, () => {});
    const port = await gw.listen();
    const bridle2 = await createBridle({ adapter: gw.webchatAdapter(), maxSteps: 4 });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // Attach the capabilities listener BEFORE connecting: the frame can land
    // between the client's 'open' and a later listener attachment.
    const capsArrived = new Promise<void>((res) => ws.once("message", () => res()));
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });
    await capsArrived;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== "render_request") return;
      const parsed = Wire().parseToolCalls('```bridle-tool\n{"nope": true}\n```');
      expect(parsed.toolCalls.length).toBe(0);
      expect(parsed.errors.length).toBeGreaterThan(0);
      ws.send(
        JSON.stringify({ type: "render_result", id: msg.id, ok: true, text: parsed.text, toolCalls: [] }),
      );
    });

    const res = await bridle2.run("hello");
    expect(res.steps).toBe(1);
    expect(res.text).toBe("");

    await gw.close();
    ws.close();
  });
});

function lastRoles(messages: Array<Frame>): string[] {
  return messages.map((m) => m.role);
}
