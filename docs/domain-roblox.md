# bridle domain plugin — Roblox (M5 design)

**Status: DESIGN — belum dieksekusi.** Dokumen ini memetakan warisan
terverifikasi ZeroScript-Free ke arsitektur plugin bridle, sehingga eksekusi
nanti tinggal mengikuti rencana ini. Prinsip yang dipegang: *everything is a
plugin*, *model-visible means logged*, dan *enforcement over hope* — tiga hal
yang membedakan bridle dari harness asal-muasal.

Provenance: konsep diadopsi dari ZeroScript-Free (GPL-3.0) — bridge Studio
MCP, docs mirror, verify kinds, auto_run; dsh — session-log invariant.
Ekspresi kode nanti ditulis dari dokumen ini (clean-room rules berlaku).

---

## §1 Tujuan & non-tujuan

Tujuan: agen yang bisa **membaca, mengubah, menjalankan, menguji, dan
memverifikasi** sebuah place Roblox Studio lewat chat web gratis — dengan
setiap mutasi ter-gate dan setiap klaim "done" diverifikasi mesin.

Non-tujuan (untuk M5): multi-player orchestration, editor visual sendiri,
menyaingi Studio MCP resmi sebagai protokol.

## §2 Arsitektur paket

```
packages/roblox/            ← SATU plugin domain (@bridle/roblox)
  src/index.ts              robloxPlugin(opts): PluginDef
  src/studio.ts             koneksi Studio MCP (stdio/HTTP), reconnect
  src/tools/*.ts            satu modul per tool (daftar §3)
  src/knowledge/docs.ts     docs mirror + FTS search
  src/verify/*.ts           verify kinds (§5)
  tests/fake-studio.test.ts suite vs FakeStudio (§6)
extension/content/gemini.js … provider tambahan bila perlu render cadangan
```

Plugin `robloxPlugin` hanya:
1. `provide("tools", ...)` — mendaftarkan tool Studio lewat registry standar,
   masing-masing dengan `permission` terklasifikasi (§3);
2. memasang listener `agent/pre-step` untuk **knowledge injection** (§4);
3. menyediakan service `"roblox"` (API internal untuk verify kinds).

Tidak ada satu pun fork dari core — uninstall plugin = Studio terputus
bersih, audit tetap ada di log.

## §3 Permukaan tool + klasifikasi izin (M4 dipakai penuh)

| Tool | Kelas | Catatan gate |
|---|---|---|
| `script_read`, `script_search`, `script_grep`, `search_game_tree`, `inspect_instance`, `get_studio_state`, `get_console_output`, `list_commands` | `read` | mode default: allow |
| `multi_edit`, `insert_from_creator_store`, `store_image` | `write` | mode default: ask |
| `execute_luau` | `execute` | mode default: ask; **rule khusus**: argumen yang mengandung `:Destroy(` / `:ClearAllChildren()` / `:Remove()` pada scope luas → naik paksa ke review terpisah (lihat §7) |
| `start_stop_play`, `user_keyboard_input`, `user_mouse_input` | `write` | play mode |
| `screen_capture` | `read` | |

Konfigurasi tipikal live session:

```ts
security: {
  modes: { read: "allow", write: "ask", execute: "ask" },
  rules: [{ match: "console_output", cls: "read" }],
  approver: blockingConsoleApprover(),
}
```

Ini persis jawaban struktural atas aturan prompt ZS *"NEVER DELETE BROADLY"*:
di ZS itu nasihat 2000-kata; di bridle itu `decision.deny` yang tidak bisa
dilobi oleh model.

## §4 Knowledge plugin (docs mirror + skill sheets)

- `docs_refresh` (WRITE): fetch `create.roblox.com/docs/llms.txt` → kurasi
  ~100 halaman inti → cache lokal (cap 256KB/halaman).
- Index FTS lokal (`docs_index(title,url,body)`); tool `doc_search` = READ.
- **Context hook Tier-2**: listener `agent/pre-step` mendeteksi token API
  (mis. `ProfileStore`, `RemoteEvent`) di pesan terakhir → sisipkan potongan
  docs (budget ~1500 char) ke `messages` via waterfall — tanpa side channel,
  karena rewrite tetap lewat log (`assistant/pre-step` terekam sebagai bagian
  request yang dikirim; invariant tetap tertutup).
- Skill sheets: markdown terkurasi per library (Vide, Charm, ProfileStore,
  Net, Signal, Promise) — disuntik dengan aturan budget sama.
- Project memory ala ZS (ModuleScript di place): dibaca/diupdate lewat tool
  biasa — jadi otomatis ter-audit, bukan channel gelap.

## §5 Verify-driven autonomy (verify kinds + auto_run)

Service `"roblox"` mengekspos `verify(kind, target)`; hasil selalu
`append("audit/verify", {...})`:

