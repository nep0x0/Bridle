import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createBridle } from "../src/index.ts";

/** Minimal OpenAI-compatible /chat/completions mock with a scripted
 *  response sequence — proves the adapter round-trips tool_calls over
 *  real HTTP without any external API. */
function startMock(script: Array<Record<string, unknown>>) {
  const seen: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body || "{}"));
      const step = script[Math.min(seen.length - 1, script.length - 1)]!;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(step));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({
          url: `http://127.0.0.1:${addr!.port}`,
          seen,
          close: () => server.close(),
        });
      });
    },
  );
}

let close: (() => void) | undefined;
afterAll(() => close?.());

describe("M2 gate: full harness over real HTTP", () => {
  it("tool-call round trip: model asks for math.eval -> executes -> final answer", async () => {
    const mock = await startMock([
      {
        // step 1: the "model" requests a tool call
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "math.eval",
                    arguments: '{"expr": "12*9"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        // step 2: after seeing [ok] 108, answers in prose
        choices: [
          { message: { content: "12*9 is 108." } },
        ],
      },
    ]);
    close = mock.close;

    const bridle = await createBridle({
      llm: { baseUrl: mock.url, apiKey: "test-key", model: "mock-1" },
    });
    const r = await bridle.run("What is 12*9?");
    expect(r.steps).toBe(2);
    expect(r.text).toBe("12*9 is 108.");

    // The second request carried the tool result back to the endpoint.
    const second = mock.seen[1]!;
    const msgs = second.messages as Array<Record<string, unknown>>;
    expect(msgs.at(-1)).toMatchObject({ role: "tool", content: "[ok] 108" });

    // Durable trail exists and ends cleanly.
    const types = bridle.log.all().map((e) => e.type);
    expect(types).toContain("tool/call");
    expect(types).toContain("tool/result");
    expect(types.at(-1)).toBe("turn/end");
  });

  it("builtin tools are registered and usable", async () => {
    const mock = await startMock([
      { choices: [{ message: { content: "ok" } }] },
    ]);
    close = mock.close;
    const bridle = await createBridle({
      llm: { baseUrl: mock.url, apiKey: "k", model: "m" },
    });
    const names = bridle.tools.list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["echo", "now", "math.eval"]));
  });

  it("HTTP errors surface as honest failures", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bridle = await createBridle({
      llm: { baseUrl: url, apiKey: "wrong", model: "m" },
    });
    await expect(bridle.run("hi")).rejects.toThrow(/llm http 401/);
    server.close();
  });
});
