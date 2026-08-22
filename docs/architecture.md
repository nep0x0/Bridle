# bridle — Architecture (M0)

**You don't replace the horse.** bridle turns web AI chats into real agents.
This document records the engineering decisions made so far. It is the
provenance record for the clean-room implementation.

## Provenance

- **License**: GPL-3.0-or-later.
- This codebase is written **from scratch in TypeScript**. It is *inspired
  by* the architecture of three projects: ZeroScript-Free (GPL-3.0), DeepSeek
  Harness `dsh` (MIT, TypeScript, cordis-based) and Cordis (MIT). No source
  lines were copied from any of them. Where a concept is adopted from dsh's
  published architecture document (session-log invariant, waterfall events,
  capability seams, profiles/bundles), that is noted inline as `Adopted: dsh`.
- The npm `cordis` package was evaluated and found to expose only low-level
  primitives (fiber/registry/events); even dsh vendors it rather than
  consuming it directly. Decision: implement a thin, compatible kernel
  ourselves (`@bridle/kernel`) so the lifecycle semantics stay fully under
  our control; revisit vendoring if interop with the cordis ecosystem becomes
  a goal.

## Kernel (`@bridle/kernel`)

Five ideas (cordis-paradigm, clean-room implementation):

1. **A plugin is `{name, requires?, setup(ctx)}`.** Load order is expressed
   through service requirements, never manual boot sequencing.
2. **A Context is a repository of services.** Services claim stable keys
   (`ctx.provide("tools", api)`); consumers resolve them via
   `ctx.service("tools")` (async) or `requireService` (sync). Extend
   `ServiceMap` via declaration merging for typing.
3. **Typed events with four dispatch modes**, chosen per call site:
   `emit` (observe), `waterfall` (around-middleware with short-circuit),
   `parallel`, `serial`. Extend `EventMap` via declaration merging.
4. **Registrations are reversible effects.** Everything installed during a
   plugin's setup is tagged with its name; `unmount(name)` unwinds LIFO and
   drops its listeners. Failed setup leaves no residue.
5. **The host application is itself just a plugin.**

## Adopted: dsh (from docs/architecture.md of DeepSeek Harness)

- *Model-visible means logged*: the durable session log will be the only
  source of model context (planned M1).
- *Waterfall interception points* around requests and tool executions
  (`agent/pre-step`, `tools/pre-execute` equivalents) — permission gates and
  prompt rewriting become ordinary listeners.
- *Capability seams*: a swappable capability = Service Definition + Provider
  + Consumer.
- *Profiles/bundles/patch layers* for composition (planned M4+).

## Roadmap

| Milestone | Scope | Gate |
|---|---|---|
| M0 ✅ | kernel: context/events/effects/injection | build+test green, demo runs |
| M1 ✅ | session log (logged=visible prefix invariant) + tools pipeline + agent loop plugin | 18 tests incl. reject/rewrite/maxSteps/fork-replay |
| M2 ✅ | llm seam + OpenAI-compatible adapter + headless bundle & CLI | E2E over real HTTP: tool-call round trip vs local mock |
| M3 ◐ | webchat gateway ws + browser extension + deepseek/gemini adapters | live chat E2E |
| M4 | security gate/audit + workflow pack (plans/auto_run/scaffold) | harness verify suite |
| M5 | roblox domain plugin | roblox verify suite vs live Studio |
| M6 | demo-fs domain + plugin cookbook + npm publish | third-party plugin guide |

## M3 progress notes (2026-08-22)

Gateway and the first extension adapter exist; the *live chat* E2E is still
the open gate for M3.

- **Protocol** (`@bridle/gateway-ws`, JSON frames over ws): gateway → adapter
  `{capabilities, tools}` on connect, then per turn `{render_request, id,
  messages, tools}`; adapter → `{render_result, id, ok, text, toolCalls?,
  error?}`; keep-alive `ping`/`pong`; and an explicit
  `{adapter_ready, url}` announcement when a content adapter attaches its
  port — a bare socket is not readiness (the MV3 service worker connects
  long before any tab does). The browser-side counterpart lives in
  `extension/` (MV3 service worker owns the socket with a 10s heartbeat;
  content adapters speak a `bridle-adapter` port and reconnect with backoff
  when the worker is recycled).
- **Tool wire format** (`extension/content/bridle-wire.js`): web chats have no
  function-calling channel, so tool calls ride in reply text as fenced
  ` ```bridle-tool ``` ` blocks (`{"name","args"}` or `{"calls":[...]}`);
  results are fed back as `⟦TOOL ok|error name⟧…⟦/TOOL⟧`. Concept adopted
  from ZeroScript-Free's command-in-fenced-block mechanism (see Provenance);
  expression is original and DOM-free so Node tests exercise the shipped file.
- **Fixed port seam**: `EXTENSION_DEFAULT_PORT = 8642` matches the compiled-in
  default of the extension's service worker.
- **Bugfix (gateway)**: `close()` used to hang forever while an adapter stayed
  connected — `WebSocketServer.close()` never fires its callback on open
  sockets. It now force-terminates tracked connections first. Regression-
  covered by the E2E teardown.
- **Automated gate** (browser-free half): `bundles/headless/tests/
  webchat.e2e.test.ts` runs a full harness turn through real ws frames using
  the shipped wire parser — capabilities listing, messy tool-call round trip
  (prose + unterminated fence), and honest close when a block fails to parse.

## Clean-room working rules

1. Never open a GPL file to "port" it; write from this document.
2. Concepts may be shared; expression may not.
3. If relicensing to MIT ever desired: obtain written permission from the
   ZeroScript-Free author, or prove every file's independent authorship via
   git history from day one.
