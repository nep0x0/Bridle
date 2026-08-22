// bridle bridge — DeepSeek (chat.deepseek.com) content adapter.
//
// Speaks the port protocol with the service worker:
//   ← {type:"render_request", id, messages, tools}
//   → {type:"adapter_result", id, ok, text, toolCalls?, error?}
//
// One turn of the harness becomes: compose chat text → type it into the
// composer → send → wait for the reply to finish → read its text → parse
// tool calls (BridleWire) → answer.
//
// DeepSeek DOM facts this relies on (re-validate after site deploys):
//   - turns are .ds-message items; assistant bodies live in .ds-markdown;
//     reasoning drafts live in .ds-think-content and MUST be ignored
//   - the composer is a plain <textarea>; set value via the native setter
//     + input event, then click .ds-button--primary
//
// Provenance: clean-room original expression; the *concept* of a per-site DOM
// adapter with stability-window completion detection was adopted from
// ZeroScript-Free (GPL-3.0). No source lines were taken.
//
// SPDX-License-Identifier: GPL-3.0-or-later

(() => {
  "use strict";
  const Wire = globalThis.BridleWire;

  const SEL = {
    item: ".ds-message",
    markdown: ".ds-markdown",
    thinking: ".ds-think-content",
    editor: "textarea",
    sendBtn: ".ds-button--primary",
  };

  // Completion tuning (ms): a reply counts as done when the newest visible
  // markdown has been UNCHANGED for idleMs AND no stop-glyph is showing.
  // Streaming replies dip for seconds mid-generation, hence the long idle bar.
  const TIMINGS = {
    pollMs: 250,
    idleMs: 1500,
    warmupMs: 45_000, // empty turn container may precede the first token
    timeoutMs: 170_000,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── reading the page ──────────────────────────────────────────────────

  /** All assistant markdown blocks on the page, reasoning excluded. */
  function markdownBlocks() {
    return [...document.querySelectorAll(SEL.markdown)].filter(
      (m) => !m.closest(SEL.thinking),
    );
  }

  function blockText(m) {
    return m ? (m.textContent || "").trim() : "";
  }

  /** Text of the NEWEST assistant reply (used as the completion signal). */
  function newestReplyText() {
    const blocks = markdownBlocks();
    return blockText(blocks[blocks.length - 1]);
  }

  /** Heuristic stop-glyph probe: while streaming, the primary footer button
   *  shows a square/stop shape instead of the send arrow. Combined with the
   *  stability window so a selector miss degrades to slower-but-correct. */
  function stopGlyphVisible() {
    const btn = document.querySelector(SEL.sendBtn);
    if (!btn) return false;
    const shape = btn.querySelector("svg rect, svg path");
    const d = shape?.getAttribute("d") || "";
    return Boolean(btn.querySelector("svg rect") || d.startsWith("M2"));
  }

  // ── writing the page ──────────────────────────────────────────────────

  function getEditor() {
    const box = document.querySelector(SEL.editor);
    if (!box) throw new Error("DeepSeek composer textarea not found");
    return box;
  }

  function insertText(text) {
    const editor = getEditor();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(editor, text);
    else editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function clickSend() {
    const btn = [...document.querySelectorAll(SEL.sendBtn)].find(
      (b) => !b.disabled && b.offsetParent !== null,
    );
    if (btn) {
      btn.click();
      return;
    }
    // fallback: Enter on the composer
    const editor = getEditor();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
  }

  // ── composing the outgoing message ────────────────────────────────────

  /** MVP conversation policy: the SITE thread already holds every earlier
   *  turn, so we only inject what is NEW since our previous render — i.e.
   *  everything after the last assistant message in the derived history.
   *  (A full-history re-send would duplicate the thread on the page.) */
  function composeOutgoing(messages, tools) {
    let lastAssistant = -1;
    messages.forEach((m, i) => {
      if (m.role === "assistant") lastAssistant = i;
    });
    const fresh = messages.slice(lastAssistant + 1);
    if (fresh.length === 0) {
      throw new Error("render_request contained no new messages since the last assistant turn");
    }
    const parts = [];
    for (const m of fresh) {
      if (m.role === "user") parts.push(String(m.text ?? ""));
      else if (m.role === "tool")
        parts.push(Wire.encodeToolResult(m.forCallId ?? "?", /^\[ok\]/.test(m.text ?? ""), m.text));
      // role==="assistant" never appears in `fresh` by construction
    }
    let out = parts.join("\n\n");
    const last = fresh[fresh.length - 1];
    if (last.role === "user" && Array.isArray(tools) && tools.length > 0) {
      out += Wire.encodeToolDirective(tools);
    }
    return out;
  }

  // ── one render ────────────────────────────────────────────────────────

  async function render(messages, tools) {
    const outgoing = composeOutgoing(messages, tools);
    const baselineCount = markdownBlocks().length;

    insertText(outgoing);
    await sleep(50); // let React settle before clicking
    clickSend();

    // Wait for a NEW reply block to appear (warmup), then for it to go quiet.
    const startedAt = Date.now();
    const warmDeadline = startedAt + TIMINGS.warmupMs;
    while (markdownBlocks().length <= baselineCount) {
      if (Date.now() > warmDeadline) {
        throw new Error(`no reply appeared within ${TIMINGS.warmupMs}ms`);
      }
      await sleep(TIMINGS.pollMs);
    }

    let prev = "";
    let stableSince = 0;
    const deadline = Date.now() + TIMINGS.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(TIMINGS.pollMs);
      const t = newestReplyText();
      if (t && t === prev) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= TIMINGS.idleMs && !stopGlyphVisible()) break;
      } else {
        prev = t;
        stableSince = 0;
      }
    }
    if (!prev) throw new Error("reply stayed empty until the deadline");

    const parsed = Wire.parseToolCalls(prev);
    return {
      ok: true,
      text: parsed.text,
      toolCalls: parsed.toolCalls.map((tc, i) => ({
        id: `web_${Date.now()}_${i}`,
        name: tc.name,
        args: tc.args,
      })),
      ...(parsed.errors.length ? { error: parsed.errors.join("; ") } : {}),
    };
  }

  // ── port wiring ───────────────────────────────────────────────────────

  const port = chrome.runtime.connect({ name: "bridle-adapter" });
  let busy = false;

  port.onMessage.addListener((m) => {
    if (m?.type !== "render_request") return;
    if (busy) {
      port.postMessage({
        type: "adapter_result",
        id: m.id,
        ok: false,
        text: "",
        toolCalls: [],
        error: "adapter busy with another render",
      });
      return;
    }
    busy = true;
    render(m.messages ?? [], m.tools ?? [])
      .then((r) => port.postMessage({ type: "adapter_result", id: m.id, ...r }))
      .catch((e) =>
        port.postMessage({
          type: "adapter_result",
          id: m.id,
          ok: false,
          text: "",
          toolCalls: [],
          error: String(e?.message ?? e),
        }),
      )
      .finally(() => {
        busy = false;
      });
  });

  console.info("[bridle] adapter ready on", location.host);
})();
