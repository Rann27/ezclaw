# Harness, wrapper, memori, dan tools Agent

Dokumen ini menjelaskan apa yang membungkus model di EZClaw: wrapper prompt bersegmen, memori, tools Agent, dan prompt caching. Lihat juga [`CODEX-HARNESS.md`](CODEX-HARNESS.md) untuk temuan dari instalasi Codex.

## Wrapper bersegmen

Setiap profil harness adalah daftar **segmen**: judul, kegunaan (catatan untuk pemilik, tidak dikirim), saklar ON/OFF, dan isi. Segmen digabung berurutan dalam salah satu dari dua format:

- **Teks biasa**: segmen digabung dengan baris kosong; judul Markdown ada di dalam isi segmen.
- **Tag**: setiap segmen dibungkus `<judul>…</judul>`, seperti wrapper Antigravity.

Variabel yang diisi saat dikirim: `{{date}}`, `{{os}}`, `{{shell}}`, `{{workspace}}`, `{{approval}}`, `{{model}}`, `{{timezone}}`, `{{codex_permissions}}`.

Setiap segmen punya **tempat**:

- **System prompt** (bawaan): masuk ke system prompt.
- **Pesan developer**: dikirim sebagai pesan `developer` terpisah setelah system prompt (Anthropic tidak punya role ini, jadi teksnya digabung ke system prompt).
- **Konteks sebelum pesanmu**: dikirim sebagai pesan user tepat sebelum pesanmu yang terbaru, seperti `<environment_context>` di Codex.

Opsi profil lain: **bungkus pesanmu dengan tag** (mis. `USER_REQUEST` menjadi `<USER_REQUEST>…</USER_REQUEST>`, seperti Antigravity), **cara kirim AGENTS.md** (di system prompt, atau gaya Codex sebagai pesan konteks), dan **deskripsi tools** (EZClaw atau gaya Codex).

Tombol **Anatomi request** di editor menunjukkan isi satu request secara utuh dan berurutan: system prompt, pesan developer, riwayat, konteks, pesanmu, dan daftar tools.

| Profil | Untuk | Asal |
|---|---|---|
| EZClaw Agent | Agent | Ditulis untuk EZClaw |
| Gaya Cowork | Agent | Ditulis EZClaw dengan gaya Claude Cowork / Claude Code. **Bukan** salinan prompt Anthropic; prompt asli Cowork tidak tersedia di komputer ini. |
| Codex (hardcode) | Agent | Teks dasar ditanam di `apps/server/src/agent/codexBase.ts` (dari katalog model Codex, OpenAI, Apache-2.0). Susunan request meniru Codex, lihat di bawah. |
| Codex (dari instalasi) | Agent | Sama, tetapi teks dasar dibaca setiap kali dari `models.json` di folder Codex pemilik. Hanya `models.json` yang dibuka. |
| EZClaw Chat | Chat | Ditulis untuk EZClaw. Aktif secara bawaan untuk thread Chat baru. |
| Chat gaya Claude | Chat | Ditulis EZClaw dengan gaya Claude, bukan salinan prompt Anthropic |
| Chat gaya ChatGPT | Chat | Ditulis EZClaw dengan gaya ChatGPT, bukan salinan prompt OpenAI |

**Impor dari teks** (Settings, Harness) memecah teks wrapper apa pun: teks bertag dipecah per tag, Markdown per judul tingkat atas (blok kode diabaikan). Teks di luar tag menjadi segmen sendiri yang bisa dimatikan.

Profil bawaan hanya bisa dilihat; duplikasi untuk mengubah. Profil lama (sebelum segmen ada) dipecah otomatis saat dibaca.

## Urutan prompt dan caching

Urutan yang dikirim, dari atas:

1. Segmen tetap profil, sesuai urutan
2. File instruksi project (`AGENTS.md`, `EZCLAW.md`, `CLAUDE.md`, sesuai profil)
3. Daftar skill (Agent, bila `read_skill` aktif)
4. Memori yang sudah disetujui
5. Instruksi tambahan thread
6. Segmen yang ditandai **berubah-ubah** (tanggal, folder, mode izin)

Bagian 1 sampai 5 sama dari request ke request, jadi provider yang meng-cache awalan prompt bisa memakainya ulang. Pratinjau di Settings menunjukkan berapa persen yang bisa di-cache.

- **OpenAI** dan **DeepSeek** meng-cache awalan otomatis (OpenAI untuk prompt di atas sekitar 1024 token). Tidak perlu tanda khusus.
- **Anthropic**: EZClaw memasang `cache_control` pada system prompt dan blok terakhir percakapan. Diatur lewat field profil model `promptCache` (bawaan aktif untuk protokol Anthropic). Catatan: penulisan cache Anthropic dikenai biaya sedikit lebih mahal sekali, lalu baca cache jauh lebih murah; untuk run Agent yang banyak langkah ini menguntungkan.
- **OpenRouter** model `anthropic/*`: preset menyalakan `promptCache`, jadi system message dikirim sebagai bagian teks dengan `cache_control`.
- Token dari cache tampil di footer jawaban Chat dan Agent ("dari cache").

## Susunan request Codex

Diambil dari kode sumber Codex (`openai/codex`, Apache-2.0). Satu giliran Codex dikirim sebagai:

