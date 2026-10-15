# EZClaw Design System

Versi 0.1, 2026-10-15. Token ada di [`design/tokens.css`](design/tokens.css). Pratinjau hidup semua komponen ada di [`design/preview.html`](design/preview.html) (buka langsung di browser, ada toggle tema).

> **Catatan jujur soal arah desain.** Owner memberi dua arahan: warna brand `#8EA66B` dan "desain normal saja". Selebihnya (tipografi, motif, aksen, tata letak) disusun oleh agent. Arah yang disusun agent cenderung jatuh ke selera default AI, jadi setiap keputusan di bawah ditulis beserta alasannya supaya mudah ditolak atau diganti. Bagian yang paling layak ditinjau owner: tipografi (bagian 4), aksen ember (bagian 3.3), dan motif Thread (bagian 7).

---

## 1. Arah

**Design Read:** EZClaw dibaca sebagai *workbench AI lokal satu pengguna (chat, agent, studio gambar) untuk power user yang tinggal di dalamnya berjam-jam setiap hari, dengan bahasa visual ruang kerja kertas hangat dan sage sebagai brand*, dial **ENERGY 1 / RHYTHM 2 / MOTION 1**.

| Dial | Nilai | Alasan |
|---|---|---|
| ENERGY | 1 (tenang) | Owner minta desain normal. Alat yang dipakai berjam-jam tidak boleh melelahkan. Yang menarik perhatian hanya konten (jawaban, gambar) dan hal yang menunggu owner. |
| RHYTHM | 2 (konsisten, ada jeda) | Chat dan Agent berbagi struktur yang sama, tapi Image dan Edit sengaja berbeda: gambar butuh ruang besar, bukan kolom teks. |
| MOTION | 1 (hover dan state) | Gerak hanya untuk umpan balik (hover, tekan, panel buka) dan untuk state nyata "sedang berjalan". Tidak ada animasi dekoratif. |

**Kepribadian:** tenang, teliti, jujur soal apa yang terjadi. EZClaw menunjukkan request mentah, parameter yang dibuang, dan perintah yang akan dijalankan. Desainnya harus mendukung sifat itu: informasi teknis terbaca jelas, tidak disembunyikan di balik gaya.

**Yang dihindari secara sadar:** latar gelap "tech" sebagai default, gradient ungu-biru, kartu statistik di beranda, ikon sparkle untuk fitur AI, badge "AI Powered".

---

## 2. Prinsip

1. **Satu fokus per layar.** Chat dan Agent: composer dan timeline. Image: hasil terakhir. Edit: gambar target. Elemen lain mengalah.
2. **Yang menunggu owner selalu terlihat.** Approval dan pertanyaan agent memakai satu-satunya warna aksen (ember). Tidak ada elemen lain yang memakai warna itu.
3. **Teknis itu konten.** ID model, parameter, path, dan perintah ditulis dalam font mono yang mudah dibedakan karakternya, bukan disingkat atau disembunyikan.
4. **Tidak ada state palsu.** Loading menyebut apa yang dimuat. Error menyebut penyebab dan langkah berikutnya. Kosong menjelaskan langkah pertama.

---

## 3. Warna

Palet aktif: **sage** (brand) + **netral hangat** (dasar) + **ember** (satu aksen). Merah hanya untuk error dan aksi destruktif.

### 3.1 Netral hangat

| Token | Light | Dark | Peran |
|---|---|---|---|
| `--bg` | `#F6F5F0` | `#141512` | Kanvas aplikasi |
| `--surface` | `#FCFBF8` | `#1B1C18` | Panel, sidebar, inspector |
| `--raised` | `#FFFFFF` | `#23241F` | Popover, composer, kartu yang perlu menonjol |
| `--sunken` | `#EFEDE6` | `#10110E` | Blok kode, output tool, sumur input |
| `--line` | `#E3E0D6` | `#2C2D27` | Garis pemisah (dekoratif) |
| `--line-strong` | `#8C887B` | `#6E6F64` | Tepi kontrol (input, select), minimal 3:1 |
| `--text` | `#1E1F1A` | `#ECEBE4` | Teks utama |
| `--text-2` | `#55564C` | `#B4B3A8` | Teks sekunder |
| `--text-3` | `#6A6A5F` | `#8F8E84` | Meta, placeholder, timestamp |

