# EZClaw: Product Requirements Document

| | |
|---|---|
| **Produk** | EZClaw |
| **Status** | Draft v0.2 (M0 dan M1 selesai) |
| **Owner** | Pemilik EZClaw (single user) |
| **Tanggal dibuat** | 2026-10-15 |
| **Terakhir diubah** | 2026-10-15 |
| **Dokumen terkait** | [`DESIGN.md`](../DESIGN.md), [`design/tokens.css`](../design/tokens.css), [`design/preview.html`](../design/preview.html) |

---

## 1. Ringkasan

**Satu kalimat:** EZClaw adalah workbench AI lokal berbasis web yang menyatukan chat, agent loop yang bekerja di folder project, generate gambar, dan edit gambar berbasis referensi, di atas satu lapisan provider yang paham perbedaan parameter tiap model.

**Gambaran:** Hari ini setiap kebutuhan AI tersebar di aplikasi berbeda: Codex atau Claude Code untuk agent, ChatGPT atau Gemini untuk chat dan gambar, dashboard OpenRouter dan Venice untuk mencoba model baru. Setiap aplikasi terkunci ke provider-nya sendiri, dan aplikasi yang multi-provider biasanya memperlakukan semua model sama, sehingga parameter khusus (reasoning effort, thinking budget, aspect ratio gambar, jumlah gambar referensi) hilang atau malah membuat request gagal.

EZClaw berjalan di komputer sendiri (`127.0.0.1`), menyimpan data secara lokal, dan memakai API key milik owner. Intinya ada dua: **Model Registry + Parameter Engine** yang membuat setiap model bisa dipakai dengan parameter yang benar, dan **Harness** (system prompt, tools, kebijakan loop) yang bisa di-ON/OFF-kan per thread, terinspirasi dari harness Codex.

**Fakta singkat:**
- **Pengguna:** satu orang, owner sendiri, power user yang juga developer.
- **Masalah inti:** alur kerja AI terpecah di banyak aplikasi, dan parameter khusus model tidak tertangani.
- **Metrik utama:** jumlah tugas mingguan (chat, agent, gambar) yang selesai di EZClaw tanpa membuka aplikasi provider lain.
- **Target rilis pribadi v1:** sekitar 10 sampai 12 minggu kerja (lihat bagian 11, estimasi kasar).

---

## 2. Masalah

### 2.1 Masalah

1. **Terpecah.** Agent, chat, generate gambar, dan edit gambar ada di produk berbeda dengan riwayat, key, dan kebiasaan masing-masing.
2. **Terkunci provider.** Codex hanya optimal dengan model OpenAI, Claude Code dengan Claude. Owner ingin menjalankan loop agent yang sama dengan DeepSeek V4.1 Flash, GPT-6 Luna, atau model OpenRouter/Venice yang sedang dicoba.
3. **Parameter tidak seragam.** Satu model memakai `reasoning_effort`, yang lain `thinking.budget_tokens`, yang lain `enable_thinking`, yang lain menolak `temperature` saat reasoning aktif. Model gambar berbeda di ukuran, aspect ratio, `steps`, `cfg`, negative prompt, dan jumlah gambar input. Aplikasi umum menyembunyikan parameter ini atau mengirim parameter yang ditolak.
4. **Edit gambar berbasis referensi tidak punya alur yang jelas.** Di aplikasi chat, gambar target dan gambar referensi tercampur dalam satu pesan tanpa peran yang jelas, jadi model sering mengedit gambar yang salah atau meniru referensi terlalu jauh.

### 2.2 Kondisi sekarang

Owner berpindah antara Codex/Claude Code (agent), ChatGPT/Gemini (chat, gambar), dashboard OpenRouter dan Venice (mencoba model). Prompt yang bagus, gambar hasil, dan riwayat tersebar tanpa satu tempat untuk dicari ulang.

### 2.3 Kenapa sekarang

Model murah dan cepat (DeepSeek V4.1 Flash, model di OpenRouter dan Venice) sudah cukup kuat untuk loop agent, dan model gambar seperti Qwen Image tersedia lewat gateway. Yang belum ada adalah satu harness lokal yang memperlakukan semua model ini sebagai warga kelas satu.

---

## 3. Tujuan dan Non-goal

### 3.1 Tujuan owner

1. **Satu tempat kerja:** chat, agent, generate, dan edit gambar dalam satu aplikasi lokal dengan riwayat yang bisa dicari.
2. **Model bebas tanpa kehilangan fitur:** model apa pun yang ditambahkan langsung bisa dipakai, dan parameter khususnya muncul di UI tanpa menulis kode.
3. **Agent yang bisa dipercaya:** loop agent bekerja di folder project dengan izin yang jelas, bisa dihentikan, dan setiap perubahan file bisa di-undo.
4. **Edit gambar yang presisi:** satu gambar target, beberapa referensi dengan peran yang jelas, hasil berversi yang bisa dibandingkan dan dilanjutkan.

### 3.2 Tujuan teknis

1. Menambah provider OpenAI-compatible baru cukup lewat form, tanpa kode.
2. Menambah protokol baru (misalnya API native provider baru) cukup dengan satu adapter yang memenuhi interface yang sama.
3. Harness adalah data (profil), bukan kode yang tersebar, sehingga bisa diganti, di-ON/OFF-kan, dan dibandingkan.

### 3.3 Non-goal

- Multi-user, login, atau deploy ke server publik.
- Inpainting atau edit berbasis mask (secara eksplisit di luar lingkup sesuai brief).
- Generate video, audio, atau voice chat.
- Fine-tuning atau training model.
- Menggantikan IDE. EZClaw mengerjakan task di folder, bukan editor kode.
- Login "Sign in with ChatGPT" atau langganan konsumen lain. EZClaw hanya memakai API key.

---

## 4. Persona

### 4.1 Persona utama: Owner sebagai power user

- **Peran:** developer dan kreator, memakai AI setiap hari untuk coding, riset, dan visual.
- **Tingkat teknis:** tinggi. Nyaman membaca JSON request dan menyetel parameter.
- **Perilaku:**
  - Mencoba model baru di OpenRouter dan Venice begitu rilis.
  - Memakai model cepat dan murah (DeepSeek V4.1 Flash) untuk kerja harian, model besar (GPT-6 Luna) untuk task berat.
  - Generate gambar dengan Qwen Image, sering dengan beberapa gambar referensi.
- **Kebutuhan:** kontrol penuh atas model dan parameter, tanpa harus mengatur ulang setiap kali.
- **Frustrasi:**
  - Request gagal karena parameter yang tidak didukung model.
  - Agent bagus terkunci ke satu vendor.
  - Hasil edit gambar mengubah bagian yang seharusnya tetap.

### 4.2 Persona kedua: Owner sebagai developer EZClaw

- Menambah adapter provider, profil harness, atau preset model.
- Butuh: arsitektur adapter yang jelas, fixture request/response untuk test, log request mentah untuk debug.

---

## 5. Konsep inti dan glosarium

