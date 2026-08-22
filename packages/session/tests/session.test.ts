import { describe, expect, it, vi } from "vitest";
import {
  SessionLog,
  makeProjector,
  type SessionEvent,
} from "../src/index.ts";

describe("session log", () => {
  it("appends durable events with monotonic ids and notifies", () => {
    const notify = vi.fn();
    const log = new SessionLog(notify);
    const a = log.append("user/message", { text: "hi" });
    const b = log.append("assistant/message", { text: "hello" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0].type).toBe("user/message");
    expect(log.lastId()).toBe(2);
    expect(log.all().length).toBe(2);
  });

  it("since(id) returns only later events", () => {
    const log = new SessionLog();
    log.append("a", {});
    log.append("b", {});
    log.append("c", {});
    expect(log.since(1).map((e) => e.type)).toEqual(["b", "c"]);
  });

  it("derive() projects deterministically from the log alone", () => {
    const log = new SessionLog();
    log.append("noise", 1); // must NOT reach the model
    log.append("user/message", { role: "user", text: "q" });
    log.append("assistant/message", { role: "assistant", text: "a" });
    const project = makeProjector<{ role: string; text: string }>(
      (t) => t.endsWith("/message"),
      (e) => (e.payload as { role: string; text: string }),
    );
    const msgs1 = log.derive(project);
    const msgs2 = log.derive(project);
    expect(msgs1).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
    expect(msgs1).toEqual(msgs2); // replay is deterministic
  });

  it("fork copies a prefix; child is independent", () => {
    const parent = new SessionLog();
    parent.append("user/message", { n: 1 });
    parent.append("assistant/message", { n: 2 });
    parent.append("user/message", { n: 3 });
    const child = parent.fork(undefined, 2); // fork at boundary id=2
    expect(child.all().length).toBe(2);
    expect(child.lastId()).toBe(2);
    // independence both ways
    const extra = child.append("extra", {});
    parent.append("parent-only", {});
    expect(child.all().some((e) => e.type === "parent-only")).toBe(false);
    expect(parent.all().some((e) => e.type === "extra")).toBe(false);
    // ids continue correctly in the child
    expect(extra.id).toBe(3);
  });

  it("returned arrays are defensive copies — the log cannot be mutated", () => {
    const log = new SessionLog();
    log.append("t", { v: 1 });
    const arr = log.all() as SessionEvent[];
    arr.push({ id: 99, type: "hack", ts: 0, payload: {} });
    expect(log.all().length).toBe(1);
    expect(log.all().some((e) => e.type === "hack")).toBe(false);
  });
});
