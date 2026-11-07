# Animus design system — extracted from `animus.pen`

## Source and coverage

**Source.** `/Users/efishery/.pencil/documents/6a35f316-ca78-4af7-a105-4f59ba146ee2/animus.pen`
Pencil document version `2.22`, `fileToken` `4bbf71be-2380-4f8a-aa16-a53123115a98`, authored themes `["dark", "light"]`.

**Node census.** 6142 frames, 4609 text nodes, 2207 icons, 992 component instances (`ref`), 140 rectangles, 83 ellipses, 48 paths, 2 groups.

**Scope.** 73 top-level nodes:

| Group | Count | Contents |
| --- | --- | --- |
| `x.ai /` library boards | 10 | 01 Foundations, 02 Components, 03 Page patterns, 04 Forms and fields, 05 Feedback and overlays, 06 Uploads/badges/menus, 07 Data and utilities, 08 Advanced controls, 09 AI assistant chat, 10 Chat conversation pattern |
| `Animus /` product frames | 57 | Jobs, Task card, Issue detail, Repositories, Settings, Inbox, plus 3 authored documentation boards |
| Unlabeled | 6 | 5 image backdrops + 1 composed reference frame (`Task card / Running and paused states`) |

**Evidence classes.** Every value below carries one of four labels:

- **authored token** — a named document variable, with its bindings.
- **observed value** — a literal or measured node property.
- **inferred role** — a proposed grouping justified by repeated use, not authored.
- **unresolved** — the source cannot establish the value.

**Coverage.** All values below are read directly from the document JSON. No rendered captures were taken: no Pencil MCP server is available in this environment, so nothing here is visually verified against a render. Both authored themes are recorded, but only the dark theme is the product target — no light-mode frame was reviewed, so every light-mode value is structured-only.

**How to reproduce the token and component inventories.**

```bash
PEN=/Users/efishery/.pencil/documents/6a35f316-ca78-4af7-a105-4f59ba146ee2/animus.pen
bun -e '
const d = JSON.parse(require("fs").readFileSync(process.env.PEN, "utf8"));
const rows = Object.entries(d.variables).map(([k, v]) =>
  Array.isArray(v.value)
    ? `${k}\t${v.type}\t${v.value.map((e) => `${e.theme?.mode}=${e.value}`).join("\t")}`
    : `${k}\t${v.type}\t${JSON.stringify(v.value)}`);
console.log(rows.join("\n"));'
```

---

## Foundations

### Color tokens

All 60 variables are authored tokens (`doc.variables`). Aliases are referenced from node properties as `$xai-*`.

| Token | Type | Dark | Light | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| `xai-bg` | color | `#0A0A0A` | `#FFFFFF` | authored token | Canvas. Zero-consumer analysis: 181 fills, 28 strokes. |
| `xai-text` | color | `#FFFFFF` | `#0A0A0A` | authored token | Primary text (1834 text nodes) and the primary button fill. |
| `xai-text-secondary` | color | `#A3A3A3` | `#525252` | authored token | Secondary text (1659 text nodes). |
| `xai-text-muted` | color | `#7D8187` | `#61656B` | authored token | Supporting text (769 text nodes). |
| `xai-font` | string | `"xVf"` | — | authored token | Opaque font-asset identifier. **Unresolved**: see Typography. |
| `xai-font-code` | string | `"GeistMono"` | — | authored token | Code face. |
| `xai-control-border` | color | `#777777` | `#777777` | authored token | Borders of controls (fields, outline badges, toasts). 143 strokes. |
| `xai-border` | color | `#1F2228` | `#D7DADE` | authored token | Structural divider. 223 strokes. |
| `xai-border-subtle` | color | `#FFFFFF14` | `#0A0A0A1F` | authored token | The dominant hairline. 1163 strokes. |
| `xai-surface` | color | `#1A1A1A` | `#F5F5F5` | authored token | Default raised surface. 467 fills. |
| `xai-action-secondary` | color | `#202020` | `#E8E8E8` | authored token | Secondary button and selected option fill. 160 fills. |
| `xai-accent` | color | `#FF6308` | `#B84300` | authored token | Announcement/accent text only (9 text nodes). |
| `xai-accent-bg` | color | `#FF63081A` | `#FF630814` | authored token | Accent chip surface. |
| `xai-elevation-stage` | color | `#111111` | `#F1F1F1` | authored token | Backdrop used to demonstrate elevation specimens. |
| `xai-elevation-edge` | color | `#FFFFFF1F` | `#0A0A0A1A` | authored token | 1px elevation edge. 16 strokes. |
| `xai-elevation-1-surface` | color | `#1A1A1A` | `#FFFFFF` | authored token | Raised card surface. 240 fills. |
| `xai-elevation-1-y` | number | `1` | — | authored token | Shadow offset. |
| `xai-elevation-1-shadow` | color | `#0000004D` | `#00000014` | authored token | Shadow color. |
| `xai-elevation-1-blur` | number | `4` | — | authored token | Shadow blur. |
| `xai-elevation-2-surface` | color | `#202020` | `#FFFFFF` | authored token | Floating surface (popovers, select options). 87 fills. |
| `xai-elevation-2-y` | number | `4` | — | authored token | Shadow offset. |
| `xai-elevation-2-shadow` | color | `#00000066` | `#0000001F` | authored token | Shadow color. |
| `xai-elevation-2-blur` | number | `12` | — | authored token | Shadow blur. |
| `xai-elevation-3-surface` | color | `#262626` | `#FFFFFF` | authored token | Overlay surface (dialogs, sheets). |
| `xai-elevation-3-y` | number | `12` | — | authored token | Shadow offset. |
| `xai-elevation-3-shadow` | color | `#0000008C` | `#00000029` | authored token | Shadow color. |
| `xai-elevation-3-blur` | number | `32` | — | authored token | Shadow blur. |
| `xai-radius-news` | number | `8` | — | authored token | News/card-corner radius, also the field control radius. 48 uses. |
| `xai-radius-code` | number | `12` | — | authored token | Code block and toast radius. |
| `xai-radius-card` | number | `16` | — | authored token | Card radius. 35 uses. |
| `xai-radius-pill` | number | `9999` | — | authored token | Action and badge radius. 80 uses. |
| `xai-space-8` | number | `8` | — | authored token | Spacing step. |
| `xai-space-12` | number | `12` | — | authored token | Spacing step. |
| `xai-space-24` | number | `24` | — | authored token | Spacing step. |
| `xai-space-40` | number | `40` | — | authored token | Spacing step. |
| `xai-divider-alpha` | color | `#0A0A0A33` | `#FFFFFF33` | authored token | Alpha divider. |
| `xai-hover` | color | `#E5E5E5` | `#262626` | authored token | Hover tint. Inverted relative to the canvas — verify before use. |
| `xai-announcement-surface` | color | `#1A1A1A99` | `#F0F0F099` | authored token | Translucent announcement surface. |
| `xai-white-04` | color | `#FFFFFF0A` | `#0A0A0A0A` | authored token | 4% white wash. 76 fills. |
| `xai-white-08` | color | `#FFFFFF14` | `#0A0A0A14` | authored token | 8% white wash. |
| `xai-white-20` | color | `#FFFFFF33` | `#0A0A0A33` | authored token | 20% white wash. |
| `xai-white-25` | color | `#FFFFFF40` | `#0A0A0A40` | authored token | 25% white wash. 49 fills. |
| `xai-white-30` | color | `#FFFFFF4D` | `#0A0A0A80` | authored token | 30% white wash. |
| `xai-white` | color | `#FFFFFF14` | `#0A0A0A14` | authored token | 8% wash, aliased name; same resolved value as `xai-white-08`. |
| `xai-white-2` | color | `#FFFFFF0A` | `#0A0A0A0A` | authored token | 4% wash, aliased name; same resolved value as `xai-white-04`. |
| `xai-error` | color | `#FF8A8A` | `#B42318` | authored token | Error text/icon. 19 text nodes. |
| `xai-error-bg` | color | `#FF8A8A1F` | `#B4231814` | authored token | Error surface tint. |
| `xai-success` | color | `#91C17A` | `#326B24` | authored token | Success text/icon. 98 text nodes, 48 fills. |
| `xai-success-bg` | color | `#91C17A1F` | `#326B2414` | authored token | Success surface tint. 17 fills. |
| `xai-warning` | color | `#FFAB70` | `#8A4B0F` | authored token | Warning text/icon. 70 text nodes. |
| `xai-warning-bg` | color | `#FFAB701F` | `#8A4B0F14` | authored token | Warning surface tint. |
| `xai-info` | color | `#9ECBFF` | `#195D9E` | authored token | Info text/icon. 21 text nodes. |
| `xai-info-bg` | color | `#9ECBFF1F` | `#195D9E14` | authored token | Info surface tint. |
| `xai-overlay` | color | `#111111` | `#E5E5E5` | authored token | Modal scrim. |
| `xai-code-text` | color | `#E1E4E8` | `#272B30` | authored token | Code body. 55 text nodes. |
| `xai-code-muted` | color | `#8D867E` | `#625D57` | authored token | Code punctuation/comment. |
| `xai-code-keyword` | color | `#F97583` | `#AC2436` | authored token | Code keyword. |
| `xai-code-param` | color | `#FFAB70` | `#8A4B0F` | authored token | Code parameter. |
| `xai-code-string` | color | `#9ECBFF` | `#195D9E` | authored token | Code string. |
| `xai-code-function` | color | `#79B8FF` | `#175EB0` | authored token | Code function name. |

