# Harness Codex: temuan dan keputusan untuk EZClaw

Ditulis di awal M2 (2026-10-15) setelah membaca folder `~/.codex` milik owner. Yang dibaca: `config.toml` (dengan kredensial disensor), `models.json` (katalog model Codex), `rules/default.rules`, dan **struktur** satu log sesi (nama event, nama tool, bentuk argumen, tanpa isi percakapan). Yang sengaja tidak dibuka: `auth.json`, `.sandbox-secrets`, `cap_sid`, dan isi percakapan di log sesi atau database.

Biner Codex sendiri (tempat definisi tool dan loop berada) tidak ada di folder ini sebagai kode, jadi sebagian perilaku disimpulkan dari log, bukan dibaca dari sumbernya.

## Yang ditemukan

### 1. Codex dipakai owner lewat DeepSeek dengan wire Responses

`config.toml` memakai `model = "deepseek-flash"`, `model_provider = "deepseek"`, `wire_api = "responses"`, base URL `https://api.deepseek.com/`. Dokumentasi DeepSeek memastikan ada `POST /responses` (hanya `deepseek-flash` yang terdokumentasi; stateless, jadi seluruh riwayat dikirim di `input` tiap giliran; hanya tool `function` yang berlaku).

**Keputusan:** M2 menambah adapter `openai-responses`. Itu wire yang sama dengan yang dipakai Codex untuk DeepSeek, dan wire yang dibutuhkan GPT-6 Astra/Sol untuk tools. `openai-chat` dan `anthropic` juga mendapat tool calling.

### 2. Katalog model menentukan perilaku harness

Tiap entri `models.json` (39 field) berisi bukan hanya nama model, tapi juga cara harness memperlakukannya:

| Field Codex | Arti | Padanan di EZClaw |
|---|---|---|
| `base_instructions` / `instructions_template` | System prompt (17,7 ribu karakter) | `HarnessProfile.systemPrompt` |
| `apply_patch_tool_type: freeform` | Edit file lewat tool bebas-format "patch" | Tool `apply_patch` (P1). M2 memakai `edit_file` dan `write_file` yang lebih mudah dipakai model kecil |
| `shell_type: shell_command` | Cara shell diekspos | Tool `shell` |
| `truncation_policy {tokens, 10000}` | Output tool dipotong ke 10 ribu token | `loop.toolOutputLimit` |
| `supports_parallel_tool_calls` | Banyak tool call sekaligus | Dijalankan paralel jika aman (baca saja), berurutan jika ada tulis |
| `context_window`, `effective_context_window_percent: 95`, `auto_compact_token_limit` | Batas konteks dan kapan memadatkan | `context.compactAt` |
| `default_reasoning_level`, `supported_reasoning_levels` | Effort | Sudah ada di Parameter Engine |
| `input_modalities` | Gambar masuk | Profil kemampuan |

**Keputusan:** harness EZClaw adalah **data per profil** (bukan konstanta di kode), dan tiap profil bisa menimpa nilai per model.

### 3. Isi system prompt Codex (struktur, bukan salinan)

Bagian-bagiannya: kepribadian dan gaya tulis, "Working with the user" (kanal `commentary` untuk update singkat dan `final` untuk jawaban akhir; pesan baru dari user di tengah kerja dinilai apakah menimpa atau menambah; konteks yang dipadatkan dianggap satu rangkaian kerja), format jawaban akhir, aturan kerja, batasan edit file, otonomi dan ketekunan, tindakan destruktif, dan skills.

Pola yang berguna dan dipakai ulang sebagai ide:

- **Matriks otonomi per jenis permintaan:** menjawab/menjelaskan/review tidak boleh menulis ke luar; mendiagnosis tidak berarti memperbaiki; mengubah/membangun berarti mengimplementasikan dan memverifikasi. Kata seperti "selesaikan" menuntut ketekunan tapi tidak memperluas izin.
- **Tindakan destruktif:** resolve target dengan pengecekan baca-saja, jangan pakai `$HOME`, `~`, `/`, atau root workspace sebagai target rekursif, pilih operasi yang bisa dipulihkan, beri tahu apa yang dihapus.
- **Worktree kotor:** perubahan yang sudah ada milik user, jangan dibalikkan (`git reset --hard`, `git checkout --` hanya jika diminta jelas).
- **Efisiensi:** cari dengan `rg`, panggil tool paralel jika bisa, jangan menyambung perintah dengan `echo "===="`, jangan sleep lebih dari 60 detik.
- **Pembaruan berkala:** model memberi update singkat sebelum dan selama memakai tool, tidak diam lebih dari sekitar 60 detik.

**Keputusan:** prompt bawaan EZClaw Agent ditulis sendiri (bahasa dan batasan EZClaw sendiri) dengan pola di atas. Teks Codex **tidak disalin ke repo.** Profil **Codex-ref** membaca `base_instructions` dari `models.json` milik owner saat dipakai, jadi isinya tetap milik Codex di komputer owner dan selalu versi yang sama dengan yang owner pakai di Codex. Hanya `models.json` yang dibaca dari folder itu.

### 4. Bentuk tool dan hasilnya

Dari log sesi, tool yang dipakai: `exec_command` (argumen `cmd`, `workdir`) dan `apply_patch` (tool custom/freeform, isinya diawali `*** Begin Patch`, lalu `*** Add File:` / `*** Update File:` / `*** Delete File:`). Hasil `exec_command` diberi kepala tetap:

```
Chunk ID: ...
Wall time: 0.7191 seconds
Process exited with code 0
Original token count: 15
Output:
<isi>
```

**Keputusan:** hasil tool `shell` EZClaw memakai kepala yang sama jenisnya (kode keluar, durasi, jumlah token asli, apakah dipotong), supaya model yang sudah terbiasa dengan format Codex berperilaku sama. Pemotongan menyimpan kepala dan ekor, bukan hanya awal.

### 5. Kebijakan izin dan aturan perintah

Turn context mencatat `approval_policy` (contoh: `never`) dan `sandbox_policy` (contoh: `danger-full-access`) per giliran. File `rules/default.rules` menyimpan keputusan "izinkan selalu" sebagai baris:

```
prefix_rule(pattern=["npm", "run", "build"], decision="allow")
```

Artinya aturan mencocokkan **awalan** daftar argumen perintah, bukan teks bebas.

**Keputusan:** "Selalu izinkan pola ini" di EZClaw menyimpan aturan awalan per workspace dengan semantik yang sama, dan perintah dengan pengendali shell (`;`, `&&`, `|`, `>`, substitusi) tidak pernah cocok dengan aturan awalan, supaya `npm run build && curl ...` tidak lolos karena `npm run build` diizinkan.

### 6. Siklus giliran dan event

Log memakai event `task_started`, `task_complete` (dengan `duration_ms`, `time_to_first_token_ms`), `turn_aborted`, `token_count`, dan `turn_context` yang menyimpan cwd, tanggal, zona waktu, model, effort, dan kebijakan izin tiap giliran.

**Keputusan:** run agent EZClaw mencatat hal yang sama per giliran (cwd, tanggal, zona waktu, model, effort, mode izin) di data run, dan menyuntikkan tanggal, OS, dan workspace ke prompt.

### 7. Hal lain di setup owner yang relevan

- Server MCP `a1111` (Stable Diffusion WebUI lokal di `127.0.0.1:7860`) untuk gambar. Relevan untuk M3/M4: opsi provider gambar lokal bisa menyusul setelah jalur OpenRouter/Venice.
- Plugin dan skills Codex tidak dipakai oleh EZClaw di M2 (di luar lingkup).

## Dampak ke PRD

- Adapter `openai-responses` naik dari "nanti" ke M2 (E5-S1).
- Tool `apply_patch` tetap P1; M2 memakai `edit_file` (ganti string tepat) dan `write_file`.
- E4-S2: profil **Codex-ref** dikerjakan di M2 (bukan M5), berupa impor dari `models.json` lokal.
- E5-S3: aturan "selalu izinkan" memakai pencocokan awalan argumen, bukan pencocokan string.
