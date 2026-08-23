/**
 * bridle headless — command registry plugin (TUI-first, plugin-first).
 *
 * Slash commands in the interactive runner are NOT hardcoded there: they
 * live in a "commands" service exactly like tools do. Anything mounted
 * later can register more (e.g. a domain pack could offer "/studio"), and
 * every registration is an owner-tagged reversible effect.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginContext, PluginDef } from "@bridle/kernel";
import type { SessionLog } from "@bridle/session";
import type { ToolsService } from "@bridle/tools";

export interface CommandIO {
  /** Where the command writes its output (REPL stdout, tests, …). */
  log(...parts: unknown[]): void;
}

export interface Command {
  name: string;
  description: string;
  execute(args: string, io: CommandIO): Promise<void> | void;
}

export interface CommandsApi {
  register(cmd: Command): () => void;
  unregister(name: string): void;
  list(): Array<{ name: string; description: string }>;
  has(name: string): boolean;
  /** Dispatch a raw REPL line starting with "/". Resolves false when the
   *  command is unknown — output/help is already written to io. */
  dispatch(line: string, io: CommandIO): Promise<boolean>;
}

// sessions/tools are augmented by their owning packages (@bridle/session,
// @bridle/security); this module adds only its own key.
declare module "@bridle/kernel" {
  interface ServiceMap {
    commands: CommandsApi;
  }
}

export function commandPlugin(): PluginDef {
  return {
    name: "commands",
    requires: ["sessions", "tools"],
    setup(ctx) {
      return commandSetup(ctx as PluginContext);
    },
  };
}

async function commandSetup(ctx: PluginContext): Promise<void> {
  const sessions: SessionLog = await ctx.service("sessions");
  const tools: ToolsService = await ctx.service("tools");

  const registry = new Map<string, Command>();

  function register(cmd: Command): () => void {
    if (registry.has(cmd.name)) {
      throw new Error(`command "${cmd.name}" is already registered`);
    }
    registry.set(cmd.name, cmd);
    return () => registry.delete(cmd.name);
  }

  const api: CommandsApi = {
    register,
    unregister: (n) => registry.delete(n),
    list: () =>
      [...registry.values()].map(({ name, description }) => ({
        name,
        description,
      })),
    has: (n) => registry.has(n),
    async dispatch(line, io) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("/")) return false;
      const body = trimmed.slice(1);
      const sp = body.indexOf(" ");
      const name = sp < 0 ? body : body.slice(0, sp);
      const restArgs = sp < 0 ? "" : body.slice(sp + 1).trim();
      const cmd = registry.get(name);
      if (!cmd) {
        io.log(
          `unknown command "/${name}". Available: ` +
            [...registry.keys()].map((k) => `/${k}`).join(", "),
        );
        return false;
      }
      await cmd.execute(restArgs, io);
      return true;
    },
  };

  // ── builtins ────────────────────────────────────────────────────────────

  register({
    name: "help",
    description: "List available commands.",
    execute(_args, io) {
      for (const c of api.list()) io.log(`/${c.name.padEnd(8)} ${c.description}`);
    },
  });

  register({
    name: "tools",
    description: "List registered tools with their permission classes.",
    execute(_args, io) {
      for (const t of tools.list()) {
        const perm = tools.describe(t.name)?.permission ?? "(undeclared)";
        io.log(`${t.name.padEnd(26)} [${perm}] ${t.description.split("\n")[0]}`);
      }
    },
  });

  register({
    name: "log",
    description: "Show the last N durable session events (default 15).",
    execute(args, io) {
      const n = Math.max(1, Number(args || 15) || 15);
      const events = sessions.all().slice(-n);
      for (const e of events) {
        io.log(
          `${String(e.id).padStart(4)} ${e.type.padEnd(18)} ${JSON.stringify(e.payload).slice(0, 110)}`,
        );
      }
      if (events.length === 0) io.log("(session log empty)");
    },
  });

  register({
    name: "audit",
    description: "Show recent audit/* events (gate decisions & results).",
    execute(args, io) {
      const n = Math.max(1, Number(args || 20) || 20);
      const events = sessions.all().filter((e) => e.type.startsWith("audit/")).slice(-n);
      for (const e of events) {
        io.log(
          `${String(e.id).padStart(4)} ${e.type.padEnd(14)} ${JSON.stringify(e.payload).slice(0, 120)}`,
        );
      }
      if (events.length === 0) io.log("(no audit events yet)");
    },
  });

  ctx.provide("commands", api);
}
