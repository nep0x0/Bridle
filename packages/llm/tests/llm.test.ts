import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { openAiCompatAdapter } from "../src/index.ts";

function startMock(respond: () => Record<string, unknown>) {
  const seen: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respond()));
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

describe("openai-compatible adapter", () => {
  let close: (() => void) | undefined;
  afterAll(() => close?.());

  it("maps messages to OpenAI shapes and parses tool_calls back", async () => {
    const mock = await startMock(() => ({
      choices: [
        {
          message: {
            content: "doing it",
            tool_calls: [
              {
                id: "c1",
                function: { name: "add", arguments: '{"a":2,"b":3}' },
              },
              // malformed arguments must degrade to {}, never throw
              { id: "c2", function: { name: "bad", arguments: "{oops" } },
            ],
          },
        },
      ],
    }));
    close = mock.close;

    const adapter = openAiCompatAdapter({
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
    });
    const out = await adapter.complete({
      messages: [
        { role: "user", text: "q" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c9", name: "t", args: { x: 1 } }],
        },
        { role: "tool", forCallId: "c9", text: "[ok] done" },
      ],
      tools: [{ name: "add", description: "adds" }],
    });

    expect(out.text).toBe("doing it");
    expect(out.toolCalls).toEqual([
      { id: "c1", name: "add", args: { a: 2, b: 3 } },
      { id: "c2", name: "bad", args: {} },
    ]);

    const body = mock.seen[0]!;
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c9" }] });
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c9" });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
    });
  });
});
