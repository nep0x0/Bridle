// bridle bridge — tool wire format (shared by every content adapter).
//
// Web chats have no native function-calling channel, so tool calls travel
// INSIDE the assistant's ordinary reply text as a fenced code block:
//
//   ```bridle-tool
//   {"name": "math.eval", "args": {"expr": "12*9"}}
//   ```
//
// A reply may carry at most ONE block; multi-call replies use the envelope:
//
//   ```bridle-tool
//   {"calls": [{"name": "a", "args": {}}, {"name": "b", "args": {}}]}
//   ```
//
// This file is deliberately DOM-free and chrome.*-free so the exact shipped
// parser is unit-testable in Node (side-effect import sets globalThis.BridleWire).
//
// Provenance: clean-room original expression. The *concept* of carrying
// commands through fenced blocks that a page script parses was adopted from
// ZeroScript-Free (GPL-3.0); no source lines were taken from it.
//
// SPDX-License-Identifier: GPL-3.0-or-later

globalThis.BridleWire = (() => {
  "use strict";

  const FENCE_RE = /```[ \t]*bridle-tool[ \t]*\r?\n?([\s\S]*?)(?:```|$)/gi;
  // Some sites bleed UI chrome (a language token or a "Copy" caption) into the
  // block's first line; drop exactly one such leading token before JSON.parse.
  const CHROME_RE = /^(?:json|copy|javascript|js)\s+/i;

  /** Build the directive appended to the last user message when tools exist.
   *  Kept intentionally small: web-chat context is expensive. */
  function encodeToolDirective(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return "";
    const lines = tools.map((t) => {
      const params = t.params ? Object.keys(t.params).join(", ") : "";
      return `- ${t.name}(${params}) — ${(t.description || "").split("\n")[0].trim()}`;
    });
    return [
      "",
      "⟦BRIDLE-TOOLS⟧ You are connected to a local tool bridge on the user's machine.",
      "To run a tool, reply with exactly one fenced block and nothing else in it:",
      "```bridle-tool",
      '{"name":"tool_name","args":{"param":"value"}}',
      "```",
      "The result comes back to you as the next user message wrapped in ⟦TOOL⟧…⟦/TOOL⟧.",
      "One block per reply; wait for its result before the next call.",
      "When the task is done, answer normally WITHOUT any bridle-tool block.",
      "Available tools:",
      ...lines,
    ].join("\n");
  }

  /** Parse reply text → { text, toolCalls, errors }.
   *  text = reply minus the bridle-tool fences (honest display remainder);
   *  errors = per-block reasons (malformed JSON etc.) — never thrown. */
  function parseToolCalls(reply) {
    const toolCalls = [];
    const errors = [];
    let body = String(reply ?? "");
    FENCE_RE.lastIndex = 0;
    body = body.replace(FENCE_RE, (_m, inner) => {
      let raw = String(inner ?? "").trim();
      raw = raw.replace(CHROME_RE, "").trim();
      try {
        const obj = JSON.parse(raw);
        if (Array.isArray(obj?.calls)) {
          for (const c of obj.calls) {
            if (c && typeof c.name === "string" && c.name) {
              toolCalls.push({ name: c.name, args: c.args ?? {} });
            } else {
              errors.push("call entry missing \"name\"");
            }
          }
        } else if (obj && typeof obj.name === "string" && obj.name) {
          toolCalls.push({ id: undefined, name: obj.name, args: obj.args ?? {} });
        } else {
          errors.push("block has neither \"name\" nor \"calls\"");
        }
      } catch (e) {
        errors.push(`invalid JSON: ${e.message}`);
      }
      return ""; // strip the whole fence from the display text
    });
    return { text: body.trim(), toolCalls, errors };
  }

  /** Render one tool result the way the adapter feeds it back into the chat. */
  function encodeToolResult(name, ok, text) {
    const tag = ok ? "ok" : "error";
    return `⟦TOOL ${tag} ${name}⟧${String(text ?? "")}⟦/TOOL⟧`;
  }

  return { encodeToolDirective, parseToolCalls, encodeToolResult };
})();
