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

## Pengaman run panjang

- **Batas biaya per run** (aturan loop profil, bawaan mati): run berhenti sebelum langkah berikutnya begitu biaya yang dilaporkan provider mencapai batas. Hanya berlaku untuk provider yang melaporkan biaya per request (Experiential Labs, OpenRouter). Kalau provider tidak melaporkannya, run memberi catatan sekali dan batas tidak dijaga.
- **Gangguan server dicoba ulang**: balasan 500, 502, 503, 504, 520–524, dan 529, juga koneksi yang gagal sebelum ada data, dikirim ulang dengan request yang sama setelah 5, 15, 30, lalu 60 detik (atau selama `Retry-After`). Error di tengah streaming tidak diulang, supaya jawaban tidak dobel. Server lokal yang mati tidak ditunggu.
- Halaman error HTML dari CDN diringkas menjadi judulnya, misalnya "520: Web server is returning an unknown error (halaman error HTML)".

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
| `web_search` | Pencarian lewat Brave, Tavily, atau Exa dengan key pemilik; tanpa key, atau kalau layanan itu gagal, lewat DuckDuckGo | Tanya di mode Tanya dulu |
| `spawn_agent` | Subagent riset hanya-baca dengan konteks sendiri; hasilnya laporan | Langkah yang butuh izin tetap ditanyakan ke pemilik |
| `read_skill` | Membaca `SKILL.md` dari skill yang terdaftar | Tanpa izin |
| `update_plan`, `ask_user`, `propose_memory` | Rencana, bertanya, mengusulkan memori | Tanpa izin |

**Undo**: di bawah setiap permintaan yang mengubah file muncul "Batalkan perubahan file". Semua file yang diubah run itu lewat tools file dikembalikan; file yang dibuat run itu dihapus. Perubahan lewat perintah shell tidak tercatat.

## MCP

Settings, MCP. MCP server memberi model tools tambahan. EZClaw adalah klien MCP (SDK resmi `@modelcontextprotocol/sdk`).

- **Lokal (stdio)**: perintah seperti `npx`/`uvx` dijalankan sebagai proses anak. Hanya variabel lingkungan dasar yang diwariskan, ditambah env milik server itu; variabel `EZCLAW_*` dan key lain tidak ikut. Baris stderr terakhir tampil sebagai log.
- **Remote (HTTP)**: Streamable HTTP, dengan cadangan HTTP+SSE untuk server lama. Header (misalnya `Authorization`) bisa diisi sendiri, atau server meminta **login OAuth**: tombol Login membuka halaman masuknya, lalu browser kembali ke `/mcp/oauth/callback` di EZClaw. Registrasi klien dan token disimpan di penyimpanan kredensial.
- Env, header, dan token tidak pernah masuk database; halaman hanya menampilkan namanya.
- **Aktif**: disambung saat EZClaw jalan dan tools-nya ditawarkan. **Agent/Chat**: mode yang memakainya. Server yang mati tetap bisa dinyalakan otomatis oleh skill yang membutuhkannya.
- Gambar di hasil tool selalu tampil di timeline; ke model hanya dikirim bila modelnya menerima gambar.
- Tools tampil ke model sebagai `mcp__server__tool`. Resource server bisa dibaca lewat `mcp_list_resources` dan `mcp_read_resource`; prompt server muncul di menu `/` sebagai `/server:prompt` dan hasilnya masuk ke kotak pesan.
- **Izin**: "Ikut mode thread" berarti tool bertanda hanya-baca (`readOnlyHint`) jalan tanpa tanya, tool lain ditanya kecuali di Otomatis penuh. "Percayai server" menjalankan semua tool tanpa tanya. Per tool bisa diatur Selalu izinkan, Selalu tanya (ditanya juga di Otomatis penuh), atau Matikan. "Selalu izinkan" di kartu izin mengubah aturan tool itu.
- **Impor**: config Claude Desktop, Cursor, VS Code (JSON) atau Codex (`config.toml`), dari file di komputer ini atau ditempel. Server hasil impor mulai dalam keadaan mati.

## Skills

Settings, Skills. Skill adalah folder berisi `SKILL.md` dengan front matter `name`, `description`, dan opsional `mcp: [server]`.

