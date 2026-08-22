/**
 * bridle roblox domain — Docs Mirror (R2).
 *
 * Web chat models are trained on stale API knowledge; the mirror grounds
 * them in the CURRENT official documentation. Roblox publishes an llms.txt
 * index FOR code agents; we curate the core scripting pages, cache them
 * locally (capped), and inject short excerpts into the model's context when
 * its message touches a known API — through the agent/pre-step waterfall,
 * so the rewrite stays inside the logged request (invariant intact).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const LLMS_URL = "https://create.roblox.com/docs/llms.txt";
const BASE_URL = "https://create.roblox.com";
export const MAX_PAGE_BYTES = 256 * 1024;

/** Core scripting topics worth mirroring; noise topics are excluded. */
const CURATE_KEYWORDS = [
  "luau", "script", "remote", "datastore", "memory store",
  "constraint", "physics", "raycast", "collision",
  "gui", "user interface", "input", "animation", "audio", "sound",
  "particle", "player", "character", "humanoid", "camera", "team",
  "collectionservice", "attribute", "instance", "workspace", "terrain",
  "lighting", "teleport", "marketplaceservice",
];
const EXCLUDE_KEYWORDS = [
  "monetization", "analytics", "advertis", "policy", "licens",
  "publish", "release", "community", "copyright", "payout", "talent",
];

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface MirrorPage {
  title: string;
  url: string;
  body: string;
}

/** Parse an llms.txt index into entries. */
export function parseLlmsIndex(text: string): Array<{ title: string; path: string }> {
  const out: Array<{ title: string; path: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^-\s*\[([^\]]+)\]\((\/[^)]+\.md)\)/.exec(line.trim());
    if (m) out.push({ title: m[1]!, path: m[2]! });
  }
  return out;
}

/** Keep coding-relevant pages, drop noise, cap count. */
export function curate(
  entries: Array<{ title: string; path: string }>,
  maxPages = 100,
): Array<{ title: string; path: string }> {
  const out: Array<{ title: string; path: string }> = [];
  for (const e of entries) {
    if (out.length >= maxPages) break;
    const hay = e.title.toLowerCase();
    if (EXCLUDE_KEYWORDS.some((k) => hay.includes(k))) continue;
    if (!CURATE_KEYWORDS.some((k) => hay.includes(k))) continue;
    out.push(e);
  }
  return out;
}

function tokenize(q: string): string[] {
  return (q.toLowerCase().match(/[a-z0-9_.:-]+/g) ?? []).slice(0, 12);
}

export class DocsMirror {
  #pages: MirrorPage[] = [];
  #refreshedAt = 0;

  constructor(private fetcher: Fetcher = fetch as unknown as Fetcher) {}

  get size(): number {
    return this.#pages.length;
  }
  get refreshedAt(): number {
    return this.#refreshedAt;
  }

  /** Seed directly (tests / cache loading). */
  seed(pages: MirrorPage[]): void {
    this.#pages = pages.slice(0, 400);
    this.#refreshedAt = Date.now();
  }

  /** Download the curated mirror. Returns an honest summary; per-page
   *  failures are counted, never fatal. */
  async refresh(maxPages = 100, log?: (m: string) => void): Promise<{
    pages: number;
    bytes: number;
    errors: number;
  }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let indexText: string;
    try {
      const res = await this.fetcher(LLMS_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`llms.txt http ${res.status}`);
      indexText = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const pages = curate(parseLlmsIndex(indexText), maxPages);
    log?.(`docs mirror: ${pages.length} page(s) selected from index`);

    const out: MirrorPage[] = [];
    let bytes = 0;
    let errors = 0;
    for (const p of pages) {
      try {
        const res = await this.fetcher(BASE_URL + p.path);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const body = (await res.text()).slice(0, MAX_PAGE_BYTES);
        out.push({ title: p.title, url: BASE_URL + p.path, body });
        bytes += body.length;
      } catch {
        errors++;
      }
    }
    this.#pages = out;
    this.#refreshedAt = Date.now();
    return { pages: out.length, bytes, errors };
  }

  /** Rank pages by token hits (title counts double). Empty query -> []. */
  search(query: string, limit = 3): Array<MirrorPage & { score: number }> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scored = this.#pages.map((p) => {
      const title = p.title.toLowerCase();
      const body = p.body.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (title.includes(t)) score += 2;
        if (body.includes(t)) score += 1;
      }
      return { ...p, score };
    });
    return scored
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Build the Tier-2 excerpt pack for a user message, within budget.
   *  Returns null honestly when nothing matches. */
  injectFor(lastUserText: string, budget = 1500): string | null {
    if (this.#pages.length === 0) return null;
    const tokens = tokenize(lastUserText).filter((t) => t.length >= 4);
    if (tokens.length === 0) return null;
    const best = this.search(tokens.join(" "), 2);
    if (best.length === 0) return null;
    const parts: string[] = ["## Official docs (local mirror)"];
    let used = parts[0]!.length;
    for (const p of best) {
      const excerpt = p.body.replace(/\s+/g, " ").slice(0, 420).trim();
      const block = `\n### ${p.title} (${p.url})\n${excerpt}...`;
      if (used + block.length > budget) break;
      parts.push(block);
      used += block.length;
    }
    return parts.length > 1 ? parts.join("\n") : null;
  }
}
