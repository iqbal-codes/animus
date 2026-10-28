# UI/UX Design Brief: LabQ Software Factory Operator Console

**Target Canvas**: `/Users/efishery/.pencil/documents/240767a8-5df0-413b-a5c3-3c5cb274b820/pabriq-software-factory.pen`  
**Base Design System**: `xai-design-system`  
**Purpose**: Antarmuka kontrol, supervisi, dan observabilitas operasional untuk software factory autonomous berbasis Archon SDLC engine (`archon-loop`) dan Pi agent sessions.

---

## 1. Core Visual Foundations (x.ai Tokens)

| Property | Token / Nilai | Keterangan |
| :--- | :--- | :--- |
| **Canvas Background** | `$xai-bg` (`#0A0A0A` / `#000000`) | Hitam pekat pekat tanpa gradien warna-warni |
| **Surface Container** | `$xai-surface` (`#1A1A1A`) | Background panel/sidebar/card |
| **Secondary Surface** | `$xai-action-secondary` (`#202020`) | Background tombol sekunder & item hover |
| **Border / Divider** | `$xai-border` (`#1F2228`), `$xai-white-08` | Border 1px tipis, flat, no outer neon glow |
| **Text Primary** | `$xai-text` (`#FFFFFF`) | Teks utama kontras tinggi |
| **Text Secondary / Muted** | `$xai-text-secondary` (`#A3A3A3`), `$xai-text-muted` (`#7D8187`) | Deskripsi, label sekunder, dan metadata |
| **Accent Color** | `$xai-accent` (`#FF6308`), `$xai-accent-bg` | Oranye khas x.ai untuk penanda aktif/running |
| **Status Colors** | `$xai-success` (`#91C17A`), `$xai-warning` (`#FFAB70`), `$xai-error` (`#FF8A8A`) | Semantic feedback |
| **Typography** | Font UI: `$xai-font` (`xVf` / Sans-serif) • Monospace: `$xai-font-code` (`GeistMono`) | Standard typography |
| **Radius Scale** | Card: `$xai-radius-card` (16px) • Code block: `$xai-radius-code` (12px) • Pill: `9999px` | Jangan campur aduk radius |

---

## 2. Layout Structure & Wireframe Breakdown

Screen dibagi menjadi 2 area utama: **Sidebar Kiri (280–300px)** dan **Main Content Pane (Sisa lebar)**.

```
+---------------------------------------------------------------------------------------------------------+
| [X] Brand Mark     v1.0.0 |  (●) Engine Active   Window: 20:00-05:00   Slots: 1/2   [Promote to main]  (T) |
| [+ Add Repository]        +-----------------------------------------------------------------------------+
| [Q Search repo/issue...]  |  pabriq-app / Issues / #42                   [ready-for-agent] [gpt-6.1-sol]  |
|                           |  #42 Add webhook signature verification                                     |
| REPOSITORIES              |  (● Telemetry & Logs)   (Specification)   (PR & Diffs)   (Token Economics)  |
| v [pabriq-app]            |-----------------------------------------------------------------------------|
|   (spin) #42 webhook-verify|  SDLC: (✓ pick) -> (✓ claim) -> (● build) -> (check-app) -> (review) -> (land)|
|   (•)    #43 rate-limit   |-----------------------------------------------------------------------------|
|   (•)    #44 kafka-backoff|  +-----------------------------------------------------------------------+  |
| > [labq-platform]         |  | (● ● ●) LIVE LOG STREAM · PID: 19482                           [Copy] |  |
| > [pabriq-web]            |  | 20:15:02 [loop-pick] Admitted #42. Lock acquired.                     |  |
|                           |  | 20:15:18 [loop-work] Created git worktree tree-42.                    |  |
|                           |  | 20:18:22 [loop-work] Running test suite: 4 passed.                    |  |
|                           |  +-----------------------------------------------------------------------+  |
|                           |  +-----------------------------------+ +---------------------------------+  |
|                           |  | STAGING PR & DIFFS                | | TOKEN ECONOMICS & PERFORMANCE   |  |
|                           |  | Branch: feat/webhook -> develop   | | Input: 24,510    Thinking: 3,200|  |
| ------------------------- |  | auth/webhook.py          +38 / -2 | | Output: 1,840    Cost: $0.14 USD|  |
| [*] Factory Settings      |  | tests/test_webhook.py    +45 / -0 | |                                 |  |
|     Agents·Skills·MCP·... |  +-----------------------------------+ +---------------------------------+  |
+---------------------------------------------------------------------------------------------------------+
```

---

## 3. Rincian Kebutuhan Setiap Bagian

### A. Sidebar Kiri (Navigasi, Hierarchy & Kontrol)
1. **Header Sidebar**:
   - Logo x.ai (`uM96z`) + Nama Produk / Versi.
2. **Action Utama**:
   - Tombol **`+ Add Repository`**: Menggunakan komponen tombol White Pill solid (`#FFFFFF`, teks hitam, radius 9999px, tinggi 40–44px, mirip tombol `New chat` di x.ai).
3. **Filter / Search**:
   - Input search tipis bersudut lembut dengan leading search icon di dalamnya.