### Color roles

Authored guidance, node `F5J4Hw` (*Color usage*, Foundations):

> White drives hierarchy. Orange is reserved for announcements. Muted text is for supporting content; faint borders are decorative.

Three text tiers, **inferred role** from usage counts: `xai-text` `#FFFFFF` for headings and primary content (1834 nodes), `xai-text-secondary` `#A3A3A3` for labels and body metadata (1659 nodes), `xai-text-muted` `#7D8187` for supporting detail (769 nodes).

Orange does **not** carry primary actions. `xai-accent` appears on 9 text nodes and in the Stage chip only; the primary button is inverted white-on-dark.

### Color usage census

Observed values across all boards.

| Kind | Distribution |
| --- | --- |
| Fill | `surface` 467 · `elevation-1-surface` 240 · `bg` 181 · `action-secondary` 160 · transparent `#00000000` 124 · `elevation-2-surface` 87 · `white-04` 76 · `text` 64 · `white-25` 49 · `success` 48 · scrim `#000000A6` 38 · `text-muted` 17 · `elevation-stage` 17 · `success-bg` 17 |
| Stroke | `border-subtle` 1163 · `border` 223 · `control-border` 143 · `elevation-edge` 16 · `bg` 28 · `text` 23 |
| Text fill | `text` 1834 · `text-secondary` 1659 · `text-muted` 769 · `success` 98 · `warning` 70 · `code-text` 55 · `bg` 33 · `info` 21 · `error` 19 · `code-keyword` 10 · `accent` 9 · `code-string` 3 |

Untokenised literals that repeat and need a role decision later (**observed value**, _unresolved_): `#24262B` (27 fills), `#111214` (13), `#E8E8E8` (12), `#111111` (12 fills, 12 text), `#EEEEEE` (11 strokes, 11 text).

### Typography

**Authored scale** from the *Type and geometry* board (`GvLKY`):

| Role | Family | Size | Weight | Line height | Source node |
| --- | --- | --- | --- | --- | --- |
| Display / 60 · 450 | `$xai-font` | 60 | 450 | 1.1 | `f7QjT` |
| Section / 48 · 500 | `$xai-font` | 48 | 500 | 1.2 | `AR0hd` |
| Heading / 30 · 500 | `$xai-font` | 30 | 500 | 1.2 | `pISXX` |
| Card / 24 · 500 | `$xai-font` | 24 | 500 | 1.33 | `mMkkI` |
| Body / 16 · regular | `$xai-font` | 16 | normal | 1.5 | `UjAzb` |
| Control / 14 · 500 | `$xai-font` | 14 | 500 | 1.43 | `dXjuw` |
| Code / 13 · regular | `$xai-font-code` | 13 | normal | 1.6 | `mgdzr` |

**Face note**, verbatim (`UUC5Z`): "Source fonts: xVf for interface text; GeistMono for code. Reuse the source font mappings when exporting."

`xai-font = "xVf"` is **unresolved**. The document carries no font-asset registry and the identifier occurs only as that variable's value, so the concrete family cannot be established from the file.

**Family census by board group** — the load-bearing finding for implementation:

| Group | Families |
| --- | --- |
| `x.ai /` library boards | `$xai-font` 689 · `$xai-font-code` 57 |
| `Animus /` product frames | `Inter` 3399 · `$xai-font` 147 · `Geist Mono` 223 · `JetBrains Mono` 90 |
| Unlabeled backdrop frame | `Inter` 4 |

The Animus product surface is authored in **Inter** with **Geist Mono** for code. `$xai-font` stays confined to the library boards. `JetBrains Mono` (90 nodes) is a third mono face with no token — **observed value**, inconsistent with `Geist Mono` and to be resolved toward it.

**Observed size census** (px → count): 12→1232, 11→954, 13→787, 14→698, 28→239, 10→189, 11.5→147, 20→107, 24→98, 16→77, 15→24, 18→20, 26→11, 48→9, 22→6, 17→2, 30→1, 40→1, 56→1, 60→1.

**Weight census:** normal 3205, 500 1231, 600 108, 450 1.

**Line-height census:** 1.45→1428, 1.5→1313, 1.4→1271, 1.2→155, 1.43→39, 1.85→34, 1.3→25, 1.6→14, 1→11.

**Tracking census:** −0.8→235, −0.7→49, 0.4→6, −0.4→4, −1.1→1.

The authored six-role scale does not cover the 10/11/12/13 sizes that carry most product text. **Inferred role**: product UI runs a dense 11–14 body tier (line heights 1.4–1.45) on top of the marketing scale, with 28 px section titles.

### Geometry

