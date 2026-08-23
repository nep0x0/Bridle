#!/usr/bin/env node
/**
 * bridle — the unified CLI.
 *
 *   bridle run "<prompt>"        one-shot turn via an OpenAI-compatible API
 *                                 (env: BRIDLE_BASE_URL / BRIDLE_API_KEY /
 *                                  BRIDLE_MODEL)
 *   bridle webchat [flags]       live REPL whose brain is a real web-chat
 *                                 tab through the bridle bridge extension
 *                                 (flags: --roblox --allow t1,t2 --verbose)
 *   bridle help                  this text
 *
 * Tip for a two-keystroke life:
 *   cd bundles/headless && pnpm link --global
 *   … then `bridle webchat --roblox` works from anywhere
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const webchatMain = async (...a) =>
  (await import(pathToFileURL(here + "webchat-main.mjs"))).main(...a);

const HELP = `bridle — universal web-chat agent harness

USAGE
  bridle run "<prompt>"          one-shot turn over an OpenAI-compatible API
  bridle webchat [flags] [task]  live REPL; brain = your browser chat tab
  bridle help                    show this text

WEBCHAT FLAGS
  --roblox              mount the Roblox domain (live Studio if configured)
  --allow t1,t2         auto-approve these tools; others ask y/N in terminal
  --verbose             dump the durable session log after every turn
  env: BRIDLE_SKIP_ADAPTER_WAIT=1 skips waiting for the chat tab

EXAMPLES
  bridle webchat --roblox --allow roblox.execute_luau,roblox.search_game_tree \\
      "Create a red Part named RedBlock at (0,5,0)"
  BRIDLE_BASE_URL=https://api.deepseek.com BRIDLE_API_KEY=sk-… \\
  BRIDLE_MODEL=deepseek-chat bridle run "What is 12*9? Use the math tool."
`;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const rest = argv.slice(1);

switch (cmd) {
  case "run": {
    const prompt = rest.join(" ").trim();
    if (!prompt) {
      console.error('usage: bridle run "<prompt>"');
      console.error("env: BRIDLE_BASE_URL, BRIDLE_API_KEY, BRIDLE_MODEL");
      process.exit(2);
    }
    const { baseUrl, apiKey, model } = process.env;
    if (!baseUrl || !apiKey || !model) {
      console.error("missing env: BRIDLE_BASE_URL / BRIDLE_API_KEY / BRIDLE_MODEL");
      process.exit(2);
    }
    const { createBridle } = await import("../dist/index.js");
    const bridle = await createBridle({
      llm: { baseUrl, apiKey, model, timeoutMs: 120_000 },
    });
    const result = await bridle.run(prompt);
    if (result.rejected) {
      console.error(`rejected: ${result.rejected}`);
      process.exit(1);
    }
    console.log(result.text || "(empty response)");
    break;
  }
  case "webchat":
  case "chat":
    await webchatMain(rest);
    break;
  case "help":
  case "--help":
  case "-h":
  default:
    if (cmd !== "help" && !cmd.startsWith("-")) {
      console.error(`unknown command "${cmd}"\n`);
    }
    console.log(HELP);
    if (cmd !== "help" && !cmd.startsWith("-")) process.exit(2);
}
