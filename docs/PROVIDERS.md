# Catatan provider (diverifikasi di M1, 2026-10-15)

Dokumen ini mencatat apa yang **benar-benar dibaca dari dokumentasi resmi** saat M1, dan apa yang masih asumsi. Aturan yang dipakai aplikasi ada di `packages/registry/src/presets/*.json`; setiap file menyimpan `source` dan tanggal `checked`. Jika provider berubah, ubah file JSON itu (atau pakai Override di Profil model), tidak perlu mengubah kode.

Cara membaca: **Terverifikasi** = dibaca dari halaman dokumentasi resmi pada tanggal di atas. **Asumsi** = belum ditemukan di dokumentasi yang diperiksa, jadi EZClaw mengandalkan auto-retry dan Extra body.

## Lapisan profil

Profil kemampuan sebuah model dihitung dari lapisan berurutan, lapisan belakangan menang:

1. **Bawaan protokol** (`packages/core/src/profile.ts`)
2. **Preset fallback** (aturan berprioritas `fallback`, untuk mengisi celah sebelum discovery)
3. **Discovery** (data dari endpoint daftar model provider)
4. **Preset koreksi** (hal yang tidak dilaporkan provider: quirk, default aktif/tidak)
5. **Override pemilik** (Profil model, JSON)

Terpisah dari profil, field request yang pernah ditolak model dicatat per model (`omit`) dan tidak dikirim lagi.

## Per provider