| Istilah | Arti di EZClaw |
|---|---|
| **Provider** | Penyedia model langsung: OpenAI, Anthropic, Google, xAI, Alibaba (Qwen), Z.ai (GLM), DeepSeek, MiniMax, Xiaomi (MiMo). |
| **Gateway** | Agregator yang meneruskan ke banyak model: OpenRouter, Venice.ai. |
| **Endpoint** | Satu konfigurasi koneksi: base URL, auth, protokol. Provider bawaan, gateway, custom, dan local semuanya disimpan sebagai Endpoint. |
| **Protokol** | Format wire API: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini generateContent, dan protokol gambar (OpenAI Images, Venice Image, DashScope async, dll). |
| **Model** | Satu model di satu Endpoint, misalnya `deepseek/deepseek-v4.1-flash` di OpenRouter. Model yang sama di dua Endpoint adalah dua entri. |
| **Capability Profile** | Data yang menjelaskan apa yang bisa dilakukan model: modalitas input/output, tools, reasoning, parameter yang didukung beserta rentangnya, batas gambar input, ukuran output, dan quirk. |
| **Parameter Engine** | Lapisan yang menerjemahkan parameter kanonik EZClaw ke parameter spesifik protokol dan model, serta merender panel parameter di UI. |
| **Harness** | Profil yang membungkus model: system prompt, daftar tools, kebijakan loop, kebijakan konteks, kebijakan izin, dan file instruksi project. Bisa ON/OFF per thread. |
| **Thread** | Satu percakapan di mode mana pun (Chat, Agent, Image, Edit). |
| **Run** | Satu eksekusi agent loop dari satu pesan owner sampai berhenti. Terdiri dari Step. |
| **Step** | Satu panggilan model plus tool call yang dihasilkan dan hasilnya. |
| **Workspace** | Folder project tempat agent bekerja. Semua tulis-file dibatasi ke sini kecuali diizinkan. |
| **Asset** | File gambar yang disimpan EZClaw (upload, hasil generate, hasil edit), dengan metadata lengkap. |
| **Lineage** | Rantai versi gambar: asset induk, instruksi, referensi, model, dan parameter yang menghasilkan asset anak. |

---

## 6. Kebutuhan fungsional (Epic dan User Story)

Prioritas: **P0** wajib untuk v1, **P1** penting setelah P0 stabil, **P2** nanti.
Ukuran effort: XS, S, M, L, XL.

### Epic E1: Endpoint dan Model Registry (P0)

#### E1-S1 Menambah Endpoint bawaan (P0, M)

```
Sebagai owner,
saya ingin memilih provider dari daftar dan cukup menempelkan API key,
supaya model provider itu langsung bisa dipakai.
```

**Acceptance criteria**
- [ ] Daftar bawaan berisi: OpenAI, Anthropic, Google Gemini, xAI, Alibaba Qwen, Z.ai GLM, DeepSeek, MiniMax, Xiaomi MiMo, OpenRouter, Venice.ai.
- [ ] Given key valid, when owner menekan "Test connection", then EZClaw memanggil endpoint model list (atau request minimal) dan menampilkan jumlah model yang ditemukan.
- [ ] Given key salah, then pesan error menampilkan status HTTP dan pesan provider apa adanya, plus saran perbaikan (misalnya "Key ditolak (401). Cek apakah key untuk region yang benar.").
- [ ] Key tidak pernah dikirim balik ke browser. UI hanya menampilkan 4 karakter terakhir.
- [ ] Provider yang punya lebih dari satu base URL (region internasional vs China, misalnya Qwen dan GLM) menyediakan pilihan region.

#### E1-S2 Custom Endpoint (P0, M)

```
Sebagai owner,
saya ingin menambah endpoint sendiri dengan memilih protokolnya,
supaya penyedia apa pun yang kompatibel bisa dipakai tanpa menunggu dukungan resmi.
```

**Acceptance criteria**
- [ ] Field: nama, base URL, protokol (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini, OpenAI Images), skema auth (Bearer, header custom, query param, tanpa auth), header tambahan.
- [ ] Jika endpoint punya `/models`, model ditemukan otomatis. Jika tidak, owner menambah model ID manual.
- [ ] Owner bisa menyalin konfigurasi Endpoint bawaan menjadi custom (misalnya DeepSeek lewat endpoint Anthropic-compatible).

#### E1-S3 Local Endpoint (P0, S)

```
Sebagai owner,
saya ingin menyambungkan server model lokal,
supaya model offline bisa dipakai di semua mode.
```

**Acceptance criteria**
- [ ] Preset: Ollama, LM Studio, llama.cpp server, vLLM, dengan base URL default yang bisa diubah.
- [ ] Given server lokal mati, then status Endpoint menunjukkan "Tidak terjangkau" dengan URL yang dicoba, tanpa memblokir mode lain.
- [ ] Output `<think>...</think>` di dalam konten dipisah menjadi blok reasoning.

#### E1-S4 Model discovery dan katalog (P0, M)

```
Sebagai owner,
saya ingin melihat semua model dari semua Endpoint dalam satu katalog yang bisa difilter,
supaya saya cepat menemukan model untuk chat, agent, generate, atau edit.
```

**Acceptance criteria**
- [ ] Katalog bisa difilter berdasarkan: Endpoint, modalitas output (teks, gambar), input gambar, tools, reasoning.
- [ ] Untuk OpenRouter, filter memakai metadata dari endpoint model list (modalitas input/output dan daftar parameter yang didukung).
- [ ] Untuk Venice, model gambar dan teks dipisah berdasarkan tipe model dari endpoint model list.
- [ ] Owner bisa menandai model favorit dan memberi alias (misalnya "Flash" untuk DeepSeek V4.1 Flash).
- [ ] Katalog di-cache lokal dan bisa di-refresh manual. Refresh otomatis maksimal sekali per 24 jam per Endpoint.

#### E1-S5 Default model per peran (P0, S)

```
Sebagai owner,
saya ingin menentukan model default untuk setiap peran,
supaya thread baru langsung memakai model yang tepat.
```

**Acceptance criteria**
- [ ] Peran: Chat, Agent, Image Generate, Image Edit, Prompt Composer (LLM yang menyusun prompt gambar, lihat E6-S3), Title/Summary (LLM murah untuk judul thread dan kompaksi konteks).
- [ ] Contoh setelan awal owner: Chat dan Agent = DeepSeek V4.1 Flash, Image Generate dan Edit = Qwen Image via OpenRouter atau Venice. Nilai sebenarnya diisi owner, bukan di-hardcode.

### Epic E2: Parameter Engine (P0)

Ini bagian yang menjawab "setiap model punya parameter yang berbeda". Prinsipnya: **EZClaw tidak pernah menebak diam-diam.** Setiap parameter yang dikirim bisa dilihat, dan setiap parameter yang dibuang diberi tahu.

#### E2-S1 Capability Profile berlapis (P0, L)

```
Sebagai owner,
saya ingin EZClaw tahu parameter apa yang didukung tiap model,
supaya panel parameter hanya menampilkan yang relevan dan request tidak gagal.
```

**Acceptance criteria**
- [ ] Profil efektif dihitung dari lima lapis, urutan prioritas naik:
  1. **Default protokol** (misalnya Anthropic Messages wajib `max_tokens`).
  2. **Discovery** dari endpoint model list (OpenRouter `supported_parameters`, modalitas, context length; Venice model spec).
  3. **Preset kurasi** yang dikirim bersama EZClaw, dicocokkan dengan pola ID model (misalnya semua model keluarga reasoning OpenAI menolak `temperature` saat reasoning aktif).
  4. **Override owner** per model, diedit lewat UI atau JSON.
  5. **Hasil belajar runtime** (lihat E2-S4).