4. **Tree List Repositori & Issue**:
   - **Parent**: Nama repositori (misal `pabriq-app`, `labq-platform`, `pabriq-web`). Dilengkapi ikon folder git dan chevron collapse/expand.
   - **Submenu Issues**: List issue di dalam repo terpilih:
     - **Issue Aktif Sedang Dikerjakan (e.g. `#42`)**: Ter-highlight dengan background `$xai-action-secondary`, border halus `$xai-accent`, subtitle runtime `lap-XXXXX · in progress`, dan **spinning arc indicator** (lingkaran loading berputar warna oranye `$xai-accent`).
     - **Issue Siap (Admitted / Ready, e.g. `#43`)**: Indikator titik hijau (`$xai-success`) dengan badge/label `Ready`.
     - **Issue Tertahan (Held / Blocked, e.g. `#44`)**: Indikator titik amber (`$xai-warning`) dengan keterangan `Blocked by #42` atau label `needs-info`.
5. **Footer Sidebar (Paling Bawah)**:
   - Separator/divider tipis 1px (`$xai-border`).
   - Menu **`Settings` / `Factory Settings`**: Mengatur konfigurasi runtime factory (*Agents, Skills registry, MCP tools, Harness Pi, dan Work window schedule*).

---

### B. Top Header Bar (Global Factory Status & Actions)
Tinggi 60–64px, background `$xai-surface`, border bawah tipis.
1. **Sisi Kiri (Status Operasional)**:
   - Indikator engine: Titik hijau berkedip/solid + teks `Factory Active`.
   - Info operasional (bisa berupa teks bersih atau capsule pill):
     - Jam kerja: `Window: 20:00 – 05:00`
     - Slot ketersediaan: `Slots: 1/2 Active`
     - Base branch staging: `Base: develop` (highlight oranye)
2. **Sisi Kanan (Kontrol Global)**:
   - **Tombol Promosi Staging**: Tombol White Pill `Promote 4 Commits to main` (memicu morning promotion PR develop -> main).
   - **Master Engine Toggle Switch**: Komponen switch ON/OFF (`T7pqfo`) untuk mengaktifkan / menonaktifkan software factory.
   - **Tombol Drain Admissions**: Tombol darurat sekunder (`.factory/PAUSE`) dengan teks peringatan merah (`$xai-error`).

---

### C. Main Content Pane (Detail Issue yang Diklik)
1. **Issue Headline Bar**:
   - Breadcrumbs: `pabriq-app > Issues > #42`.
   - Metadata badges: `ready-for-agent`, model `gpt-6.1-sol (large)`, git worktree `tree-42`, runtime duration `04m 12s`.
   - Judul Issue: Typography besar (`22–26px`, font `$xai-font`, weight 500) kontras tinggi.
2. **Navigation Tabs**:
   - Tab bergaya pill x.ai:
     - `● Realtime Telemetry & Logs` (Active state)
     - `Issue Specification`
     - `PR & File Diffs`
     - `Token Economics & Stats`
3. **SDLC Pipeline Breadcrumb Bar**:
   - Visualisasi alur kerja Archon loop:
     `pick` → `claim` → `build (loop-work)` → `check-app` → `review` → `land`
   - Stage selesai: centang hijau (`✓`).
   - Stage aktif: kapsul ber-highlight oranye dengan pulsing dot (`●`).
   - Stage pending: teks muted abu-abu.
4. **Live Terminal / Monospace Log Stream**:
   - Format mengadopsi komponen `x.ai / Panel / Code` (`r8KMCd`):
     - Background hitam pekat (`#000000`).
     - Radius 12px (`$xai-radius-code`).
     - Header bar terminal: Di kiri terdapat **3 Mac window dots** (merah, kuning, hijau), label `LIVE LOG STREAM · PID: 19482`, dan di kanan terdapat tombol `Copy` serta info polling rate (`poll: 2.1s`).
     - Area isi: Font monospace `GeistMono` (ukuran 11px, line-height 1.5) menampilkan log proses git worktree, modifikasi file, test execution, dan status evidence.
5. **Bottom Grid Cards**:
   Dua card sejajar dengan radius 16px (`$xai-radius-card`):
   - **Card 1: Staging PR & File Diffs**: Menampilkan target branch (`feat/webhook-verify → develop`) serta list file yang diubah beserta jumlah baris tambah/kurang (`+38 / -2`, hijau/merah).
   - **Card 2: Token Economics & Performance**: Grid metrik angka besar bersih khas x.ai:
     - Input Tokens (e.g. `24,510`, subtext cached)
     - Output Tokens (e.g. `1,840`, subtext speed 48 tok/s)
     - Thinking Tokens (e.g. `3,200`, subtext adaptive)
     - Est. Run Cost (e.g. `$0.14 USD`, subtext within budget)

---

## 4. Referensi Komponen yang Ada di File `.pen`

Jika kamu merakitnya di Pen.app menggunakan reusable components x.ai yang sudah ada di dokumen:
- Brand Logo: `uM96z` (`x.ai / Brand mark`)
- Primary Button: `bp2iN` (`x.ai / Button / Primary`)
- Compact Button: `zfqO1` (`x.ai / Button / Compact`)
- Switch Toggle: `T7pqfo` (`x.ai / Switch / On`)
- Tabs: `o5SEO2` (Active), `DMeWI` (Inactive)
- Badges: `Q7Gevs` (Neutral), `nXSkc` (Success), `h2MuaI` (Warning)
- Code Panel: `r8KMCd` (`x.ai / Panel / Code`)
- Breadcrumbs: `a1Du4c` (`x.ai / Breadcrumbs`)
- Loading Spinner: `Qh4Up` (`x.ai / Loading / Spinner`)
- Icons: Menggunakan Lucide icons bawaan Pen.app (`folder`, `search`, `settings`, `chevron-down`, `check`, `terminal`, `copy`, dll.)
