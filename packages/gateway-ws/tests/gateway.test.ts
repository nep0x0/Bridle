import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebchatGateway } from "../src/index.ts";

const TOOLS = [
  { name: "echo", description: "echo", params: { text: "string" } },
];

describe("webchat gateway", () => {
  let cleanup: Array<() => void> = [];
  afterAll(() => cleanup.forEach((fn) => fn()));

  /** Connect AND capture the first frame (capabilities) without a race:
   *  the listener is attached before the connection completes. */
  function connect(
    url: string,
  ): Promise<{ ws: WebSocket; first: Promise<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const first = new Promise<Record<string, unknown>>((res) => {
        // res — NOT the outer resolve: resolving the outer promise here would
        // leave `first` pending forever and hang every await first below.
        ws.once("message", (raw) => res(JSON.parse(String(raw))));
      });
      ws.on("open", () => resolve({ ws, first }));
      ws.on("error", reject);
    });
  }

  function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
    });
  }

  it("pushes capabilities on connect and round-trips render_request/result", async () => {
    const step = (m: string) => console.log("[t1]", m);
    const gw = new WebchatGateway(() => TOOLS, {}, (m) => step("gw:" + m));
    const port = await gw.listen();
    step("port=" + port);
    const { ws, first } = await connect(`ws://127.0.0.1:${port}`);
    step("connected");
    cleanup.push(() => ws.close());
    cleanup.push(() => gw.close());

    // capabilities arrive first
    const caps = await first;
    expect(caps.type).toBe("capabilities");
    expect(caps.tools).toEqual(TOOLS);
    expect(gw.hasAdapter()).toBe(true);

    // drive the adapter seam: complete() must produce a render_request on
    // the wire and resolve when the adapter answers.
    const adapter = gw.webchatAdapter();
    const pendingComplete = adapter.complete({
      messages: [{ role: "user", text: "hi" }],
      tools: TOOLS,
    });
    const rr = await nextMessage(ws);
    expect(rr.type).toBe("render_request");
    expect(rr.id).toBeDefined();

    ws.send(
      JSON.stringify({
        type: "render_result",
        id: rr.id,
        ok: true,
        text: "sure",
        toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }],
      }),
    );
    await expect(pendingComplete).resolves.toEqual({
      text: "sure",
      toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }],
    });
  });

  it("times out honestly when the adapter never answers", async () => {
    const gw = new WebchatGateway(() => TOOLS, { renderTimeoutMs: 150 }, () => {});
    const port = await gw.listen();
    const { ws, first } = await connect(`ws://127.0.0.1:${port}`);
    cleanup.push(() => ws.close());
    cleanup.push(() => gw.close());
    await first;

    const adapter = gw.webchatAdapter();
    await expect(
      adapter.complete({ messages: [{ role: "user", text: "x" }], tools: [] }),
    ).rejects.toThrow(/render timed out/);
  });

  it("answers pings and records adapter_ready announcements", async () => {
    const gw = new WebchatGateway(() => TOOLS, {}, () => {});
    const port = await gw.listen();
    const { ws, first } = await connect(`ws://127.0.0.1:${port}`);
    cleanup.push(() => ws.close());
    cleanup.push(() => gw.close());
    await first; // capabilities

    // A bare socket is not readiness — only an explicit announcement is.
    expect(gw.hasReadyAdapter()).toBe(false);
    ws.send(JSON.stringify({ type: "adapter_ready", url: "https://chat.deepseek.com/" }));
    ws.send(JSON.stringify({ type: "ping" }));

    const pong = await nextMessage(ws);
    expect(pong.type).toBe("pong");
    expect(gw.hasReadyAdapter()).toBe(true);
    expect(gw.readyAdapter?.url).toBe("https://chat.deepseek.com/");
  });

  it("complete() without a connected adapter fails with a clear error", async () => {
    const gw = new WebchatGateway(() => TOOLS, {}, () => {});
    const port = await gw.listen();
    cleanup.push(() => gw.close());
    const adapter = gw.webchatAdapter();
    await expect(
      adapter.complete({ messages: [], tools: [] }),
    ).rejects.toThrow(/no webchat adapter connected/);
  });
});
