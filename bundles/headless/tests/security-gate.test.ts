/**
 * Headless integration: with `security` mounted, a denied tool call flows
 * back to the model as an honest "Permission denied" tool result — the turn
 * still completes, the model just cannot pretend it executed.
 */
import { describe, expect, it } from "vitest";
import { createBridle } from "../src/index.ts";

describe("M4 gate: createBridle security wiring", () => {
  it("denied execute surfaces as a tool error to the model, not a crash", async () => {
    let renders = 0;
    const bridle = await createBridle({
      maxSteps: 4,
      security: { modes: { read: "allow", write: "deny", execute: "deny" } },
      adapter: {
        async complete(req) {
          renders++;
          if (renders === 1) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "math.eval", args: { expr: "12*9" } }],
            };
          }
          const toolMsg = req.messages.findLast((m) => m.role === "tool");
          expect(String(toolMsg?.text)).toMatch(/^(\[error\] )?Permission denied:/);
          return { text: "I could not run the math tool — permission denied.", toolCalls: [] };
        },
      },
    });

    const res = await bridle.run("What is 12*9?");
    expect(res.rejected).toBeUndefined();
    expect(res.steps).toBe(2);
    expect(res.text).toBe("I could not run the math tool — permission denied.");

    const result = bridle.log.all().find((e) => e.type === "tool/result");
    const p = result!.payload as { ok: boolean; text: string };
    expect(p.ok).toBe(false);
    expect(p.text).toMatch(/^Permission denied:/);

    // durable audit trail exists alongside the model-visible events
    const types = bridle.log.all().map((e) => e.type);
    expect(types).toContain("audit/gate");
  });
});
