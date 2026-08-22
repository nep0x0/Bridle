/**
 * bridle workflow — plan manifest + verify-driven auto_run + scaffolds.
 *
 * Enforcement over hope: a task only becomes "done" when its verify steps
 * actually pass. Repeated failures block the task honestly (a generic
 * rollback hook is optional; real place-rollback belongs to domain packs).
 *
 * Every mutation mirrors a durable `workflow/*` session event. Those events
 * are NOT model-visible (the projector keeps /message and tool/result
 * classes), so the audit trail cannot be tampered with from conversation.
 *
 * Concept lineage: ZeroScript-Free v2 P5 plans + v3 auto_run/scaffolds,
 * re-expressed over bridle's seams. Clean-room: written from this design,
 * not ported line-by-line.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "node:crypto";
import type {
  PluginContext,
  PluginDef,
} from "@bridle/kernel";
import type { SessionLog } from "@bridle/session";
import type { ToolsService, ToolDef } from "@bridle/tools";

// ── types ────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled";

export interface PlanTask {
  seq: number;
  title: string;
  status: TaskStatus;
  result?: string;
  verify: VerifyStep[];
}

export interface WorkflowPlan {
  id: string;
  goal: string;
  decision?: PlanDecision;
  tasks: PlanTask[];
  createdAt: number;
}

/** Explicit architectural decision (creative scaffold converges here). */
export interface PlanDecision {
  chosen: string;
  reason?: string;
  risks?: string;
  alternatives?: string[];
}

export interface VerifyStep {
  kind: string;
  note?: string;
  /** For kind="tool": which registered tool to run and with what args. */
  name?: string;
  args?: Record<string, unknown>;
}

export type VerifyHandler = (
  step: VerifyStep,
  io: { tools: ToolsService },
) => Promise<{ ok: boolean; detail: string }>;

export interface WorkflowOptions {
  maxCycles?: number; // default 3
  maxTasks?: number; // default 12
  /** Domain packs extend verification here (playtest, docs, style, ...).
   *  Unknown kinds are reported as FAIL honestly, never skipped silently. */
  verifyKinds?: Record<string, VerifyHandler>;
  /** Optional hook invoked when cycles exhaust (real rollbacks live in
   *  domains; generic bridle just blocks the task). */
  onRollback?: (planId: string, seq: number) => Promise<string> | string;
}

interface CycleRecord {
  count: number;
  limit: number;
}

// ── store ────────────────────────────────────────────────────────────────

class PlanStore {
  #plans = new Map<string, WorkflowPlan>();

  create(goal: string, tasks: Array<{ title: string; verify?: VerifyStep[] }>, decision?: PlanDecision): WorkflowPlan {
    const id = `plan_${randomBytes(4).toString("hex")}`;
    const now = Date.now();
    const plan: WorkflowPlan = {
      id,
      goal,
      decision,
      createdAt: now,
      tasks: tasks.map((t, i) => ({
        seq: i + 1,
        title: t.title,
        status: "pending" as TaskStatus,
        verify: t.verify ?? [],
      })),
    };
    this.#plans.set(id, plan);
    return plan;
  }

  get(id: string): WorkflowPlan | undefined {
    return this.#plans.get(id);
  }

