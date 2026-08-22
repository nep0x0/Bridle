// bridle bridge — tool wire format (shared by every content adapter).
//
// Web chats have no native function-calling channel, so tool calls travel
// INSIDE the assistant's ordinary reply text:
//
//   ```bridle-tool
//   {"name": "math.eval", "args": {"expr": "12*9"}}
//   ```
//
// A reply may carry several calls via the envelope {"calls":[...]}. CRITICAL
// DOM fact: rendered code blocks LOSE their ``` fences (markdown syntax is
// never part of textContent), so the parser must recognise the BARE JSON
// envelope too — keyed on the string-valued "name"/"calls" key, the same
// trick ZeroScript uses when it keys on "command". Prose almost never
// contains that shape; unparseable bare candidates are treated as prose.
//
// Results are fed back wrapped in ⟦TOOL ok|error name⟧…⟦/TOOL⟧.
//
// This file is deliberately DOM-free and chrome.*-free so the exact shipped
// parser is unit-testable in Node (side-effect import sets globalThis.BridleWire).
//
// Provenance: clean-room original expression. The *concepts* of carrying
// commands through fenced blocks and keying on the JSON envelope shape were
// adopted from ZeroScript-Free (GPL-3.0); no source lines were taken from it.
//
// SPDX-License-Identifier: GPL-3.0-or-later

globalThis.BridleWire = (() => {
  "use strict";

  const FENCE_RE = /```[ \t]*bridle-tool[ \t]*\r?\n?([\s\S]*?)(?:```|$)/gi;
  // Some sites bleed UI chrome (a language token or a "Copy" caption) into a
  // block's first line; drop exactly one such leading token before JSON.parse.
  const CHROME_RE = /^(?:json|copy|javascript|js)\s+/i;
  const BARE_START_RE = /\{\s*"(?:name|calls)"\s*:/g;
  // A fence's language token can survive rendering as a lone line.
  const LONE_LANG_TOKEN_RE = /^[ \t]*bridle-tool[ \t]*$/gim;

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

  /** Walk a balanced {...} object starting at `start` (string-aware).
   *  Returns the candidate substring, or null when unbalanced. */
  function extractBalancedJson(text, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Parse reply text → { text, toolCalls, errors }.
   *  text = reply minus recognized payloads (honest display remainder);
   *  errors = per-block reasons — never thrown. */
  function parseToolCalls(reply) {
    const toolCalls = [];
    const errors = [];
    let body = String(reply ?? "");

    // Validates one candidate payload; pushes calls/errors. Returns true when
    // consumed (recognized shape). Bare candidates that fail JSON.parse are
    // prose lookalikes: not consumed, not reported.
    function consume(raw, reportMalformed) {
      let candidate = String(raw ?? "").trim();
      candidate = candidate.replace(CHROME_RE, "").trim();
      let obj;
      try {
        obj = JSON.parse(candidate);
      } catch (e) {
        if (reportMalformed) errors.push(`invalid JSON: ${e.message}`);
        return reportMalformed;
      }
      if (Array.isArray(obj?.calls)) {
        for (const c of obj.calls) {
          if (c && typeof c.name === "string" && c.name) {
            toolCalls.push({ name: c.name, args: c.args ?? {} });
          } else {
            errors.push('call entry missing "name"');
          }
        }
        return true;
      }
      if (obj && typeof obj.name === "string" && obj.name) {
        toolCalls.push({ name: obj.name, args: obj.args ?? {} });
        return true;
      }
      errors.push('block has neither "name" nor "calls"');
      return true;
    }

    // 1) fenced blocks (survive only in plain-text contexts)
    FENCE_RE.lastIndex = 0;
    body = body.replace(FENCE_RE, (_m, inner) => {
      consume(inner, true);
      return "";
    });

    // 2) bare envelopes (fences lost to DOM rendering)
    const eaten = [];
    BARE_START_RE.lastIndex = 0;
    let m;
    while ((m = BARE_START_RE.exec(body))) {
      const candidate = extractBalancedJson(body, m.index);
      if (!candidate) continue;
      if (consume(candidate, false)) {
        eaten.push([m.index, m.index + candidate.length]);
        BARE_START_RE.lastIndex = m.index + candidate.length;
      }
    }
    if (eaten.length) {
      let out = "";
      let pos = 0;
      for (const [a, b] of eaten) {
        out += body.slice(pos, a);
        pos = b;
      }
      body = out + body.slice(pos);
    }

    // 3) stray language token line + collapsed leftover blank lines
    body = body.replace(LONE_LANG_TOKEN_RE, "");
    body = body.replace(/\n{3,}/g, "\n\n");

    return { text: body.trim(), toolCalls, errors };
  }

  /** Render one tool result the way the adapter feeds it back into the chat. */
  function encodeToolResult(name, ok, text) {
    const tag = ok ? "ok" : "error";
    return `⟦TOOL ${tag} ${name}⟧${String(text ?? "")}⟦/TOOL⟧`;
  }

  return { encodeToolDirective, parseToolCalls, encodeToolResult };
})();
