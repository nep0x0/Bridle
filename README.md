# bridle

> **You don't replace the horse.**
> A universal agent harness that turns web AI chats into real agents —
> GPL-3.0-or-later, TypeScript, powered by a Cordis-style plugin kernel.

**Status: `M3 ✅ — webchat bridge live` (pre-alpha, API will change).**
A real web-chat tab (chat.deepseek.com) now drives the harness end to end:
prompt rendered by the browser extension, tool calls executed locally,
results fed back into the chat — no API key.

Most AI chat sites give you a brilliant brain with no hands. bridle is the
harness: it normalizes any web-chat model into a tool-calling agent loop,
grounds it in local knowledge, enforces verification before "done", and
audits every action.

Everything is a plugin — including the agent loop itself. The `roblox`
domain (Studio inspect/edit/playtest, Luau linting, docs mirror) is just one
installable plugin, not the product.

## Principles

1. **Web AI stays the reasoning engine.** No local LLM, no fine-tuning.
2. **Model-visible means logged.** Anything that reaches a request must be
   reconstructable from the durable session log.
3. **Registrations are reversible effects.** Plugins mount and unmount
   cleanly; nothing leaks.
4. **Enforcement over hope.** Verification gates and permission classes are
   structural, not prompt advice.
5. **Honesty.** Unresolved references are reported, never guessed.

## Packages

| Package | Owns |
|---|---|
| `@bridle/kernel` | Context, typed events (`emit/waterfall/parallel/serial`), reversible effects, service injection |
| `@bridle/session` | Durable append-only session log; *model-visible means logged* |
| `@bridle/tools` | Tool registry + guarded pipeline (`tools/pre-execute` waterfall deny/mutate, post-execute audit) |
| `@bridle/agent` | The agent loop **as a plugin**: turn/step driver over the session log |
| `@bridle/llm` | Canonical adapter seam + OpenAI-compatible provider (DeepSeek, Groq, Ollama, ...) |
| `@bridle/security` | Permission-class gate (`read/write/execute`, allow/ask/deny) over `tools/pre-execute` + durable audit trail |
| `@bridle/headless` | One-call wiring (`createBridle`) + the `bridle` CLI |
| `extension/` | Browser extension (MV3): web-chat render adapters over the gateway protocol — M3, WIP, see [extension/README.md](./extension/README.md) |

## Quick start (headless)

```sh
BRIDLE_BASE_URL=https://api.deepseek.com \
BRIDLE_API_KEY=sk-... \
BRIDLE_MODEL=deepseek-chat \
pnpm --filter @bridle/headless exec bridle "What is 12*9? Use the math tool."
```

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).

Clean-room note: this implementation is written from scratch in TypeScript.
It is *inspired by* the architecture of ZeroScript-Free (GPL-3.0), DeepSeek
Harness (MIT) and Cordis (MIT) — no source lines were copied from them.
See [docs/architecture.md](./docs/architecture.md#provenance).
