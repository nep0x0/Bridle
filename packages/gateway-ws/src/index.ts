/**
 * bridle gateway — a ws server that bridges the kernel (Node) to browser
 * side web-chat adapters.
 *
 * Protocol (JSON lines over ws):
 *   gateway -> adapter:
 *     {type:"capabilities", tools:[{name,description,params}]}
 *     {type:"render_request", id, messages, tools}   // run ONE model turn
 *   adapter -> gateway:
 *     {type:"render_result", id, ok, text, toolCalls?, error?}
 *
 * The WebchatAdapter below implements the SAME `LlmAdapter` seam as API
 * providers: from the agent loop's perspective, chatting through a browser
 * is indistinguishable from calling an HTTP endpoint.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { LlmAdapter, LlmMessage, LlmToolCall } from "@bridle/llm";

export interface GatewayToolInfo {
  name: string;
  description: string;
  params?: Record<string, string>;
}

/** Port the browser extension assumes when no explicit port is configured
 *  (the extension's default in extension/background/service-worker.js).
 *  Tests and one-off runs may still use an ephemeral port (0). */
export const EXTENSION_DEFAULT_PORT = 8642;

export interface GatewayOptions {
  port?: number; // default 0 = ephemeral
  host?: string; // default 127.0.0.1
  renderTimeoutMs?: number; // default 180_000 (web chats are slow)
}

interface Pending {
  resolve: (r: RenderResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RenderResult {
  ok: boolean;
  text: string;
  toolCalls?: LlmToolCall[];
  error?: string;
}

export class WebchatGateway {
  #wss: WebSocketServer | undefined;
  #client: WebSocket | undefined;
  #pending = new Map<string, Pending>();
  #nextId = 1;
  /** Info from the newest `adapter_ready` frame (a chat tab actually
   *  attached its port — stronger than a bare socket connection). */
  #readyInfo: { url?: string } | undefined;
  readonly connections: Set<WebSocket> = new Set();

  constructor(
    private readonly getTools: () => GatewayToolInfo[],
    private readonly opts: GatewayOptions = {},
    private readonly logFn: (msg: string) => void = () => {},
  ) {}

  /** True once an adapter announced itself with `adapter_ready`. */
  hasReadyAdapter(): boolean {
    return this.#readyInfo !== undefined;
  }

  /** Newest readiness info (tab URL etc.), or undefined. */
  get readyAdapter(): { url?: string } | undefined {
    return this.#readyInfo;
  }

  /** Start listening. Resolves with the bound port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#wss = new WebSocketServer({
        port: this.opts.port ?? 0,
        host: this.opts.host ?? "127.0.0.1",
      });
      this.#wss.on("connection", (ws) => this.#onConnection(ws));
      this.#wss.on("error", reject);
      this.#wss.on("listening", () => {
        const addr = this.#wss!.address();
        const port =
          typeof addr === "object" && addr ? addr.port : Number(addr);
        resolve(port);
      });
    });
  }

  close(): Promise<void> {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, text: "", error: "gateway closed" });
    }
    this.#pending.clear();
    // Force-terminate every adapter socket FIRST: WebSocketServer.close()
    // only waits on open sockets and its callback would never fire while an
    // adapter stays connected (verified: close() hung indefinitely).
    for (const ws of [...this.connections]) {
      try {
        ws.terminate();
      } catch {
        // already dead — nothing to unwind
      }
    }
    this.connections.clear();
    return new Promise((resolve) => {
      this.#wss?.close(() => resolve());
      if (!this.#wss) resolve();
    });
  }

  hasAdapter(): boolean {
    return (
      this.#client !== undefined && this.#client.readyState === WebSocket.OPEN
    );
  }

  #onConnection(ws: WebSocket): void {
    // One adapter at a time (M3); newest wins.
    this.#client = ws;
    this.connections.add(ws);
    this.logFn("webchat adapter connected");
    ws.send(JSON.stringify({ type: "capabilities", tools: this.getTools() }));
    ws.on("message", (raw) => this.#onMessage(String(raw)));
    ws.on("close", () => {
      this.connections.delete(ws);
      if (this.#client === ws) {
        this.#client = undefined;
        this.#readyInfo = undefined; // readiness died with its socket
      }
      this.logFn("webchat adapter disconnected");
    });
  }

  #onMessage(raw: string): void {
    let msg: {
      type: string;
      id?: string;
      ok?: boolean;
      text?: string;
      toolCalls?: LlmToolCall[];
      error?: string;
      url?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames honestly (no crash)
    }
    if (msg.type === "ping") {
      // Keep-alive handshake with the extension's service worker.
      this.#client?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "adapter_ready") {
      // A content adapter attached its port — the gateway can now render.
      this.#readyInfo = { url: msg.url };
      this.logFn(`adapter ready: ${msg.url ?? "unknown tab"}`);
      return;
    }
    if (msg.type === "render_result" && msg.id) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve({
        ok: Boolean(msg.ok),
        text: String(msg.text ?? ""),
        toolCalls: Array.isArray(msg.toolCalls) ? msg.toolCalls : [],
        error: msg.error,
      });
    }
  }

  /** Build an LlmAdapter that renders turns through the connected browser. */
  webchatAdapter(): LlmAdapter {
    const timeoutMs = this.opts.renderTimeoutMs ?? 180_000;
    return {
      complete: async (req: {
        messages: LlmMessage[];
        tools: Array<{ name: string; description: string }>;
      }) => {
        const client = this.#client;
        if (!client || client.readyState !== WebSocket.OPEN) {
          throw new Error(
            "no webchat adapter connected — is the browser extension running?",
          );
        }
        const id = `rr_${this.#nextId++}`;
        const result = await new Promise<RenderResult>((resolve) => {
          const timer = setTimeout(() => {
            this.#pending.delete(id);
            resolve({ ok: false, text: "", error: `render timed out after ${timeoutMs}ms` });
          }, timeoutMs);
          this.#pending.set(id, { resolve, timer });
          client.send(
            JSON.stringify({
              type: "render_request",
              id,
              messages: req.messages,
              tools: req.tools,
            }),
          );
        });
        if (!result.ok) {
          throw new Error(`webchat render failed: ${result.error ?? result.text}`);
        }
        return { text: result.text, toolCalls: result.toolCalls ?? [] };
      },
    };
  }
}
