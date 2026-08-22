import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebchatGateway } from "../src/index.ts";

describe("probe", () => {
  it("raw connectivity", async () => {
    const gw = new WebchatGateway(() => [{ name: "e", description: "" }], {}, (m) =>
      console.log("[gw]", m),
    );
    const port = await gw.listen();
    const events: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = new Promise<void>((res) => ws.on("open", () => { events.push("open"); res(); }));
    ws.on("message", (raw) => events.push("msg:" + String(raw).slice(0, 40)));
    ws.on("error", (e) => events.push("err:" + e.message));
    ws.on("close", () => events.push("closed"));
    await opened;
    await new Promise((r) => setTimeout(r, 500));
    console.log("events:", JSON.stringify(events));
    expect(events.some((e) => e.startsWith("msg:"))).toBe(true);
    gw.close();
  });
});