1. `instructions`: teks dasar model (`base_instructions` di katalog).
2. Pesan `developer`: `<permissions instructions>` (mode sandbox dan kebijakan persetujuan), lalu daftar skill.
3. Pesan `user`: `# AGENTS.md instructions for <folder>` berisi `<INSTRUCTIONS>…</INSTRUCTIONS>`, lalu `<environment_context>` (cwd, shell, tanggal, zona waktu).
4. Pesan user yang sebenarnya.
5. Tools: `exec_command`, `apply_patch`, `update_plan`, `view_image`, dan lainnya.

Profil Codex di EZClaw mengikuti susunan itu. Perbedaan yang tersisa:

- Izin dipetakan dari mode EZClaw: Otomatis penuh menjadi `never`, mode lain `unless-trusted`; sandbox selalu ditulis `danger-full-access` karena EZClaw tidak punya sandbox OS.
- `apply_patch` di Codex adalah tool *freeform* dengan grammar; EZClaw memakai versi fungsi biasa dengan format patch yang sama.
- Tools Codex lain (MCP, `write_stdin`, `request_user_input`, dll.) tidak ada; EZClaw memakai tool miliknya sendiri bila diaktifkan di profil.
- Teks yang dikirim bergantung model: katalog Codex punya teks berbeda per model. EZClaw memakai satu teks.

## Wrapper hasil ekstraksi (Antigravity, dll.)

Teks wrapper dari aplikasi lain bisa dimasukkan lewat **Impor dari teks**. Wrapper semacam itu menyebut tool milik aplikasinya (`view_file`, `invoke_subagent`, …), jadi tambahkan segmen yang memetakan nama itu ke tool EZClaw, dan segmen berubah-ubah berisi folder, OS, dan tanggal. Teks milik pihak lain sebaiknya hanya disimpan di data lokal (`~/.ezclaw`), tidak di repo.

## Memori

Catatan singkat yang ikut di wrapper setiap thread yang profilnya mengaktifkan memori.

- **Umum**: semua Chat dan Agent. **Folder**: hanya Agent di folder itu.
- Model hanya bisa **mengusulkan** lewat tool `propose_memory`. Usulan tampil sebagai kartu di timeline Agent dan di Settings, Memori; baru dipakai setelah disimpan pemilik. Usulan yang tampak berisi kredensial ditolak tool.
- Maksimal 60 memori terbaru masuk ke satu prompt.

Konteks di dalam satu thread: Agent dan Chat sama-sama memadatkan percakapan lama menjadi ringkasan saat mendekati batas konteks model (Chat di 80% jendela).

## Tools Agent

| Tool | Fungsi | Izin |
|---|---|---|
| `list_dir`, `glob`, `read_file`, `search` | Melihat isi workspace | Tanpa izin di dalam workspace |
| `write_file`, `edit_file`, `apply_patch` | Mengubah file; isi sebelum perubahan pertama dicatat untuk undo | Tanya dulu, kecuali mode Edit otomatis atau Otomatis penuh |
| `shell`, `exec_command` | Perintah sekali jalan | Tanya, kecuali Otomatis penuh atau aturan "selalu izinkan"; perintah berisiko selalu ditanya |
| `start_process`, `read_process`, `stop_process` | Proses lama di latar (dev server, watcher); berhenti saat EZClaw ditutup | Sama dengan shell |
| `view_image` | Menampilkan gambar dari workspace ke model yang punya vision | Tanpa izin di dalam workspace |
| `web_fetch` | Membaca halaman web sebagai teks; alamat lokal dan jaringan privat ditolak | Tanya, kecuali Otomatis penuh |
| `web_search` | Pencarian lewat Brave, Tavily, atau Exa dengan key pemilik | Tanya di mode Tanya dulu |
| `spawn_agent` | Subagent riset hanya-baca dengan konteks sendiri; hasilnya laporan | Langkah yang butuh izin tetap ditanyakan ke pemilik |
| `read_skill` | Membaca `SKILL.md` dari skill yang terdaftar | Tanpa izin |
| `update_plan`, `ask_user`, `propose_memory` | Rencana, bertanya, mengusulkan memori | Tanpa izin |

**Undo**: di bawah setiap permintaan yang mengubah file muncul "Batalkan perubahan file". Semua file yang diubah run itu lewat tools file dikembalikan; file yang dibuat run itu dihapus. Perubahan lewat perintah shell tidak tercatat.

**Skill** dicari di `.ezclaw/skills`, `.agents/skills`, dan `.claude/skills` di workspace, folder `skills` di data EZClaw, dan folder tambahan di Settings, Umum.

## Dibanding Codex dan Claude Code / Cowork

Yang sudah setara: loop tool calling dengan izin per mode, edit file presisi dan patch, shell sekali jalan dan proses latar, rencana bertahap, bertanya ke pengguna, cari file dan isi, lihat gambar, baca web dan cari web, subagent riset, skills, file instruksi project, memori lintas sesi, pemadatan konteks, undo perubahan file.

Yang **belum** ada:

- Klien **MCP** (server tool eksternal).
- **Sandbox** tingkat sistem operasi. Batas EZClaw adalah folder workspace, izin, dan deteksi perintah berisiko, bukan isolasi proses.
- **Hooks** (perintah otomatis sebelum atau sesudah tool).
- Mengirim pesan **di tengah run** yang sedang berjalan; saat ini pesan baru menunggu run selesai.
- Subagent yang bisa **mengubah** file, dan beberapa subagent paralel.
- Undo untuk perubahan yang dibuat lewat perintah shell.