**Authored radius tokens:** `xai-radius-news` 8 (board specimen `HHC1u` "News / 8"), `xai-radius-code` 12 (`dWmr3` "Code / 12"), `xai-radius-card` 16 (`pi1WM` "Card / 16"), `xai-radius-pill` 9999 (`P6RyX` "Action / pill").

**Observed radius census:** 6→428, 12→268, 9999→256, 7→214, 8→193, 10→108, `$xai-radius-pill`→80, 4→70, `$xai-radius-news`→48, `$xai-radius-card`→35, 5→17, 16→12, 2→7, 999→6, `[16,16,16,6]`→3, 3→2. The 6/7/10 cluster is **observed value**, untokenised against the authored 8/12/16/pill scale.

**Nested-radius rule** (**inferred role**, evidenced twice in the Jobs header `PxEJz`): an `r=10` container with `pad=4` holds `r=6` segments; an `r=10` container with `pad=3` holds `r=7` segments. Inner radius = outer radius − container padding. The implemented header uses the pad-3 variant for both segmented controls so their outer heights agree.

**Authored spacing scale** (`Ss4TJ`): 4, 8, 12, 16, 20, 24, 40, 64, 96.

**Observed gap census:** 12→1201, 8→796, 6→505, 10→282, 5→263, 16→261, 7→165, 20→155, 24→144, 2→139, 4→123, 32→38, 26→45, 14→32, 40→9, 3→7. The 5/6/7/10/14 values sit off the authored 4-step scale (**observed value**).

**Authored layout specifications**, verbatim (`WMOf6`):

> Desktop: 1280 container · 24 side padding
> Header: 64 high · Section padding: 96
> Cards: 20 or 24 gap · Support card inset: 40

Product overrides (**observed value**): the Animus Jobs header is 76 high with 28 px horizontal padding (`PxEJz`); the app sidebar is 64 wide with padding `[20,10,16,10]` (`baXIP`).

### Elevation

| Level | Surface | Shadow offset y | Blur | Shadow | Edge | Usage | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 / Flat | `#0A0A0A` | — | — | none | none | Page sections in flow | `eDcba` |
| 1 / Raised | `#1A1A1A` | 1 | 4 | `#0000004D` | `#FFFFFF1F` | Contained cards, grouped controls | `e7X9ci` |
| 2 / Floating | `#202020` | 4 | 12 | `#00000066` | `#FFFFFF1F` | Dropdowns, popovers, transient menus | `IeZBw` |
| 3 / Overlay | `#262626` | 12 | 32 | `#0000008C` | `#FFFFFF1F` | Dialogs and sheets | `SASbR` |

Authored guidance (`WeAJW`): "Pair shadows with progressively lighter surfaces and a 1 px elevation edge, #FFFFFF1F. Shadows alone lose definition against a dark canvas. Keep the edge decorative; it is not a focus indicator."

Scope caveat (`ZgGXt`, verbatim): "These four levels extend the x.ai design system. They are proposed guidance, not verified elevation behavior from the source website. All shadow specimens use x = 0 and an outer shadow."

Because of that note, levels 2 and 3 are **inferred role / proposed extension**, not verified source behaviour.

**Observed usage:** `elevation-3` shadow (y12 / blur 32) on 31 nodes, `elevation-2` (y4 / blur 12) on 10, `elevation-1` on 2, `background_blur` radius 4 on 2, radius 1 on 1.

### Iconography

Every icon node uses `library: "lucide"` — 80 distinct glyphs, inline sizes 12–20 px (18 px in navigation, 20 px in fields and toasts, 12–14 px in card meta). Top usage: `ellipsis` 368, `chevron-down` 118, `git-pull-request` 108, `columns-3` 98, `inbox` 93, `loader-circle` 64, `github` 62, `plus` 60, `cpu` 60, `search` 56, `square` 56, `layers` 54. The two glyphs drawn as raw `path` nodes (the primary-button chevron, `kTuwM`/`dQ9uE`) are 3.33 px legs with a 1.67 px stroke.

---

## Component catalog

154 definitions carry `reusable: true`. 992 instances reference only 10 of them: `ENO1O` 722, `F7qtwv` 98, `u7TcZ` 69, `OgB6C` 50, `aCdnZ` 22, `E13uuD` 10, `a5EnOD` 10, `EkPzp` 8, `TphIm` 2, `w8VWZ` 1.