- [ ] UI "Inspect profile" menunjukkan nilai efektif dan lapis asal setiap field.
- [ ] Preset kurasi disimpan sebagai file JSON di repo (`packages/registry/presets/*.json`) sehingga mudah ditambah tanpa mengubah kode.

#### E2-S2 Panel parameter dinamis (P0, M)

```
Sebagai owner,
saya ingin panel parameter yang berubah sesuai model yang dipilih,
supaya saya hanya melihat kontrol yang benar-benar berlaku.
```

**Acceptance criteria**
- [ ] Panel dirender dari Capability Profile: slider untuk numerik dengan rentang dari profil, select untuk enum (misalnya reasoning effort `minimal/low/medium/high`), toggle untuk boolean, input angka untuk budget token.
- [ ] Parameter yang tidak didukung tidak ditampilkan. Parameter yang didukung tapi bentrok (misalnya `temperature` saat reasoning aktif pada model tertentu) ditampilkan disabled dengan alasan satu kalimat.
- [ ] Setiap thread menyimpan setelan parameternya. Owner bisa menyimpan setelan sebagai preset bernama ("Flash, effort tinggi").
- [ ] Bagian **Advanced: extra body (JSON)** selalu tersedia untuk parameter yang belum dikenal EZClaw. Isinya digabung ke body request apa adanya, dengan peringatan jika menimpa field yang dikelola EZClaw.

#### E2-S3 Pemetaan parameter kanonik (P0, L)

```
Sebagai owner,
saya ingin satu set kontrol yang konsisten (misalnya "Reasoning: tinggi"),
supaya saya tidak perlu hafal nama parameter tiap provider.
```

**Acceptance criteria**
- [ ] Parameter kanonik teks: `temperature`, `top_p`, `top_k`, `min_p`, `max_output_tokens`, `stop`, `seed`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `reasoning` (mode: off / effort level / budget token), `response_format` (teks, JSON object, JSON schema), `tools`, `tool_choice`, `parallel_tool_calls`, `web_search` (jika provider menyediakan pencarian native).
- [ ] Parameter kanonik gambar: `prompt`, `negative_prompt`, `size` atau `aspect_ratio`, `n`, `seed`, `steps`, `guidance` (cfg), `quality`, `style`, `output_format`, `input_images[]` dengan peran.
- [ ] Setiap pemetaan per protokol dan per provider punya unit test dengan fixture request.
- [ ] Contoh pemetaan `reasoning` yang harus didukung (diverifikasi di M1):

| Tujuan / protokol | Bentuk parameter |
|---|---|
| OpenAI Responses | `reasoning.effort` |
| OpenAI Chat Completions | `reasoning_effort` |
| Anthropic Messages | Claude 4.7 ke atas: `thinking: {type: adaptive}` + `output_config.effort` (`enabled` + `budget_tokens` ditolak). Claude 4.5 ke bawah: `thinking: {type: enabled, budget_tokens}` |
| Gemini | `thinkingConfig` (budget atau level, tergantung generasi model) |
| OpenRouter | objek `reasoning` terpadu (effort atau max_tokens) |
| Qwen (mode kompatibel) | `enable_thinking` dan budget thinking |
| GLM | objek `thinking` (enabled / disabled) |
| DeepSeek | `thinking: {type: enabled/disabled}` + `reasoning_effort` (low/high/max) |

#### E2-S4 Belajar dari penolakan (P0, M)

```
Sebagai owner,
saya ingin EZClaw menangani parameter yang ditolak dengan jujur,
supaya satu parameter salah tidak membuat seluruh pesan gagal.
```

**Acceptance criteria**
- [ ] Given provider mengembalikan 400 yang menyebut parameter tertentu tidak didukung, when owner menyalakan "Auto-retry tanpa parameter yang ditolak" (default ON), then EZClaw mengulang sekali tanpa parameter itu dan menampilkan catatan kecil di pesan: "`top_k` ditolak model ini, dikirim ulang tanpanya."
- [ ] Parameter yang ditolak dicatat di lapis "hasil belajar runtime" untuk model itu, dan bisa dihapus owner.
- [ ] EZClaw tidak pernah retry lebih dari sekali untuk satu pesan, dan tidak pernah retry error 401, 402, 403, atau 429 sebagai masalah parameter.

#### E2-S5 Inspektor request mentah (P0, S)

```
Sebagai owner-developer,
saya ingin melihat request dan response mentah dari setiap pesan,
supaya saya bisa men-debug parameter dan adapter.
```

**Acceptance criteria**
- [ ] Setiap pesan asisten punya aksi "Lihat request" yang menampilkan URL, header (key disensor), body JSON, status, dan usage.
- [ ] Data mentah disimpan maksimal 30 hari (bisa diubah), lalu dihapus otomatis.

### Epic E3: Chat (P0)

#### E3-S1 Chat streaming (P0, M)

```
Sebagai owner,
saya ingin chat dengan model mana pun dengan respons yang mengalir,
supaya saya bisa membaca jawaban selagi dibuat.
```

**Acceptance criteria**
- [ ] Token pertama tampil kurang dari 150 ms setelah token pertama diterima server EZClaw dari provider (overhead EZClaw, bukan latensi provider).
- [ ] Markdown, tabel GFM, LaTeX, dan blok kode dengan syntax highlight dirender saat streaming tanpa layout melompat.
- [ ] Tombol Stop menghentikan stream dan menyimpan teks parsial dengan tanda "Dihentikan".
- [ ] Jika koneksi browser putus, stream tetap berjalan di server dan tersambung kembali saat tab dibuka lagi.

#### E3-S2 Blok reasoning (P0, S)

```
Sebagai owner,
saya ingin melihat proses berpikir model terpisah dari jawaban,
supaya jawabannya bersih tapi alasannya tetap bisa dibaca.
```

**Acceptance criteria**
- [ ] Reasoning dari `reasoning_content`, blok thinking Anthropic, ringkasan reasoning OpenAI, thought Gemini, atau tag `<think>` dirender sebagai blok terlipat dengan durasi dan jumlah token jika tersedia.
- [ ] Kebijakan "kirim ulang reasoning ke riwayat" diatur per profil model, karena berbeda antar provider: blok thinking Anthropic yang bertanda tangan wajib dipertahankan saat tool use, signature thought Gemini perlu dikembalikan, item reasoning terenkripsi OpenAI Responses perlu diteruskan jika tidak memakai penyimpanan server, sementara provider lain meminta reasoning tidak dikirim balik. Detail tiap provider diverifikasi di M1 dan ditulis di preset.

#### E3-S3 Lampiran (P0, M)

**Acceptance criteria**
- [ ] Gambar (PNG, JPEG, WebP, GIF frame pertama) bisa di-drag, di-paste, atau dipilih. Diubah ukurannya otomatis sesuai batas profil model.
- [ ] File teks dan kode disisipkan sebagai konten teks dengan nama file. PDF dikirim native jika model mendukung, jika tidak diekstrak jadi teks (P1).
- [ ] Given model tidak menerima input gambar, when owner melampirkan gambar, then composer menampilkan peringatan sebelum kirim, bukan error setelah kirim.

#### E3-S4 Edit, regenerate, dan cabang (P0 edit/regenerate, P1 cabang)