| Kind | Implementasi | Sumber ide |
|---|---|---|
| `static` | parse Luau + cek struktur dasar | ZS `_plan_verify` |
| `lint` | jalankan linting atas script target | ZS review |
| `docs` | cocokkan API yang dipakai vs docs mirror | ZS v3 fase 1 |
| `unit_test` | fungsi cek Luau via `execute_luau` (ala check_scene OpenGameEval) | ZS v3 fase 2 |
| `playtest` | start play → baca console error → screenshot → stop | ZS subagent playtest |

Command plugin `auto_run {goal, max_cycles≤5, verify:{kind,...}}`:

```
plan (plan_goals/tasks) ──▶ eksekusi langkah ──▶ verify OTOMATIS per mutasi
        ▲                                              │ gagal
        └── temuan dirangkum ◀─────────────────────────┘
habis budget ⟹ rollback snapshot + laporan jujur apa yang tercapai
```

State siklus disimpan di session log (`plan/*`, `audit/verify`) — jadi
reconstructable penuh; model tidak bisa "mengklaim done" tanpa jejak verify,
karena gate lapis kedua (`agent/pre-step` policy plugin) boleh menolak turn
yang mengklaim selesai tanpa `audit/verify` sukses terkait.

## §6 Verify suite

Dua lapis, sesuai pola repo:

1. **FakeStudio** (CI, deterministik): in-memory mock yang mengimplementasikan
   kontrak tool §3 (game tree kecil, script store, console buffer, "play"
   flag). Suite menguji: klasifikasi izin tiap tool, docs injection budget,
   auto_run happy-path + rollback path, dan larangan eksekusi saat gate deny.
2. **Live Studio** (opt-in via env `BRIDLE_LIVE_STUDIO=1`): place uji minimal
   berisi skenario kenal pasti (script rusak untuk debug-fix, UI kosong untuk
   build). Gate: semua test FakeStudio hijau + `verify_agents` analog lulus
   live. Benchmark mini ala ZS bench/tasks.json (grounding, code-gen atomik,
   multi-step, debug-fix, disiplin harness) dijalankan sebelum/sesudah tiap
   fase besar; angka masuk CHANGELOG.

## §7 Keamanan spesifik-Roblox

- `execute_luau`: charset/length guard + deteksi pattern destruktif →
  eskalasi approval terpisah (rule M4, bukan prompt).
- Datamodel `Edit` vs `Play`: play-only calls ditolak saat place tidak dalam
  play mode (fakta lingkungan, dicek tool-side, bukan percaya model).
- Snapshot/rollback: wajib sebelum siklus auto_run pertama; snapshot adalah
  tool WRITE ter-audit tersendiri.
- Semua keputusan gate & verify durabel di log — laporan akhir menyertakan
  ringkasan audit, bukan klaim model.

## §8 Urutan eksekusi (R0–R4)

| Fase | Isi | Gerbang |
|---|---|---|
| R0 | kerangka plugin + FakeStudio + 3 tool read | suite FakeStudio hijau |
| R1 | write tools + gate rules destruktif + snapshot/rollback | deny-test + live smoke |
| R2 | docs mirror + knowledge injection | injection budget test |
| R3 | verify kinds + auto_run loop | auto_run FakeStudio end-to-end |
| R4 | live Studio suite + benchmark mini | angka benchmark tercatat |

**Status eksekusi (2026-08-22):** R0–R3 ✅ (opencode), R4 kode ✅ —
`McpStdioTransport` (JSON-RPC stdio, handshake, retry `tools/list` untuk
late-attach backend, pemetaan argumen terpusat di satu tabel) diuji mekanis
terhadap fake MCP server child-process; suite live bersifat opt-in
(`BRIDLE_LIVE_STUDIO=1`) dan skip jujur tanpa Studio. **Belum tuntas:**
satu lari nyata vs Roblox Studio (butuh Windows/macOS) untuk memvalidasi
bentuk argumen di tabel pemetaan + angka benchmark mini.

**Update 2026-08-23 — GERBANG LIVE TERCAPAI.** Dua pelajaran lapangan yang
mengubah implementasi (keduanya bertentangan dengan schema yang diiklankan):
1. `studio_id` TIDAK pernah ditegakkan — ZS mengirim `arguments:{}` dan
   berhasil; kita ikut persis. Kunci "required" di schema adalah jebakan.
2. Instans Studio mendaftar ke proxy beberapa detik SETELAH proxy hidup —
   poll pertama hampir selalu `"studios":[]`; klien harus sabar.

Live run: wine sistem + WINEPREFIX vinegar (`prefixes/studio`), 27 tool,
instance "ai play test" terdaftar, get_studio_state menjawab mode Edit.
Sisa non-gate: angka benchmark mini + validasi live rule destruktif §7.
