/**
 * R4 gate: McpStdioTransport mechanics against a deterministic fake
 * StudioMCP child process (newline JSON-RPC, late tools/list, content
 * parsing, argument shapes, unknown-tool honesty).
 *
 * The fixture answers `received <args-json>` for multi_edit/execute_luau so
 * the tests pin EXACTLY the argument shapes this transport emits — those
 * shapes are the thing a first live run may need to correct, in one table.
 */
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { McpStdioTransport } from "../src/mcp-stdio.ts";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-mcp-server.mjs");

const open = (extraArgs: string[] = []) =>
  McpStdioTransport.connect({
    command: process.execPath,
    args: [SERVER, ...extraArgs],
    requestTimeoutMs: 5000,
    toolsReadyTimeoutMs: 8000,
  });

let toClose: McpStdioTransport[] = [];
afterAll(() => {
  for (const t of toClose) t.close();
  toClose = [];
});

describe("McpStdioTransport (R4) vs fake StudioMCP", () => {
  it("handshakes through the LATE tools/list (first list is empty)", async () => {
    const t = await open();
    toClose.push(t);
    expect(t.advertisedTools()).toContain("execute_luau");
    expect(t.kind).toBe("live");
  });

  it("maps reads to tool calls with the documented shapes", async () => {
    const t = await open();
    toClose.push(t);

    const state = await t.getState();
    expect(state.ok).toBe(true);
    expect(state.text).toContain("Studio Mode: Edit");

    const existing = await t.readScript("Game.Existing");
    expect(existing?.source).toBe("print(1)");
    expect(await t.readScript("Game.Missing")).toBeNull();

    const tree = await t.searchGameTree("", 4);
    expect(tree.map((e) => e.fullPath)).toContain("Game.Existing");

    const hits = await t.grepScripts("print");
    expect(hits[0]).toMatchObject({ path: "Game.Existing", line: 1 });

    const shot = await t.screenCapture();
    expect(shot.text).toContain("[images: 1]"); // image content counted

    const inspect = await t.inspectInstance("Game.Existing");
    expect(inspect.text).toContain("(Script)");
  });

  it("multi_edit: real schema (file_path) with create/replace forms, no studio_id", async () => {
    const t = await open();
    toClose.push(t);

    // CREATE: current read returns not-found ⇒ old_string:"" + className
    const create = await t.multiEdit([{ path: "Game.Created", source: "return 42" }]);
    expect(create.text).toContain('"file_path":"Game.Created"');
    expect(create.text).toContain('"old_string":""');
    expect(create.text).toContain('"new_string":"return 42"');
    expect(create.text).toContain('"className":"Script"');

    // REPLACE: Game.Existing exists ⇒ old_string must be its FULL source.
    const replace = await t.multiEdit([{ path: "Game.Existing", source: "print(2)" }]);
    expect(replace.text).toContain('"file_path":"Game.Existing"');
    expect(replace.text).toContain('"old_string":"print(1)"');
    expect(replace.text).toContain('"new_string":"print(2)"');
    expect(replace.text).toContain('"datamodel_type":"Edit"');
    void create;
  });

  it("sends NO studio_id at all — the field ZeroScript proved unnecessary", async () => {
    const t = await open();
    toClose.push(t);
    // The multi_edit echo carries the full arguments object — assert the
    // absence of the key the advertised schema falsely calls required.
    const r = await t.multiEdit([{ path: "Game.Existing", source: "print(3)" }]);
    expect(r.text).not.toContain("studio_id");
  });

  it("argument shapes are pinned via the fixture echo", async () => {
    const t = await open();
    toClose.push(t);

    // execute_luau carries datamodel_type:"Edit"
    const luau = await t.executeLuau("x=1");
    expect(luau.text).toContain("datamodel_type=Edit");

    // start_stop_play carries is_start boolean both ways
    expect((await t.startStopPlay(true)).text).toBe("play started");
    expect((await t.startStopPlay(false)).text).toBe("play stopped");

    // get_console_output forwards max_lines as max_lines
    const con = await t.getConsole(7);
    expect(con.ok).toBe(true);
  });

  it("unit_test marker flows through the live path untouched", async () => {
    const t = await open();
    toClose.push(t);
    const out = await t.executeLuau('print("BRIDLE_TEST_PASS")');
    expect(out.text).toBe("BRIDLE_TEST_PASS");
  });

  it("minimal server: missing tools fail honestly listing what IS available", async () => {
    const t = await open(["--minimal"]);
    toClose.push(t);
    expect(t.advertisedTools()).toEqual(["get_studio_state"]);
    await expect(t.screenCapture()).rejects.toThrow(/screen_capture.*Available: get_studio_state/s);
  });
});