**Acceptance criteria**
- [ ] Edit pesan owner lalu kirim ulang membuat cabang baru. Cabang lama tetap bisa dibuka (navigasi `< 2/3 >`).
- [ ] Regenerate bisa memakai model lain dari menu, dan hasilnya disimpan sebagai cabang.
- [ ] Ganti model di tengah thread diperbolehkan. Riwayat dikonversi ke format protokol model baru.

#### E3-S5 Preset system prompt (P0, S)

**Acceptance criteria**
- [ ] Owner menyimpan system prompt bernama, memilihnya per thread, dan bisa menetapkan default.
- [ ] Variabel sederhana tersedia: `{{date}}`, `{{os}}`, `{{workspace}}`.

#### E3-S6 Organisasi thread (P0 dasar, P1 cari)

**Acceptance criteria**
- [ ] Judul thread dibuat otomatis oleh model peran Title setelah pesan pertama, bisa diganti manual.
- [ ] Pin, arsip, hapus (dengan konfirmasi), export ke Markdown dan JSON.
- [ ] P1: pencarian teks penuh di semua thread (SQLite FTS5).

### Epic E4: Harness (P0)

Harness adalah lapisan yang mengubah "model mentah" menjadi "asisten yang bisa bekerja". Owner ingin harness ini bisa dimatikan untuk membandingkan atau untuk chat polos.

#### E4-S1 Harness ON/OFF per thread (P0, M)

```
Sebagai owner,
saya ingin satu toggle Harness di composer,
supaya saya bisa memilih antara model mentah dan model dengan tools serta instruksi kerja.
```

**Acceptance criteria**
- [ ] Toggle tersedia di Chat dan Agent. Di Agent, OFF berarti loop tetap berjalan tapi hanya dengan system prompt owner dan tools yang owner pilih manual.
- [ ] Mengubah toggle di tengah thread berlaku mulai giliran berikutnya, dan tercatat sebagai penanda di timeline thread ("Harness OFF mulai pesan ini").
- [ ] Status OFF berarti: tidak ada system prompt tambahan dari EZClaw, tidak ada tools, tidak ada file instruksi project yang disisipkan. Request yang dikirim sama persis dengan yang terlihat di inspektor.

#### E4-S2 Profil harness (P0 dua profil, P1 profil Codex)

**Acceptance criteria**
- [ ] Profil adalah data (`harness/*.json` + template prompt Markdown) dengan field: `systemPrompt`, `tools[]`, `loop` (maks step, kondisi berhenti), `context` (ambang kompaksi, batas output tool), `approval` (mode default), `projectInstructions` (nama file yang dibaca, misalnya `AGENTS.md`, `EZCLAW.md`).
- [ ] Profil bawaan P0: **EZClaw Chat** (ringan, tools opsional: web fetch, baca lampiran) dan **EZClaw Agent** (tools file, shell, plan).
- [ ] P1: profil **Codex-ref**, disusun setelah mempelajari direktori Codex yang akan diberikan owner (lihat Open Question Q1). Tujuannya meniru struktur tools, gaya instruksi, dan kebijakan approval Codex, lalu membandingkan hasilnya dengan profil EZClaw Agent pada task yang sama.
- [ ] Owner bisa menduplikasi dan mengedit profil dari UI. Profil bawaan read-only.

#### E4-S3 File instruksi project (P0, S)

**Acceptance criteria**
- [ ] Saat harness ON di Agent, EZClaw membaca `AGENTS.md` dan `EZCLAW.md` dari root workspace (dan folder induk sampai root git) lalu menyisipkannya sesuai profil.
- [ ] UI menunjukkan file instruksi mana yang dipakai di run ini.

### Epic E5: Agent Loop (P0)

#### E5-S1 Menjalankan task di workspace (P0, XL)

```
Sebagai owner,
saya ingin memberi task ke agent yang bekerja di folder project saya,
supaya pekerjaan multi-langkah (baca kode, ubah file, jalankan test) dikerjakan sampai selesai.
```

**Acceptance criteria**
- [ ] Owner memilih folder workspace (path lokal) saat membuat thread Agent. Folder terakhir diingat.
- [ ] Loop: panggil model, eksekusi tool call, kirim hasilnya, ulangi sampai model menjawab tanpa tool call, owner menekan Stop, atau batas step tercapai (default 60, bisa diubah).
- [ ] Setiap step tampil di timeline secara live: teks model, reasoning (terlipat), tool call dengan argumen, output tool (terpotong dengan opsi lihat penuh), durasi, dan token.
- [ ] Run berjalan di server, bukan di browser. Menutup tab tidak menghentikan run. Membuka kembali menampilkan state terkini.
- [ ] Bekerja dengan model mana pun yang mendukung tool calling. Model tanpa tool calling ditandai di katalog dan tidak bisa dipilih untuk Agent saat harness ON (P2: mode tool calling berbasis teks untuk model tanpa dukungan native).

#### E5-S2 Tools bawaan (P0)

| Tool | Fungsi | Prioritas |
|---|---|---|
| `list_dir` | Daftar isi folder dengan kedalaman terbatas, menghormati `.gitignore` | P0 |
| `read_file` | Baca file dengan rentang baris, batas ukuran | P0 |
| `search` | Pencarian teks/regex di workspace (ripgrep) | P0 |
| `write_file` | Buat atau timpa file | P0 |
| `edit_file` | Ganti string tepat di file (gagal jika tidak unik) | P0 |
| `shell` | Jalankan perintah (PowerShell di Windows, opsi Git Bash), timeout, output dipotong kepala+ekor | P0 |
| `update_plan` | Daftar langkah dengan status, tampil sebagai panel plan | P0 |
| `ask_user` | Jeda run dan tanya owner, lanjut setelah dijawab | P0 |
| `view_image` | Masukkan gambar dari workspace ke konteks model | P1 |
| `apply_patch` | Patch multi-file (format mengikuti temuan dari Codex) | P1 |
| `web_fetch` | Ambil halaman sebagai teks | P1 |
| `web_search` | Pencarian web (native provider jika ada, atau API yang dikonfigurasi owner) | P1 |
| `shell_background` | Jalankan proses panjang (dev server) dan baca log-nya | P1 |
| `generate_image` | Agent memanggil Image Studio | P2 |
| Klien MCP | Tools dari server MCP yang dikonfigurasi owner | P2 |

#### E5-S3 Izin dan keamanan eksekusi (P0, L)

```
Sebagai owner,
saya ingin mengatur apa yang boleh dilakukan agent tanpa bertanya,
supaya saya bisa membiarkannya bekerja tanpa takut file di luar project rusak.
```

**Acceptance criteria**
- [ ] Tiga mode approval:
  - **Tanya dulu** (default): setiap tulis file dan setiap perintah shell menunggu persetujuan.
  - **Edit otomatis**: tulis file di dalam workspace otomatis, shell tetap ditanya.
  - **Otomatis penuh**: semua otomatis di dalam workspace. Mengaktifkannya memerlukan konfirmasi eksplisit per thread.
- [ ] Di mode apa pun, tulis file di luar workspace selalu ditanya.
- [ ] Kartu approval menampilkan: aksi, path atau perintah lengkap, diff untuk edit file, dan tombol Izinkan, Izinkan selalu untuk pola ini (disimpan per workspace), Tolak dengan alasan (alasan dikirim ke model).
- [ ] Daftar perintah yang selalu ditanya walau mode otomatis penuh (misalnya hapus rekursif, format disk, `git push --force`) bisa diedit owner.
- [ ] Batasan jujur: v1 tidak memakai sandbox OS di Windows. Perlindungan berasal dari approval, pembatasan path, dan daftar perintah. Hal ini ditulis di layar pengaturan agent.

