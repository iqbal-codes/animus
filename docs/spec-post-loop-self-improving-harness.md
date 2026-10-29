# Spec & Implementation Plan: Post-Loop Self-Improving Harness (Harness² Adaptation)

* **Status:** Ready for Implementation
* **Date:** 2026-10-29
* **Reference Architecture:** [Google Research Harness²](https://github.com/google-research/harness2) (arXiv:2610.14224), TypeSafe Jev System 1 (`typesafe/jev-1.14`), Pi Coding Agent Extensions & Skills
* **Target Subsystems:** `scripts/local-loop.ts`, `scripts/loop/providers.ts`, `scripts/loop/config.ts`, `scripts/loop/types.ts`, `scripts/loop/scheduler.ts`, `.archon/config.yaml`, `.factory/`, `.agents/skills/`, `apps/backend/src/main.ts`

---

## 1. Executive Summary & Problem Statement

Hasil audit terhadap repositori `labq-software-factory` menunjukkan bahwa mekanisme **Post-Loop Self-Learning Harness** saat ini baru sebatas spesifikasi dokumen, skema pasif (`.factory/lessons.jsonl`), dan mockup UI (`web/app.js`), namun **belum berjalan secara otomatis di dalam loop eksekusi**.

### 5 Gap Eksisting yang Ditemukan:
1. **Tidak Ada Trigger Refleksi di `scripts/local-loop.ts`**: Siklus lap berhenti begitu saja setelah review (`waiting_approval` atau `sent_back`) atau saat gagal (`failed`), tanpa mengekstrak pelajaran dari kegagalan yang terjadi.
2. **Isolasi Buta (`--no-skills` & `--no-context-files`)**: Argumen pemanggilan CLI `pi` di `scripts/loop/providers.ts` (`buildProviderArgv`) mematikan *seluruh* skill dan context files untuk mencegah polusi dari mesin host, namun akibatnya ikut memblokir `.agents/skills/` resmi milik repositori dan `.factory/lessons.jsonl`.
3. **Refleksi Reaktif vs Terminal**: Belum ada mekanisme pengumpulan jejak lintas-lap (*Run Dossier*). Refleksi tidak boleh dijalankan secara prematur di tengah jalan (misal saat Lap 0 gagal), melainkan harus dikumpulkan dan dieksekusi di **akhir siklus issue** (saat *Approved* setelah revisi, atau saat mencapai batas maksimum retry / *Needs Human Review*).
4. **Belum Ada In-Loop Gatekeeper (Hooks)**: Aturan baru hanya ditulis sebagai teks pasif yang mudah diabaikan LLM, belum memanfaatkan *Pi Extension Hooks* (`-e`) yang bertindak langsung di dalam *tool execution loop*.
5. **Endpoint Backend Phantom (404)**: UI `web/app.js` memanggil `/api/harness/lessons`, `/api/harness/tools`, dan `/api/harness/veto`, tetapi rute tersebut belum diimplementasikan di `apps/backend/src/main.ts`.

---

## 2. Prinsip Desain (Adaptasi Google Research Harness²)

Mengadopsi pendekatan **Two-Level Recursion** dari Google Research Harness² yang disesuaikan dengan arsitektur pabrik kita:

1. **Curated Hermetic Injection**:
   Pertahankan `--no-skills`, `--no-context-files`, dan `--no-extensions` agar sesi Pi tetap bersih dari file global mesin host (`~/.agents/skills/`, `~/CLAUDE.md`), lalu suntikkan secara eksplisit **hanya** skill resmi repo (`--skill`), hook repo (`-e`), dan pelajaran yang relevan (`--append-system-prompt`).
2. **Contrastive Terminal Reflection (Bukan Per-Lap Reaktif)**:
   Pelajaran berkualitas tinggi lahir dari **kontras perilaku (*behavioral contrast*)** antara Lap yang gagal (Lap 0/1) dan Lap yang berhasil menyelesaikan masalah (Lap Final). Oleh karena itu, seluruh log perjalanan dikumpulkan dulu ke dalam **Issue Run Dossier**, dan refleksi hanya dipicu satu kali di **kondisi terminal**.
3. **Dual-System Governance (System 2 Authoring + System 1 Gating)**:
   - **System 2 (Pi Agent)** menganalisis Dossier dan merumuskan draf perubahan harness.
   - **System 1 (TypeSafe Jev)** memvalidasi secara deterministik (< 300ms) apakah pelajaran tersebut spesifik, bebas halusinasi, dan non-trivial (`confidence >= 0.70`).
4. **Hierarki Komponen & Pemisahan Delivery (Fast-Track vs Structural PR)**:
   - **Level 1 (`.factory/lessons.jsonl`) & Level 2 (`.factory/tool-guidance.json`)**: Di-commit langsung ke branch PR tiket yang sedang aktif (*Fast-Track*, bebas PR spam).
   - **Level 3 (`.agents/skills/<name>/SKILL.md`), Level 4 (`.factory/hooks/`), & Level 5 (`AGENTS.md`)**: Dieksekusi oleh Pi dengan panduan skill **`$writing-for-agents`** dan **`$skill-creator`**, lalu dikirim melalui **Pull Request terpisah** (`chore(harness): ...`).

---

## 3. Arsitektur Alur Kerja (Target Architecture)

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   SELF-IMPROVING HARNESS PIPELINE                           │
│                                                                             │
│  [1. PRE-LAP: Curated Hermetic Injection] (scripts/loop/harness-memory.ts)  │
│  • --no-skills --no-context-files --no-extensions (Bersih dari host)        │
│  • --skill .agents/skills/<allowed> (Hanya skill repo resmi)                │
│  • -e .factory/hooks/loop-guard.ts (Pi Extension hook di dalam tool loop)   │
│  • --append-system-prompt (Active lessons yang match target file)           │
│                                     │                                       │
│                                     ▼                                       │
│  [2. IN-LAP: Execution & Dossier Recording] (scripts/local-loop.ts)         │
│  • Lap 0..N berjalan menyelesaikan issue (Builder -> Checks -> QA -> Review)│
│  • Setiap attempt dicatat ke `<stateRoot>/dossiers/issue-<num>.json`        │
│                                     │                                       │
│                                     ▼                                       │
│  [3. POST-ISSUE TERMINAL TRIGGER] (scripts/loop/reflector.ts)               │
│  • Hanya jalan saat: Status == `waiting_approval` ATAU `needs_owner`        │
│  • Membutuhkan >= 1 friksi/kegagalan di Lap sebelumnya (kontras bukti)      │
│                                     │                                       │
│                                     ▼                                       │
│  [4. DUAL-SYSTEM REFLECTION & GOVERNANCE]                                   │
│  • System 2 (Pi + $writing-for-agents + $skill-creator): Draft perubahan    │
│  • System 1 (TypeSafe Jev): Validasi non-triviality & confidence >= 0.70    │
│      ├── Level 1-2 (Lessons / Tool Guidance) ──> Commit langsung ke PR Issue│
│      └── Level 3-5 (Skill Baru / AGENTS.md)  ──> Buat PR Harness Terpisah   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Rencana Implementasi Bertahap (Phased Implementation Plan)

### Fase 1: Curated Hermetic Injection & Pi Loop Hooks

#### 1.1. Buat Modul `scripts/loop/harness-memory.ts` & Update `scripts/loop/types.ts` + `scripts/loop/config.ts`
1. Tambahkan `"reflector"` pada union type `LoopRole` di `scripts/loop/types.ts`.
2. Di `scripts/loop/config.ts`, petakan role `"reflector"` ke tier `"large"` (atau alias `@reasoning` di `.archon/config.yaml`, yaitu `router/cx/gpt-6.1-sol` dengan `effort: high`) agar analisis kontras trajectory dan penulisan skill memiliki daya nalar tertinggi.
3. Siapkan injeksi konteks selektif di `scripts/loop/harness-memory.ts` sebelum provider dijalankan:
- **`resolveAllowedSkills(root: string, role: LoopRole): string[]`**:
  - Mengembalikan daftar path absolut `.agents/skills/*` milik repositori sesuai peran:
    - `builder`: `tdd`, `diagnosing-bugs`, `factory-implement`
    - `reviewer`: `factory-review`
    - `reflector`: `factory-harness`, serta meta-skills `writing-for-agents` dan `skill-creator`
- **`matchRelevantLessons(root: string, targetHints: string[]): LessonEntry[]`**:
  - Membaca `.factory/lessons.jsonl`, memfilter `vetoed === false`.
  - Mencocokkan `trigger_patterns` (glob) terhadap daftar file yang diubah atau disebut pada tiket.
  - Memformat maksimal 5 aturan yang cocok menjadi blok Markdown ringkas:
    ```markdown
    ## Active Repository Gotchas (Learned from Previous Laps)
    - [<topic>]: <rule> (Evidence: <evidence>)
    ```
  - **Safe Mode**: Jika `.factory/NO_HARNESS_MEMORY` ditemukan, fungsi mengembalikan string kosong.

#### 1.2. Buat Pi Extension Hook `.factory/hooks/loop-guard.ts`
Mengimplementasikan komponen `c8` (Lifecycle Hooks di dalam tool execution loop Pi):
- Memasang handler pada event `tool_call` dan `tool_result`:
  1. **Protected Paths Guard**: Mencegah tool `write` / `edit` memodifikasi `protected_paths` (`harness/**`, `.factory/holdout/**`, `MISSION.md`, dll.) dengan mengembalikan `{ block: true, reason: "..." }`.
  2. **Command Loop Hinting**: Jika perintah `bash` gagal dengan error signature yang sudah dikenal di `.factory/tool-guidance.json`, tambahkan petunjuk perintah yang benar pada observasi output.

#### 1.3. Update Multi-Harness Provider di `scripts/loop/providers.ts` & `scripts/local-loop.ts`
Sejak PR #77 (`761c367`), `local-loop.ts` menggunakan `buildProviderArgv()` yang mendukung multi-harness (`pi`, `claude`, `codex`, `opencode`, `copilot`) dan *reasoning effort* (`EFFORT_LADDER`). Modifikasi `BuildProviderArgvOptions` dan `buildProviderArgv()` di `scripts/loop/providers.ts` agar menerima `skills?: string[]`, `extensions?: string[]`, dan `appendSystemPrompts?: string[]`:
```typescript
export interface BuildProviderArgvOptions {
  model?: string;
  effort?: EffortRung;
  prompt: string;
  sessionDir?: string;
  skills?: string[];
  extensions?: string[];
  appendSystemPrompts?: string[];
}
```
- **Untuk provider `"pi"`**: Teruskan `--no-extensions` diikuti `-e <hook>`, `--no-skills` diikuti `--skill <path>`, dan `--no-context-files` diikuti `--append-system-prompt <text>`.
- **Untuk provider `"claude"` / `"codex"` / `"opencode"` / `"copilot"`**: Jika `appendSystemPrompts` tersedia, gabungkan blok *Active Repository Gotchas* secara bersih ke bagian akhir prompt atau gunakan flag `--append-system-prompt` (pada `claude`) sehingga injeksi memori bekerja lintas provider harness.
- **Update `countActiveLaps()` di `scripts/loop/scheduler.ts`**: Tambahkan status `"qa"`, `"reviewing"`, dan `"reflecting"` ke dalam perhitungan *active laps* agar scheduler tidak menganggap lap selesai ketika masih berada di tahap QA, review, atau post-lap reflection.

* **Completion Criterion Fase 1**: Unit test di `tests/integration/local-loop.bun.test.ts` memverifikasi bahwa `argv` Pi memuat `--skill`, `-e`, dan `--append-system-prompt` yang sesuai, serta menonaktifkan injeksi memori saat `.factory/NO_HARNESS_MEMORY` aktif.

---

### Fase 2: Pengumpulan Bukti Perjalanan (*Issue Run Dossier*)

#### 2.1. Buat Modul `scripts/loop/dossier.ts`
Mencatat setiap putaran lap ke dalam `<stateRoot>/dossiers/issue-<number>.json`:

```typescript
export interface LapAttemptRecord {
  lapIndex: number;
  runId: string;
  timestamp: string;
  status: "waiting_approval" | "sent_back" | "failed" | "needs_owner";
  candidateHead?: string;
  changedFiles: string[];
  failedStage?: "builder" | "ordinary_checks" | "qa" | "reviewer";
  errorExcerpt?: string;
  reviewFindings: string[];
  qaFailures: string[];
}

export interface IssueDossier {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  branch: string;
  prUrl?: string;
  attempts: LapAttemptRecord[];
  reflectedAt?: string;
}
```

#### 2.2. Logika Trigger Refleksi Terminal (`shouldTriggerReflection`)
Refleksi **hanya** dijalankan apabila `dossier.reflectedAt` masih kosong dan memenuhi salah satu dari dua kondisi terminal berikut:
1. **Kondisi A (Approved After Friction)**:
   - Status lap saat ini adalah `"waiting_approval"` **DAN** terdapat $\ge 1$ attempt sebelumnya di dalam `dossier.attempts` yang gagal (`sent_back` atau `failed`) atau terdapat error recovery di dalam transisi tool.
2. **Kondisi B (Exhausted / Escalated to Human)**:
   - Status lap adalah `"needs_owner"` atau jumlah kegagalan berturut-turut mencapai batas maksimum (`attempts.length >= maxRejections`).

* **Completion Criterion Fase 2**: Simulasi multi-lap (Lap 0 `sent_back` $\rightarrow$ Lap 1 `waiting_approval`) menghasilkan file `dossier.json` yang lengkap dan `shouldTriggerReflection()` mengembalikan `true` tepat di akhir Lap 1.

---

### Fase 3: Engine Reflektor, Kurasi Jev, & Evolusi Skill

#### 3.1. Buat Prompt Reflektor (`scripts/prompts/loop-reflect.md`)
Mengadaptasi prompt `experience()` dari Google Research Harness²:
- Meminta agen membandingkan *trajectory* Lap yang gagal dengan Lap yang berhasil.
- Memberikan atribusi eksplisit: `helped`, `hurt`, `no observed effect`, atau `confounded`.
- Menolak pembuatan lesson jika bukti hanya bersifat `confounded` (`NO_ENTRY`).
- Menghasilkan output JSON terstruktur berisi kandidat:
  - `tool_guidance_updates`: pasangan key-command yang terbukti keluar dengan `exit code 0`.
  - `candidate_lessons`: sesuai skema `docs/agents/harness-authoring-standard.md` (kalimat positif imperatif $\le 2$ kalimat, `trigger_patterns`, `evidence`).
  - `skill_promotion`: rekomendasi pembuatan/pembaruan skill jika pola kegagalan bersifat multi-langkah atau `occurrence_count >= 3`.

#### 3.2. Buat Modul `scripts/loop/reflector.ts`
Menjalankan proses kurasi dan penyimpanan perubahan harness:

1. **Kurasi System 1 (TypeSafe Jev)**:
   Setiap kandidat lesson diuji melalui Jev client:
   - `is_lesson_valid_and_non_trivial` (`noul` $\ge 0.70$): Apakah pelajaran mencatat fakta teknis spesifik repositori yang dapat diulang?
   - `hallucination_risk` (`score`): Pastikan berada pada level `grounded_in_logs`.

2. **Eksekusi Fast-Track (Level 1 & 2 — Lessons & Tool Guidance)**:
   - Jika kandidat lesson lolos Jev:
     - Jika topik sudah ada di `.factory/lessons.jsonl`, tingkatkan `occurrence_count += 1`.
     - Jika belum ada, tambahkan entri baru ke `.factory/lessons.jsonl`.
   - Commit perubahan `.factory/lessons.jsonl` dan `.factory/tool-guidance.json` langsung ke branch PR tiket yang sedang aktif sebelum lap ditutup.

3. **Eksekusi Structural PR (Level 3–5 — Skills, Hooks, & `AGENTS.md`)**:
   - Jika `occurrence_count >= 3` atau terdapat rekomendasi `skill_promotion`:
   - Spawn sesi Pi khusus (*Skill Synthesis Agent*) dengan menyertakan:
     - `--skill <path>/writing-for-agents`
     - `--skill <path>/skill-creator`
     - `--skill <path>/.agents/skills/factory-harness`
   - **Aturan Penulisan Wajib**:
     - Buat/update `.agents/skills/<skill-name>/SKILL.md` dengan YAML frontmatter (`name`, `description` yang jelas memicu cabang kondisi), langkah-langkah bernomor, dan setiap langkah diakhiri `*Completion Criterion*`.
     - Gunakan kalimat positif (*positive phrasing*), hindari negasi, dan gunakan *leading words* yang tajam.
     - Tambahkan **1 baris context pointer** di `AGENTS.md` (satu trigger per branch).
     - Jaga agar `AGENTS.md` tetap **$\le 150$ baris** (lakukan *pruning* kalimat *no-op* jika mendekati batas).
   - **Isolated PR Creation**:
     - Buat worktree/branch baru dari `main` (`worktree.baseBranch` di `.archon/config.yaml`, misal `harness/skill-<skill-name>`).
     - Jalankan test integritas (`tests/integration/harness.test.ts`).
     - Buat Pull Request terpisah: `chore(harness): evolve <skill-name> skill from issue #<N> dossier`.

* **Completion Criterion Fase 3**: Test offline dengan mock transport Jev dan Pi memverifikasi bahwa:
  1. Lesson dengan confidence $\ge 0.70$ tersimpan di `.factory/lessons.jsonl`.
  2. Lesson dengan confidence $< 0.70$ ditolak.
  3. Eskalasi skill (`occurrence_count >= 3`) memicu pembuatan struktur `.agents/skills/<name>/SKILL.md` yang valid dan menjaga `AGENTS.md` $\le 150$ baris.

---

### Fase 4: Backend API & Operator Web Console Integration

#### 4.1. Implementasi Endpoint di `apps/backend/src/main.ts`
Menghubungkan UI tabel Harness di `web/app.js` dengan file di `.factory/`:
1. **`GET /api/v1/harness/lessons` & `/api/harness/lessons`**:
   - Membaca `.factory/lessons.jsonl` dan mengecek `.factory/NO_HARNESS_MEMORY`.
   - Response: `{ safe_mode: boolean, lessons: LessonEntry[] }`.
2. **`GET /api/v1/harness/tools` & `/api/harness/tools`**:
   - Membaca `.factory/tool-guidance.json`.
   - Response: `{ tools: Record<string, string> }`.
3. **`POST /api/v1/harness/veto` & `/api/harness/veto`**:
   - Menerima `{ id: string }`.
   - Mengubah flag `vetoed: true` untuk lesson terkait di `.factory/lessons.jsonl` secara atomik.
   - Response: `{ ok: true, id: string, vetoed: true }`.

* **Completion Criterion Fase 4**: Endpoint `/api/v1/harness/*` mengembalikan HTTP 200 dengan data valid, aksi Veto memperbarui `.factory/lessons.jsonl`, dan dashboard web menampilkan daftar pelajaran serta tool guidance tanpa error 404.

---

## 5. Urutan Pengerjaan (Execution Roadmap)

| Tahap | Paket Pekerjaan | File Utama | Verifikasi |
|---|---|---|---|
| **Step 1** | **Backend Harness API** | `apps/backend/src/main.ts`, `packages/contracts/src/operator.ts` | `tests/integration/harness.test.ts` |
| **Step 2** | **Curated Hermetic Injection & Guard Hook** | `scripts/loop/harness-memory.ts`, `scripts/loop/providers.ts`, `.factory/hooks/loop-guard.ts`, `scripts/local-loop.ts` | `tests/integration/local-loop.bun.test.ts` |
| **Step 3** | **Issue Run Dossier & Terminal Trigger** | `scripts/loop/dossier.ts`, `scripts/local-loop.ts` | `tests/integration/loop-modules.bun.test.ts` |
| **Step 4** | **Post-Issue Reflector, Jev Gating & Skill PR** | `scripts/loop/reflector.ts`, `scripts/prompts/loop-reflect.md` | `tests/integration/harness.test.ts` |
| **Step 5** | **Full Verification Suite** | Seluruh file di atas | `bun harness/ci.ts` |