| Family | Pencil definitions and boards | Variants, states and evidence | Anatomy and dependencies | Token bindings and significant overrides |
| --- | --- | --- | --- | --- |
| Brand | `x.ai / Brand mark` `ftT1G` — 01 Foundations > System identity | Single master. 51 × 19.4. | Frame plus one child path. | No token bindings; vector brand artwork. |
| Buttons | Primary `u7TcZ`, Secondary `OgB6C`, Compact `snWN7`, Split `U4kBYe` — 02 Components > Action components; Icon `hG74G` — 05 Feedback > Toast and icon control | Primary 69 instances, Secondary 50, Icon 1. Split has no sampled instance. | Primary: label + trailing chevron. Secondary/Compact: label only. Icon: 44 × 44 with a 20 px glyph. | Primary `$xai-text` fill / `$xai-bg` text; Secondary `$xai-action-secondary`; all `$xai-radius-pill`. Product override: height 36 + padding `[8,18]` on `NQ5uh`. |
| Announcement and navigation | Announcement `kxaOn`, Badge/New `BihOq`, Navigation/Dropdown `X9WFG`, Tab/Active `K2pPvN`, Tab/Inactive `M62ErK` — 02 Components > Announcement and navigation | Library only, no product instance. | Announcement: 3 children (surface + copy + action). Tabs: 32 high. | `$xai-announcement-surface`, `$xai-border-subtle`; tabs use text tiers. |
| Fields | Text `aCdnZ`, Focus `XvnJd`, Error `laVtn`, Email `Th7kx`, Password `pkDUX`, Select `u8TIPq`, Search `E13uuD`, Textarea `cxQ99`, Disabled `FNTbc` — 04 Forms and fields + selection board; Number Default `OW6x9`, Focus `rQ2XP`, Disabled `sIitd`; Date `V1AnC`, Date range `sQhQR` | Text 22 instances, Search 10. Remaining states are specimens only. | Label + control + helper. Control 48 high, padding `[12,16]`. Search adds a leading 20 px icon; Error adds a trailing `circle-alert`. | Control `$xai-surface` fill, 1px `$xai-control-border`, `$xai-radius-news`. Focus: 2px `$xai-text`. Error: 1px `$xai-error` + error helper. |
| Selection | Checkbox Checked `FiEqd` / Unchecked `YLK2S`; Radio Selected `ZxYDh` / Unselected `yyb5K`; Switch On `v4zJV` / Off `Jx73D` — selection masters | Specimens only. | Two children each (control + label). | `$xai-text`, `$xai-action-secondary`, `$xai-border`. |
| Form composition | `x.ai / Form / Invite member` `szBpJ` — 04 Forms > Form composition and usage | Single composed example, no instance. | 6 children; composes Field masters plus buttons. | Inherits field tokens. |
| Upload | Default `eTb0S`, Dragging `YRIJl`, Error `H49FvC`, Disabled `aZzFB` — 06 Uploads | All 166 high. Specimens only. | Dropzone: icon + copy + hint. | Fill depends on state; `$xai-border-subtle` default, `$xai-error` on error. |
| File item | Queued `p6vyz`, Uploading `THon6`, Complete `YuriH`, Error `eitHm` — 06 Uploads > File item states | 4 states, specimens only. | 1–2 children; filename row plus progress or status icon. | `$xai-surface`, `$xai-success`, `$xai-error`. |
| Badges | Neutral `Y2hHn`, Success `tDZNZ`, Warning `Q6J7T`, Error `VvsQA`, Outline `Zep1S`, Count `F7qtwv` — 06 Uploads > Badge masters | Count badge 98 instances; other variants specimens only. | Pill, height 24, padding `[4,10]` (Count `[4,7]`), one label. Outline adds a 1px stroke. | Fill always `$xai-surface` (Outline `$xai-bg`); status colour lives in the label text. |
| Select popover | Searchable `xOIMP`, Grouped `oBxbU`, Multiselect `c1bsU`; options Default `a5EnOD`, Selected `TphIm`, Disabled `pfa1X` — 06 Uploads > Select dropdown popovers | Default option 10 instances, Selected 2. Multiselect has 7 children. | Popover composes search field + option list; option is 360 × 40. | Option `$xai-elevation-2-surface` (`r=4`); Selected swaps to `$xai-action-secondary` + 16 px check. |
| Action menu | File actions `IdyiJ`; items Default `L6Ppb`, Hover `p1uq6`, Disabled `NWDyg`, Destructive `vGdSS`; Separator `kPXyW` — 06 Uploads > Action menus | All specimens only. | Menu 400 wide; item 40 high with icon + label + optional trailing. | Item hover `$xai-white-04`; destructive item `$xai-error`. |
| Precision controls | Segmented control Default `xpLPT`, Focus `gDpIn`, Disabled `GLJIa`; Slider Default `AXigp`, Focus `d0ZFrP`, Disabled `Tb2R6`; Stepper Horizontal `gaOCM` — 08 Advanced controls | Specimens only. | Segmented: 3 children (outer pad + segments). Slider: track + thumb + value. Stepper: 5 children. | Segment active `$xai-action-secondary`; focus ring `$xai-text`. |
| Command palette | Default `EfSVA`, No results `WZNWX`; items Selected `Z0cBVH`, Default `K1LqTE`, With shortcut `C0uv5T`, Disabled `ZLZ1k`; Keyboard shortcut `biw0d` — 05 Feedback > Overlay specimens | Specimens only. | Palette composes search, grouped commands, keyboard-shortcut chips. | `$xai-elevation-3-surface`, `$xai-border-subtle`, item selected `$xai-action-secondary`. |
| Overlays | Confirmation Default `XUWYE`, Destructive `Xz6th`; Modal/Invite member `w8VWZ` (1 instance); Sheet/Right `KAVRy`, Sheet/Bottom `y5V2O1` — 05 Feedback > Overlay specimens | Confirmation and sheets specimens only; Modal has one instance. | Confirmation: header + body + footer actions. Sheet/Right 480 wide. | `$xai-elevation-3-surface`, `$xai-overlay` scrim, `$xai-elevation-3` shadow. |
| Feedback | Alert Info `B1DGI`, Success `GNQmL`, Warning `amUZL`, Error `EkPzp` (8 instances); Toast/Success `nHUYY` — 05 Feedback | Alert/Error is the only deeply used feedback master. | Alert: 20 px status icon + title/description block. Toast: icon + message + close Icon button. | Alert `$xai-surface` + `$xai-border-subtle`, `$xai-radius-news`. Toast `$xai-action-secondary` + `$xai-control-border`, `$xai-radius-code`. |
| Tables and pagination | Text cell `gSA8g`, Sortable header `slUTc`, Checkbox cell `wt5sD`, Actions cell `Y2CvaM`, Default `aSnkl`, Row `k711H`, Row selected `ZySfH`, Loading `PlCLv`, Empty `k1TXL`, Pagination `jeb58` — 07 Data > 01 Tables | Specimens only. | Table nests Row, which nests the cell masters; header cell carries the sort affordance. | `$xai-border-subtle` row dividers; selected row `$xai-white-04`. |
| Date picker | Calendar `kHkho`, Range `MqCk9` — 07 Data > 02 Date selection | Specimens only. | 336 wide, 8 children (header + grid). | `$xai-elevation-2-surface`; selected day `$xai-action-secondary`; today `$xai-border`. |
| Identity, navigation and selection | Avatars Initials `H80RgD`, Fallback `h2zZW`, Group `teqS1`, Image `X0HCl`; Chips Removable `TQTVC`, Filter `tzVW5`, Selected `P0yavj`, Unselected `GDayC`; Breadcrumbs `Zv2CV`; Tooltip Top `EdZAo`, Bottom `EVBwH`, Left `bKdZD`, Right `ZUSu4` — 07 Data > 03 | Specimens only. Avatar/Image has an image fill. | Avatar 40 × 40; Group 4 children; chip 2 children; breadcrumbs 5 children; tooltip 2 children. | Chip selected `$xai-surface`; tooltip `$xai-elevation-2-surface`. |
| Disclosure and async | Accordion Collapsed `MQkfn`, Expanded `JAJ8q`; Loading Spinner `arKEe`, Progress `iTyyU`, Skeleton `D6aiH2`; Empty state Default `KVSE2`, No results `cdmdE` — 07 Data > 04 | Specimens only. | Accordion 1–2 children; skeleton 3 rows; empty state 4 children (icon, title, body, action). | `$xai-border-subtle` dividers; skeleton `$xai-white-04`. |
| Chat | 33 masters — 09 AI assistant chat and 10 Chat conversation pattern | No product instance anywhere in the document. | Conversation items `LT3fQ`/`Zdg0E`/`eVsoh`; header `DIoge`; model selector `KGKhD`; messages `Mxvg8`, `r2baV4`, `VKcAj`, `YSBhp`; actions `uUcGp`; response version `j40ULW`; composer `N6Etcr`, `LPr0O`, `NCvPi`, `LDJwN`; attachments `t3QRh`, `MevG5`, `JP23E`; code block `vk4N2`; source `HVVE6`; structured response `J0ZbF`; follow-up `L0x9Kb`; status `ToOa7`, `fa6gX`, `P1MH2`, `yo23u`; empty conversation `a41UL6`; recovery `gIWsS`, `Faa7w`, `VLyKa`; response table `aSp2F`; tool selector `RKVQ8`; new conversation `ldc81`. | User bubble `$xai-surface`; assistant content on canvas; composer `$xai-surface` + `$xai-control-border`. |
| Page patterns | Header/Desktop `QsoS0`; Card/Product `lyQZ5`, Card/News `o0AAW9`; Panel/Code `caI91`, Card/Support `F1U23` — 03 Page patterns | Library only. Card/Product 402.66 × 280; Card/Support 604 × 417. | Header composes nav + brand; cards are content specimens. | Card `$xai-surface` + `$xai-border-subtle`; product card uses `$xai-radius-card`. |
| Animus masters | Task card `ENO1O` (722 instances), Chip/Stage `bS9C8` | Task card: 12-state library `pCdHu` + agent-triage variant `C8sFW`. Chip: single state. | See master anatomy below. | See master anatomy below. |