#### E5-S4 Checkpoint dan undo (P1, M)

**Acceptance criteria**
- [ ] Sebelum tool menulis file, isi lama disimpan sebagai checkpoint per step.
- [ ] Owner bisa "Undo sampai step ini" yang mengembalikan semua file yang diubah sejak step itu, dengan pratinjau daftar file.
- [ ] Checkpoint tidak bergantung pada git, tapi jika workspace adalah repo git, EZClaw menampilkan `git status` ringkas di akhir run.

#### E5-S5 Manajemen konteks (P0, M)

**Acceptance criteria**
- [ ] Penggunaan konteks ditampilkan sebagai meter (token terpakai dari context window profil).
- [ ] Saat mencapai ambang profil (default 80%), EZClaw menjalankan kompaksi: riwayat lama diringkas oleh model peran Summary, file dan keputusan penting dipertahankan, lalu run lanjut. Kompaksi tercatat di timeline.
- [ ] Output tool panjang dipotong (kepala dan ekor) sesuai batas profil, dengan catatan jumlah baris yang dihilangkan.
- [ ] Prompt caching dipakai jika provider mendukung (misalnya penanda cache pada Anthropic), supaya loop panjang lebih murah.

#### E5-S6 Mengarahkan run yang sedang jalan (P1, M)

**Acceptance criteria**
- [ ] Owner bisa mengetik pesan saat run berjalan. Pesan masuk antrian dan disisipkan sebelum panggilan model berikutnya.
- [ ] Pause dan Resume tersedia di antara step.

### Epic E6: Image Generate (P0)

Alurnya seperti generate gambar di ChatGPT atau Gemini: sebuah thread percakapan di mana jawaban asisten berupa gambar, dan pesan lanjutan ("buat versi malam hari") mengubah hasil sebelumnya.

#### E6-S1 Generate dari prompt (P0, M)

```
Sebagai owner,
saya ingin menulis prompt, memilih model gambar, dan mendapatkan beberapa hasil,
supaya saya bisa memilih yang terbaik.
```

**Acceptance criteria**
- [ ] Composer gambar: prompt, model, aspect ratio atau ukuran (pilihan dari profil model), jumlah gambar (dibatasi profil), seed, dan parameter khusus model (steps, cfg, negative prompt, style, quality) jika didukung.
- [ ] Hasil tampil sebagai grid di giliran asisten. Setiap gambar punya aksi: perbesar, unduh, salin prompt, jadikan referensi, buka di Image Edit, generate ulang dengan seed yang sama.
- [ ] Selama proses, setiap slot menunjukkan status (antri, berjalan, gagal dengan alasan), bukan skeleton kosong.
- [ ] Mendukung tiga jalur teknis, dipilih otomatis dari profil model:
  1. **Model chat dengan output gambar** (misalnya model gambar Gemini, atau model di OpenRouter dengan modalitas output gambar): dikirim sebagai pesan chat dengan modalitas gambar.
  2. **API gambar khusus** (OpenAI Images, endpoint image generate Venice, xAI image): dikirim sebagai request gambar.
  3. **API async** (misalnya DashScope untuk Qwen Image langsung dari Alibaba): submit task lalu polling, dengan status di UI.

#### E6-S2 Gambar referensi saat generate (P0, M)

**Acceptance criteria**
- [ ] Owner bisa menambahkan 0 sampai N gambar referensi (N dari profil model). Jika model tidak menerima gambar input, tombol referensi disabled dengan alasan.
- [ ] Setiap referensi bisa diberi label peran opsional (gaya, subjek, komposisi, palet warna, bebas). Label dikompilasi ke dalam prompt (lihat E7-S2).

#### E6-S3 Follow-up percakapan dan Prompt Composer (P0, L)

```
Sebagai owner,
saya ingin menulis "ubah jadi malam hari, tambah lampu jalan" setelah hasil pertama,
supaya saya mengiterasi gambar seperti di ChatGPT, bahkan dengan model yang hanya menerima satu prompt.
```

**Acceptance criteria**
- [ ] Untuk model percakapan (jalur 1), riwayat thread dan gambar sebelumnya dikirim apa adanya.
- [ ] Untuk model prompt tunggal (jalur 2 dan 3, misalnya Qwen Image), model peran **Prompt Composer** menyusun prompt mandiri dari riwayat dan instruksi baru, lalu memutuskan apakah gambar sebelumnya dipakai sebagai input (jika model mendukung edit) atau generate ulang dari prompt.
- [ ] Prompt hasil susunan selalu ditampilkan di atas hasil, bisa diedit, dan bisa dikirim ulang. Tidak ada prompt tersembunyi.
- [ ] Owner bisa mematikan Prompt Composer per thread (prompt dikirim persis seperti diketik).

### Epic E7: Image Edit Expert (P0)

Satu gambar menjadi objek edit utama, gambar lain menjadi referensi. Tanpa mask.

#### E7-S1 Workspace edit (P0, L)

```
Sebagai owner,
saya ingin satu layar dengan gambar target besar, slot referensi, dan kotak instruksi,
supaya jelas mana yang diedit dan mana yang hanya contoh.
```

**Acceptance criteria**
- [ ] Area target: satu gambar (upload, paste, dari Library, atau dari hasil Generate).
- [ ] Area referensi: slot gambar dengan peran wajib dipilih dari daftar: **Gaya**, **Subjek/Karakter**, **Objek**, **Palet warna**, **Komposisi/Pose**, **Latar**, **Lainnya** (dengan deskripsi singkat).
- [ ] Jumlah slot referensi dibatasi profil model (total gambar input dikurangi satu untuk target). Jika melebihi, slot berlebih ditandai dan tidak dikirim, dengan alasan.
- [ ] Kotak instruksi dan chip **Pertahankan** (wajah, komposisi, warna, teks di gambar, latar) yang dikompilasi ke prompt.

#### E7-S2 Kompilasi prompt edit (P0, M)

**Acceptance criteria**
- [ ] EZClaw menyusun prompt yang menyebut urutan gambar secara eksplisit, misalnya: "Gambar 1 adalah gambar yang diedit. Gambar 2 adalah referensi gaya: tiru teknik warna dan tekstur, bukan isinya. Instruksi: ... Pertahankan: wajah dan komposisi Gambar 1."
- [ ] Template kompilasi bisa diatur per model (beberapa model lebih baik dengan bahasa Inggris, atau dengan format tertentu). Default bahasa Inggris, karena sebagian besar model gambar dilatih dominan dengan prompt bahasa Inggris (diuji di M3).
- [ ] Prompt hasil kompilasi bisa dilihat dan diedit sebelum dikirim. Opsi "Rapikan dengan Prompt Composer" tersedia.

#### E7-S3 Versi, perbandingan, dan lanjutan (P0, M)

