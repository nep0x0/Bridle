/**
 * bridle TUI — the interactive REPL, Ink-powered (same tech as Claude Code
 * and Gemini CLI): transcript above, bordered input box below, spinner while
 * the model thinks.
 *
 * Runs only on a real terminal (TTY). Pipes/CI fall back to the plain
 * readline REPL automatically.
 *
 * Everything shown here is still plugin-first: progress lines arrive via the
 * turnProgressPlugin sink, slash commands dispatch through the commands
 * service — this file owns PRESENTATION only.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";

export type EntryKind = "you" | "info" | "ok" | "err" | "sys";
export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

export interface SinkRef {
  current: (kind: EntryKind, text: string) => void;
}

export interface TuiHeader {
  tools: number;
  studio?: string | null;
}

export interface TuiOptions {
  bridle: any; // Bridle instance (kept loose: presentation only)
  commands: import("@bridle/kernel").ServiceMap["commands"];
  initialPrompt?: string;
  verbose: boolean;
  /** Mutable sink the caller wires into turnProgressPlugin. */
  sinkRef: SinkRef;
  header?: TuiHeader;
  onClose(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function deco(entry: Entry): { prefix: string; color?: string } {
  if (entry.kind === "you") return { prefix: "❯ ", color: "cyan" };
  if (entry.kind === "ok") return { prefix: "✓ ", color: "green" };
  if (entry.kind === "err") return { prefix: "✗ ", color: "red" };
  if (entry.kind === "sys") return { prefix: "◆ ", color: "magenta" };
  if (/^→ tool /.test(entry.text)) return { prefix: "", color: "gray" };
  if (/^result /.test(entry.text))
    return entry.text.startsWith("result ok")
      ? { prefix: "", color: "green" }
      : { prefix: "", color: "red" };
  return { prefix: "", color: undefined };
}

function colorFor(kind: EntryKind): string | undefined {
  switch (kind) {
    case "you":
      return "cyan";
    case "ok":
      return "green";
    case "err":
      return "red";
    case "sys":
      return "magenta";
    default:
      return undefined;
  }
}

const PREFIX: Record<EntryKind, string> = {
  you: "❯ ",
  info: "",
  ok: "✓ ",
  err: "✗ ",
  sys: "· ",
};

export function runTuiRepl(opts: TuiOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const instance = render(<ReplApp {...opts} onDone={resolve} />);
    void instance.waitUntilExit();
  });
}

function ReplApp(props: TuiOptions & { onDone(): void }) {
  const { bridle, commands, verbose, sinkRef, header, onDone } = props;
  const app = useApp();

  const [entries, setEntries] = useState<Entry[]>([]);
  const idRef = useRef(0);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [caption, setCaption] = useState("");
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);

  // Expose push() to imperative callers (progress sink, runTurn, …).
  const push = (kind: EntryKind, text: string) =>
    setEntries((prev) => [...prev, { id: ++idRef.current, kind, text }]);
  sinkRef.current = (kind, text) => {
    if (busy) setCaption(text.replace(/^[→✓✗·■]+\s*/, ""));
    push(kind, text);
  };

  // Capture stray console output so nothing corrupts the frame.
  useEffect(() => {
    const orig = { log: console.log, info: console.info, error: console.error };
    console.log = (...a: unknown[]) => push("info", a.map(String).join(" "));
    console.info = (...a: unknown[]) => push("info", a.map(String).join(" "));
    console.error = (...a: unknown[]) => push("err", a.map(String).join(" "));
    return () => {
      console.log = orig.log;
      console.info = orig.info;
      console.error = orig.error;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spinner frames only while a turn is running.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsed(0);
    const iv = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 100);
    return () => clearInterval(iv);
  }, [busy]);

  async function runTurn(text: string) {
    setBusy(true);
    try {
      const res = await bridle.run(text);
      if (res.rejected) {
        push("err", `rejected: ${res.rejected}`);
      } else {
        if (verbose) {
          for (const e of bridle.log.all()) {
            push(
              "info",
              `${String(e.id).padStart(3)} ${e.type.padEnd(18)} ${JSON.stringify(e.payload).slice(0, 110)}`,
            );
          }
        }
        push("ok", `steps ${res.steps} — ${res.text || "(empty response)"}`);
      }
    } catch (err) {
      push("err", `turn failed honestly: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setBusy(false);
      const next = queueRef.current.shift();
      if (next) void runTurn(next);
    }
  }

  function finish() {
    props.onClose();
    app.exit(); // tears down the instance; waitUntilExit() resolves
    onDone();
  }

  function submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    if (/^(exit|quit|keluar)$/i.test(text)) return finish();
    push("you", text);
    if (text.startsWith("/")) {
      void commands
        .dispatch(text, { log: (l: string) => push("info", l) })
        .catch((e: unknown) => push("err", String((e as Error)?.message ?? e)));
      return;
    }
    if (runningRef.current) {
      queueRef.current.push(text);
      push("sys", "queued — turn in progress");
      return;
    }
    runningRef.current = true;
    void runTurn(text).then(() => {
      runningRef.current = false;
    });
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") return finish();
    if (key.return) return submit(value);
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.tab &&
      !key.pageUp &&
      !key.pageDown
    ) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry) => {
          const d = deco(entry);
          const legacyPrefix = PREFIX[entry.kind];
          return (
            <Box key={entry.id} paddingLeft={1} paddingRight={1}>
              <Text color={d.color} wrap="end">
                {(d.prefix || legacyPrefix) + entry.text}
              </Text>
            </Box>
          );
        }}
      </Static>

      <Box
        borderStyle="round"
        borderColor={busy ? "#8a7a3a" : "#4a5a8a"}
        paddingX={1}
        flexDirection="column"
      >
        {/* header status — selalu terlihat, menempel di kotak input */}
        <Box justifyContent="space-between" marginBottom={0}>
          <Text bold color="#7aa2ff">
            BRIDLE
          </Text>
          <Text dimColor>
            {header?.tools ?? 0} tools
            {header?.studio ? ` · studio: ${header.studio}` : ""}
          </Text>
        </Box>
        <Box>
          <Box marginRight={1}>
            <Text color={busy ? "yellow" : "green"}>
              {busy ? `${FRAMES[frame]} ` : "❯ "}
            </Text>
          </Box>
          {value ? (
            <Text>{value}</Text>
          ) : busy ? (
            <Text dimColor>{caption || "menunggu balasan model…"}</Text>
          ) : (
            <Text dimColor>ketik prompt… (/help untuk perintah)</Text>
          )}
        </Box>
        <Box justifyContent="space-between" marginTop={0}>
          <Text dimColor>/help · ctrl+c keluar</Text>
          {busy && (
            <Text color="yellow">
              {elapsed}s · input otomatis mengantre
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
