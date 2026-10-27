# Research: TypeSafe Jev Decision Model & Penerapannya pada Software Factory

* **Tanggal:** 2026-10-27
* **Topik:** Evaluasi arsitektur TypeSafe Jev (System 1 Typed Decision Engine) untuk otomasi dan *self-improvement* pada Software Factory.
* **Status:** Final Research Report

---

## 1. Executive Summary: Apa itu TypeSafe Jev?

**TypeSafe Jev** adalah *non-autoregressive typed decision engine* (sering dikategorikan sebagai mesin **System 1** untuk agen AI). Berbeda dari model bahasa generatif (*autoregressive* LLM seperti Claude, GPT, atau Pi) yang memprediksi token kata per kata untuk menghasilkan teks bebas, Jev dirancang murni untuk mengevaluasi *state* dan menghasilkan keputusan terstruktur bertipe data (*typed decisions*) dengan probabilitas terkalibrasi (*calibrated confidence*) dalam **satu forward pass** sub-detik (~200–300 ms).

Riset dan reproduksi terbuka Jev (misalnya [open-jev-typed-decision-engine](https://github.com/intikhab49/open-jev-typed-decision-engine), [Verdict-open-jev](https://github.com/Heman10x-NGU/Verdict-open-jev), dan [jev-pilot](https://github.com/h0j5bz0adh0-stack/jev-pilot)) menunjukkan arsitektur berbasis *bidirectional encoder* (~150M parameter, seperti ModernBERT) yang menerima *context state* bersama marker pertanyaan `<<q>>` dan label `<<l>>`, lalu memproyeksikannya melalui linear classification head dengan normalisasi *softmax* dan *Brier penalty*.

### Tiga Primitif Keputusan (*Decision Primitives*)
1. **`noul` (Boolean / Binary Gate)**:
   Keputusan biner ya/tidak (`true`/`false`) berdasarkan evaluasi kriteria ketat terhadap context. Disertai confidence score (0.00 – 1.00).
2. **`choice` (Categorical / Discrete Enum)**:
   Pemilihan satu opsi dari kamus label diskrit (`label -> criteria description`). Menghasilkan distribusi probabilitas penuh di seluruh opsi (misal: menentukan rute alur kerja atau pemenang strategi).
3. **`score` (Ordinal / Scaled Evaluation)**:
   Penilaian bertingkat pada skala berurutan (misal: tingkat risiko 1–5, tingkat keparahan defect minor/major/blocker).

### Karakteristik Kunci
* **Zero Prose / No Hallucination**: Jev tidak menghasilkan teks penjelasan bebas; outputnya murni typed struct/JSON.
* **Calibrated Confidence**: Confidence score mencerminkan ketepatan matematis (bukan sekadar keyakinan palsu LLM generatif).
* **Latency & Cost Ekstrem Rendah**: Berjalan dalam ~25–300ms dengan konsumsi VRAM/token yang sangat kecil dibandingkan memanggil model penalaran besar untuk sekadar mengambil keputusan klasifikasi.

---

## 2. Kesenjangan (*Gaps*) di Software Factory Saat Ini

Berdasarkan analisis arsitektur factory kita (`labq-software-factory`, `factory/consumer.py`, dan `app.py`):
1. **Intake Triage Terlalu Lambat atau Terlalu Permisif**:
   * Saat ini, *workability gate* bersifat aturan string sederhana (regex `Depends on`), atau membutuhkan pemanggilan model LLM penalaran penuh hanya untuk mengecek apakah tiket memiliki acceptance criteria yang jelas.
2. **Penentuan Pemenang Probing (Harness² Task-Level)**:
   * Saat mengimplementasikan siklus *Propose-Probe-Compose* dari Harness², mengevaluasi kandidat strategi menggunakan LLM generatif rentan terhadap *bias posisi* (*positional bias*) dan memakan banyak token.
3. **Safety Brake & Stale-Loop Detection**:
   * Membedakan agen yang "sedang berpikir keras menyelesaikan masalah kompleks" vs "agen yang terjebak dalam infinite retry loop" memerlukan klasifikasi trace eksekusi yang cepat tanpa menambah overhead latensi.
4. **Otorisasi Auto-Merge `develop`**:
   * Keputusan apakah PR aman untuk di-merge otomatis membutuhkan evaluasi biner yang deterministik terhadap diff dan hasil test, tanpa interpretasi bebas yang melenceng.

---

## 3. Case yang Sangat Cocok untuk Software Factory Kita

Berikut adalah 5 *use case* dengan nilai ROI tertinggi untuk mengadopsi TypeSafe Jev ke dalam ekosistem Software Factory:

### Case 1: Issue Readiness & Scope Gatekeeper (Intake Triage)
* **Primitif Jev:** `noul` + `score`
* **Cara Kerja:**
  Saat issue baru dibuat atau sebelum dimasukkan ke antrean lap, Jev mengevaluasi deskripsi issue terhadap kriteria kesiapan pabrik:
  ```json
  Question: noul(
    target="is_ready_for_agent",
    criteria="Issue memiliki acceptance criteria yang dapat diverifikasi secara objektif dan ruang lingkup kode jelas tanpa ambiguitas."
  )
  Question: score(
    target="scope_complexity",
    levels=["trivial", "single_file", "multi_file_feature", "architectural_refactor", "epic_needs_breakdown"]
  )
  ```
* **Manfaat:** Tiket yang belum siap langsung diberi label `needs-info` dalam hitungan milidetik sebelum membuang kuota eksekusi lap Archon/Pi.

### Case 2: Candidate Arbitration pada Harness² Probing (Task-Level Recursion)
* **Primitif Jev:** `choice`
* **Cara Kerja:**
  Saat lap mengalami kegagalan pada tahap verifikasi dan menjalankan *targeted probes* (misal membandingkan 2 alternatif perbaikan diff/patch):
  ```json
  Question: choice(
    target="best_remediation_candidate",
    options={
      "patch_a": "Memperbaiki bug tanpa menambah dependensi baru dan lolos seluruh suite regression.",
      "patch_b": "Menambahkan wrapper layer yang mengubah signature publik modul.",
      "reject_both": "Kedua patch memperkenalkan side-effect berbahaya."
    }
  )
  ```
* **Manfaat:** Arbitrasi objektif yang tidak terpengaruh urutan teks (*option-order invariant*) dan sub-detik untuk memilih patch terbaik sebelum melangkah ke tahap *Compose*.

### Case 3: Loop Detection & Circuit Breaker (Runtime Safety)
* **Primitif Jev:** `noul` + `choice`
* **Cara Kerja:**
  Di `factory/consumer.py`, pantau 5 perintah shell terakhir dan riwayat error lap.
  ```json
  Question: noul(
    target="is_execution_stuck",
    criteria="Log menunjukkan agen mengulang perintah command yang sama dengan parameter identik dan mendapatkan error yang sama berulang kali."
  )
  Question: choice(
    target="brake_action",
    options={
      "continue": "Agen membuat progres konkrit (mengedit file baru atau error berkurang).",
      "intervene_hint": "Berikan inject instruksi koreksi error.",
      "pause_lap": "Hentikan lap dan tandai status needs-owner."
    }
  )
  ```
* **Manfaat:** Menghentikan *token burning* secara otomatis jika agen loopback mengalami degradasi logika, sebelum melanggar batas timeout besar.

### Case 4: Dynamic Merge Authority Gate (`develop` Auto-Merge)
* **Primitif Jev:** `noul`
* **Cara Kerja:**
  Sebagai syarat mutlak sebelum mengeksekusi merge otomatis ke branch `develop`:
  ```json
  Question: noul(
    target="authorized_for_auto_merge",
    criteria="Diff PR hanya menyentuh file dalam cakupan tiket, seluruh test suite hijau, tidak ada bypass security/linter, dan target branch adalah develop."
  )
  ```
* **Manfaat:** Memberikan lapisan verifikasi *zero-trust* deterministik sebelum kode masuk ke branch integrasi bersama.

### Case 5: Curation & Pruning of Learned Lessons (Harnessing-Level)
* **Primitif Jev:** `score` + `noul`
* **Cara Kerja:**
  Saat *Post-Lap Reflexion* merumuskan draf pelajaran baru untuk dimasukkan ke `.factory/lessons.jsonl`:
  ```json
  Question: noul(
    target="is_lesson_valid_and_non_trivial",
    criteria="Pelajaran mencatat fakta teknis spesifik repositori yang dapat diulang, bukan sekadar rangkuman umum atau halusinasi."
  )
  Question: score(
    target="hallucination_risk",
    levels=["grounded_in_logs", "plausible_inference", "unsupported_claim"]
  )
  ```
* **Manfaat:** Menyaring aturan-aturan "sampah" atau "prompt bloat" agar memory `.factory/` tetap bersih dan berkualitas tinggi.

---

## 4. Pola Arsitektur: Dual-System (System 1 + System 2)

Kombinasi paling kokoh untuk Software Factory adalah membagi peran secara tegas:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   SOFTWARE FACTORY OPERATING SYSTEM                    │
│                                                                        │
│   [ SYSTEM 1: TypeSafe Jev ]            [ SYSTEM 2: Archon + Pi/Claude]│
│   - Sub-300ms Latency                   - Deep Reasoning               │
│   - Non-autoregressive (Encoder)        - Autoregressive Generation    │
│   - Pure Typed Decisions                - Code Writing & Architecture  │
│   - Deterministic Gates & Routing       - Complex Refactoring & Design │
│   ─────────────────────────────         ────────────────────────────── │
│   * Intake Filter (Ready/Hold)          * Feature Implementation       │
│   * Worktree Arbitration (Probing)      * Bug Diagnosis & Fix          │
│   * Loop Detection & Safe Brake         * Post-Mortem Deep Reflection  │
│   * Merge Gatekeeper                    * Synthesis of New Skills      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Sumber & Referensi Primer

1. **Jev Architecture & Specifications:**
   * [intikhab49/open-jev-typed-decision-engine](https://github.com/intikhab49/open-jev-typed-decision-engine) — Open reproduction of TypeSafe Jev, encoder design, `<<q>>`/`<<l>>` token serialization, Brier penalty loss.
   * [Heman10x-NGU/Verdict-open-jev](https://github.com/Heman10x-NGU/Verdict-open-jev) — Non-autoregressive ModernBERT decision engine with calibrated uncertainty (RLCD).
2. **Autonomous Agent Applications:**
   * [h0j5bz0adh0-stack/jev-pilot](https://github.com/h0j5bz0adh0-stack/jev-pilot) — Fast System-1 Decision, Arbitration & Safety Engine for Autonomous AI Agents.
   * [sergio-lim/ai-decision-engine](https://github.com/sergio-lim/ai-decision-engine) — Typed AI decisions, confidence-gated routing.
   * [zhangcy122/OpenJev](https://github.com/zhangcy122/OpenJev) — Deliberative decision flywheel (System 2 ➔ System 1).
3. **Repository Konteks Lokal:**
   * `docs/current-factory-analysis.md` & `factory/consumer.py` — Delivery loop lifecycle, claim logic, and merge gating.