- Dicari di `.ezclaw/skills`, `.agents/skills`, dan `.claude/skills` di workspace, folder `skills` di data EZClaw, dan folder tambahan di Settings, Umum. Nama yang sama: yang pertama ditemukan menang.
- Per skill: **Aktif** (dipakai Agent) dan **Chat** (juga dipakai di Chat; bawaan mati).
- Skill di folder EZClaw bisa diubah, dihapus, dan dibuat dari app. **Impor** menyalin setiap folder ber-`SKILL.md` dari folder lokal, file zip, atau repo GitHub publik (`https://github.com/pemilik/repo/tree/branch/folder`).
- `/nama-skill` di bagian mana pun dalam pesan, boleh lebih dari satu, mengirim isi skill bersama request (tanpa menunggu model memanggil `read_skill`) dan menyalakan MCP server yang disebut skill.
- Skill yang dibaca lewat `read_skill` juga menyalakan MCP server-nya; tools server itu tersedia mulai langkah berikutnya dan tetap menyala untuk pesan berikutnya di thread itu. Thread lain tidak ikut membawa tools-nya, jadi server dengan tools besar sebaiknya dimatikan dan dipanggil lewat skill.
- `read_skill` dengan `file` membaca file pembantu di folder skill. Chat memakai ini karena tidak punya `read_file`.

## Pesan di tengah run

Saat Agent (atau Chat dengan tools) sedang bekerja, kotak pesan tetap aktif. Pesan yang dikirim masuk antrean dan disisipkan ke percakapan setelah langkah yang sedang berjalan selesai (setelah hasil tool, supaya setiap pemanggilan tool tetap punya jawabannya). Kalau model sudah selesai menjawab saat pesan masuk, run berlanjut untuk menjawab pesan itu. Chat biasa tanpa tools tetap menunggu jawaban selesai.

## Lampiran di Chat

Klik ikon klip, seret file ke kotak pesan, atau tempel dari clipboard.

- **Gambar** dikirim sebagai gambar. Kalau model yang dipilih tidak menerima gambar, pesan itu dijawab model cadangan: peran **Cadangan vision** di Settings, Umum, atau bila kosong model lain yang menerima gambar (endpoint yang sama didahulukan). Thread tetap memakai model pilihanmu.
- **PDF** dibaca teksnya (lebih hemat, bisa dibaca model teks). PDF tanpa lapisan teks (hasil scan) diubah menjadi gambar per halaman, paling banyak 8 halaman, lalu mengikuti aturan gambar.
- **DOCX** dan file teks/kode dikirim sebagai teks. Lebih dari 150.000 karakter per file dipotong dengan catatan.
- Teks lampiran ikut tersimpan di pesan, jadi tetap terbaca di giliran berikutnya.

## Chat dengan tools

Kalau ada MCP server yang aktif untuk Chat, atau skill yang dinyalakan untuk Chat, pesan Chat dijalankan dengan loop yang sama seperti Agent, tanpa folder: model bisa memanggil tools MCP dan `read_skill`, izin mengikuti mode Tanya dulu, dan langkahnya tampil sebagai timeline. Tanpa itu, Chat tetap streaming biasa.

Tombol **Web** di kotak pesan Chat juga memakai loop ini, dengan tool `web_search` dan `web_fetch`. Menyalakan tombol itu dihitung sebagai izin, jadi pencarian dan pembacaan halaman tidak ditanyakan lagi. Model diminta menutup jawabannya dengan daftar sumber. Tombolnya mati untuk model yang tidak mendukung tools, dan posisinya diingat di browser.

## Dibanding Codex dan Claude Code / Cowork

Yang sudah setara: loop tool calling dengan izin per mode, edit file presisi dan patch, shell sekali jalan dan proses latar, rencana bertahap, bertanya ke pengguna, cari file dan isi, lihat gambar, baca web dan cari web, subagent riset, skills, file instruksi project, memori lintas sesi, pemadatan konteks, undo perubahan file.

Yang **belum** ada:

- **Sandbox** tingkat sistem operasi. Batas EZClaw adalah folder workspace, izin, dan deteksi perintah berisiko, bukan isolasi proses.
- **Hooks** (perintah otomatis sebelum atau sesudah tool).
- Subagent yang bisa **mengubah** file, dan beberapa subagent paralel.
- Undo untuk perubahan yang dibuat lewat perintah shell.