**Alasan:** netral diberi sedikit rona hangat ke arah sage supaya brand terasa "milik" permukaannya, dan supaya tidak jatuh ke putih steril dengan garis abu-abu tipis.

### 3.2 Sage (brand)

| Token | Light | Dark | Peran |
|---|---|---|---|
| `--brand` | `#8EA66B` | `#8EA66B` | Isi tombol utama, node Thread selesai, toggle aktif di dark |
| `--brand-hover` | `#7F975D` | `#A3B784` | Hover tombol utama |
| `--brand-ink` | `#1A2210` | `#141A0C` | Teks di atas `--brand` |
| `--brand-strong` | `#5F7840` | `#8EA66B` | Toggle aktif, indikator terpilih (minimal 3:1 terhadap latar) |
| `--brand-text` | `#4A5E31` | `#A9BF88` | Link dan teks berwarna brand |
| `--brand-soft` | `#E5EBD9` | `#252D1B` | Latar item terpilih, chip aktif |
| `--brand-soft-text` | `#3B4B26` | `#BCD09C` | Teks di atas `--brand-soft` |

**Keputusan penting:** `#8EA66B` sebagai teks di atas latar terang hanya 2,46:1 (gagal WCAG). Karena itu di light mode, brand dipakai sebagai **isi** dengan teks tinta gelap (`#1A2210`, 6,11:1), bukan sebagai warna teks. Tombol utama sage dengan teks gelap juga jadi ciri visual EZClaw, berbeda dari tombol berwarna dengan teks putih yang umum.

### 3.3 Ember (aksen tunggal)

| Token | Light | Dark | Peran |
|---|---|---|---|
| `--ember` | `#D98B3A` | `#D98B3A` | Node Thread "menunggu owner", isi tombol Izinkan di kartu approval |
| `--ember-text` | `#8A4510` | `#E8A55E` | Teks status "Menunggu persetujuan" |
| `--ember-soft` | `#F8E6CF` | `#3A2A18` | Latar kartu approval dan ask_user |

**Alasan:** EZClaw sering dibiarkan bekerja sendiri. Satu-satunya momen yang butuh owner adalah approval dan pertanyaan agent, jadi aksen dikhususkan untuk momen itu. Ember dipilih karena hangat dan berlawanan dengan sage tanpa terbaca sebagai error.

**Aturan:** ember tidak boleh dipakai untuk dekorasi, highlight, badge "baru", atau hover.

### 3.4 Danger

| Token | Light | Dark |
|---|---|---|
| `--danger` (isi tombol) | `#A3372A`, teks `#FFFFFF` | `#EC8A78`, teks `#141512` |
| `--danger-text` | `#A3372A` | `#EC8A78` |
| `--danger-soft` | `#F6E0DB` | `#3A1E19` |

Sukses tidak punya warna sendiri: memakai sage, karena "selesai" adalah state normal EZClaw, bukan perayaan.

### 3.5 Hasil uji kontras (WCAG AA)

Diuji dengan `contrast-check.py` dari antislop-human.

| Pasangan | Light | Dark |
|---|---|---|
| `--text` di `--bg` | 15,19 | 15,34 |
| `--text-2` di `--surface` / `--bg` | 6,82 | 8,12 |
| `--text-3` di `--bg` | 5,01 | 5,56 |
| `--text-3` di `--sunken` | 4,67 | 5,75 |
| `--text-3` di `--raised` | 5,47 | 4,74 |
| `--brand-ink` di `--brand` | 6,11 | 6,61 |
| `--brand-ink` di `--brand-hover` | 5,07 | 7,55 |
| `--brand-text` di `--bg` | 6,55 | 9,16 |
| `--brand-soft-text` di `--brand-soft` | 7,75 | 8,60 |
| `--ember-text` di `--ember-soft` | 5,86 | 6,54 |
| `--ember-ink` di `--ember` | 6,09 | 6,72 |
| `--danger-text` di `--danger-soft` | 5,29 | 6,14 |
| teks danger di `--danger` | 6,69 | 7,40 |
| `--line-strong` (tepi kontrol) di `--surface` | 3,43 | 3,36 |
| `--brand-strong` (toggle aktif) di `--bg` | 4,53 | 6,38 |

