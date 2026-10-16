# EZClaw

Workbench AI lokal: chat, agent loop, generate gambar, dan edit gambar berbasis referensi, untuk model dari banyak provider. Kebutuhan lengkap ada di [`docs/PRD.md`](docs/PRD.md), desain di [`DESIGN.md`](DESIGN.md).

Status: **M0 sampai M4 selesai**. Empat mode dalam satu aplikasi lokal:

- **Chat**: percakapan streaming ke model dari banyak provider, dengan panel parameter yang mengikuti kemampuan model dan harness yang bisa dinyalakan atau dimatikan.
- **Agent**: loop agent yang bekerja di satu folder (baca, cari, ubah file, jalankan perintah) dengan persetujuan, rencana, dan pemadatan konteks. Profil harness diatur di Settings, Harness, termasuk profil Codex yang meniru susunan request Codex.
- **Image**: generate gambar dari prompt dan gambar referensi lewat lima jalur provider, dengan Prompt Composer untuk pesan lanjutan. Prompt yang dikirim selalu terlihat.
- **Edit**: ubah satu gambar target dengan referensi berperan dan chip Pertahankan, simpan tiap hasil sebagai versi berantai, dan bandingkan dua versi.

Agent dan Chat memakai **wrapper bersegmen** yang bisa dinyalakan, dimatikan, dan diubah per bagian (bawaan: EZClaw, gaya Cowork, Codex hardcode dan Codex dari instalasimu, serta tiga gaya chat), dengan urutan yang ramah prompt caching, **memori** lintas thread yang diusulkan model dan disetujui kamu, dan tools Agent tambahan: glob, proses latar, lihat gambar, web fetch dan search, subagent, skills, serta undo perubahan file. Detailnya di [`docs/HARNESS.md`](docs/HARNESS.md).

Semua diuji dengan server tiruan; belum dengan key provider asli. Catatan verifikasi dokumentasi provider ada di [`docs/PROVIDERS.md`](docs/PROVIDERS.md), temuan Codex di [`docs/CODEX-HARNESS.md`](docs/CODEX-HARNESS.md).

## Kebutuhan

- Node.js 22.12 atau lebih baru
- pnpm 9
- Windows: Visual Studio Build Tools (C++), karena `better-sqlite3` bisa di-compile saat `pnpm install` jika tidak ada binary siap pakai untuk versi Node kamu

## Menjalankan

Di Windows, cukup klik dua kali **`run.bat`**: memasang dependensi dan membangun aplikasi saat pertama kali, lalu menjalankan server dan membuka browser. `run.bat rebuild` memaksa build ulang setelah kode berubah.

Atau lewat terminal:

```bash
pnpm install
```

Development (server dengan auto-reload + UI Vite):

```bash
pnpm dev
```

Buka http://localhost:5173. API berjalan di `127.0.0.1:8787` dan diakses lewat proxy Vite.

Pemakaian biasa:

```bash
pnpm build
```

```bash
pnpm start
```

Buka http://127.0.0.1:8787.

## Perintah lain

| Perintah | Fungsi |
|---|---|
| `pnpm test` | Test core (parameter engine), registry (preset, discovery), dan server (keamanan, endpoint, streaming chat) |
| `pnpm typecheck` | Typecheck semua package |
| `pnpm db:generate` | Buat migrasi SQL baru setelah mengubah `apps/server/src/db/schema.ts` |

## Mencoba tanpa API key

Server tiruan yang meniru API OpenAI tersedia untuk mencoba UI tanpa biaya, dan `sandbox` memakai folder data sementara serta penyimpanan key berupa file, jadi `~/.ezclaw` dan Credential Manager tidak tersentuh.

```bash
pnpm --filter @ezclaw/server mock
```

```bash
pnpm build
node scripts/sandbox.mjs
```

Di Settings > Endpoint, tambahkan endpoint **Custom** dengan base URL `http://127.0.0.1:9911/v1` dan key apa saja. Model: `echo`, `think`, `tags`, `markdown`, `reject-top_p`, `slow`, `midfail`, `json-only` (dan `unauthorized` jika ditambahkan manual).

## Konfigurasi

| Variabel | Default | Arti |
|---|---|---|
| `EZCLAW_PORT` | `8787` | Port server |
| `EZCLAW_DATA_DIR` | `~/.ezclaw` | Folder database dan data lain |
| `EZCLAW_WEB_PORT` | `5173` | Port Vite saat `pnpm dev` |
| `EZCLAW_SECRET_STORE` | `auto` | `auto` memakai Credential Manager OS dan jatuh ke file terenkripsi jika gagal; `file` memaksa file |

## Keamanan lokal

- Server hanya listen di `127.0.0.1`.
- Setiap peluncuran membuat token sesi acak. Server menuliskannya ke `index.html`, dan semua request `/api` wajib membawa header `x-ezclaw-token`.
- API key disimpan di Windows Credential Manager (atau file terenkripsi jika tidak tersedia, dengan peringatan di Settings), tidak di database, dan tidak pernah dikirim balik ke browser. Catatan request menyembunyikan header kunci.
- Gambar eksternal di jawaban model tidak dimuat (mencegah kebocoran isi percakapan lewat URL gambar).
- Header `Host` harus `127.0.0.1:PORT` atau `localhost:PORT` di semua route (mencegah DNS rebinding membaca token). Request `/api` dengan `Origin` asing atau `Sec-Fetch-Site: cross-site` ditolak.

## Struktur

```
apps/server     Hono + SQLite (Drizzle), API, run manager, adapter stream, penyaji UI hasil build
apps/web        React + Vite + Tailwind, memakai token dari design/tokens.css
packages/core   Tipe, skema (zod), profil kemampuan berlapis, dan Parameter Engine
packages/registry  Katalog endpoint, preset provider (JSON), parser discovery
design          Token desain dan halaman pratinjau komponen
docs            PRD
scripts/dev.mjs Menjalankan server dan Vite dengan token sesi yang sama
```