**Acceptance criteria**
- [ ] Setiap hasil edit menjadi versi baru di Lineage dengan metadata lengkap (induk, referensi, instruksi, prompt terkompilasi, model, parameter, seed).
- [ ] Perbandingan: berdampingan dan geser (slider) antara dua versi mana pun, termasuk aslinya.
- [ ] "Lanjutkan dari versi ini" menjadikan versi itu target baru tanpa menghapus cabang lain.
- [ ] Lineage tampil sebagai rangkaian versi (bukan hanya grid), sehingga owner tahu urutan edit.

#### E7-S4 Model satu input (P2, M, eksperimental)

**Acceptance criteria**
- [ ] Untuk model edit yang hanya menerima satu gambar, opsi "Gabungkan referensi" membuat satu lembar kolase (target + referensi berlabel) sebagai input, dengan peringatan bahwa kualitasnya tidak dijamin.

### Epic E8: Library (P1)

**Acceptance criteria**
- [ ] Semua asset (upload, generate, edit) tampil di satu galeri dengan filter model, mode, tanggal, favorit, dan pencarian prompt.
- [ ] "Remix" membuka composer dengan prompt, model, dan parameter yang sama.
- [ ] Metadata disimpan di database, dan opsional ditulis ke metadata PNG (owner bisa mematikan).

### Epic E9: Penggunaan dan biaya (P1)

**Acceptance criteria**
- [ ] Per pesan dan per run: token input, output, reasoning, cache, dan biaya jika provider mengembalikan biaya (misalnya data usage OpenRouter).
- [ ] Jika provider tidak mengembalikan biaya, owner bisa mengisi harga per model, dan EZClaw menghitung estimasi dengan label "estimasi".
- [ ] Ringkasan harian dan mingguan per Endpoint dan per model.

### Epic E10: Pengaturan, rahasia, dan keamanan lokal (P0)

**Acceptance criteria**
- [ ] Server hanya listen di `127.0.0.1`.
- [ ] Setiap peluncuran membuat token sesi acak yang disisipkan ke halaman yang disajikan server. Semua request API wajib membawa token ini, dan header `Origin`/`Host` diperiksa untuk mencegah situs lain (atau DNS rebinding) memanggil API lokal yang bisa menjalankan shell.
- [ ] API key disimpan di credential store OS (Windows Credential Manager) lewat library keyring. Fallback: file terenkripsi di folder data, dengan peringatan.
- [ ] Log dan inspektor request menyensor key dan header auth.
- [ ] Folder data default `~/.ezclaw/` (bisa diubah): database, media, checkpoint, log.
- [ ] Backup dan restore: export satu arsip (database + media) dan import kembali.

---

## 7. Pertimbangan teknis

### 7.1 Stack (keputusan owner: TypeScript penuh)

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Runtime | Node.js 22 LTS | Stabil di Windows untuk proses shell dan native module. Bun bisa dicoba nanti. |
| Monorepo | pnpm workspaces | Satu repo untuk server, web, dan paket bersama. |
| Server | Hono + `@hono/node-server` | Ringan, typed, SSE mudah. |
| Validasi | Zod | Satu skema untuk API, profil, dan form. |
| Database | SQLite (`better-sqlite3`) + Drizzle ORM | Lokal, satu file, FTS5 untuk pencarian. |
| Frontend | React 19 + Vite + TypeScript | Ekosistem luas, dev server cepat. |
| Routing dan data | TanStack Router + TanStack Query | Routing typed, cache request. |
| State UI | Zustand | Kecil, cukup untuk state composer dan panel. |
| Styling | Tailwind CSS v4 dengan token dari `design/tokens.css` | Token tetap satu sumber, utility untuk kecepatan. |
| Komponen dasar | Radix UI primitives | Dialog, popover, select, slider, switch, tabs yang aksesibel dengan keyboard. |
| Markdown | `react-markdown` + `remark-gfm` + KaTeX + Shiki | Render chat dan kode. |
| Ikon | Phosphor Icons | Lihat alasan di `DESIGN.md`. |
| Gambar | `sharp` | Resize, thumbnail, konversi sebelum upload ke provider. |
| Shell dan pencarian | `child_process` + `@vscode/ripgrep` | Tool agent. |
| Keyring | `@napi-rs/keyring` | Windows Credential Manager. |
| Test | Vitest + Playwright + mock provider server | Adapter diuji dengan fixture rekaman. |

### 7.2 Arsitektur

```
Browser (React UI)
   |  HTTP + SSE, token sesi, hanya 127.0.0.1
   v
Server EZClaw (Hono, Node)
   |-- API routes (threads, runs, assets, endpoints, settings)
   |-- Run Manager ............ menjalankan chat stream, agent loop, job gambar di server
   |      |-- Harness Engine ... profil -> system prompt, tools, kebijakan loop/konteks
   |      |-- Tool Runtime ..... fs, shell, search, plan, ask_user, approval gate
   |      `-- Image Pipeline ... prompt composer, kompilasi edit, polling async
   |-- Model Registry ......... endpoint, discovery, capability profile berlapis
   |-- Parameter Engine ....... kanonik -> spesifik protokol/model, belajar penolakan
   |-- Protocol Adapters ...... openai-chat, openai-responses, anthropic, gemini,
   |                            openai-images, venice-image, dashscope-async, ...
   |-- Storage ................ SQLite (Drizzle), media di disk, checkpoint
   `-- Secrets ................ keyring OS
```

Struktur repo yang diusulkan:

```
ezclaw/
  apps/
    server/        Hono, run manager, tool runtime
    web/           React UI
  packages/
    core/          tipe kanonik (Message, Part, Params, Capability)
    adapters/      satu folder per protokol
    registry/      endpoint bawaan, preset kurasi (JSON), resolver profil
    harness/       profil bawaan (JSON + Markdown)
    ui/            komponen sesuai DESIGN.md
  design/          tokens.css, preview.html
  docs/            PRD.md, catatan riset Codex (nanti)
```

### 7.3 Format pesan kanonik

Semua riwayat disimpan dalam satu format, lalu adapter mengonversinya ke format protokol saat dikirim. Ini yang memungkinkan ganti model di tengah thread.

```ts
type Part =
  | { type: "text"; text: string }
  | { type: "image"; assetId: string; role?: ImageRole }
  | { type: "file"; assetId: string; mime: string; name: string }
  | { type: "reasoning"; text?: string; signature?: string; encrypted?: string; providerMeta?: unknown }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; output: string; isError?: boolean; images?: string[] };

interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  parts: Part[];
  modelRef?: { endpointId: string; modelId: string };
  usage?: Usage;
}
```

`providerMeta` menyimpan data yang harus dikembalikan ke provider yang sama (signature, item terenkripsi). Saat ganti model ke provider lain, data ini dibuang atau dikonversi sesuai kebijakan profil.

### 7.4 Interface adapter

```ts
interface ProtocolAdapter {
  id: string;                                   // "openai-chat", "anthropic", ...
  listModels?(ep: Endpoint): Promise<DiscoveredModel[]>;
  buildRequest(input: CanonicalRequest, profile: CapabilityProfile): HttpRequest;
  parseStream(res: Response): AsyncIterable<CanonicalEvent>;  // text, reasoning, tool_call delta, usage, done
  parseError(res: Response): Promise<AdapterError>;           // termasuk deteksi parameter ditolak
}
```

