# UI/UX Design Brief: LabQ Software Factory Operator Console

**Target Canvas**: `/Users/efishery/.pencil/documents/240767a8-5df0-413b-a5c3-3c5cb274b820/pabriq-software-factory.pen`  
**Base Design System**: `xai-design-system`  
**Purpose**: An operational control, supervision, and observability interface for an autonomous software factory based on the Archon SDLC engine (`archon-loop`) and Pi agent sessions.

---

## 1. Core Visual Foundations (x.ai Tokens)

| Property | Token / Value | Description |
| :--- | :--- | :--- |
| **Canvas Background** | `$xai-bg` (`#0A0A0A` / `#000000`) | Deep black without multicolored gradients |
| **Surface Container** | `$xai-surface` (`#1A1A1A`) | Panel/sidebar/card background |
| **Secondary Surface** | `$xai-action-secondary` (`#202020`) | Secondary button & hovered item background |
| **Border / Divider** | `$xai-border` (`#1F2228`), `$xai-white-08` | Thin 1px border, flat, no outer neon glow |
| **Text Primary** | `$xai-text` (`#FFFFFF`) | High-contrast primary text |
| **Text Secondary / Muted** | `$xai-text-secondary` (`#A3A3A3`), `$xai-text-muted` (`#7D8187`) | Descriptions, secondary labels, and metadata |
| **Accent Color** | `$xai-accent` (`#FF6308`), `$xai-accent-bg` | Signature x.ai orange for active/running indicators |
| **Status Colors** | `$xai-success` (`#91C17A`), `$xai-warning` (`#FFAB70`), `$xai-error` (`#FF8A8A`) | Semantic feedback |
| **Typography** | UI font: `$xai-font` (`xVf` / Sans-serif) • Monospace: `$xai-font-code` (`GeistMono`) | Standard typography |
| **Radius Scale** | Card: `$xai-radius-card` (16px) • Code block: `$xai-radius-code` (12px) • Pill: `9999px` | Do not mix radii inconsistently |

---

## 2. Layout Structure & Wireframe Breakdown

The screen is divided into 2 main areas: **Left Sidebar (280–300px)** and **Main Content Pane (Remaining width)**.

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

## 3. Detailed Requirements for Each Section

### A. Left Sidebar (Navigation, Hierarchy & Controls)
1. **Sidebar Header**:
   - x.ai logo (`uM96z`) + Product Name / Version.
2. **Primary Action**:
   - **`+ Add Repository`** button: Use the solid White Pill button component (`#FFFFFF`, black text, 9999px radius, 40–44px height, similar to the `New chat` button in x.ai).
3. **Filter / Search**:
   - A thin search input with softly rounded corners and a leading search icon inside.
4. **Repository & Issue Tree List**:
   - **Parent**: Repository name (e.g. `pabriq-app`, `labq-platform`, `pabriq-web`). Includes a git folder icon and a collapse/expand chevron.
   - **Issues Submenu**: List of issues in the selected repository:
     - **Active Issue Being Worked On (e.g. `#42`)**: Highlighted with the `$xai-action-secondary` background, a subtle `$xai-accent` border, runtime subtitle `lap-XXXXX · in progress`, and a **spinning arc indicator** (a rotating orange `$xai-accent` loading circle).
     - **Ready Issue (Admitted / Ready, e.g. `#43`)**: Green dot indicator (`$xai-success`) with a `Ready` badge/label.
     - **Held Issue (Held / Blocked, e.g. `#44`)**: Amber dot indicator (`$xai-warning`) with the description `Blocked by #42` or the `needs-info` label.
5. **Sidebar Footer (Bottom)**:
   - Thin 1px separator/divider (`$xai-border`).
   - **`Settings` / `Factory Settings`** menu: Configure the factory runtime (*Agents, Skills registry, MCP tools, Harness Pi, and Work window schedule*).

---