### Master anatomy

**Button / Primary `u7TcZ`** — fill `$xai-text`, text `$xai-bg`, `r=$xai-radius-pill`, height 44, padding `[12,16,12,20]`, gap 2, label `$xai-font 14/500/1.43`, trailing 20 × 20 chevron drawn as two 3.33 px paths with 1.67 px strokes in `$xai-bg`. The asymmetric padding exists because of that chevron. **The primary action is inverted white-on-dark, not orange.** Product override `NQ5uh`: height 36, padding `[8,18]`, `fit_content` width.

**Button / Secondary `OgB6C`** — fill `$xai-action-secondary`, text `$xai-text`, pill, height 44, padding `[12,20]`, label `$xai-font 14/500/1.43`. Task-card footer instance is pinned to 260 × 32 with padding `[6,12]`.

**Button / Compact `snWN7`** — fill `$xai-text`, text `$xai-bg`, pill, height 40, padding `[10,18]`.

**Button / Icon `hG74G`** — 44 × 44, `$xai-surface` fill, pill, one 20 px glyph in `$xai-text`.

**Badges** — Neutral `Y2hHn`, Success `tDZNZ`, Warning `Q6J7T`, Error `VvsQA`: pill, height 24, padding `[4,10]`, fill `$xai-surface`, label `$xai-font 11/500/1`; the status colour lives in the label (`$xai-text-secondary`, `$xai-success`, `$xai-warning`, `$xai-error`). Outline `Zep1S` keeps `$xai-bg` with a 1px `$xai-control-border` stroke. Count `F7qtwv`: padding `[4,7]`, label `$xai-text`.

**Field / Text `aCdnZ`, Focus `XvnJd`, Error `laVtn`** — vertical, gap 8. Label `$xai-font 14/500/1.5` in `$xai-text`. Control height 48, padding `[12,16]`, gap 12, fill `$xai-surface`, `r=$xai-radius-news`, 1px `$xai-control-border`; value `14/normal/1.5` in `$xai-text-secondary` when empty and `$xai-text` when filled. Helper `12/normal/1.5` in `$xai-text-secondary`. Focus: identical control with a **2 px `$xai-text`** border. Error: 1 px `$xai-error` border, trailing `circle-alert` 20 px, helper in `$xai-error`.

**Field / Search `E13uuD`** — same shell with a leading 20 px `search` glyph in `$xai-text-secondary`.

**Select option / Default `a5EnOD`** — 360 × 40, padding `[10,12]`, gap 12, `r=4`, fill `$xai-elevation-2-surface`, label `14/normal/1.5` in `$xai-text`. Selected `TphIm` swaps the fill to `$xai-action-secondary` and adds a 16 px `check` in `$xai-text`. Disabled `pfa1X` is defined but not sampled.

**Alert / Error `EkPzp`** — gap 16, padding 20, fill `$xai-surface`, 1 px `$xai-border-subtle`, `r=$xai-radius-news`; 20 px `circle-alert` in `$xai-error`; content slot gap 4 with title `14/500/1.5` in `$xai-text` and description `14/normal/1.5` in `$xai-text-secondary`.

**Toast / Success `nHUYY`** — 480 wide, gap 12, padding 16, fill `$xai-action-secondary`, 1 px `$xai-control-border`, `r=$xai-radius-code`; 20 px `circle-check` in `$xai-success`; message `14/normal/1.5` in `$xai-text`; close is the Icon button master (44 × 44, `$xai-surface`, pill, 20 px `x`).

**Animus / Task card `ENO1O`** — 288 wide, vertical, gap 10, padding 14, fill `$xai-elevation-1-surface`, 1 px `$xai-border-subtle`, `r=12`.

| Region | Contents |
| --- | --- |
| Header (gap 8) | 12 × 12 `loader-circle` execution indicator in `$xai-success` · task ID (`#145`, `Geist Mono 11/1.45`, `$xai-text-secondary`) · repository chip (padding `[4,10]`, `$xai-bg`, 1 px `$xai-control-border`, pill, `Inter 11/500`) · stage chip (padding `[4,10]`, `$xai-surface`, pill, `Inter 11/500`) · flexible space · admission marker, `PR #145`, `Lap 1/3` (each `Inter 11/1.45`, `$xai-text-secondary`) |
| Body | Title `Inter 14/500/1.45` in `$xai-text` — then state summary, state detail and event timestamp, each 260 wide at `Inter 11/1.45` in `$xai-text-secondary` |
| Action | Secondary-button instance at 260 × 32, padding `[6,12]` |
| Metrics (gap 5) | harness · duration (`Codex · 8m 42s`, `Inter 11/1.45`) · flexible space · spend (`$1.24`, `Geist Mono 11`) · trailing value (`Inter 12`) |

**Animus / Chip / Stage `bS9C8`** — height 18, padding `[4,6]`, fill `$xai-accent-bg`, pill, label `Inter 11/500/1` in `$xai-accent`. This is the only accent-orange element on a product surface.

**Task card state library `pCdHu`** — a preview board with the disclaimer node `q1kFh` and 12 states: Triage `WQkGm`, Queued `N6Vt7u`, Running / no PR `ckoUR`, Running / linked PR `nikMD`, Verification / active `Ur8oo`, Code review / active `G2oEe`, Needs human review `U1sxW`, Paused `eJC6T`, Blocked `P4CFu`, Failed `MSFbe`, Merged `i6ABvU`, Canceled / before start `h7AZ1b`; plus Agent triage running `C8sFW` (318 wide) and the idle-vs-active triage rule `j6QCib`.

**Task card / Approved state rules `q7Kjl`** — shared card anatomy `aNu1f`, a 10-column state visibility matrix (`WJ6AO` Triage, `azjJE` Queue, `AgHX6` In progress, `U59SS` Verification, `tbARi` Code review, `CcQ8l` Needs review, `YfeRv` Paused / blocked, `E7VKj` Failed, `xaf2q` Merged, `HcTCS` Canceled), data rules `IuWNC`, decisions to confirm `O2Fnh`, and semantic colour rules `mALRT` (human attention, execution failure, completed outcome, routine state).

**Issue detail lifecycle `dRgxq`** — 4 content states: Ready / queued detail `d4fmMd`, Implementing `bzMak`, Merged by human `y6wIy`, Failed / stopped `LzsOM`.

### Defined but unverified

These definitions have no sampled instance in any product frame — they establish library breadth, not product usage: the whole Chat family (33), page-pattern cards (`QsoS0`, `lyQZ5`, `o0AAW9`, `caI91`, `F1U23`), date picker (`kHkho`, `MqCk9`), upload and file-item masters, action menu, command palette, segmented control, slider, stepper, split button, announcement, tooltip, breadcrumbs, accordion, skeleton, form composition, and the tab masters.