Provider yang kompatibel OpenAI (DeepSeek, Qwen mode kompatibel, GLM, MiniMax, MiMo, xAI, OpenRouter, Venice, lokal) memakai adapter `openai-chat` yang sama ditambah **quirk** dari profil: nama field reasoning di stream, parameter tambahan (misalnya `venice_parameters` untuk Venice, objek `provider` untuk routing OpenRouter), dan aturan role system.

### 7.5 Agent loop (ringkas)

```
run(threadId, userMessage):
  ctx = harness.buildContext(thread, workspace)        # system prompt, instruksi project, tools
  loop step in 1..maxSteps:
    if ctx.tokens > threshold: ctx = compact(ctx)
    resp = stream(model, ctx)                          # event dikirim ke UI via SSE
    if resp.toolCalls is empty: break
    for call in resp.toolCalls:
      if needsApproval(call): await approval(call)     # run berstatus "menunggu owner"
      result = toolRuntime.exec(call)                  # checkpoint sebelum tulis file
      ctx.append(result)
    ctx.appendQueuedUserMessages()
  persist(run)
```

### 7.6 Penyimpanan

Tabel utama (SQLite): `endpoints`, `models`, `model_overrides`, `learned_params`, `threads`, `messages`, `runs`, `steps`, `approvals`, `assets`, `asset_lineage`, `presets`, `harness_profiles`, `usage`, `request_logs`. Media disimpan di `~/.ezclaw/media/<yyyy>/<sha256>.<ext>` dengan thumbnail WebP.

### 7.7 Kinerja

- Overhead EZClaw sebelum request keluar ke provider: target kurang dari 50 ms (tidak termasuk upload gambar).
- UI tetap responsif pada thread berisi 2.000 pesan (list virtual).
- Library tetap lancar dengan 10.000 asset (thumbnail, pagination).

### 7.8 Kompatibilitas

- OS utama: Windows 11. macOS dan Linux sebaiknya jalan, tapi tidak diuji di v1.
- Browser: Chrome dan Edge terbaru. Firefox best effort.
- Layar: desktop utama. Lebar ponsel tetap tidak rusak (tanpa horizontal scroll) untuk melihat riwayat dan hasil gambar dari HP di jaringan yang sama (P2, butuh mode bind LAN yang eksplisit).

---

## 8. Kebutuhan desain dan UX

Detail visual ada di [`DESIGN.md`](../DESIGN.md). Ringkasan kebutuhan:

- **Empat mode** dengan satu shell: Chat, Agent, Image, Edit. Berpindah mode tidak kehilangan draf composer.
- **Fokus per layar:** di Chat dan Agent, fokusnya composer dan timeline. Di Image, hasil terakhir. Di Edit, gambar target.
- **Inspector kanan** (bisa ditutup): model, parameter dinamis, harness, dan info run. Bukan dashboard berisi kartu statistik.
- **Approval** memakai satu warna aksen khusus (ember) agar satu-satunya hal yang menunggu owner selalu terlihat.
- **Tema:** mengikuti OS, dengan toggle manual light/dark. Kedua tema wajib lolos kontras WCAG AA.
- **Keyboard:** semua aksi utama bisa lewat keyboard. Pintasan awal: `Ctrl+Enter` kirim, `Esc` stop atau tutup dialog, `Ctrl+K` palet perintah (P1), `Ctrl+Shift+M` ganti model, `Ctrl+.` toggle harness, `Alt+1..4` ganti mode (`Ctrl+angka` sudah dipakai browser untuk pindah tab).
- **State wajib:** setiap daftar dan panel data punya state kosong (menjelaskan langkah pertama), loading (menyebut apa yang dimuat), dan error (menyebut penyebab dan langkah berikutnya).
- **Bahasa UI:** lihat Open Question Q5.

---

## 9. Metrik keberhasilan

Ini alat pribadi, jadi metriknya adalah sinyal pemakaian dan kualitas untuk satu orang. Semua angka di bawah adalah **target** yang diukur dari data lokal EZClaw, bukan klaim.

**North Star:** jumlah tugas per minggu (thread chat yang dipakai, run agent yang selesai, gambar yang disimpan) yang dikerjakan di EZClaw tanpa membuka aplikasi provider lain.

| Kategori | Metrik | Target v1 | Cara ukur |
|---|---|---|---|
| Kompatibilitas | Model favorit owner yang jalan tanpa edit JSON manual | 9 dari 10 | Checklist model favorit di M5 |
| Kompatibilitas | Pesan gagal karena parameter (setelah auto-retry) | kurang dari 1% | Tabel `request_logs` |
| Kinerja | Overhead EZClaw sebelum request keluar | kurang dari 50 ms (p95) | Timer di server |
| Agent | Task benchmark pribadi (10 task di repo nyata) yang selesai tanpa intervensi selain approval | 7 dari 10 dengan DeepSeek V4.1 Flash, profil EZClaw Agent | Dijalankan di M4 dan M5 |
| Harness | Selisih hasil benchmark harness ON vs OFF, dan EZClaw Agent vs Codex-ref | dicatat, tanpa target angka | Laporan perbandingan |
| Edit gambar | Edit yang mempertahankan subjek utama sesuai chip Pertahankan | dinilai owner 4 dari 5 rata-rata | Rating jempol per versi |
| Keandalan | Run agent yang hilang karena tab ditutup atau reload | 0 | Uji manual |

---

## 10. Lingkup

### 10.1 Masuk lingkup v1

- Endpoint bawaan untuk 9 provider dan 2 gateway, custom endpoint, dan local endpoint.
- Model Registry, Capability Profile berlapis, panel parameter dinamis, belajar penolakan, inspektor request.
- Chat streaming dengan reasoning, lampiran, edit/regenerate, preset system prompt.
- Harness ON/OFF dengan dua profil bawaan.
- Agent loop dengan tools P0, tiga mode approval, kompaksi konteks.
- Image Generate dengan referensi dan Prompt Composer.
- Image Edit Expert dengan peran referensi, kompilasi prompt, lineage, dan perbandingan.
- Keamanan lokal (bind localhost, token sesi, cek origin, keyring).

### 10.2 Di luar lingkup v1

- Inpainting, mask, outpainting.
- Video, audio, voice.
- Multi-user, login, akses publik.
- Sandbox OS untuk shell di Windows.
- Login berbasis langganan konsumen (misalnya ChatGPT Plus).
- Aplikasi mobile native.

### 10.3 Nanti (P1/P2)

- Profil harness Codex-ref (setelah riset direktori Codex).
- Checkpoint dan undo, `apply_patch`, web search/fetch, proses background.
- Library, pencarian teks penuh, ringkasan biaya.
- Klien MCP, tool `generate_image` untuk agent, mode tool calling berbasis teks.
- Kolase referensi untuk model satu input.
- Perbandingan dua model berdampingan untuk prompt yang sama.

---

## 11. Milestone

Estimasi kasar dalam minggu kerja, belum divalidasi dengan waktu yang tersedia.