### 3.6 Pasangan yang dilarang

- `--brand` sebagai warna teks di light mode (2,46:1).
- `--line` sebagai satu-satunya tepi kontrol input (dekoratif, di bawah 3:1).
- Teks putih di atas `--brand` (2,69:1).

---

## 4. Tipografi

| Peran | Font | Alasan |
|---|---|---|
| UI dan prosa | **Atkinson Hyperlegible Next** | Dirancang untuk membedakan karakter yang mirip (`I l 1`, `O 0`). EZClaw penuh ID model, versi, dan parameter seperti `qwen-image-edit`, `v4.1`, `top_p 0.1`. Salah baca di sini berarti salah konfigurasi. Bentuknya juga tidak umum dipakai di alat AI, jadi memberi suara sendiri. |
| Kode, ID model, path, perintah | **Atkinson Hyperlegible Mono** | Satu keluarga dengan font UI, sehingga teks campuran (kalimat yang menyebut `read_file`) tetap serasi. Mono tidak dipakai untuk judul atau dekorasi. |

Fallback: `Segoe UI` dan `Cascadia Mono` (tersedia di Windows 11).

### Skala

| Token | Ukuran | Line height | Pemakaian |
|---|---|---|---|
| `--text-xs` | 12 | 1,45 | Timestamp, token count, meta |
| `--text-sm` | 13 | 1,45 | Chip, label parameter, inspector padat |
| `--text-md` | 14 | 1,45 | Default UI: tombol, list thread, input |
| `--text-read` | 15 | 1,62 | Prosa chat dan agent, maksimal lebar 72ch |
| `--text-lg` | 17 | 1,25 | Judul panel |
| `--text-xl` | 20 | 1,25 | Judul halaman (Settings, Library) |
| `--text-2xl` | 24 | 1,25 | Judul empty state |

Berat: 400 isi, 600 label dan judul, 700 hanya untuk wordmark. Tidak ada label huruf kapital dengan tracking lebar. Label section ditulis kalimat biasa, berat 600, ukuran `--text-sm`, warna `--text-2`.

---

## 5. Ruang, radius, elevasi

**Ruang:** basis 4px (`--s-1` 4 sampai `--s-14` 56). Kepadatan berbeda per area dan disengaja:
- Inspector dan list thread: padat (`--s-2` antar baris), karena owner memindai.
- Timeline chat/agent: lega (`--s-6` antar giliran), karena owner membaca.
- Studio gambar: paling lega (`--s-8` di sekitar kanvas), karena gambar butuh napas.

**Radius berdasarkan peran:**

| Token | Nilai | Dipakai untuk |
|---|---|---|
| `--r-xs` | 4 | Chip, tag, node Thread |
| `--r-sm` | 6 | Tombol, input, select |
| `--r-md` | 10 | Panel, kartu tool, tile gambar |
| `--r-lg` | 14 | Composer, dialog |
| `--r-full` | 999 | Track switch saja |

Tidak ada tombol atau kartu berbentuk pil. Composer punya radius terbesar karena ia fokus utama layar.

**Elevasi:** permukaan diam rata (dipisah warna dan garis, tanpa bayangan). Bayangan hanya untuk lapisan yang benar-benar melayang: popover/menu (`--shadow-pop`) dan dialog (`--shadow-dialog`). Composer memakai `--raised` dan garis, bukan bayangan.

---

## 6. Gerak

| Token | Nilai | Untuk |
|---|---|---|
| `--t-fast` | 120ms | Hover, tekan, warna |
| `--t-base` | 180ms | Panel inspector buka/tutup, popover |
| `--ease` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Semua transisi |

Satu-satunya gerak berulang yang diizinkan: **node Thread yang sedang berjalan** (isian bergeser pelan di dalam node) dan kursor streaming, karena keduanya menandai state nyata "model sedang bekerja". Keduanya berhenti saat state berubah dan dimatikan oleh `prefers-reduced-motion`. Tidak ada fade-up saat scroll, tidak ada elemen melayang.

