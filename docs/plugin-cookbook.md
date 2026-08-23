# bridle plugin cookbook

Panduan menulis plugin domain untuk bridle — dari nol sampai siap dipublikasikan.
Studi kasus yang menyertainya:

- `packages/demo-fs` — **referensi minimal** (~130 baris, in-memory filesystem)
- `packages/roblox` — **contoh lengkap** (transport live/fake, knowledge injection,
  verify kinds, gate destruktif)

> Prinsip yang dipegang sepanjang buku ini: *everything is a plugin*,
> *model-visible means logged*, *enforcement over hope*, dan **registrasi
> bersifat efek reversibel**.

---

## §1 Anatomi minimum

Sebuah plugin adalah `{name, requires?, setup(ctx)}`:

```ts
import type { PluginDef } from "@bridle/kernel";

export function myPlugin(opts: MyOptions = {}): PluginDef {
  return {
    name: "my-domain",
    requires: ["tools"],          // load order = kebutuhan layanan, BUKAN urutan boot
    setup(ctx) { return mySetup(ctx, opts); },
  };
}
```

Aturan empatnya kernel:

1. **Service = kemampuan.** Berikan lewat `ctx.provide("myKey", api)`; konsumsi
   milik orang lain via `await ctx.service("key")`.
2. **Event = titik tembus.** Perilaku core diliputi lewat listener, bukan diedit.
3. **Registrasi reversibel.** Semua yang kamu pasang di `setup` ter-tag dengan
   nama plugin; `unmount(name)` membongkar LIFO.
4. **Setup gagal = tidak ada residu.** Kernel otomatis unmount bila setup melempar.

## §2 Menyediakan tools (dengan kelas izin)

```ts
async function mySetup(ctx: PluginContext): Promise<void> {
  const tools = await ctx.service("tools");
  const disposers: Array<() => void> = [];

  disposers.push(tools.register({
    name: "my.read",                 // prefix domain-mu: "my."
    description: "Read something from my domain.",
    params: { path: "string" },      // muncul di directive chat — hemat kata
    permission: "read",              // read | write | execute  ← dibaca gerbang M4
    execute: async (a) => ({ ok: true, text: "…" }),
  }));

  // KUNCI REVERSIBILITAS: kumpulkan disposer, bongkar via ctx.effect.
  ctx.effect(() => { for (const d of disposers.splice(0)) d(); });
}
```

Konvensi kelas izin (ditegakkan gerbang M4, mode default **menolak** write & execute):

| Kelas | Arti | Contoh |
|---|---|---|
| `read` | mengamati | `script_read`, `ls`, `get_studio_state` |
| `write` | mengubah state | `multi_edit`, `start_stop_play` |
| `execute` | menjalankan kode/instruksi arbitrer | `execute_luau`, `math.eval`; **default untuk tool tanpa deklarasi** |

Pola destruktif (mis. `:Destroy()`) jangan dititipkan ke prompt — tolak di
`execute` dan minta flag eksplisit (`allow_destructive=true`), seperti
`packages/roblox/src/tools/write.ts`.

## §3 Service domain + typing

```ts
export interface MyApi { /* introspection untuk plugin lain */ }

declare module "@bridle/kernel" {
  interface ServiceMap {
    // kunci milik paket lain TIDAK perlu diulang; deklarasi kompatibel merge
    myDomain: MyApi;
  }
}
// di akhir setup:
ctx.provide("myDomain", api);
```

## §4 Titik tembus (event seams) yang tersedia

| Event | Mode | Dipakai untuk |
|---|---|---|
| `tools/pre-execute` | waterfall | **gate izin**, mutasi argumen, tolak call |
| `tools/post-execute` | emit | audit hasil eksekusi |
| `agent/pre-step` | waterfall | *knowledge injection*: tulis ulang `messages` sebelum ke model |
| `session/appended` | emit | progres UI, metrik (hanya `{id,type}` — ambil payload dari log) |
| `workflow/*`, `audit/*` | — | event durabel yang TIDAK terlihat model (tamper-proof) |

Contoh injeksi pengetahuan (pola roblox):

```ts
ctx.on("agent/pre-step", ((p, next) => {
  const lastUser = [...p.messages].reverse().find((m) => m.role === "user");
  const pack = lastUser ? myInjectFor(lastUser.text, budget) : null;
  if (!pack) return next();
  p.messages = [...p.messages.slice(0, idx), { role: "user", text: lastUser.text + "\n\n" + pack }, ...];
  return next();                       // WAJIB next() kalau tidak menolak
}) as unknown as (...args: never[]) => unknown);
```

## §5 Commands & verify kinds (TUI + auto_run)

Perintah slash dan verify kinds juga registry — domain-mu bisa mendaftar:

```ts
const commands = await ctx.service("commands");   // butuh @bridle/headless terpasang
commands.register({ name: "/studio", description: "…", execute(args, io) { … } });

const workflow = await ctx.service("workflow");
workflow.registerVerifyKind("playtest", handler); // kind tak dikenal = FAIL jujur
```

## §6 Testing pattern (fixture harness)

```ts
import { Context } from "@bridle/kernel";

async function makeHarness() {
  const ctx = new Context();
  await ctx.mount({ name: "tools", setup: (s) => toolsPlugin(s) });
  await ctx.mount(myPlugin({ /* opts */ }));
  return { ctx, tools: ctx.requireService("tools") };
}

it("unmount unwinds every registration", async () => {
  const h = await makeHarness();
  h.ctx.unmount("my-domain");
  expect(h.tools.list().filter((t) => t.name.startsWith("my."))).toEqual([]);
});
```

Lihat utuh: `packages/demo-fs/tests/demo-fs.test.ts`.

## §7 Checklist publikasi

- [ ] `package.json`: `files:["dist"]`, `publishConfig.access:"public"`,
      `repository`/`bugs`/`homepage` mengarah ke repo Bridle
- [ ] `license: "GPL-3.0-or-later"` (wajib — turunan langsung dari kernel)
- [ ] `pnpm build && pnpm --filter @bridle/demo-fs exec npm pack --dry-run`
      → pastikan tarball hanya berisi `dist/` + metadata
- [ ] Suite hijau termasuk test reversibility (§6)

## §8 Setelah ini?

Domain kedua (`packages/roblox`) memperlihatkan pola lanjutan: transport
live/fake bergantian, knowledge injection ber-budget, verify kinds untuk
`auto_run`, dan gate destruktif struktural. Baca berdampingan dengan buku ini.