| Milestone | Isi | Estimasi | Selesai jika |
|---|---|---|---|
| **M0 Fondasi** | Monorepo, server + web, SQLite, token sesi, token desain, shell UI, tema | 1 minggu | App terbuka di `127.0.0.1`, toggle tema jalan, test CI lokal hijau |
| **M1 Registry dan Chat** | Endpoint (semua provider), discovery, Capability Profile, Parameter Engine, chat streaming, reasoning, lampiran, inspektor | 2 sampai 3 minggu | Chat jalan dengan DeepSeek V4.1 Flash, GPT-6 Luna, 3 model OpenRouter, 2 model Venice, 1 model lokal |
| **M2 Agent dan Harness** | Mulai dengan riset direktori Codex, lalu agent loop, tools P0, approval, kompaksi, harness ON/OFF, profil EZClaw Agent | 3 minggu | 10 task benchmark dijalankan dan hasilnya dicatat |
| **M3 Image Generate** | Tiga jalur teknis, referensi, Prompt Composer, grid hasil | 1,5 minggu | Qwen Image (lewat OpenRouter atau Venice) jalan dengan follow-up percakapan |
| **M4 Image Edit** | Workspace edit, peran referensi, kompilasi prompt, lineage, perbandingan | 1,5 minggu | Edit 3 versi berantai dengan 2 referensi, perbandingan geser jalan |
| **M5 Profil Codex-ref dan polish** | Profil Codex-ref, checkpoint/undo, Library, biaya, backup | 2 minggu | Laporan perbandingan harness, checklist metrik bagian 9 diisi |

---

## 12. Risiko dan mitigasi

| Risiko | Dampak | Kemungkinan | Mitigasi |
|---|---|---|---|
| API provider berubah atau parameter baru muncul | Request gagal | Tinggi | Lapisan profil berlapis, extra body JSON, belajar penolakan, preset sebagai file JSON yang mudah diperbarui |
| Perilaku reasoning saat tool use berbeda antar provider (signature, item terenkripsi) | Loop agent rusak di step ke-2 | Tinggi | Kebijakan per profil, fixture test multi-step per adapter sebelum model dipakai untuk Agent |
| Agent menjalankan perintah berbahaya | Kehilangan data | Sedang | Approval default "Tanya dulu", batasan path, daftar perintah selalu tanya, checkpoint (P1), tanpa klaim sandbox |
| Situs web memanggil API lokal | Eksekusi perintah dari luar | Rendah, dampak tinggi | Token sesi, cek Origin/Host, bind localhost |
| Model gambar via gateway tidak mendukung semua parameter atau multi-input | Edit tidak sesuai harapan | Sedang | Profil membatasi slot, peringatan sebelum kirim, kolase (P2) |
| Nama model di brief (DeepSeek V4.1 Flash, GPT-6 Luna) punya parameter yang belum diketahui | Fitur reasoning tidak terpetakan | Sedang | Discovery + override + extra body, preset ditulis setelah membaca dokumentasi resmi di M1 |
| Scope terlalu besar untuk satu orang | v1 molor | Tinggi | Milestone berurutan, P1/P2 dipisah tegas, setiap milestone bisa dipakai sendiri |
| Biaya API membengkak saat loop agent panjang | Tagihan tak terduga | Sedang | Batas step, meter token, prompt caching, P1: batas biaya per run |

---

## 13. Dependensi dan asumsi

### Dependensi

- API key milik owner untuk provider dan gateway yang dipakai.
- Akses baca ke direktori Codex dari owner (untuk M2 dan M5).
- Dokumentasi resmi tiap provider untuk menulis preset kurasi.

### Asumsi (diverifikasi di M1)

- OpenRouter dan Venice tetap menyediakan endpoint model list dengan metadata modalitas dan parameter.
- Qwen Image tersedia lewat OpenRouter atau Venice dengan dukungan gambar input untuk edit. Jika tidak, jalur DashScope langsung dipakai.
- DeepSeek, GLM, MiniMax, MiMo, dan Qwen menyediakan endpoint kompatibel OpenAI, dan beberapa juga kompatibel Anthropic.
- Model yang owner pakai untuk Agent mendukung tool calling native.
- Owner menjalankan EZClaw di satu komputer Windows 11 dengan Node.js 22.

---

## 14. Open questions

| # | Pertanyaan | Kapan perlu dijawab |
|---|---|---|
| Q1 | Path direktori Codex yang akan dipelajari, dan bagian mana yang paling penting (prompt, tools, approval, kompaksi)? | Awal M2 |
| Q2 | Untuk Qwen Image, jalur utama OpenRouter atau Venice? Apakah perlu jalur DashScope langsung? | M3 |
| Q3 | Apakah web search untuk agent memakai fitur native provider saja, atau perlu API pencarian terpisah (dan yang mana)? | M2 |
| Q4 | Apakah perlu batas biaya per run atau per hari yang menghentikan agent otomatis? | M2 |
| Q5 | Bahasa UI: Inggris, Indonesia, atau keduanya? (Draf desain memakai label Indonesia, dengan istilah teknis seperti Harness, Endpoint, dan token tetap Inggris.) | M0 |
| Q6 | Logo EZClaw: sementara memakai wordmark teks. Apakah ada konsep logo? | Sebelum polish M5 |
| Q7 | Apakah akses dari HP di jaringan lokal dibutuhkan? Ini mengubah model keamanan (bind LAN + auth). | M5 |

---

## Lampiran A: Matriks Endpoint awal

Tabel ini adalah asumsi awal sebelum M1. **Hasil verifikasi terhadap dokumentasi resmi ada di [`PROVIDERS.md`](PROVIDERS.md)** dan lebih akurat; beberapa baris di bawah (misalnya DeepSeek, Anthropic, Xiaomi MiMo) sudah dikoreksi di sana.

| Endpoint | Protokol teks | Protokol gambar | Catatan yang perlu dicek |
|---|---|---|---|
| OpenAI | Responses (utama), Chat Completions | Images (generate + edit multi-input) | Reasoning effort, item reasoning terenkripsi, role developer |
| Anthropic | Messages | tidak ada output gambar | Thinking budget/effort, signature thinking saat tool use, cache control |
| Google Gemini | generateContent native, endpoint kompatibel OpenAI | Model gambar Gemini (output gambar dalam chat) | Thinking config per generasi, thought signature, batas gambar input |
| xAI | Chat Completions / Responses kompatibel | Endpoint image generation | Dukungan edit gambar, parameter reasoning |
| Alibaba Qwen | Mode kompatibel OpenAI (DashScope / Model Studio) | API gambar async DashScope | Region internasional vs China, `enable_thinking` |
| Z.ai GLM | Kompatibel OpenAI, kompatibel Anthropic | belum dipetakan | Objek `thinking`, region |
| DeepSeek | Kompatibel OpenAI, kompatibel Anthropic | tidak ada | Field `reasoning_content`, aturan kirim balik reasoning saat tool use di V4.x |
| MiniMax | Kompatibel OpenAI, kompatibel Anthropic | belum dipetakan | Cara reasoning dikembalikan dan apakah wajib dipertahankan di riwayat |
| Xiaomi MiMo | Kompatibel OpenAI (diasumsikan) | belum dipetakan | Base URL, parameter thinking |
| OpenRouter | Chat Completions kompatibel + objek `reasoning` terpadu | Output gambar lewat chat dengan modalitas gambar | `supported_parameters` per model, routing `provider`, data biaya di usage |
| Venice.ai | Chat Completions kompatibel + `venice_parameters` | Endpoint image generate dan edit native | Spesifikasi model gambar (ukuran, steps, style), batas input edit |
| Custom | Dipilih owner | Dipilih owner | |
| Local | Kompatibel OpenAI (Ollama, LM Studio, llama.cpp, vLLM) | biasanya tidak ada | Tag `<think>`, dukungan tool calling bervariasi |
