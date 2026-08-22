/**
 * Test fixture: a deterministic fake StudioMCP server speaking
 * newline-delimited JSON-RPC 2.0 over stdio — enough of the real contract
 * to exercise McpStdioTransport end to end:
 *   - tools/list returns [] on the FIRST call (late backend attach) and the
 *     full catalogue afterwards, forcing the transport's retry loop
 *   - every tools/call answers `received <json-arguments>` so tests can
 *     assert EXACTLY what argument shapes the transport produced
 *   - --minimal advertises only get_studio_state (unknown-tool honesty)
 */
import readline from "node:readline";

const minimal = process.argv.includes("--minimal");

const ALL_TOOLS = [
  "get_studio_state",
  "get_console_output",
  "search_game_tree",
  "inspect_instance",
  "script_read",
  "script_grep",
  "screen_capture",
  "multi_edit",
  "execute_luau",
  "start_stop_play",
];

const SCRIPTS = {
  "Game.Existing": {
    path: "Game.Existing",
    className: "Script",
    source: "print(1)",
  },
};

let listCalls = 0;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) + "\n",
  );
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-studiomcp", version: "0.1.0" },
    });
    return;
  }
  if (method === "tools/list") {
    listCalls++;
    // First call is always empty (late backend attach); afterwards minimal
    // mode advertises exactly one tool so unknown-tool paths stay testable.
    const names = listCalls === 1
      ? []
      : minimal
        ? ["get_studio_state"]
        : ALL_TOOLS;
    respond(id, { tools: names.map((name) => ({ name })) });
    return;
  }
  if (method === "tools/call") {
    const name = params.name;
    if (!minimal && !ALL_TOOLS.includes(name)) {
      respondError(id, `unknown tool ${name}`);
      return;
    }
    const args = params.arguments ?? {};
    const echo = (text) => respond(id, { content: [{ type: "text", text }] });

    switch (name) {
      case "get_studio_state":
        return echo("Current Studio Mode: Edit");
      case "get_console_output":
        return echo("[play] DataModel Client Loading");
      case "search_game_tree":
        return echo(
          JSON.stringify([
            { fullPath: "Workspace", name: "Workspace", className: "Workspace" },
            { fullPath: "Game.Existing", name: "Existing", className: "Script" },
          ]),
        );
      case "inspect_instance":
        return echo(`${args.path} (Script) parent=Game`);
      case "script_read": {
        const s = SCRIPTS[args.target_file];
        return s ? echo(JSON.stringify(s)) : echo(`script not found: ${args.target_file}`);
      }
      case "script_grep":
        return echo(`${Object.keys(SCRIPTS)[0]}:1: print(1)`);
      case "screen_capture":
        return respond(id, {
          content: [
            { type: "text", text: "screenshot attached" },
            { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
          ],
        });
      case "multi_edit":
        return echo(`received ${JSON.stringify(args)}`);
      case "execute_luau":
        return echo(
          String(args.code ?? "").includes("BRIDLE_TEST_PASS")
            ? "BRIDLE_TEST_PASS"
            : `received datamodel_type=${args.datamodel_type}`,
        );
      case "start_stop_play":
        return echo(args.is_start ? "play started" : "play stopped");
      default:
        return echo("(noop)");
    }
  }
});
