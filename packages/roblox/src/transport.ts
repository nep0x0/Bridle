/**
 * bridle roblox domain — the Studio transport seam.
 *
 * A transport is all the domain knows about Studio: tools go in, JSON
 * results come out. Two implementations:
 *   - FakeStudioTransport (in-memory, deterministic, CI)
 *   - McpStdioTransport   (R4: JSON-RPC over stdio to StudioMCP.exe)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface StudioResult {
  ok: boolean;
  text: string;
}

export interface StudioTreeEntry {
  fullPath: string;
  name: string;
  className: string;
  parentName?: string;
}

export interface StudioScript {
  path: string;
  className: string;
  source: string;
}

/** The contract every tool talks to. Domain code never imports a concrete
 *  implementation — the plugin wires one in via options. */
export interface StudioTransport {
  readonly kind: "fake" | "live";

  // reads
  getState(): Promise<StudioResult>;
  getConsole(maxLines?: number): Promise<StudioResult>;
  searchGameTree(path: string, maxDepth: number): Promise<StudioTreeEntry[]>;
  inspectInstance(path: string): Promise<StudioResult>;
  readScript(path: string): Promise<StudioScript | null>;
  listScripts(): Promise<StudioScript[]>;
  /** Studio instances attached to the MCP proxy — this is where the PLACE
   *  NAME lives (e.g. "ai play test (placeId: …)"). get_studio_state only
   *  reports mode/datamodels, never the project name. */
  listStudios(): Promise<Array<{ id?: string; name?: string }>>;
  grepScripts(pattern: string): Promise<Array<{ path: string; line: number; text: string }>>;
  screenCapture(): Promise<StudioResult>;

  // writes / execution (R1 uses these; declared now so the seam is stable)
  multiEdit(edits: Array<{ path: string; source: string }>): Promise<StudioResult>;
  executeLuau(code: string): Promise<StudioResult>;
  startStopPlay(start: boolean): Promise<StudioResult>;
}
