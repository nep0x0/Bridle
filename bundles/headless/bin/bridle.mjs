#!/usr/bin/env node
/**
 * bridle CLI (M2): one-shot turn against an OpenAI-compatible endpoint.
 *
 *   BRIDLE_BASE_URL=https://api.deepseek.com \
 *   BRIDLE_API_KEY=sk-... \
 *   BRIDLE_MODEL=deepseek-chat \
 *   bridle "What is 12*9? Use the math tool."
 */

import { createBridle } from "../dist/index.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('usage: bridle "<prompt>"');
  console.error("env: BRIDLE_BASE_URL, BRIDLE_API_KEY, BRIDLE_MODEL");
  process.exit(2);
}
const { baseUrl, apiKey, model } = process.env;
if (!baseUrl || !apiKey || !model) {
  console.error("missing env: BRIDLE_BASE_URL / BRIDLE_API_KEY / BRIDLE_MODEL");
  process.exit(2);
}

const bridle = await createBridle({
  llm: { baseUrl, apiKey, model, timeoutMs: 120_000 },
});

const result = await bridle.run(prompt);
if (result.rejected) {
  console.error(`rejected: ${result.rejected}`);
  process.exit(1);
}
console.log(result.text || "(empty response)");