| Provider | Status | Yang diketahui |
|---|---|---|
| **DeepSeek** | Terverifikasi | Base `https://api.deepseek.com` (juga `/anthropic`). Model ID `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro`; nama lama `deepseek-v4-flash` masih diterima. Thinking: `thinking: {type: enabled/disabled}` dan `reasoning_effort` low/high/max, aktif secara default (high). `temperature`, `presence_penalty`, `frequency_penalty` diabaikan saat thinking (tanpa error). `top_p` hanya berlaku saat thinking, 0.95 sampai 1.0. Reasoning di `reasoning_content`. **Dengan tools, `reasoning_content` semua giliran sebelumnya wajib dikirim ulang atau API menjawab 400** (M2). Endpoint daftar model tidak terdokumentasi, jadi model yang disarankan dipakai jika gagal. |
| **Anthropic** | Terverifikasi | `GET /v1/models` mengembalikan kapabilitas (tipe thinking, level effort, input gambar/PDF, batas token) yang dipakai sebagai lapisan discovery. Claude 4.7 ke atas menolak `thinking.type: enabled` dengan 400; pakai `thinking: {type: adaptive}` dan `output_config: {effort}`. Model 5.x berpikir secara default tetapi teks disembunyikan (`display: omitted`), jadi EZClaw mengirim `display: summarized`. Effort `xhigh` dan `max` tidak bisa dikombinasikan dengan `thinking: disabled`. Claude 4.5 ke bawah memakai `budget_tokens` (minimal 1024, lebih kecil dari `max_tokens`). Auth `x-api-key` plus `anthropic-version: 2023-06-01`. Stream: `thinking_delta`, `signature_delta`. Pembatasan sampling saat thinking pada model 5.x tidak ditemukan di halaman yang diperiksa; auto-retry menanganinya jika ditolak. |
| **OpenAI** | Sebagian | `reasoning_effort` (Chat Completions) atau `reasoning.effort` (Responses); nilai bergantung model (GPT-6 Astra menolak `none`, GPT-6.1 Sol menolak `none` dan `minimal`). **Chat Completions tidak mendukung function calling untuk GPT-6 Astra dan GPT-6.1 Sol**, jadi agent dengan tools butuh adapter Responses (M2). Model disebut: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna`. Asumsi: model reasoning menolak parameter sampling (dikunci saat reasoning aktif); dukungan `max_completion_tokens` dan Chat Completions untuk `gpt-6-luna` belum dikonfirmasi dari halaman. |
| **Google Gemini** | Terverifikasi (lapisan kompatibel) | Base `https://generativelanguage.googleapis.com/v1beta/openai/`. `reasoning_effort` minimal/low/medium/high; reasoning tidak bisa dimatikan di Gemini 2.5 Pro dan 3. Jangan campur dengan `thinking_config`. Daftar model: `GET .../openai/models` (ID berawalan `models/`, dibersihkan). Generate gambar lewat `images.generate`. API native `generateContent` belum diimplementasi. |
| **xAI** | Sebagian | Base `https://api.x.ai/v1`. `reasoning_effort` low/medium/high/xhigh pada grok-4.5 ke atas, reasoning tidak bisa dimatikan. `presencePenalty`, `frequencyPenalty`, dan `stop` ditolak pada model reasoning. Dokumentasi reasoning xAI menjelaskan Responses API; perilaku di Chat Completions belum terverifikasi. |
| **Alibaba Qwen** | Terverifikasi (kompatibel OpenAI) | `enable_thinking` (boolean) dan `thinking_budget` (integer) di body; `reasoning_content` di respons. Alibaba menyarankan domain per-workspace; domain `dashscope(-intl).aliyuncs.com/compatible-mode/v1` masih berfungsi. Rentang `thinking_budget` per model belum diverifikasi. |
| **Z.ai GLM** | Terverifikasi (internasional) | Base `https://api.z.ai/api/paas/v4/`. `thinking: {type: enabled/disabled}`, aktif secara default; `reasoning_content` di delta stream. Model contoh `glm-4.6`. Base URL China tidak ditemukan di halaman yang diperiksa. |
| **MiniMax** | Terverifikasi | Base `https://api.minimax.io/v1`. Model: `MiniMax-M3`, `MiniMax-M3.1-Flash-Preview`, `MiniMax-M2.7` dan varian. `reasoning_split: true` memisahkan reasoning ke `reasoning_content` (selalu dikirim). `temperature` harus 0 sampai 2, disarankan 1.0. Reasoning wajib dipertahankan utuh di riwayat saat memakai tools (M2). |
| **Xiaomi MiMo** | Sebagian | Base `https://api.xiaomimimo.com/v1` (juga `/anthropic`); Token Plan memakai host `token-plan-cn.xiaomimimo.com` dan kunci `tp-...`. **Auth memakai header `api-key`**, bukan Bearer. Contoh model `mimo-v2.6-pro`. Field untuk mengatur thinking tidak terdokumentasi di halaman yang diperiksa, jadi kontrolnya tidak ditampilkan (gunakan Extra body). `reasoning_content` wajib dikirim ulang pada percakapan dengan tools. |
| **OpenRouter** | Terverifikasi | `GET /api/v1/models` memberi `architecture.input_modalities`/`output_modalities`, `supported_parameters`, `context_length`, `pricing`, `top_provider.max_completion_tokens`, `default_parameters`. Objek `reasoning` terpadu: `effort` (max/xhigh/high/medium/low/minimal/none) atau `max_tokens`, plus `exclude`, `enabled`. Reasoning muncul di `reasoning` dan `reasoning_details`; `reasoning_details` perlu dikirim ulang apa adanya saat tools dipakai. Biaya per request ada di `usage.cost`. |
| **Venice.ai** | Terverifikasi | Base `https://api.venice.ai/api/v1`. `GET /models` memberi tipe (`text`, `image`, ...), `model_spec.capabilities` (function calling, vision, reasoning, reasoning effort), `constraints`, dan `pricing`. `venice_parameters`: `include_venice_system_prompt` (bawaan **true**), `enable_web_search` (off/auto/on), `strip_thinking_response`, `disable_thinking`, dan lainnya. `reasoning_effort` setara `reasoning.effort`. Mendukung `top_k`, `min_p`, `repetition_penalty`, `seed`. |
| **Lokal** (Ollama, LM Studio, llama.cpp, vLLM) | Asumsi | Kompatibel OpenAI; port bawaan dan dukungan tools bervariasi, jadi `tools` tidak diklaim. Blok `<think>` dipisahkan otomatis. |

## Yang sengaja belum ada di M1