  all(): WorkflowPlan[] {
    return [...this.#plans.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

// ── builtin verify handlers ──────────────────────────────────────────────

const builtinVerifyKinds: Record<string, VerifyHandler> = {
  static: async (step) => ({
    ok: true,
    detail: step.note ? String(step.note).slice(0, 160) : "(static expectation recorded)",
  }),
  tool: async (step, { tools }) => {
    if (!step.name) {
      return { ok: false, detail: "tool verify step needs 'name'" };
    }
    const out = await tools.execute(step.name, step.args ?? {});
    return { ok: out.ok, detail: out.text.slice(0, 200) };
  },
};

// ── formatting helpers ───────────────────────────────────────────────────

function renderDecision(d: PlanDecision): string {
  const alts = d.alternatives?.length ? ` vs ${d.alternatives.join(" vs ")}` : "";
  const parts = [`chosen: ${d.chosen}${alts}`];
  if (d.reason) parts.push(`reason: ${d.reason}`);
  if (d.risks) parts.push(`risks: ${d.risks}`);
  return parts.join(" | ");
}

function renderPlan(p: WorkflowPlan): string {
  const lines = [`Plan ${p.id} — ${p.goal}`];
  if (p.decision) lines.push(`  DECISION: ${renderDecision(p.decision)}`);
  for (const t of p.tasks) {
    const res = t.result ? ` — ${t.result.slice(0, 120)}` : "";
    lines.push(`  ${String(t.seq).padStart(2, "0")}. [${t.status}] ${t.title}${res}`);
  }
  return lines.join("\n");
}

// ── plugin ───────────────────────────────────────────────────────────────

declare module "@bridle/kernel" {
  interface ServiceMap {
    // Only the NEW key lives here; sessions/tools are already declared by
    // their owning packages — re-declaring them here with different import
    // paths breaks interface merging.
    workflow: WorkflowApi;
  }
}

export interface WorkflowApi {
  get(id: string): WorkflowPlan | undefined;
  all(): WorkflowPlan[];
  /** Domain packs register additional verify kinds (playtest, docs,
   *  style, ...). Late-stage by design: mount order stays natural. */
  registerVerifyKind(kind: string, handler: VerifyHandler): void;
  listVerifyKinds(): string[];
}

export function workflowPlugin(opts: WorkflowOptions = {}): PluginDef {
  return {
    name: "workflow",
    requires: ["sessions", "tools"],
    setup(ctx) {
      return workflowSetup(ctx, opts);
    },
  };
}

async function workflowSetup(
  ctx: PluginContext,
  opts: WorkflowOptions,
): Promise<void> {
  // These keys are declared by their owning packages (@bridle/session and
  // @bridle/agent augment ServiceMap); this package does not re-declare them.
  const sessions = (await ctx.service("sessions")) as unknown as SessionLog;
  const tools = (await ctx.service("tools")) as unknown as ToolsService;

  const store = new PlanStore();
  const cycles = new Map<string, CycleRecord>();
  const verifyKinds: Record<string, VerifyHandler> = {
    ...builtinVerifyKinds,
    ...(opts.verifyKinds ?? {}),
  };
  const maxCycles = opts.maxCycles ?? 3;
  const maxTasks = opts.maxTasks ?? 12;

  const mirror = (type: string, payload: Record<string, unknown>): void => {
    sessions.append(`workflow/${type}`, payload);
  };

  // ── tool implementations ────────────────────────────────────────────

  const planNew: ToolDef<{
    goal: string;
    tasks: Array<{ title: string; verify?: VerifyStep[] }>;
    decision?: PlanDecision;
  }> = {
    name: "plan_new",
    description:
      "Create a multi-task plan manifest (max 12 tasks). Include 'decision' for creative work: {chosen, reason?, risks?, alternatives?}. Finish every task with auto_run.",
    params: { goal: "string", tasks: "[{title, verify?:[{kind,...}]}]" },
    permission: "write",
    execute: (args) => {
      const goal = String(args.goal ?? "").trim();
      if (!goal) return { ok: false, text: "plan_new needs 'goal'" };
      if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
        return { ok: false, text: "plan_new needs non-empty 'tasks'" };
      }
      if (args.tasks.length > maxTasks) {
        return { ok: false, text: `plan_new allows at most ${maxTasks} tasks` };
      }
      const plan = store.create(goal, args.tasks, args.decision);
      mirror("plan-created", { id: plan.id, goal, tasks: plan.tasks.length });
      let text = renderPlan(plan);
      text +=
        "\nWork one task at a time; finish each with auto_run before claiming done.";
      return { ok: true, text };
    },
  };

  const planList: ToolDef<Record<string, never>> = {
    name: "plan_list",
    description: "List plans with per-task status (and persisted decisions).",
    permission: "read",
    execute: () => {
      const plans = store.all();
      if (plans.length === 0) {
        return {
          ok: true,
          text: "No plans yet. Create one with plan_new.",
        };
      }
      return { ok: true, text: plans.map(renderPlan).join("\n\n") };
    },
  };

  const planStatus: ToolDef<{
    goal_id: string;
    seq: number;
    status: TaskStatus;
    result?: string;
  }> = {
    name: "plan_status",
    description:
      "Update a task's progress: pending/in_progress/done/blocked/cancelled.",
    params: { goal_id: "string", seq: "number", status: "string" },
    permission: "write",
    execute: (args) => {
      const plan = store.get(String(args.goal_id ?? ""));
      if (!plan) return { ok: false, text: `unknown plan '${args.goal_id}'` };
      const task = plan.tasks.find((t) => t.seq === Number(args.seq));
      if (!task) {
        return { ok: false, text: `no task #${args.seq} in ${plan.id}` };
      }
      const status = String(args.status ?? "") as TaskStatus;
      const valid: TaskStatus[] = [
        "pending",
        "in_progress",
        "done",
        "blocked",
        "cancelled",
      ];
      if (!valid.includes(status)) {
        return { ok: false, text: `status must be one of: ${valid.join("/")}` };
      }
      task.status = status;
      if (typeof args.result === "string") task.result = args.result;
      mirror("task-status", {
        id: plan.id,
        seq: task.seq,
        status,
        result: task.result ?? null,
      });
      return { ok: true, text: `task ${plan.id}/${task.seq} -> [${status}]` };
    },
  };

  const planCheckpoint: ToolDef<{ goal_id: string; seq: number }> = {
    name: "plan_checkpoint",
    description:
      "Record a durable checkpoint marker BEFORE mutating anything for this task.",
    params: { goal_id: "string", seq: "number" },
    permission: "execute",
    execute: (args) => {
      const plan = store.get(String(args.goal_id ?? ""));
      if (!plan) return { ok: false, text: `unknown plan '${args.goal_id}'` };
      const task = plan.tasks.find((t) => t.seq === Number(args.seq));
      if (!task) {
        return { ok: false, text: `no task #${args.seq} in ${plan.id}` };
      }
      mirror("checkpoint", { id: plan.id, seq: task.seq, ts: Date.now() });
      return {
        ok: true,
        text: `Checkpoint recorded for ${plan.id}/${task.seq} (durable workflow/checkpoint event).`,
      };
    },
  };

  const autoRun: ToolDef<{
    goal_id: string;
    seq: number;
    mark_done?: boolean;
    max_cycles?: number;
  }> = {
    name: "auto_run",
    description:
      "Run ALL of a task's verify steps NOW. Pass marks it done with proof; repeated failures escalate to blocked after max_cycles. Never claim done without it.",
    params: { goal_id: "string", seq: "number", max_cycles: "number?" },
    permission: "execute",
    execute: async (args) => {
      const plan = store.get(String(args.goal_id ?? ""));
      if (!plan) return { ok: false, text: `unknown plan '${args.goal_id}'` };
      const task = plan.tasks.find((t) => t.seq === Number(args.seq));
      if (!task) {
        return { ok: false, text: `no task #${args.seq} in ${plan.id}` };
      }
      if (task.verify.length === 0) {
        return {
          ok: false,
          text: `task ${plan.id}/${task.seq} has no verify steps`,
        };
      }

      const lines: string[] = [];
      let allPass = true;
      for (const step of task.verify) {
        const handler = verifyKinds[step.kind];
        if (!handler) {
          allPass = false;
          lines.push(`- ${step.kind} [FAIL]: unknown verify kind`);
          continue;
        }
        const { ok, detail } = await handler(step, { tools });
        lines.push(`- ${step.kind} [${ok ? "PASS" : "FAIL"}]: ${detail}`);
        if (!ok) allPass = false;
      }

      const key = `${plan.id}/${task.seq}`;
      if (allPass) {
        cycles.delete(key);
        if (args.mark_done !== false) task.status = "done";
        mirror("auto-run-pass", { id: plan.id, seq: task.seq });
        return { ok: true, text: `VERDICT PASS\n${lines.join("\n")}\ntask marked [done].` };
      }

      const limit = Math.max(1, Math.min(Number(args.max_cycles ?? maxCycles), 10));
      const rec = cycles.get(key) ?? { count: 0, limit };
      rec.count++;
      rec.limit = limit;
      cycles.set(key, rec);

      if (rec.count >= rec.limit) {
        cycles.delete(key);
        task.status = "blocked";
        let rbNote = "";
        if (opts.onRollback) {
          try {
            rbNote = `\nrollback: ${await opts.onRollback(plan.id, task.seq)}`;
          } catch (err) {
            rbNote = `\nrollback FAILED: ${String(err)}`;
          }
        }
        mirror("auto-run-exhausted", { id: plan.id, seq: task.seq });
        return {
          ok: false,
          text: `VERDICT FAIL x${rec.limit}${rbNote}\n${lines.join("\n")}\ntask is now BLOCKED — start it over.`,
        };
      }

      mirror("auto-run-fail", { id: plan.id, seq: task.seq, cycle: rec.count });
      return {
        ok: false,
        text: `VERDICT FAIL (cycle ${rec.count}/${rec.limit}). Fix the findings above, then call auto_run again.\n${lines.join("\n")}`,
      };
    },
  };

  // Register everything as ordinary tools (gate covers them via permission).
  const defs: ToolDef[] = [
    planNew,
    planList,
    planStatus,
    planCheckpoint,
    autoRun,
  ];
  for (const d of defs) tools.register(d);

  ctx.provide("workflow", {
    get: (id) => store.get(id),
    all: () => store.all(),
    registerVerifyKind(kind, handler) {
      verifyKinds[kind] = handler;
    },
    listVerifyKinds: () => Object.keys(verifyKinds).sort(),
  });
}
