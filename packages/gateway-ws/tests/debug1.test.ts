import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebchatGateway } from "../src/index.ts";

const TOOLS = [{ name: "echo", description: "echo" }];

describe("debug single", () => {
  it("replicates test1 exactly", async () => {
    const step = (m: string) => console.log("[step]", m);
    const gw = new WebchatGateway(() => TOOLS, {}, (m) => step("gw:" + m));
    step("listening...");
    const port = await gw.listen();
    step("port=" + port);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const first = new Promise<Record<string, unknown>>((res) =>
      ws.once("message", (raw) => res(JSON.parse(String(raw)))),
    );
    ws.on("open", () => step("client open"));
    ws.on("error", (e) => step("client error: " + e.message));

    const caps = await Promise.race([
      first,
      new Promise((_, rej) => setTimeout(() => rej(new Error("caps timeout")), 3000)),
    ]);
    step("caps=" + JSON.stringify(caps).slice(0, 50));
    expect(caps.type).toBe("capabilities");

    const adapter = gw.webchatAdapter();
    step("calling complete");
    const pending = adapter.complete({
      messages: [{ role: "user", text: "hi" }],
      tools: TOOLS,
    });
    const rr = await Promise.race([
      new Promise<Record<string, unknown>>((res) =>
        ws.once("message", (raw) => res(JSON.parse(String(raw)))),
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error("rr timeout")), 3000)),
    ]);
    step("rr=" + JSON.stringify(rr).slice(0, 60));
    ws.send(JSON.stringify({ type: "render_result", id: rr.id, ok: true, text: "sure", toolCalls: [] }));
    const out = await pending;
    step("complete resolved: " + JSON.stringify(out));
    expect(out.text).toBe("sure");
    gw.close();
  }, 10000);
});