---

## 7. Motif identitas: The Thread

Semua yang terjadi di EZClaw adalah rangkaian langkah: giliran chat, step agent, versi gambar. Motifnya adalah **garis tipis vertikal dengan node persegi kecil** (7px, radius `--r-xs`) yang menandai setiap langkah. Motif ini membawa informasi nyata, bukan hiasan.

| State node | Tampilan | Arti |
|---|---|---|
| Selesai | Isi `--brand` | Step atau versi berhasil |
| Berjalan | Tepi `--brand-strong`, isian bergerak | Model atau tool sedang bekerja |
| Menunggu owner | Isi `--ember` | Approval atau ask_user |
| Gagal | Isi `--danger` | Tool error, request gagal |
| Dilewati / ditolak | Tepi `--line-strong`, kosong | Owner menolak, atau dibatalkan |

Dipakai di: timeline Agent (vertikal), tool call di Chat (vertikal, lebih pendek), lineage versi di Image Edit (horizontal). Tidak dipakai sebagai dekorasi section atau garis tepi kartu.

**Wordmark:** sementara "EZClaw" sebagai teks, Atkinson Hyperlegible Next 700, dengan "EZ" berwarna `--brand-text`. Ini placeholder sampai owner punya konsep logo (PRD Q6).

---

## 8. Ikon

**Phosphor Icons**, berat *regular* (stroke 1,5 di 20px), berat *fill* hanya untuk item navigasi aktif.

**Alasan:** cakupan luas untuk kebutuhan EZClaw (terminal, file, kuas, gambar, folder, branch), dan dua berat memberi cara menandai state aktif tanpa warna tambahan. Phosphor dipilih juga agar tidak memakai tampilan Lucide yang menjadi default banyak alat AI.

**Aturan:**
- Ikon hanya jika memperjelas aksi atau tipe. Tombol utama selalu punya label teks.
- Tidak ada ikon sparkle, bintang, petir, robot, atau orb untuk fitur AI.
- Ukuran: 16 (inline, chip), 18 (tombol), 20 (navigasi).

Pemetaan awal: Chat `ph-chat-text`, Agent `ph-terminal-window`, Image `ph-image`, Edit `ph-paint-brush`, Settings `ph-gear-six`, Lampiran `ph-paperclip`, Kirim `ph-arrow-up`, Stop `ph-stop`, Workspace `ph-folder-simple`.

---

## 9. Layout per mode

### 9.1 Shell

```
+-----------+----------------------------------------+-------------+
| Rail 248  | Area utama (fokus mode)                | Inspector   |
| wordmark  |                                        | 320, bisa   |
| mode      |                                        | ditutup     |
| thread    |                                        | model,      |
| list      |                                        | parameter,  |
| settings  |                                        | harness     |
+-----------+----------------------------------------+-------------+
```

- **Rail:** wordmark, empat mode (label teks + ikon), tombol thread baru, daftar thread mode aktif (dikelompokkan "Hari ini", "Minggu ini", "Lebih lama"), lalu Settings dan toggle tema di bawah. Thread dengan approval tertunda menampilkan node ember di barisnya.
- **Inspector:** model aktif, panel parameter dinamis, harness, info run (token, biaya). Tertutup default di layar di bawah 1280px.
- Tidak ada beranda berisi kartu statistik. Membuka EZClaw langsung ke thread terakhir mode terakhir.

### 9.2 Chat

Timeline lebar baca 72ch di tengah, composer menempel di bawah. Pesan owner rata kanan di blok `--sunken` ringan. Jawaban model tanpa balon, langsung prosa, dengan baris meta (model, token, durasi) di bawahnya. Reasoning dan tool call adalah blok terlipat di atas jawaban, terhubung dengan Thread.

### 9.3 Agent

Sama seperti Chat, ditambah:
- **Header workspace:** path folder (mono), mode approval (segmented), status run.
- **Panel plan** di atas timeline saat `update_plan` dipakai: daftar langkah dengan node Thread.
- Timeline step dengan node Thread. Kartu approval ember muncul inline di step yang menunggu, dan juga di atas composer supaya tidak terlewat saat scroll.