---

## Product patterns

### Surfaces

| Surface | Frames |
| --- | --- |
| Jobs | Kanban `D4cB0` (21 instances), List `V0Vaq` (3), New job modal `fsOs5` (20) |
| Task card | master `ENO1O`, state library `pCdHu` (13), approved state rules `q7Kjl`, running/paused comparison `ejthn` (3) |
| Issue detail | Compact / Triage `JLixj` (19), Expanded / Verification live `iceQ7` (3), Expanded / Agent merged `vDp5q` (3), lifecycle content states `dRgxq` |
| Repositories | 31 numbered screens `li3jI`, `fcyiG`, `p5qFpU`, `Xlk78`, `R7ukb`, `IRZH8`, `O4yO8P`, `vPFIP`, `jvdqB`, `jC0gG`, `MTDAB`, `b2D1j5`, `p9key`, `CL3Py`, `olhPh`, `o6nDQ`, `bxi1e`, `Gu4cX`, `Q2O6u`, `EpKk7`, `H9dEKY`, `j0uhL`, `Zhoj3`, `f8ASA`, `W3XVb`, `Mig0b`, `MZAAQ`, `pHQRY`, `O9RMf`, `p8MA7p`, `ezZq4` (21–25 instances each) + flow/behaviour index `ePEjy` |
| Settings | Platform: Providers `KanXI`, Automation `arGsb`, GitHub `q5VB5X`, System `vybWU`. Project: Models `NhnTK`, Checks `bZZo1`, Memory `M0mkek`, Releases `pCp5f`. Personal: Preferences `R5yIDY`. States: Unsaved scope change `Q3iKv`, Stop platform launches `qrhYK`. Indices: `IHY5E`, `F99iQR`. (19 instances each) |
| Inbox | Needs attention `Ht4rv` (3) |

### App shell

The product shell is a 64 px icon rail plus a content pane.

Implemented on the shadcn `sidebar-07` block: the rail lives in `apps/web/src/components/app-sidebar.tsx` with `NavMain` rows from `nav-main.tsx`, and `apps/web/src/App.tsx` holds the inset, the 76 px surface header, and the surface switch. The rail is 64 px collapsed (`--sidebar-width-icon: 4rem`) and 15 rem expanded. The app logo is served from `apps/web/public/brand/animus-emblem.webp`.

**Jobs / Kanban `TAufE`** is implemented in `apps/web/src/features/jobs/` — `jobs-screen`, `jobs-header` (`CPB4j`), `jobs-board` (`QaoKo`), `kanban-lane`, `task-card` (`ENO1O` plus every instance override), and `kpi-card`. Board content is transcribed canvas data in `jobs-model.ts`, which is the single seam to replace when a jobs API lands. The 28 px content inset lives inside the lane scroller (padding on the scrolling row, so the first and last lanes carry it), which keeps columns from being clipped against the viewport edges; the KPI row, toolbar, and status footer keep their own 28 px inset.

**Inbox `Ht4rv`** lives in `apps/web/src/features/inbox/inbox-screen.tsx`: the 76 px header (shared with Jobs, minus the view toggle and the bell — both `DISABLED` in the source), the 24/500 "Needs your attention" overview, the `Needs attention · Updates · Archived` tab strip with its 2 px underline, the 204 × 32 search pill, the type filters (`All · Clarification · Review · Failed`), the 620 px attention queue, and the issue pane on `$xai-elevation-stage` at `r=10`. The queue is derived from the `attention` blocks on `JOBS_BOARD`, so board and inbox cannot drift apart. Reading never resolves a job: selection only changes the pane. Up/Down move selection, Enter focuses the pane, Escape dismisses it, ⌘K focuses search.

**Settings `R5yIDY`** is a modal, not a destination: `apps/web/src/features/settings/settings-modal.tsx` renders the 1120 × 920 sheet (`#0E0E10`, `r=12`, elevation-3 shadow) over an inert shell, with the 240 px `#111214` scope rail (Personal selected; Platform and Project are designed but not implemented here, so they render disabled), the 92 px content header, the Appearance / Navigation / Notifications sections, and the 64 px action bar. Values persist per browser through `apps/web/src/lib/preferences.ts`; startup view and card density are applied, while the notification toggles control the rail badge and whether failed jobs enter the inbox. Escape, Cancel, and the backdrop guard unsaved edits; focus is trapped and restored to the Settings row.

**Sidebar `baXIP` (collapsed)** — 64 wide, padding `[20,10,16,10]`, 1 px `$xai-border-subtle`. Brand row (`rYu9J`, 36 high): `animus` at `Inter 24/600` in `$xai-text` beside a 28 × 28 logo at `r=7`. Nav items 44 high at `r=8`: active fill `$xai-surface` with `$xai-text` at `Inter 14/500`; inactive `$xai-text-secondary` at `Inter 14/normal`; icons 18 × 18; each row ends with a `<Badge / Count>` instance 22 high. Bottom nav holds Settings.

**Sidebar `EeR9s` (expanded, from `TAufE`)** — 240 wide, padding `[20,12,16,12]`, 20 gap between blocks. Brand row 36 high, padding `[0,8]`, gap 10: logo 28 × 28 at `r=7`, `animus` at `Inter 22/600` with −0.7 tracking, flexible space, and the `panel-left-close` collapse control (18 px) at the row's end. Nav rows pad `[0,12]` with a 12 gap; the group gap is 8.

**Jobs header `PxEJz`** — 76 high, padding `[0,28]`, 1 px `$xai-border-subtle`.

| Element | Spec |
| --- | --- |
| Title | `Jobs`, `Inter 20/500`, `$xai-text` |
| Repository selector `Kw1Ri` | pill, padding `[9,12]`, 1 px `$xai-border`, `github` 16 + label `Inter 12/normal` + `chevron-down` 14 |
| View mode `RWEdX` | padding 4, `$xai-surface`, 1 px `$xai-border-subtle`, `r=10`; segments padding `[7,11]`, `r=6`, active `$xai-action-secondary`. **Implemented at height 36 with padding 3 and `r=7` segments** so it matches the state toggle and New job — a deliberate 5 px deviation from the canvas, where this control alone is 41 |
| State toggle `o6uhC2` | height 36, padding 3, `$xai-surface`, 1 px `$xai-border`, `r=10`; segments height 30, padding `[5,8]`, `r=7` |
| Notifications `nbbjH` | 18 px `bell`, padding `[8,4]` |
| New job `NQ5uh` | `<Button / Primary>`, height 36, padding `[8,18]` |

### Settings handoff notes

Authored implementation notes from `Animus / Settings / Design handoff` (`F99iQR`), reproduced verbatim by node.

`HFabD` — **Navigation:** "Personal / Preferences. Platform / Providers, Automation, GitHub, System. Project / Models, Checks, Memory, Releases. Only Project displays a project picker. Providers and Automation have no project overrides."

`aUhhN` — **Layout:** "1120 × 920 desktop modal with a 240px scope rail and 880px content pane. Shared 32px content inset; 32px between sections. Project picker is 44px high; scope buttons 40px; section rows 38px. Close has a 36px button target."