- Adapter **OpenAI Responses** (dibutuhkan untuk tools di GPT-6 Astra/Sol) dan **Gemini native**: M2.
- Mengirim ulang reasoning ke riwayat (DeepSeek, MiMo, MiniMax, OpenRouter, Anthropic memintanya saat tools dipakai): M2. Kebijakan tiap model sudah tercatat di field `reasoningReplay`.
- Lampiran gambar/file, cabang percakapan, regenerate dengan model lain, dan preset system prompt bernama.

## Generate gambar (M3)

Dicek 2026-10-15 dari dokumentasi resmi. Satu model gambar memakai satu **jalur** (`image.wire` di profil model); jalur bisa diganti di panel Pengaturan mode Image kalau provider memakai bentuk API lain.

| Jalur | Dipakai untuk | Bentuk request | Gambar referensi | Status |
|---|---|---|---|---|
| `openai-images` | OpenAI, xAI, server kompatibel (bawaan untuk endpoint lain) | `POST /images/generations` JSON (`model`, `prompt`, `n`, `size`, `quality`, `output_format`); respons `data[].b64_json` | `POST /images/edits` multipart, satu bagian `image[]` per gambar | Terverifikasi untuk OpenAI ([panduan](https://developers.openai.com/api/docs/guides/image-generation)). Ukuran khusus (kelipatan 16, rasio 1:3 sampai 3:1) dan `quality` tambahan (`xhigh`, `max`) belum ditawarkan di UI. |
| `openrouter-images` | OpenRouter, model yang hanya keluar gambar | `POST /images` JSON (`model`, `prompt`, `n` 1 sampai 10, `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`, `seed`); respons `data[].b64_json` + `media_type` | `input_references: [{type: "image_url", image_url: {url}}]` (URL atau data URL) | Terverifikasi ([dokumentasi](https://openrouter.ai/docs/features/multimodal/image-generation)). Batas jumlah referensi per model tidak disebut; EZClaw memakai 4. |
| `chat-modalities` | Model gambar Gemini dan model OpenRouter yang keluar gambar lewat chat | `POST /chat/completions` non-stream dengan `modalities: ["image","text"]` (atau `["image"]` untuk model yang hanya gambar) dan `image_config: {aspect_ratio, image_size}`; gambar di `choices[0].message.images[].image_url.url` (data URL) | Bagian `image_url` di pesan user | Terverifikasi dari dokumentasi dan sumber pihak ketiga. Daftar lengkap aspect ratio resmi tidak ditemukan; EZClaw menawarkan rasio umum. Model yang hanya gambar bisa menolak `["image","text"]`, jadi dipilih dari modalitas output hasil discovery. |
| `venice-image` | Venice | `POST /image/generate` JSON (`model`, `prompt`, `negative_prompt`, `aspect_ratio` atau `width/height`, `resolution`, `steps`, `cfg_scale`, `seed`, `format`, `variants` 1 sampai 4); respons `images[]` base64. Field tak dikenal ditolak dengan 400. Keluarga Qwen Image menolak `width`/`height`. | `POST /image/edit` menerima **satu** `image` (data URL, URL, atau file) dan mengembalikan bytes gambar, bukan JSON | Terverifikasi ([generate](https://docs.venice.ai/api-reference/endpoint/image/generate), [edit](https://docs.venice.ai/api-reference/endpoint/image/edit)). Dokumen edit tidak menyebut multi-gambar, jadi referensi dibatasi satu. Dokumen edit sendiri tidak konsisten soal model bawaan (`qwen-edit` atau `firered-image-edit`). |
| `dashscope-async` | Alibaba DashScope (Qwen Image langsung) | `POST {root}/api/v1/services/aigc/text2image/image-synthesis` dengan header `X-DashScope-Async: enable`, lalu `GET {root}/api/v1/tasks/{id}` sampai `SUCCEEDED`; hasil berupa URL yang kedaluwarsa dalam 24 jam, jadi langsung diunduh. `n` harus 1 pada mode async, jadi EZClaw menjalankan satu task per gambar. | Belum: dokumen API edit (`qwen-image-edit`) tidak ikut terbaca, jadi model ini text-to-image saja di EZClaw | Terverifikasi ([Qwen-Image API](https://www.alibabacloud.com/help/en/model-studio/qwen-image-api)). Domain per-workspace (`{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`) dipakai apa adanya bila diisi di base URL; base `compatible-mode` diubah ke `/api/v1`. Daftar ukuran Qwen-Image selain `1664*928` berasal dari ingatan dan belum dicek. Model `qwen-image-2.0` hanya mendukung panggilan sinkron di endpoint lain, belum diimplementasi. |

Jalur dipilih otomatis dari keluarga provider (`defaultImageWire`): OpenRouter menjadi `chat-modalities` jika modelnya juga menjawab teks, selain itu `openrouter-images`; Venice `venice-image`; Google `chat-modalities`; Qwen atau domain `aliyuncs` `dashscope-async`; sisanya `openai-images`.

Catatan perilaku yang disengaja:
- **Prompt Composer** hanya jalan untuk model yang tidak melihat percakapan (semua jalur kecuali `chat-modalities`) dan tidak pada giliran pertama. Hasil susunannya selalu tampil di atas gambar, bisa diubah, dan dikirim ulang persis.
- Gambar hasil giliran sebelumnya ikut sebagai input hanya bila Composer memutuskan itu dan model menerima gambar input.
- Parameter yang tidak dimiliki jalur (misalnya negative prompt di `openai-images`) tidak dikirim dan alasannya dicatat di giliran itu.
- Hasil disimpan sebagai file di folder `assets` pada folder data; baris request log menyembunyikan isi base64.

## Edit gambar (M4)

Edit memakai jalur yang sama dengan generate, dengan gambar yang diedit sebagai **input pertama** dan referensi di belakangnya. Tanpa mask.

| Jalur | Cara gambar dikirim | Batas yang dipakai EZClaw |
|---|---|---|
| `openai-images` | `POST /images/edits` multipart, bagian `image[]` berurutan: yang diedit, lalu referensi | 16 gambar input |
| `openrouter-images` | `input_references` berurutan: yang diedit, lalu referensi | 4 gambar input (angka resmi tidak ditemukan) |
| `chat-modalities` | satu pesan user berisi semua gambar lalu teks; riwayat giliran lama **tidak** dikirim supaya jelas mana Image 1 | 4 gambar input |
| `venice-image` | `POST /image/edit` dengan satu `image`; referensi tidak dikirim | 1 gambar input: hanya yang diedit |
| `dashscope-async` | belum ada jalur edit (dokumen `qwen-image-edit` tidak terbaca) | 0: model ditolak untuk edit sebelum request keluar |

Batas ini bisa diubah per model di profil (`image.maxInputImages`, `image.wire`). Kalau model hanya menerima satu gambar input, referensi tidak dikirim dan alasannya dicatat di giliran itu. Mode **kolase** untuk model satu-input (E7-S4, eksperimental) belum dibuat.

Prompt edit dikompilasi dalam bahasa Inggris dengan urutan tetap: `Image 1 is the image to edit.`, satu baris per referensi dengan perannya, `Instruction: ...`, lalu `Keep unchanged from Image 1: ...` untuk chip Pertahankan (wajah, komposisi, warna, teks di gambar, latar). Template belum bisa diatur per model; yang bisa: melihat dan mengubah prompt hasil kompilasi sebelum kirim (dikirim apa adanya, gambar tetap berurutan), atau merapikannya dengan Prompt Composer (opsional, mati secara bawaan untuk edit).

Versi: tiap hasil edit adalah anak dari gambar yang diedit pada giliran itu. Daftar versi (`v0` asli, `v1`, `v2`, ...) disusun dari giliran-giliran itu (`buildVersions` di `packages/core/src/image.ts`), jadi mengedit versi lama membuat cabang dan tidak mengubah versi lain. Perbandingan geser dan berdampingan bekerja antara dua versi mana pun.