### 9.4 Image

Ritme berbeda dengan sengaja. Hasil generate terakhir mengisi area utama sebagai grid besar. Riwayat giliran sebelumnya di atasnya (bisa di-scroll), prompt hasil susunan Prompt Composer ditampilkan di atas setiap grid. Composer di bawah dengan tray referensi.

### 9.5 Edit

Kanvas target besar di tengah (fokus). Kolom referensi di kiri kanvas dengan slot berlabel peran. Instruksi dan chip Pertahankan di bawah kanvas. Strip lineage versi horizontal (Thread horizontal) di bawah semuanya. Mode bandingkan mengganti kanvas dengan tampilan berdampingan atau geser.

---

## 10. Komponen

Semua komponen tersedia di `design/preview.html`. Ringkasan spesifikasi:

### Tombol

| Varian | Tampilan | Pemakaian |
|---|---|---|
| Primary | Isi `--brand`, teks `--brand-ink`, radius `--r-sm`, tinggi 36 | Satu per area: Kirim, Generate, Simpan |
| Secondary | Isi `--raised`, tepi `--line-strong`, teks `--text` | Aksi pendamping |
| Ghost | Tanpa isi, teks `--text-2`, hover `--sunken` | Aksi di toolbar dan meta pesan |
| Danger | Isi `--danger`, teks `--danger-ink` | Hapus, nyalakan Otomatis penuh |
| Approve | Isi `--ember`, teks `--ember-ink` | Hanya tombol Izinkan di kartu approval |

Label tombol menyebut aksinya ("Kirim", "Generate 4 gambar", "Izinkan perintah"), bukan "Lanjut" atau "OK". Panah tidak dipakai sebagai hiasan. Target sentuh minimal 44px di layar sentuh, 36px di desktop dengan area klik diperluas.

### Fokus

Semua elemen interaktif memakai `outline: 2px solid var(--focus); outline-offset: 2px` saat `:focus-visible`. Outline tidak pernah dihapus tanpa pengganti.

### Input dan composer

- Input: tinggi 36, isi `--raised`, tepi `--line-strong`, radius `--r-sm`, placeholder `--text-3` yang menyebut isinya ("Cari thread", "https://api.example.com/v1").
- **Composer** (fokus layar): `--raised`, tepi `--line`, radius `--r-lg`. Baris atas textarea, baris bawah: chip model, toggle Harness, tombol lampiran, dan tombol Kirim di kanan. Saat model streaming, Kirim berubah menjadi Stop.

### Chip model

Format tetap: tag Endpoint (teks pendek, `--sunken`) + ID model dalam mono + tanda kapabilitas kecil (ikon gambar, tools, reasoning) yang hanya muncul jika didukung. Klik membuka pemilih model dengan pencarian dan filter kapabilitas.

### Panel parameter

Dirender dari Capability Profile. Setiap baris: label (`--text-sm` 600), kontrol, nilai saat ini (mono). Parameter yang bentrok tampil disabled dengan alasan satu kalimat di bawahnya. Bagian "Extra body (JSON)" di paling bawah, terlipat.

### Switch (Harness)

Track `--r-full`, aktif `--brand-strong`, label teks di sampingnya selalu ("Harness ON" / "Harness OFF"), bukan hanya warna.

### Segmented (mode approval)

Tiga opsi berdampingan, terpilih memakai `--brand-soft` dan teks `--brand-soft-text`. Bisa dinavigasi dengan panah kiri/kanan.

### Blok reasoning dan tool call

Terlipat default, baris ringkas: node Thread, nama ("Berpikir 12 dtk", "`read_file` src/app.ts"), durasi. Isi terbuka di `--sunken`, output dipotong kepala+ekor dengan tombol "Tampilkan semua (240 baris)".

### Kartu approval

Latar `--ember-soft`, node Thread ember, judul "Menunggu persetujuan", perintah atau path dalam mono, diff untuk edit file, lalu tombol: **Izinkan** (approve), **Selalu izinkan pola ini** (secondary), **Tolak** (ghost, membuka kolom alasan).

