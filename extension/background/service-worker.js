// bridle bridge — service worker.
//
// Owns the ONE WebSocket to the local gateway (@bridle/gateway-ws) and relays
// render_request/render_result between it and content adapters over runtime
// ports. Keeping the socket here avoids mixed-content issues inside https
// chat pages and centralises reconnect logic, exactly like a real adapter
// should: the page never talks to the network itself.
//
// Protocol (gateway ⇄ this worker), JSON frames:
//   ← {type:"capabilities", tools:[...]}        (pushed on connect)
//   → {type:"render_result", id, ok, text, toolCalls?, error?}
//   ← {type:"render_request", id, messages, tools}
//
// Port protocol (worker ⇄ content script):
//   port name "bridle-adapter"
//   → {type:"render_request", id, messages, tools}
//   ← {type:"adapter_result", id, ok, text, toolCalls?, error?}
//
// SPDX-License-Identifier: GPL-3.0-or-later

const DEFAULT_URL = "ws://127.0.0.1:8642"; // = EXTENSION_DEFAULT_PORT
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;
// Answer the gateway slightly BEFORE its own default render timeout (180s)
// so an honest error reaches the harness instead of a dropped frame.
// 280s leaves room for the content adapter's 260s overall deadline.
const RENDER_TIMEOUT_MS = 280_000;

// MV3 service workers are suspended after ~30s idle. An OPEN socket alone
// does not keep one alive — only websocket ACTIVITY does. A periodic ping
// (answered by the gateway's pong) provides that activity, the same trick
// ZeroScript's bridge uses; it also detects half-open sockets.
const HEARTBEAT_MS = 10_000;
const STALE_SOCKET_MS = 25_000;

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0;
let nextId = 1;

/** Mirrors what the in-page status bar shows (ZS-style panel data). */
const status = { gateway: false, tools: null, adapters: 0 };

function broadcastStatus() {
  status.adapters = adapterPorts.length;
  for (const { port } of adapterPorts) {
    try {
      port.postMessage({ type: "status", ...status });
    } catch { /* port closing */ }
  }
}

/** @type {Map<string, {resolve: Function, timer: any}>} */
const pendingRenders = new Map();
/** @type {Array<{port: chrome.runtime.Port, url: string}>} */
const adapterPorts = [];

// Providers migrate domains mid-session (seen live: chat.deepseek.com ->
// deepseek.com/en). Prefer a KNOWN chat surface over a stray tab; else the
// newest attachment. Logged so wrong-tab picks are never mysterious.
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pickAdapterPort() {
  const chatLike = adapterPorts.filter(
    (p) => /(^|\.)chat\./i.test(hostOf(p.url)) || p.url.includes("/chat"),
  );
  return chatLike.at(-1) ?? adapterPorts.at(-1);
}

function log(...a) {
  console.log("[bridle-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(DEFAULT_URL);
  } catch (e) {
    log("ws ctor failed:", e?.message);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN_MS;
    lastMessageAt = Date.now();
    status.gateway = true;
    log("gateway connected at", DEFAULT_URL);
    startHeartbeat();
    // Re-announce any content adapters that attached while we were offline.
    for (const { port } of adapterPorts) {
      sendFrame({ type: "adapter_ready", url: port.sender?.tab?.url });
    }
    broadcastStatus();
  };
  ws.onclose = () => {
    connected = false;
    status.gateway = false;
    status.tools = null;
    stopHeartbeat();
    failAllPending("gateway connection closed");
    broadcastStatus();
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* already closing */ }
  };
  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return; // ignore malformed frames honestly
    }
    if (msg.type === "capabilities") {
      status.tools = Array.isArray(msg.tools) ? msg.tools.length : null;
      broadcastStatus();
      return;
    }
    if (msg.type === "render_request" && msg.id) handleRenderRequest(msg);
  };
}

// ── heartbeat: keep the worker alive, detect half-open sockets ──────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!connected) return;
    if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
      log("socket stale, forcing reconnect");
      try { ws.close(); } catch { /* already closing */ }
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      try { ws.close(); } catch { /* already closing */ }
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function sendFrame(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function sendResult(id, fields) {
  sendFrame({ type: "render_result", id, ...fields });
}

function failAllPending(reason) {
  for (const [, p] of pendingRenders) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, text: "", toolCalls: [], error: reason });
  }
  pendingRenders.clear();
}

// ── render_request fan-out to a content adapter ────────────────────────

function handleRenderRequest(msg) {
  const { id } = msg;
  const chosen = pickAdapterPort();
  if (!chosen) {
    sendResult(id, {
      ok: false,
      text: "",
      toolCalls: [],
      error: "no chat tab with the bridle bridge is open",
    });
    return;
  }
  const port = chosen.port;
  log(`render #${id} -> ${chosen.url || "(unknown tab)"}`);
  const entry = {
    resolve: (fields) => {
      pendingRenders.delete(id);
      sendResult(id, fields);
    },
    // SW-side watchdog; the content adapter has its own softer deadlines.
    timer: setTimeout(
      () => entryResolve(id, { ok: false, text: "", toolCalls: [], error: `adapter timed out after ${RENDER_TIMEOUT_MS}ms` }),
      RENDER_TIMEOUT_MS,
    ),
  };
  function entryResolve(innerId, fields) {
    const p = pendingRenders.get(innerId);
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve(fields);
  }
  pendingRenders.set(id, entry);
  try {
    port.postMessage({
      type: "render_request",
      id,
      messages: msg.messages,
      tools: msg.tools,
    });
  } catch (e) {
    entryResolve(id, { ok: false, text: "", toolCalls: [], error: `port post failed: ${e?.message}` });
  }
}

// ── content adapter ports ───────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bridle-adapter") return;
  const url = port.sender?.tab?.url ?? "";
  adapterPorts.push({ port, url });
  log(`content adapter attached: ${url}`);
  // Announce readiness upstream: a bare socket is NOT enough for the runner
  // to know a chat tab is actually wired up.
  if (!sendFrame({ type: "adapter_ready", url })) {
    log("adapter attached while gateway socket down — will re-announce on reconnect");
  }
  // Give the fresh port the current status immediately (status bar MVP).
  try {
    port.postMessage({ type: "status", ...status, adapters: adapterPorts.length });
  } catch { /* never mind */ }
  port.onDisconnect.addListener(() => {
    const i = adapterPorts.findIndex((e) => e.port === port);
    if (i >= 0) adapterPorts.splice(i, 1);
    log("content adapter detached");
    // Its in-flight renders can never answer now.
    failAllPending("chat tab closed mid-render");
    broadcastStatus();
  });
  port.onMessage.addListener((m) => {
    if (m?.type !== "adapter_result" || !m.id) return;
    const p = pendingRenders.get(m.id);
    if (!p) return;
    p.resolve({
      ok: Boolean(m.ok),
      text: String(m.text ?? ""),
      toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : [],
      ...(m.error ? { error: String(m.error) } : {}),
    });
  });
});

connect();
