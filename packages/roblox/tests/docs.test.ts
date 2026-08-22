import { describe, expect, it, vi } from "vitest";
import { Context } from "@bridle/kernel";
import { sessionPlugin } from "@bridle/session";
import { toolsPlugin, type ToolsService } from "@bridle/tools";
import { workflowPlugin } from "@bridle/workflow";
import {
  FakeStudioTransport,
  DocsMirror,
  curate,
  parseLlmsIndex,
  robloxPlugin,
} from "../src/index.ts";

async function ready(docs?: Parameters<typeof robloxPlugin>[0]["docs"]) {
  const ctx = new Context();
  await ctx.mount({ name: "session", setup: sessionPlugin });
  await ctx.mount({ name: "tools", setup: toolsPlugin });
  await ctx.mount(workflowPlugin());
  await ctx.mount(
    robloxPlugin({ transport: new FakeStudioTransport(), docs }),
  );
  const tools = ctx.requireService("tools") as unknown as ToolsService;
  return { ctx, tools };
}

describe("llms.txt parsing + curation", () => {
  it("parses index entries and curates coding pages, dropping noise", () => {
    const entries = parseLlmsIndex(
      [
        "## Scripting",
        "- [Luau](/docs/en-us/luau.md): the language",
        "- [Remote Events](/docs/en-us/remote.md): networking",
        "## Business",
        "- [Sponsored Ads](/docs/en-us/ads.md): monetization",
        "- [Payouts](/docs/en-us/pay.md): earnings policy",
      ].join("\n"),
    );
    expect(entries).toHaveLength(4);
    const kept = curate(entries).map((e) => e.title);
    expect(kept).toEqual(["Luau", "Remote Events"]); // ads/payouts excluded
  });
});

describe("docs mirror", () => {
  const seed = [
    { title: "DataStore", url: "https://x/datastore.md", body: "DataStoreService GetAsync SetAsync saving player data with budget limits." },
    { title: "Remote Events", url: "https://x/remote.md", body: "RemoteEvent FireServer OnServerEvent client server replication." },
  ];

  it("search ranks by token hits", () => {
    const m = new DocsMirror();
    m.seed(seed);
    expect(m.search("datastore save", 1)[0]!.title).toBe("DataStore");
    expect(m.search("nothing matches zzz", 3)).toHaveLength(0);
  });

  it("injectFor returns excerpt pack within budget; null when no match", () => {
    const m = new DocsMirror();
    m.seed(seed);
    const pack = m.injectFor("how do I save player data with DataStore?", 1500);
    expect(pack).toContain("## Official docs (local mirror)");
    expect(pack).toContain("DataStore");
    expect(pack!.length).toBeLessThanOrEqual(1500);
    expect(m.injectFor("completely unrelated zzz", 1500)).toBeNull();
  });

  it("refresh parses llms.txt, curates, caps page bytes, counts errors", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("llms.txt")) {
        return {
          ok: true, status: 200,
          text: async () =>
            "- [Luau](/docs/en-us/luau.md): lang\n- [Ads](/docs/en-us/ads.md): noise\n",
        };
      }
      if (url.includes("luau")) {
        return { ok: true, status: 200, text: async () => "x".repeat(300_000) };
      }
      return { ok: false, status: 404, text: async () => "" };
    });
    const m = new DocsMirror(fetcher as never);
    const res = await m.refresh(100);
    expect(res.pages).toBe(1); // ads curated out
    expect(res.errors).toBe(0);
    expect(m.size).toBe(1);
    // page body capped at MAX_PAGE_BYTES
    expect(fetcher).toHaveBeenCalledTimes(2); // index + luau only
  });
});

describe("knowledge injection (agent/pre-step)", () => {
  it("rewrites the last user message with docs excerpt when tokens match", async () => {
    const m = new DocsMirror();
    m.seed([
      { title: "DataStore", url: "https://x/ds.md", body: "DataStoreService saving player data." },
    ]);
    const { ctx, tools } = await ready({
      seed: [
        { title: "DataStore", url: "https://x/ds.md", body: "DataStoreService saving player data." },
      ],
    });
    void tools;

    const claimed = ctx.waterfall<{
      messages: Array<{ role: string; text: string }>;
      proceed: boolean;
    }>("agent/pre-step", {
      messages: [
        { role: "user", text: "how do I use DataStore to save player data?" },
      ],
      proceed: true,
    });

    expect(claimed.proceed).toBe(true);
    expect(claimed.messages[0]!.text).toContain("how do I use DataStore");
    expect(claimed.messages[0]!.text).toContain("## Official docs (local mirror)");
  });

  it("leaves messages untouched when nothing matches", async () => {
    const { ctx } = await ready({
      seed: [
        { title: "DataStore", url: "https://x/ds.md", body: "DataStoreService saving." },
      ],
    });
    const claimed = ctx.waterfall<{
      messages: Array<{ role: string; text: string }>;
      proceed: boolean;
    }>("agent/pre-step", {
      messages: [{ role: "user", text: "hello there friend" }],
      proceed: true,
    });
    expect(claimed.messages[0]!.text).toBe("hello there friend");
  });

  it("doc_search is honest when the mirror is empty", async () => {
    const { tools } = await ready();
    const r = await tools.execute("roblox.doc_search", { query: "anything" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("empty");
  });
});
