#!/usr/bin/env node
// Thin alias kept for compatibility: `bridle-webchat …` === `bridle webchat …`
import { pathToFileURL } from "node:url";
const here = new URL(".", import.meta.url).pathname;
await import(pathToFileURL(here + "webchat-main.mjs")).then((m) =>
  m.main(process.argv.slice(2)),
);
