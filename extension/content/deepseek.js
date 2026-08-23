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

  // Completion tuning (ms). Two hard-won facts shape these numbers:
  //  1. DeepSeek's REASONING phase can run for minutes BEFORE any answer
  //     markdown mounts (.ds-markdown outside .ds-think-content) — the old
  //     45s warmup kept dying mid-think. We now wait for page PROGRESS
  //     instead: any growth of the conversation tail proves the model is
  //     alive, and only a fully quiet page gives up early.
  //  2. A reply counts as done when the newest visible markdown has been
  //     UNCHANGED for idleMs AND no stop-glyph is showing. Streaming pauses
  //     >2s mid-code-block were seen live (cost us a truncated tool call:
  //     final text ended at "part.B"), hence idleMs=3500 PLUS the
  //     wire-truncation guard below.
  const TIMINGS = {
    pollMs: 250,
    idleMs: 3500,
    warmupMs: 240_000,      // deep-think sessions legitimately run minutes
    progressIdleMs: 90_000, // ZS REASON_NOREPLY_MS: reasoning can stall minutes
    overallMs: 260_000,     // stays under worker 280s / gateway 300s
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Wire-aware truncation guard: if the tail looks like an UNFINISHED tool
   *  envelope (ours, or a bare one), the reply is definitionally still
   *  streaming no matter how long the pause felt. */
  function looksTruncated(text) {
    // v3: deteksi envelope di SELURUH teks — kode Luau yang panjang bisa
    // mendorong pembuka `{"name":` jauh dari 500 karakter terakhir
    // (gagal live: jawaban terpotong di tengah string kode).
    const trimmed = text.trimEnd();
    const hasEnvelope = /("(?:name|calls)"\s*:)|(\bbridle-tool\b)/i.test(trimmed);
    if (!hasEnvelope) return false;
    // Toleransi caption UI kecil setelah kurung penutup ("Salin", "Unduh", "Copy").
    return !/\}\s*(?:[A-Za-z]{0,12}\s*)?$/.test(trimmed);
  }

  // ── reading the page ──────────────────────────────────────────────────

  /** All assistant markdown blocks on the page, reasoning excluded. */
  function markdownBlocks() {
    return [...document.querySelectorAll(SEL.markdown)].filter(
      (m) => !m.closest(SEL.thinking),
    );
  }

  function blockText(m) {
    // innerText (bukan textContent): mempertahankan line-break hasil render
    // Markdown — jawaban final tidak lagi jadi satu baris gepeng.
    return m ? (m.innerText || "").trim() : "";
  }

  /** Text of the NEWEST assistant reply (used as the completion signal). */
  function newestReplyText() {
    const blocks = markdownBlocks();
    return blockText(blocks[blocks.length - 1]);
  }

  /** Cheap "is anything growing?" signature for the reasoning-tolerant
   *  warmup: conversation item count + tail item's text length. */
  function activitySignature() {
    const items = document.querySelectorAll(SEL.item);
    const last = items[items.length - 1];
    return {
      items: items.length,
      tailLen: last ? (last.innerText || "").length : 0,
    };
  }

  /** Tunggu balasan selesai — sadar-fase, ala mekanisme ZS:
   *  FASE REASONING : kontainer think tumbuh → dianggap hidup, tanpa tekanan.
   *  FASE JAWABAN   : markdown non-think baru muncul → selesai bila teks
   *                   tak berubah idleMs DAN tidak ada indikator generate.
   *  Halaman diam total ≥ progressIdleMs tanpa jawaban ⇒ gagal jujur. */
  async function waitForReply(baselineAnswerText, deadline) {
    const startedAt = Date.now();
    let sig = activitySignature();
    let lastProgressAt = startedAt;
    let announcedReasoning = false;
    let prevAnswer = "";
    let stableSince = 0;

    const answerNow = () => {
      const blocks = markdownBlocks();
      return blocks.length ? blockText(blocks[blocks.length - 1]) : "";
    };

    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `reply not settled within ${Math.round(TIMINGS.warmupMs / 1000)}s ` +
            `(model bisa masih reasoning — coba lagi / chat baru); ` +
            `aktivitas terakhir ${new Date(lastProgressAt).toISOString().slice(11, 19)}`,
        );
      }
      await sleep(TIMINGS.pollMs);

      const answer = answerNow();
      const cur = activitySignature();

      // ── fase jawaban ──────────────────────────────────────────────────
      if (answer) {
        if (answer !== prevAnswer || looksTruncated(answer)) {
          prevAnswer = answer;
          stableSince = Date.now(); // masih mengalir — reset jendela stabil
        } else if (
          stableSince &&
          Date.now() - stableSince >= TIMINGS.idleMs &&
          !generatingVisible()
        ) {
          return prev; // selesai
        }
        if (!prevAnswer) prevAnswer = answer;
        continue;
      }

      // ── fase reasoning / belum ada jawaban ────────────────────────────
      if (cur.items !== sig.items || cur.tailLen !== sig.tailLen) {
        lastProgressAt = Date.now();
        if (!announcedReasoning && cur.tailLen > 0) {
          announcedReasoning = true;
          console.info("[bridle] model sedang menulis (reasoning?) …");
        }
      }
      sig = cur;
      if (Date.now() - lastProgressAt > TIMINGS.progressIdleMs) {
        throw new Error(
          `halaman diam ${Math.round(TIMINGS.progressIdleMs / 1000)}s tanpa jawaban`,
        );
      }
    }
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
    // Guard against wrong-tab renders (seen live: a stray tab on another
    // DeepSeek host grabbed the port and hung the harness). Fail fast and
    // honestly instead of stalling 175s.
    if (!/(^|\.)chat\.deepseek\.com$/.test(location.hostname)) {
      throw new Error(
        `this tab (${location.host}) is not a supported chat surface — open chat.deepseek.com`,
      );
    }
    const outgoing = composeOutgoing(messages, tools);
    const startedAt = Date.now();
    const deadline = startedAt + TIMINGS.overallMs; // shared by both phases
    const baselineCount = markdownBlocks().length;

    ensureDeepThinking(); // Expert/"Pakar" before the first send of a chat
    insertText(outgoing);
    await sleep(50); // let React settle before clicking
    clickSend();

    await waitForReply(baselineCount, deadline);
    const raw = newestReplyText();
    if (!raw) throw new Error("balasan kosong saat deadline");
    console.info(
      `[bridle] reply captured (${raw.length} chars): ${raw.slice(0, 120).replace(/\n/g, " ")}`,
    );
    const parsed = Wire.parseToolCalls(raw);

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

  // ── port wiring (resilient) ───────────────────────────────────────────
  //
  // The MV3 service worker gets suspended when idle; when it does, our
  // runtime port dies with it. Without a retry loop the adapter would die
  // silently and every render would fail with "no chat tab". Reconnect with
  // backoff; stop only when the extension context itself is invalidated
  // (extension reloaded → only a page reload helps — say so honestly).

  let port = null;
  let retryTimer = null;
  let busy = false;

  function attachPort(attempt = 0) {
    try {
      port = chrome.runtime.connect({ name: "bridle-adapter" });
      console.info("[bridle] adapter ready on", location.host);
      attempt = 0;

      port.onDisconnect.addListener(() => {
        console.warn("[bridle] port lost (service worker recycled?) — reconnecting …");
        clearTimeout(retryTimer);
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        retryTimer = setTimeout(() => attachPort(attempt + 1), delay);
      });

      port.onMessage.addListener((m) => {
        if (m?.type === "status") {
          renderStatus(m);
          return;
        }
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
    } catch (e) {
      console.warn(
        "[bridle] cannot reach the extension context (was it reloaded or updated?)",
        "— RELOAD THIS PAGE to pick it back up. Detail:", e?.message,
      );
    }
  }

  attachPort();

  // Anchoring pass for the in-flow status bar: survives SPA re-renders that
  // detach or re-home the composer (same idea as ZS's per-frame placeBar,
  // at a calmer cadence).
  placeStatus();
  setInterval(placeStatus, 600);
})();
