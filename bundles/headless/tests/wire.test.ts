/**
 * Unit tests for the SHIPPED extension wire parser
 * (extension/content/bridle-wire.js, side-effect import — no copy).
 *
 * The bare-envelope cases are the important ones: rendered code blocks lose
 * their ``` fences in DOM textContent, so the parser MUST find the JSON
 * envelope without them (the live DeepSeek failure that motivated this).
 */
import { describe, expect, it } from "vitest";
import "../../../extension/content/bridle-wire.js";

type Frame = Record<string, any>;
const Wire = () => (globalThis as { BridleWire?: any }).BridleWire!;

describe("bridle wire format (shipped file)", () => {
  it("parses a fenced single call and strips the whole block", () => {
    const r = Wire().parseToolCalls(
      'Sure.\n\n```bridle-tool\n{"name":"math.eval","args":{"expr":"12*9"}}\n```\nDone.',
    );
    expect(r.toolCalls).toEqual([{ name: "math.eval", args: { expr: "12*9" } }]);
    expect(r.text).toBe("Sure.\n\nDone.");
    expect(r.errors).toEqual([]);
  });

  it("parses a BARE envelope whose fences were lost to DOM rendering", () => {
    const r = Wire().parseToolCalls(
      'We need answer user asks. Need run tool.\nbridle-tool\n{"name":"math.eval","args":{"expr":"12*9"}}\nThen wait.',
    );
    expect(r.toolCalls).toEqual([{ name: "math.eval", args: { expr: "12*9" } }]);
    expect(r.errors).toEqual([]);
  });

  it("parses the calls envelope with several calls", () => {
    const r = Wire().parseToolCalls('{"calls":[{"name":"a","args":{}},{"name":"b","args":{"x":1}}]}');
    expect(r.toolCalls.map((c: Frame) => c.name)).toEqual(["a", "b"]);
  });

  it("reports a malformed fenced block honestly", () => {
    const r = Wire().parseToolCalls("```bridle-tool\n{nope\n```");
    expect(r.toolCalls).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/invalid JSON/);
  });

  it("never fires on prose that merely contains braces", () => {
    const r = Wire().parseToolCalls('a {curly} thing and {"other": 1} stays untouched');
    expect(r.toolCalls).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('{"other": 1}');
  });

  it("encodes tool results for the chat loop", () => {
    expect(Wire().encodeToolResult("math.eval", true, "108")).toBe("⟦TOOL ok math.eval⟧108⟦/TOOL⟧");
    expect(Wire().encodeToolResult("x", false, "boom")).toBe("⟦TOOL error x⟧boom⟦/TOOL⟧");
  });
});
