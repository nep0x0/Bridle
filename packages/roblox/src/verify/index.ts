/**
 * bridle roblox domain — verify kinds (R3).
 *
 * These plug into the workflow pack's auto_run via registerVerifyKind, so
 * "done" is machine-enforced: lint must be clean, docs must recognise the
 * APIs used, unit tests must print their pass marker, and playtests must
 * run without error-looking console lines.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { StudioTransport } from "../transport.ts";
import type { DocsMirror } from "../knowledge/docs.ts";
import type { VerifyHandler } from "@bridle/workflow";

export const TEST_PASS_MARKER = "BRIDLE_TEST_PASS";

// ── deterministic lint ───────────────────────────────────────────────────

export interface LintFinding {
  path: string;
  line: number;
  severity: "error" | "info";
  rule: string;
  message: string;
}

const LEGACY_RE = /\b(wait|spawn|delay|tick)\s*\(/;

/** String-aware paren balance + legacy-API + print rules. */
export function lintSource(path: string, source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\n") line++;
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) {
        findings.push({
          path,
          line,
          severity: "error",
          rule: "paren-balance",
          message: "unbalanced ')' before any '('",
        });
        depth = 0; // keep scanning; report once per offender
      }
    }
  }
  if (depth !== 0) {
    findings.push({
      path,
      line,
      severity: "error",
      rule: "paren-balance",
      message: `${depth} unclosed '(' at end of file`,
    });
  }

  source.split("\n").forEach((text, idx) => {
    if (LEGACY_RE.test(text)) {
      findings.push({
        path,
        line: idx + 1,
        severity: "error",
        rule: "legacy-api",
        message: `legacy call: ${text.trim().slice(0, 60)} — use task.wait/task.spawn/task.delay/os.clock`,
      });
    } else if (/\bprint\s*\(/.test(text)) {
      findings.push({
        path,
        line: idx + 1,
        severity: "info",
        rule: "print",
        message: "print() left in source",
      });
    }
  });
  return findings;
}

// ── API-token extraction (for the docs kind) ────────────────────────────

const GETSERVICE_RE = /GetService\(\s*["'](\w+)["']\s*\)/g;

export function extractServiceTokens(source: string): string[] {
  return [...new Set([...source.matchAll(GETSERVICE_RE)].map((m) => m[1]!))];
}

// ── the four kinds ───────────────────────────────────────────────────────

export function makeVerifyKinds(
  transport: StudioTransport,
  mirror: DocsMirror | null,
): Record<string, VerifyHandler> {
  const lint: VerifyHandler = async (step) => {
    const paths =
      (step as { paths?: string[] }).paths ??
      (await transport.listScripts()).map((s) => s.path);
    if (paths.length === 0) {
      return { ok: true, detail: "no scripts to lint (empty place)" };
    }
    const findings: LintFinding[] = [];
    for (const path of paths) {
      const s = await transport.readScript(path);
      if (s) findings.push(...lintSource(path, s.source));
    }
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length > 0) {
      return {
        ok: false,
        detail: errors
          .slice(0, 5)
          .map((f) => `${f.path}:${f.line} [${f.rule}] ${f.message}`)
          .join(" | "),
      };
    }
    const infos = findings.length - errors.length;
    return {
      ok: true,
      detail: `lint clean (${infos} info finding${infos === 1 ? "" : "s"})`,
    };
  };

  const docs: VerifyHandler = async (step) => {
    const paths =
      (step as { paths?: string[] }).paths ??
      (await transport.listScripts()).map((s) => s.path);
    if (!mirror || mirror.size === 0) {
      return { ok: true, detail: "docs mirror empty — run roblox.doc_refresh (skipped, honest)" };
    }
    const unknown: string[] = [];
    let checked = 0;
    for (const path of paths) {
      const s = await transport.readScript(path);
      if (!s) continue;
      for (const svc of extractServiceTokens(s.source)) {
        checked++;
        if (mirror.search(svc, 1).length === 0) unknown.push(svc);
      }
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        detail: `APIs not found in official docs: ${[...new Set(unknown)].join(", ")}`,
      };
    }
    return {
      ok: true,
      detail: `${checked} service usage(s) verified against the docs mirror`,
    };
  };

  const unit_test: VerifyHandler = async (step) => {
    const code = (step as { code?: string }).code ?? "";
    if (!code.trim()) {
      return { ok: false, detail: "unit_test step needs 'code' printing BRIDLE_TEST_PASS" };
    }
    const out = await transport.executeLuau(code);
    const passed = out.text.includes(TEST_PASS_MARKER);
    return {
      ok: passed,
      detail: passed ? "marker received" : `no ${TEST_PASS_MARKER} in output: ${out.text.slice(0, 80)}`,
    };
  };

  const playtest: VerifyHandler = async (step) => {
    // Baseline BEFORE entering play so old lines are never misjudged.
    const before = (await transport.getConsole(500)).text;
    await transport.startStopPlay(true);
    try {
      // Give the game a real moment to run before reading the console:
      // errors do not appear instantaneously after Start (in live Studio
      // this read would otherwise almost always be premature).
      const settleMs = Math.max(
        0,
        Number((step as { settle_ms?: number }).settle_ms ?? 200),
      );
      if (settleMs > 0) {
        await new Promise((r) => setTimeout(r, settleMs));
      }
      const res = await transport.getConsole(500);
      const newLines = res.text
        .split("\n")
        .filter((l) => l && !before.includes(l));
      const errors = newLines.filter((l) => /error|failed|exception/i.test(l));
      if (errors.length > 0) {
        return {
          ok: false,
          detail: `console errors during play: ${errors[0]!.slice(0, 120)}`,
        };
      }
      return { ok: true, detail: "play session clean (no error-looking lines)" };
    } finally {
      await transport.startStopPlay(false); // always stop, even on FAIL
    }
  };

  return { lint, docs, unit_test, playtest };
}
