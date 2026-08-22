/**
 * bridle security — the permission gate as an ORDINARY LISTENER (M4).
 *
 * Enforcement over hope: instead of asking the model nicely, the gate sits
 * on the existing `tools/pre-execute` waterfall and classifies every call
 * into a permission class:
 *
 *   read     — observes state
 *   write    — mutates state
 *   execute  — runs code / arbitrary instructions (also the DEFAULT for
 *              tools that declare nothing — unknown ⇒ most cautious)
 *
 * Each class has a mode:
 *   allow — pass through
 *   deny  — short-circuit with an honest "Permission denied" tool result
 *   ask   — consult the approver (a SYNC function; the kernel waterfall is
 *           synchronous by design). No approver ⇒ refuse.
 *
 * Every decision is appended to the durable session log as audit/gate, and
 * every execution lands as audit/result — durable facts that are NOT
 * model-visible (projectMessages only projects user/assistant/tool events),
 * so the trail cannot be tampered with from inside a conversation.
 *
 * Concept lineage: ZeroScript-Free's orchestrator permission_gate
 * (server_classes, unknown ⇒ ASK), re-expressed over bridle's seams.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  PluginContext,
  PluginDef,
} from "@bridle/kernel";
import type { SessionLog } from "@bridle/session";
import type {
  ToolsService,
  PreExecutePayload,
  PostExecutePayload,
} from "@bridle/tools";

export type PermissionClass = "read" | "write" | "execute";
export type GateMode = "allow" | "ask" | "deny";

/** Sync approval callback — true allows the call. The kernel waterfall is
 *  synchronous, so interactive approvers must block (see @bridle/security/node). */
export type Approver = (req: { name: string; args: Record<string, unknown> }, cls: PermissionClass) => boolean;

export interface SecurityOptions {
  /** Mode per class. Defaults: read=allow, write=deny*, execute=deny*.
   *  (* secure defaults: without an explicit policy, mutation and code
   *  execution are REFUSED, not hoped away.) */
  modes?: Partial<Record<PermissionClass, GateMode>>;
  /** Class for tools that declare none. Default "execute". */
  defaultClass?: PermissionClass;
  /** Prefix rules (trailing `*`) or exact names; highest precedence.
   *  e.g. { match: "roblox/*", cls: "write" } */
  rules?: Array<{ match: string; cls: PermissionClass }>;
  /** Consulted in ask mode. Absent ⇒ ask refuses honestly. */
  approver?: Approver;
}

const DEFAULT_MODES: Record<PermissionClass, GateMode> = {
  read: "allow",
  write: "deny",
  execute: "deny",
};

export interface SecurityApi {
  classify(name: string): PermissionClass;
  modes(): Record<PermissionClass, GateMode>;
}

// This package does not depend on @bridle/agent (which also augments these
// keys), so it declares the seams it consumes itself — declaration merging
// makes the duplicate declarations compatible.
declare module "@bridle/kernel" {
  interface ServiceMap {
    sessions: SessionLog;
    tools: ToolsService;
    security: SecurityApi;
  }
}

function matches(rule: string, name: string): boolean {
  return rule.endsWith("*") ? name.startsWith(rule.slice(0, -1)) : rule === name;
}

export async function securitySetup(ctx: PluginContext, opts: SecurityOptions = {}): Promise<void> {
  const sessions: SessionLog = await ctx.service("sessions");
  const tools: ToolsService = await ctx.service("tools");

  const modes = { ...DEFAULT_MODES, ...(opts.modes ?? {}) };
  const defaultClass = opts.defaultClass ?? "execute";
  const rules = [...(opts.rules ?? [])].sort((a, b) => b.match.length - a.match.length);

  function classify(name: string): PermissionClass {
    for (const r of rules) if (matches(r.match, name)) return r.cls;
    return tools.describe(name)?.permission ?? defaultClass;
  }

  const api: SecurityApi = { classify, modes: () => ({ ...modes }) };

  // ── the gate: an ordinary pre-execute listener ─────────────────────────
  // (kernel listeners are stored untyped; the casts are the codebase idiom.
  //  Returning undefined = short-circuit, exactly the documented contract.)
  const gate = (
    payload: PreExecutePayload,
    next: (v?: PreExecutePayload) => PreExecutePayload,
  ): PreExecutePayload | undefined => {
    const { name } = payload.request;
    const cls = classify(name);
    const mode = modes[cls];
    let allowed = mode === "allow";

    if (mode === "ask") {
      if (!opts.approver) {
        payload.decision.deny =
          `${name} needs approval (class ${cls}, mode ask) but no approver is installed`;
      } else {
        try {
          allowed = Boolean(opts.approver(payload.request, cls));
        } catch (e) {
          allowed = false;
          payload.decision.deny =
            `${name} approver threw: ${String((e as Error)?.message ?? e)}`;
        }
        if (!allowed && payload.decision.deny === undefined) {
          payload.decision.deny = `${name} (${cls}) was not approved`;
        }
      }
    } else if (mode === "deny") {
      payload.decision.deny = `${name} is classified ${cls} and the policy denies ${cls} calls`;
    }

    if (!allowed && payload.decision.deny === undefined) {
      payload.decision.deny = `${name} refused by policy`; // defensive honesty
    }

    // Audit BEFORE returning: denials are facts too.
    sessions.append("audit/gate", {
      tool: name,
      cls,
      mode,
      allowed,
      ...(payload.decision.deny !== undefined ? { reason: payload.decision.deny } : {}),
    });

    if (!allowed) return; // short-circuit — execute never runs
    return next();
  };
  ctx.on(
    "tools/pre-execute",
    gate as unknown as (...args: never[]) => unknown,
  );

  // ── audit: outcomes of everything that DID run ─────────────────────────
  const auditor = (p: PostExecutePayload): void => {
    sessions.append("audit/result", {
      tool: p.request.name,
      ok: p.output.ok,
      elapsedMs: p.elapsedMs,
    });
  };
  ctx.on(
    "tools/post-execute",
    auditor as unknown as (...args: never[]) => unknown,
  );

  ctx.provide("security", api);
}

export function securityPlugin(opts: SecurityOptions = {}): PluginDef {
  return {
    name: "security",
    requires: ["sessions", "tools"],
    setup(ctx) {
      return securitySetup(ctx as PluginContext, opts);
    },
  };
}

/** Static allow-list approver: exact tool names pass, everything else is
 *  refused honestly. Good for demos, CI, and --allow style CLI flags. */
export function listApprover(allowed: string[]): Approver {
  const set = new Set(allowed);
  return (req) => set.has(req.name);
}