`k2IgoU` — **Narrow screens:** "Implementation: switch to a full-screen dialog when both panes no longer fit. Replace the rail with a section selector; stack controls below labels. Keep actions in stable chrome. This state has not been drawn or runtime-tested."

`Gw9fV` — **Project configuration:** "Project-owned: model tiers, role routing, verification commands and protected paths, memory and lessons, release policy. Earlier per-project provider and schedule storage mappings are superseded by the platform-only ownership decision and require implementation contract migration."

`RyAd5` — **Memory:** "Lessons: .factory/lessons.jsonl. Rules: .factory/codebase-rules.json. Safe mode: .factory/NO_HARNESS_MEMORY. Keep vetoed lessons visible with an explicit status."

`yXcuw` — **Device / platform configuration:** "Platform-owned: default and installed providers, offline evaluation, shared capacity and per-issue limits, polling, work window, launch controls, GitHub connection, security, backup, reconciliation and diagnostics. No project picker or project-level override."

`p8vFzR` — **Editing:** "Use independent drafts keyed by scope and project identity. Save only the current target. Guard scope, section, project changes and close while dirty. Never allow an “All projects” configuration form. No inherited defaults are shown without a supported contract."

`HLfU8` — **Immediate actions:** "Save persists shared provider or automation policy for the installation. The all-project launch brake is a separate immediate command requiring confirmation; running jobs continue. Audits, backup, reconciliation and lesson veto are separate commands."

`Q5oMS` — **Accessibility:** "Native scope buttons and project select; announce selected scope and project. Dialog focus trap and background inert. Close/Escape restore trigger focus after dirty guard. Confirmation initially focuses Cancel; errors preserve draft and focus. Keyboard and screen-reader behavior require implementation testing."

`TSqlp` — **Existing routes in the supplied spec:** "Brakes: /api/v1/brakes and /api/v1/projects/:id/brakes. Memory: /api/v1/harness/lessons and /api/v1/harness/veto. Promotion: /api/v1/promotion/status and /prepare. GitHub: /api/v1/webhooks/github. System: /api/v1/commands/backup, /reconcile and /api/v1/diagnostics."

`z2UK1` — **Missing contracts:** "Project config and schedule read/write; harness detection, audit and config; rules and safe-mode endpoints. Confirm contracts against the repository before implementation; the canvas does not prove route availability."

`A5tt1` — **Remaining design states:** "Drawn: one Personal panel, four Project panels, four Platform panels, unsaved-scope confirmation and all-project stop confirmation. Providers and Automation exist only under Platform. Runtime behavior, responsive layouts and backend ownership migration remain unimplemented."

### Asset references

| Asset | Role |
| --- | --- |
| `images/Orange and White Yin-Yang Emblem.webp` (1287 × 1222) | Animus app logo — used at 28 × 28, `r=7`, in the shell brand row |
| `../356ecfbb-7103-4af4-952d-e552d2b9d278/images/x.ai/2ddf6854654796ba.jpg` | Avatar/Image master fill (resolves into a sibling Pencil document) |
| `../356ecfbb-7103-4af4-952d-e552d2b9d278/images/x.ai/853873f17dd000a9.webp` | Secondary `img` fill, same sibling document |
| `images/Screenshot 2026-11-06 at 01.13.34.png` | Reference backdrop (`V4j1A`) |
| `images/Screenshot 2026-11-06 at 01.13.49.png` | Reference backdrop (`PAJKT`) |
| `images/Screenshot 2026-11-06 at 01.14.28.png` | Reference backdrop (`uXG7m`) |
| `images/Screenshot 2026-11-06 at 01.16.36.png` | Reference backdrop (`s4EtWP`) |
| `images/Screenshot 2026-11-06 at 20.00.43.png` | Reference backdrop (`DYmMO`) — a dark settings dialog with a left scope rail and right content pane, the same geometry the Settings handoff note specifies |

Reference backdrops are app-UI screenshots used as image fills. They are not product frames and carry no tokens. Four further files in the same directory are unreferenced orphans and must not be mistaken for sources: `image.webp`, `Screenshot 2026-11-02 at 09.54.21.png`, `Screenshot 2026-11-06 at 20.00.11.png`, `Screenshot 2026-11-01 at 23.15.50.png`.

---

## Implementation map into `apps/web`

Destination facts: `apps/web/components.json` declares `style: "base-nova"`, Tailwind v4 CSS-only with `css: "src/style.css"`, `utils: "@/lib/utils"`. Primitives live in `apps/web/src/components/ui/` (`button`, `input`, `badge`, `table`). The theme entrypoint is `apps/web/src/style.css`. Consumers today: `apps/web/src/features/projects/project-list.tsx`, `apps/web/src/features/projects/project-detail.tsx`, `apps/web/src/features/operations/operations-view.tsx`.

### Token parity

**Applied.** `apps/web/src/style.css` now declares this table as a single `:root, .dark` block and maps it through `@theme inline`; the duplicate shadcn default blocks are gone. The built stylesheet resolves `--primary: #fff`, `--border: #1f2228`, `--input: #777`, `--ring: #fff`, `--radius: .5rem`, `--accent: #ff6308`, `--success: #91c17a`, `--warning: #ffab70`, `--error: #ff8a8a`, and exactly one `.dark` block.

Status is `direct` (same role and value), `derived` (projected from an adjacent role), or `new` (no property today).

| Pencil token | `apps/web` property | Value | Status |
| --- | --- | --- | --- |
| `$xai-bg` | `--background` | `#0a0a0a` | direct |
| `$xai-text` | `--foreground` | `#ffffff` | direct (today `#ededed`) |
| `$xai-elevation-1-surface` | `--card` | `#1a1a1a` | direct |
| `$xai-text` | `--card-foreground` | `#ffffff` | direct |
| `$xai-elevation-2-surface` | `--popover` | `#202020` | derived (popover = elevation-2) |
| `$xai-text` | `--popover-foreground` | `#ffffff` | direct |
| `$xai-text` | `--primary` | `#ffffff` | direct — Button/Primary fill |
| `$xai-bg` | `--primary-foreground` | `#0a0a0a` | direct |
| `$xai-action-secondary` | `--secondary` | `#202020` | direct |
| `$xai-text` | `--secondary-foreground` | `#ffffff` | direct |
| `$xai-surface` | `--muted` | `#1a1a1a` | direct |
| `$xai-text-secondary` | `--muted-foreground` | `#a3a3a3` | direct (today `#a1a1aa`) |
| `$xai-accent` | `--accent` | `#ff6308` | direct |
| `$xai-bg` | `--accent-foreground` | `#0a0a0a` | direct |
| `$xai-error` | `--destructive` | `#ff8a8a` | direct (today `#dc2626`) |
| `$xai-bg` | `--destructive-foreground` | `#0a0a0a` | direct |
| `$xai-border` | `--border` | `#1f2228` | direct |
| `$xai-control-border` | `--input` | `#777777` | direct (today `#1f2228`) |
| `$xai-text` | `--ring` | `#ffffff` | direct — focus is a 2px foreground border |
| `$xai-radius-news` | `--radius` | `.5rem` | direct |
| `$xai-surface` | `--container` | `#1a1a1a` | direct (name already used by feature code) |
| `$xai-border-subtle` | `--border-subtle` | `#ffffff14` | new |
| `$xai-text-secondary` | `--text-secondary` | `#a3a3a3` | new |
| `$xai-text-muted` | `--text-muted` | `#7d8187` | new |
| `$xai-accent-bg` | `--accent-bg` | `#ff63081a` | new |
| `$xai-success` | `--success` | `#91c17a` | derived (today `#16a34a`) |
| `$xai-success-bg` | `--success-bg` | `#91c17a1f` | new |
| `$xai-warning` | `--warning` | `#ffab70` | derived (today `#d97706`) |
| `$xai-warning-bg` | `--warning-bg` | `#ffab701f` | new |
| `$xai-error` | `--error` | `#ff8a8a` | new |
| `$xai-error-bg` | `--error-bg` | `#ff8a8a1f` | new |
| `$xai-info` | `--info` | `#9ecbff` | new |
| `$xai-info-bg` | `--info-bg` | `#9ecbff1f` | new |
| `$xai-elevation-stage` | `--elevation-stage` | `#111111` | new |
| `$xai-overlay` | `--overlay` | `#111111` | new |