### B. Top Header Bar (Global Factory Status & Actions)
60–64px height, `$xai-surface` background, thin bottom border.
1. **Left Side (Operational Status)**:
   - Engine indicator: Blinking/solid green dot + `Factory Active` text.
   - Operational information (may be clean text or capsule pills):
     - Work hours: `Window: 20:00 – 05:00`
     - Available slots: `Slots: 1/2 Active`
     - Staging base branch: `Base: develop` (orange highlight)
2. **Right Side (Global Controls)**:
   - **Staging Promotion Button**: White Pill button `Promote 4 Commits to main` (triggers the morning promotion PR develop -> main).
   - **Master Engine Toggle Switch**: ON/OFF switch component (`T7pqfo`) to enable / disable the software factory.
   - **Drain Admissions Button**: Secondary emergency button (`.factory/PAUSE`) with red warning text (`$xai-error`).

---

### C. Main Content Pane (Selected Issue Details)
1. **Issue Headline Bar**:
   - Breadcrumbs: `pabriq-app > Issues > #42`.
   - Metadata badges: `ready-for-agent`, model `gpt-6.1-sol (large)`, git worktree `tree-42`, runtime duration `04m 12s`.
   - Issue Title: Large (`22–26px`, font `$xai-font`, weight 500), high-contrast typography.
2. **Navigation Tabs**:
   - x.ai pill-style tabs:
     - `● Realtime Telemetry & Logs` (Active state)
     - `Issue Specification`
     - `PR & File Diffs`
     - `Token Economics & Stats`
3. **SDLC Pipeline Breadcrumb Bar**:
   - Archon loop workflow visualization:
     `pick` → `claim` → `build (loop-work)` → `check-app` → `review` → `land`
   - Completed stage: green checkmark (`✓`).
   - Active stage: orange-highlighted capsule with a pulsing dot (`●`).
   - Pending stage: muted gray text.
4. **Live Terminal / Monospace Log Stream**:
   - Format adopts the `x.ai / Panel / Code` component (`r8KMCd`):
     - Deep black background (`#000000`).
     - 12px radius (`$xai-radius-code`).
     - Terminal header bar: **3 Mac window dots** (red, yellow, green) and the label `LIVE LOG STREAM · PID: 19482` on the left; a `Copy` button and polling rate information (`poll: 2.1s`) on the right.
     - Content area: Monospace `GeistMono` font (11px size, 1.5 line-height) displaying git worktree process logs, file modifications, test execution, and evidence status.
5. **Bottom Grid Cards**:
   Two side-by-side cards with a 16px radius (`$xai-radius-card`):
   - **Card 1: Staging PR & File Diffs**: Displays the target branch (`feat/webhook-verify → develop`) and a list of changed files with added/removed line counts (`+38 / -2`, green/red).
   - **Card 2: Token Economics & Performance**: A grid of clean, large numerical metrics in the x.ai style:
     - Input Tokens (e.g. `24,510`, subtext cached)
     - Output Tokens (e.g. `1,840`, subtext speed 48 tok/s)
     - Thinking Tokens (e.g. `3,200`, subtext adaptive)
     - Est. Run Cost (e.g. `$0.14 USD`, subtext within budget)

---

## 4. References to Existing Components in the `.pen` File

When assembling this in Pen.app using the reusable x.ai components already in the document:
- Brand Logo: `uM96z` (`x.ai / Brand mark`)
- Primary Button: `bp2iN` (`x.ai / Button / Primary`)
- Compact Button: `zfqO1` (`x.ai / Button / Compact`)
- Switch Toggle: `T7pqfo` (`x.ai / Switch / On`)
- Tabs: `o5SEO2` (Active), `DMeWI` (Inactive)
- Badges: `Q7Gevs` (Neutral), `nXSkc` (Success), `h2MuaI` (Warning)
- Code Panel: `r8KMCd` (`x.ai / Panel / Code`)
- Breadcrumbs: `a1Du4c` (`x.ai / Breadcrumbs`)
- Loading Spinner: `Qh4Up` (`x.ai / Loading / Spinner`)
- Icons: Use the Lucide icons built into Pen.app (`folder`, `search`, `settings`, `chevron-down`, `check`, `terminal`, `copy`, etc.)
