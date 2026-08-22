/**
 * bridle roblox domain — the ONE plugin that teaches bridle about Roblox.
 *
 * Everything here registers through the standard seams: tools carry their
 * permission classes (the security gate enforces), knowledge rides the
 * agent/pre-step waterfall (R2), verify kinds plug into the workflow pack
 * (R3). Unmount = Studio disconnected, nothing leaked into the kernel.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginContext, PluginDef } from "@bridle/kernel";
import type { SessionLog } from "@bridle/session";
import type { ToolsService } from "@bridle/tools";
import type { StudioTransport } from "./transport.ts";
import { FakeStudioTransport } from "./fake-studio.ts";
import { readTools } from "./tools/read.ts";
import { writeTools } from "./tools/write.ts";
import { makeVerifyKinds } from "./verify/index.ts";
import { DocsMirror, parseLlmsIndex, curate, type MirrorPage } from "./knowledge/docs.ts";
import { loadRobloxConfig, type RobloxConfig } from "./config.ts";

export {
  FakeStudioTransport,
  loadRobloxConfig,
  DocsMirror,
  parseLlmsIndex,
  curate,
};
export type { RobloxConfig, MirrorPage };

declare module "@bridle/kernel" {
  interface ServiceMap {
    roblox: RobloxApi;
  }
}

export interface RobloxApi {
  readonly transport: StudioTransport;
  readonly config: RobloxConfig;
}

export interface RobloxOptions {
  /** Explicit transport (tests pass FakeStudioTransport). Default: build
   *  the live MCP stdio transport from resolved config (R4). */
  transport?: StudioTransport;
  /** Docs mirror + knowledge injection. Default: on (empty until
   *  doc_refresh runs). Pass false to disable entirely. */
  docs?:
    | false
    | {
        /** Pre-seeded pages (tests); skips network until refresh. */
        seed?: MirrorPage[];
        fetcher?: ConstructorParameters<typeof DocsMirror>[0];
      };
  log?: (m: string) => void;
}

export function robloxPlugin(opts: RobloxOptions = {}): PluginDef {
  return {
    name: "roblox",
    requires: ["sessions", "tools", "workflow"],
    setup(ctx) {
      return robloxSetup(ctx, opts);
    },
  };
}

async function robloxSetup(ctx: PluginContext, opts: RobloxOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const config = loadRobloxConfig(log);

  const transport: StudioTransport =
    opts.transport ??
    (config.studioMcpPath
      ? // R4 will construct McpStdioTransport here; for now fail honestly.
        (() => {
          throw new Error(
            "live MCP transport arrives in R4 — pass {transport: new FakeStudioTransport()} or wait for R4",
          );
        })()
      : new FakeStudioTransport());
  if (transport.kind === "fake" && !opts.transport) {
    log("roblox: no live transport configured — using FakeStudio (deterministic)");
  }

  const tools = (await ctx.service("tools")) as unknown as ToolsService;
  for (const tool of [...readTools(transport), ...writeTools(transport)]) {
    tools.register(tool);
  }

  // ── R2: docs mirror + knowledge injection ───────────────────────────
  let mirrorOrNull: DocsMirror | null = null;
  if (opts.docs !== false) {
    const mirror = new DocsMirror(opts.docs?.fetcher);
    mirrorOrNull = mirror;
    if (opts.docs?.seed) mirror.seed(opts.docs.seed);

    tools.register({
      name: "roblox.doc_search",
      description:
        "Search the LOCAL mirror of official Roblox documentation (current API ground truth). Empty until doc_refresh runs once.",
      params: { query: "string", limit: "number?" },
      permission: "read",
      execute: async (a: { query: string; limit?: number }) => {
        if (mirror.size === 0) {
          return {
            ok: true,
            text: "docs mirror is empty — call roblox.doc_refresh first (network)",
          };
        }
        const hits = mirror.search(String(a.query ?? ""), Math.min(a.limit ?? 3, 8));
        if (hits.length === 0) return { ok: true, text: "(no docs match)" };
        return {
          ok: true,
          text: hits
            .map((h) => `### ${h.title}\n${h.url}\n${h.body.slice(0, 300)}...`)
            .join("\n\n"),
        };
      },
    });

    tools.register({
      name: "roblox.doc_refresh",
      description:
        "Download the curated official-docs mirror (~100 core pages from create.roblox.com llms.txt). Network, one-time.",
      permission: "write",
      execute: async () => {
        const res = await mirror.refresh(100, log);
        return {
          ok: res.pages > 0,
          text: `docs mirror refreshed: ${res.pages} page(s), ${Math.round(res.bytes / 1024)}KB, ${res.errors} error(s)`,
        };
      },
    });

    // Knowledge injection: rewrite the claimed messages through the SAME
    // waterfall the loop already runs — no side channel, invariant intact.
    // (A waterfall listener MUST call next() to delegate; returning without
    // it would short-circuit the chain.)
    ctx.on("agent/pre-step", (
      p: { messages: Array<{ role: string; text: string }> },
      next: () => unknown,
    ) => {
      const lastUser = [...p.messages].reverse().find((m) => m.role === "user");
      const pack = lastUser ? mirror.injectFor(lastUser.text, 1500) : null;
      if (!pack) return next();
      const idx = p.messages.indexOf(lastUser!);
      p.messages = [
        ...p.messages.slice(0, idx),
        { role: "user" as const, text: `${lastUser!.text}\n\n${pack}` },
        ...p.messages.slice(idx + 1),
      ];
      return next();
    });
    log("roblox: knowledge injection armed (mirror empty until doc_refresh)");
  }

  // ── R3: register verify kinds into the workflow pack ────────────────
  const workflow = (await ctx.service("workflow")) as unknown as {
    registerVerifyKind(kind: string, handler: never): void;
    listVerifyKinds(): string[];
  };
  for (const [kind, handler] of Object.entries(
    makeVerifyKinds(transport, mirrorOrNull),
  )) {
    workflow.registerVerifyKind(kind, handler as never);
  }

  ctx.provide("roblox", { transport, config });
}
