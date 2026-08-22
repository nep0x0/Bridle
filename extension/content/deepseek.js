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
    warmupMs: 150_000,      // absolute cap for "no answer block yet"
    progressIdleMs: 45_000, // page totally quiet this long ⇒ something broke
    overallMs: 165_000,     // stays under the worker's 175s watchdog
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Wire-aware truncation guard: if the tail looks like an UNFINISHED tool
   *  envelope (ours, or a bare one), the reply is definitionally still
   *  streaming no matter how long the pause felt. */
  function looksTruncated(text) {
    const trimmed = text.trimEnd();
    const tail = trimmed.slice(-500);
    if (/(\{\s*"?\s*(?:name|calls)"?\s*:?|\bbridle-tool\b)/i.test(tail)) {
      return !/\}\s*$/.test(trimmed);
    }
    return false;
  }

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

  /** Cheap "is anything growing?" signature for the reasoning-tolerant
   *  warmup: conversation item count + tail item's text length. */
  function activitySignature() {
    const items = document.querySelectorAll(SEL.item);
    const last = items[items.length - 1];
    return {
      items: items.length,
      tailLen: last ? (last.textContent || "").length : 0,
    };
  }

  /** Wait until a NEW answer block exists. Reasoning-tolerant: page progress
   *  (item growth) keeps resetting the give-up timer; only a page that is
   *  both quiet AND answerless for progressIdleMs fails early. */
  async function waitForNewReply(baselineCount, deadline) {
    const startedAt = Date.now();
    let sig = activitySignature();
    let lastProgressAt = startedAt;
    let announced = false;
    while (markdownBlocks().length <= baselineCount) {
      if (Date.now() > deadline) {
        throw new Error(
          `no answer block within ${Math.round(TIMINGS.warmupMs / 1000)}s ` +
            `(reasoning can be slow — try a fresh chat)`,
        );
      }
      const cur = activitySignature();
      if (cur.items !== sig.items || cur.tailLen !== sig.tailLen) {
        lastProgressAt = Date.now();
        if (!announced && cur.tailLen > 0) {
          announced = true;
          console.info("[bridle] model is generating (possibly reasoning) …");
        }
      }
      sig = cur;
      if (Date.now() - lastProgressAt > TIMINGS.progressIdleMs) {
        throw new Error(
          `page went quiet for ${Math.round(TIMINGS.progressIdleMs / 1000)}s without an answer block`,
        );
      }
      await sleep(TIMINGS.pollMs);
    }
  }

  /** Heuristic "still generating" probe, multi-signal:
   *    - .ds-loading overlay present
   *    - primary button carries a stop-ish glyph (rect shape / M2-path) or a
   *      stop-labelled aria/title (locale-tolerant)
   *  Combined with the stability window + truncation guard so ANY single
   *  selector miss degrades to slower-but-correct, never wrong. */
  function generatingVisible() {
    if (document.querySelector(SEL.generating)) return true;
    const btn = document.querySelector(SEL.sendBtn);
    if (!btn) return false;
    const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("title") ?? ""}`.toLowerCase();
    if (/stop|berhenti|停止/.test(label)) return true;
    const shape = btn.querySelector("svg rect, svg path");
    const d = shape?.getAttribute("d") || "";
    return Boolean(btn.querySelector("svg rect") || d.startsWith("M2"));
  }

  // ── status bar (in-flow above the composer, ZS-style placement) ───────
  //
  // Placement strategy adopted from ZeroScript's core/main.js placeBar():
  // find the lowest ancestor of the textarea that CONTAINS the send button
  // but NOT the model-mode tabs — that is the rounded input box itself — and
  // live there as its first child (full width, reflows cleanly). A periodic
  // anchoring pass self-heals after SPA re-renders.

  const BAR_ID = "bridle-status-bar";

  // LATCHED mount (ZS does the same for its Vision selection): once a
  // conversation starts, DeepSeek REMOVES the mode radiogroup from the DOM,
  // so the "no tabs" constraint vanishes and a fresh climb would land in a
  // tiny button row — squashing the bar. Latch the first good box and reuse
  // it while it stays connected and still contains the editor.
  let latchedParent = null; // Element | null

  /** Lowest textarea ancestor holding the send button but no mode tabs. */
  function barMount() {
    let ta;
    try {
      ta = getEditor();
    } catch {
      return null;
    }
    if (!ta) return null;

    if (
      latchedParent &&
      latchedParent.isConnected &&
      latchedParent.contains(ta)
    ) {
      let before = latchedParent.firstElementChild;
      if (before && before.id === BAR_ID) before = before.nextElementSibling;
      return { parent: latchedParent, before };
    }

    const send = document.querySelector(SEL.sendBtn);
    const group = document.querySelector('[role="radiogroup"]');
    let box = ta.parentElement;
    while (box && box !== document.body) {
      const holdsSend = !send || box.contains(send);
      const holdsTabs = group && box.contains(group);
      if (holdsSend && !holdsTabs) break;
      box = box.parentElement;
    }
    if (!box || box === document.body) box = ta.parentElement;
    if (!box) return null;
    latchedParent = box; // latch
    let before = box.firstElementChild;
    if (before && before.id === BAR_ID) before = before.nextElementSibling;
    return { parent: box, before };
  }

  /** One anchoring pass: create if missing, re-home if re-rendered away.
   *  Visual contract (copied from ZS's zs-bar-inside): TRANSPARENT, no own
   *  radius — it blends as a top strip of the rounded composer with only a
   *  subtle bottom hairline; padding matches the input's text inset. */
  function placeStatus() {
    const mount = barMount();
    if (!mount) return;
    let bar = document.getElementById(BAR_ID);
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.style.cssText = [
        "width:100%", "box-sizing:border-box",
        "flex-shrink:0", "min-height:26px",
        "margin:0 0 6px 0",
        "display:flex", "gap:10px", "align-items:center",
        "padding:4px 14px 8px",
        "background:transparent", "border:none",
        "border-bottom:1px solid #ffffff14", "border-radius:0",
        "color:#d7e3ff", "font:600 12px/1.4 system-ui,sans-serif",
        "pointer-events:none", "white-space:nowrap",
      ].join(";");
      mount.parent.insertBefore(bar, mount.before ?? null);
      return; // content painted by the next renderStatus tick
    }
    if (bar.parentElement !== mount.parent) {
      try {
        mount.parent.insertBefore(bar, mount.before ?? null);
      } catch { /* transient SPA churn */ }
    }
  }

  function renderStatus(s) {
    lastStatusRendered = s;
    placeStatus();
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    const dot = (on) =>
      `<span style="width:8px;height:8px;border-radius:50%;background:${on ? "#38d17c" : "#5a6478"};display:inline-block"></span>`;
    const tools =
      typeof s.tools === "number" && s.tools > 0 ? `${s.tools} tools` : "no tools";
    bar.innerHTML =
      `<span style="letter-spacing:.4px">BRIDLE</span>` +
      `<span style="display:flex;gap:4px;align-items:center">${dot(s.gateway)} gateway</span>` +
      `<span>${tools}</span>` +
      `<span style="display:flex;gap:4px;align-items:center">${dot(s.adapters > 0)} chat tab</span>`;
  }

  // ── composer mode: pick Expert/"Pakar" so the brain actually thinks ────
  //
  // DeepSeek V4 model radios carry data-model-type ("default"=Instant,
  // "expert", "vision"); older builds used a separate DeepThink toggle.
  // Radios DISAPPEAR once a conversation starts — this runs before every
  // send, silently doing nothing when they are already gone.

  const nodeText = (n) => ((n && (n.innerText || n.textContent)) || "").trim();

  function ensureDeepThinking() {
    const group = document.querySelector('[role="radiogroup"]');
    const radios = group
      ? [...group.querySelectorAll('[role="radio"]')]
      : [...document.querySelectorAll('[role="radio"]')];
    const expert =
      radios.find((r) => r.getAttribute("data-model-type") === "expert") ||
      radios.find((r) => /pakar|expert|专家|专业/i.test(nodeText(r)));
    if (expert) {
      if (expert.getAttribute("aria-checked") !== "true") {
        try {
          expert.click();
          console.info("[bridle] composer mode -> expert");
        } catch { /* best effort */ }
      }
      return;
    }
    // Legacy fallback: a separate DeepThink toggle.
    const tg = [...document.querySelectorAll(".ds-toggle-button")].find((t) =>
      /deep\s*think|deepthink|pikir/i.test(nodeText(t)),
    );
    const off =
      tg &&
      (tg.getAttribute("aria-pressed") === "false" ||
        !tg.classList.contains("ds-toggle-button--selected"));
    if (tg && off) {
      try {
        tg.click();
        console.info("[bridle] legacy DeepThink toggled ON");
      } catch { /* best effort */ }
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
    const outgoing = composeOutgoing(messages, tools);
    const startedAt = Date.now();
    const deadline = startedAt + TIMINGS.overallMs; // shared by both phases
    const baselineCount = markdownBlocks().length;

    ensureDeepThinking(); // Expert/"Pakar" before the first send of a chat
    insertText(outgoing);
    await sleep(50); // let React settle before clicking
    clickSend();

    await waitForNewReply(baselineCount, deadline);

    let prev = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(TIMINGS.pollMs);
      const t = newestReplyText();
      if (t && t === prev && !looksTruncated(t)) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= TIMINGS.idleMs && !generatingVisible()) break;
        // looksTruncated ⇒ deliberately fall through: still streaming.
      } else {
        prev = t;
        stableSince = 0;
      }
    }
    if (!prev) throw new Error("reply stayed empty until the deadline");
    if (looksTruncated(prev)) {
      console.warn("[bridle] deadline hit while the tool envelope still looked unfinished");
    }
    console.info(`[bridle] reply captured (${prev.length} chars): ${prev.slice(0, 120).replace(/\n/g, " ")}`);

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