### Tile gambar

Radius `--r-md`, tanpa bayangan. State: antri (teks "Antri ke-2"), berjalan (node Thread berjalan + teks "Membuat gambar"), gagal (pesan provider dan tombol "Coba lagi"), selesai (gambar + aksi saat hover dan fokus).

### Slot referensi (Edit)

Kotak dengan gambar, select peran wajib (Gaya, Subjek, Objek, Palet warna, Komposisi, Latar, Lainnya), dan tombol hapus. Slot yang melebihi batas model diberi tepi putus-putus dan teks "Tidak dikirim: model ini menerima maksimal 3 gambar".

### Dialog

`--raised`, radius `--r-lg`, `--shadow-dialog`, scrim `--scrim`. Tutup dengan Esc, fokus dikunci di dalam, fokus kembali ke pemicu saat ditutup.

---

## 11. State kosong, loading, error

| State | Contoh teks |
|---|---|
| Kosong, belum ada Endpoint | "Belum ada model. Tambahkan API key OpenRouter, Venice, atau provider lain untuk mulai." + tombol "Tambah endpoint" |
| Kosong, thread Agent baru | "Pilih folder project, lalu jelaskan tugasnya. Agent akan meminta izin sebelum menulis file atau menjalankan perintah." |
| Kosong, Library | "Gambar yang kamu generate atau edit akan muncul di sini." |
| Loading katalog | "Memuat daftar model dari OpenRouter" |
| Loading run | Node Thread berjalan + "Menunggu respons DeepSeek V4.1 Flash" |
| Error parameter | "`top_k` ditolak model ini. Dikirim ulang tanpanya." (info, bukan error merah) |
| Error auth | "OpenRouter menolak key (401). Periksa key di Settings > Endpoint." + tombol "Buka Settings" |
| Error jaringan lokal | "Tidak bisa menjangkau http://127.0.0.1:11434. Pastikan Ollama berjalan." + tombol "Coba lagi" |

---

## 12. Aksesibilitas

- Semua pasangan teks lolos WCAG AA di kedua tema (bagian 3.5).
- Seluruh aplikasi bisa dipakai dengan keyboard: Tab sesuai urutan visual, Enter/Space mengaktifkan, Esc menutup dialog dan menghentikan stream, panah untuk segmented dan list.
- State tidak hanya dibedakan warna: node Thread punya label teks yang terbaca screen reader, toggle punya label ON/OFF.
- `prefers-reduced-motion` mematikan semua transisi dan gerak node berjalan.
- Lebar ponsel: tidak ada horizontal scroll. Rail dan inspector menjadi drawer.

---

## 13. Log keputusan (satu baris alasan)

| Keputusan | Alasan |
|---|---|
| Netral kertas hangat | Sesi panjang lebih nyaman, dan menghindari putih steril. |
| Sage sebagai isi dengan tinta gelap | `#8EA66B` gagal kontras sebagai teks, dan tinta gelap memberi tombol ciri yang berbeda. |
| Ember hanya untuk "menunggu owner" | EZClaw sering bekerja sendiri, jadi satu warna harus berarti "kamu dibutuhkan". |
| Tema mengikuti OS + toggle | Keputusan owner. Tidak ada alasan produk untuk memaksa satu tema. |
| Atkinson Hyperlegible Next + Mono | ID model dan parameter harus terbaca tanpa salah karakter. |
| Phosphor | Cakupan luas dan dua berat untuk state aktif, tanpa tampilan Lucide default. |
| Motif Thread | Semua hal di EZClaw adalah langkah berurutan, jadi motifnya membawa status nyata. |
| Bayangan hanya untuk lapisan melayang | Elevasi harus berarti "di atas halaman", bukan hiasan. |
| Rail + inspector, tanpa beranda statistik | Keputusan utama owner adalah memilih thread dan model, bukan membaca angka. |
| Ritme berbeda untuk Image dan Edit | Gambar butuh kanvas, bukan kolom baca. |
| Label UI berbahasa Indonesia, istilah teknis tetap Inggris (Harness, Endpoint, token) | Bahasa owner sehari-hari. Sementara, menunggu jawaban PRD Q5. |
