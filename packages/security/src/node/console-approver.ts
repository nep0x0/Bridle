/**
 * bridle security — Node-only interactive approver.
 *
 * The kernel waterfall is SYNCHRONOUS, so an "ask" approver must block the
 * thread to wait for a human. Recipe (same trick Node CLIs use): a worker
 * thread reads stdin and publishes the verdict into a SharedArrayBuffer;
 * the main thread parks itself in Atomics.wait until notified. Works only
 * under Node — hence the separate "@bridle/security/node" entry point.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Worker } from "node:worker_threads";
import type { Approver } from "../index.js";

export interface ConsoleApproverOptions {
  /** Extra text shown after the y/N prompt. */
  hint?: string;
}

export function blockingConsoleApprover(opts: ConsoleApproverOptions = {}): Approver {
  let worker: Worker | undefined;
  let sab: SharedArrayBuffer | undefined;

  function ensureWorker(): void {
    if (worker) return;
    sab = new SharedArrayBuffer(8);
    // Workers do not inherit stdin unless stdin:true — without it the
    // readline below never fires and every ask would hang forever.
    worker = new Worker(
      `
      const { workerData } = require("node:worker_threads");
      const rl = require("node:readline").createInterface({
        input: process.stdin,
        terminal: false,
        crlfDelay: Infinity,
      });
      const arr = new Int32Array(workerData.sab);
      rl.on("line", (line) => {
        const yes = /^\\s*(y|yes|ya|ok|approve)\\s*$/i.test(line.trim());
        Atomics.store(arr, 0, yes ? 1 : 0);
        Atomics.notify(arr, 0);
      });
      `,
      { eval: true, workerData: { sab }, stdin: true },
    );
  }

  return (req, cls) => {
    ensureWorker();
    const arr = new Int32Array(sab!);
    process.stdout.write(
      `[bridle approve] ${req.name} (${cls}) — allow? [y/N] ${opts.hint ?? ""}\n> `,
    );
    Atomics.store(arr, 0, -1);
    Atomics.wait(arr, 0, -1);
    return Atomics.load(arr, 0) === 1;
  };
}