Decisions applied with this table:

- `--muted-bg` had no design source and no consumer; it is dropped.
- Sidebar group is `derived` — the document names no sidebar tokens. Applied as `--sidebar: #0a0a0a`, `--sidebar-foreground: #ffffff`, `--sidebar-primary: #1a1a1a`, `--sidebar-primary-foreground: #ffffff`, `--sidebar-accent: #1a1a1a`, `--sidebar-accent-foreground: #ffffff`, `--sidebar-border: #1f2228`, `--sidebar-ring: #ffffff`. The rail frame `baXIP` has no fill of its own and inherits the canvas; its active row is `$xai-surface` (`#1a1a1a`) with `$xai-text`, never accent.
- Charts: `--chart-1..5` and their `@theme` mappings are removed. The document defines no chart palette, nothing consumes them, and `shadcn/tailwind.css` carries no reference.
- Fonts: applied as `--font-sans: "Inter Variable"` and `--font-mono: "Geist Mono Variable"`. `@fontsource-variable/geist-mono@^5.3.0` is installed and the build emits 13 woff2 files. `@fontsource-variable/noto-sans` is removed (no node in the document), along with the unused `--font-heading`.
- Radii: the derived ramp is kept (`lg = radius × 1.25` = 10 px, `sm` = 6 px), which matches the observed 6/8/10 cluster, and the authored tokens are exposed as utilities: `--radius-news` 8, `--radius-code` 12, `--radius-card` 16, `--radius-pill` 9999.

### Component map

Implemented in the local shadcn primitives under `apps/web/src/components/ui/`. The table below records the original mapping intent; the applied state is summarized after it.

| Pencil master | Destination | Mechanism | Change scope | Reason |
| --- | --- | --- | --- | --- |
| Button/Primary `u7TcZ` (+ `NQ5uh` h36, `snWN7` h40) | `src/components/ui/button.tsx`, `buttonVariants` variant `default` | Restyle the `cva` classes; keep `@base-ui/react/button` and the Props API | Pill radius, heights 44/40/36, inverted fill | The design's only primary action |
| Button/Secondary `OgB6C` | `buttonVariants` variant `secondary` | Restyle | Fill `$xai-action-secondary`, pill, h44 | Matches existing variant slot |
| Button/Icon `hG74G` | `buttonVariants` size `icon` | Restyle | 44 × 44, pill, surface fill | Existing size slot |
| Badges `Y2hHn`/`tDZNZ`/`Q6J7T`/`VvsQA`/`Zep1S`/`F7qtwv` | `src/components/ui/badge.tsx`, `badgeVariants` | Replace the ad-hoc `emerald`/`amber`/`zinc` variants with token colours; pill, h24, padding `[4,10]` | Existing callers use `active`, `held`, `tombstone`, `accent`, `success`, `warning`, `destructive` | Status colour belongs in the label, fill stays `$xai-surface` |
| Field `aCdnZ`/`XvnJd`/`laVtn`/`E13uuD` | `src/components/ui/input.tsx` | Restyle: h48, padding `[12,16]`, surface fill, `control-border`, `radius-news`, 2 px focus border, error border | No field wrapper exists — label/helper composition is a new pattern, not added here | Existing primitive |
| Select option `a5EnOD`, `TphIm`, `pfa1X` | No file yet (needs `@base-ui/react/select`) | — | Gap | No primitive installed |
| Alert `B1DGI`…`EkPzp` | No file yet | Composition of badge/alert tokens | Gap | No primitive installed |
| Task card `ENO1O` | No equivalent | — | New component | `apps/web` has no card primitive |
| Chip/Stage `bS9C8` | `badgeVariants` variant `accent` | Closest existing hook; the 18 px pill shape differs | Verify against `accent` caller | Existing hook |

### Applied shadcn alignment

- Action buttons are pill: `sm` 32, `default` 36, `md` 40, `lg` 44, icon 44/36/32.
- Navigation rows are 8 px in the sidebar and Settings scope rail; segmented controls use a 10 px container with 6 px segments and an `action-secondary` active segment.
- Badges and chips are pill. Badges are 24 px high with 11 px labels; chips are 32 px high with 13 px labels.
- Fields use the 48 px surface shell, 8 px radius, `control-border`, and an inset 2 px focus outline. Textareas start at 128 px.
- Dialogs and confirmation dialogs use the 16 px `surface` overlay with 32 px padding; right sheets are 480 px; bottom sheets use a 16 px top radius.
- Tables use an 8 px frame with a surface header and `white-04` row states. Calendar is 336 px at 12 px radius. Avatars default to 40 px. Empty states use 12 px radius and 32 px padding.
- Chat surfaces: user messages use `surface` at 16 px radius, composer uses `surface`/border at 16 px, code blocks use 12 px radius.
- Stepper and file-upload wrappers are not added because no consumer exists; their primitives remain tokenized. Stock-only primitives inherit the same tokens.

---

## Unresolved and unverified

- `xai-font = "xVf"` — no family resolvable from the file. Product surfaces are Inter + Geist Mono, which is what the repository should implement.
- Light theme is recorded but no light-mode frame was reviewed; every light value is structured-only.
- No rendered capture of any frame exists in this extraction; all values are structured evidence.
- The 6/7/10 px radii and 5/6/7/10/14 px gaps are heavily used but untokenised.
- `JetBrains Mono` (90 text nodes) has no token and conflicts with `Geist Mono`.
- Literal fill clusters `#24262B` (27) and `#111214` (13) have no token role.
- The Chat family (33 masters), page-pattern cards, date picker, upload, action menu, command palette, stepper, slider, segmented control, split button, announcement, tooltip, breadcrumbs, accordion, skeleton and form composition have no sampled product instance.
- The five reference backdrops are not product frames; four additional image files are orphans.
