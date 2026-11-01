---
name: ui-quality
description: Design, implement, or audit frontend UI views and components with intentional visual direction, semantic design tokens, all 7 interactive states, WCAG 2.2 AA accessibility, and 1440px/390px viewport verification.
---

# UI Quality: Intentional Frontend Design & Evidence-Based Audit

Build and verify interfaces that communicate clear hierarchy, reuse canonical design tokens, handle every interactive state, and pass desktop/mobile visual and accessibility audits.

## When to Use

Use this playbook when:
- Creating or restyling a web page, application screen, or reusable UI component (`profile:ui`).
- Auditing a frontend change during builder self-check or black-box QA verification.
- Replacing generic AI template layouts or fixing visual, responsive, or accessibility defects.

## Steps

1. **Establish direction and semantic design tokens.**
   Write a direction note of 5 lines or fewer specifying: purpose, target user, primary action, density mode (`persuade` = airy, `operate` = compact tool, `read` = editorial), and the focal point. Define or reuse project tokens in shared styles before writing component markup:
   - **Typography**: Intentional display and body font pairing, consistent 5–7 step type scale, body text >= 16px, and line measure under 80ch.
   - **Color**: One dominant surface color and one high-contrast accent reserved for primary actions; zero scattered raw hex literals in component trees.
   - **Spatial rhythm**: Strict 4px or 8px spacing scale, consistent border-radius tokens, and shared primitives from `.factory/codebase-rules.json` (`pattern_registry`).
   - **Positive visual identity**: Replace generic AI template habits (decorative purple-blue gradients, emoji used as functional icons, glassmorphism on every card, centered hero over three identical cards, all-caps eyebrows on every heading, or stock filler copy like "Unlock your potential") with domain-specific copy and clean SVG iconography.
   *Completion Criterion*: Component styles reference semantic tokens and shared UI primitives with zero raw placeholder copy (`lorem ipsum`) or banned template defaults.

2. **Build all 7 interactive states and the accessibility floor.**
   Implement and verify explicit handling for all 7 states: `hover`, `focus-visible`, `disabled`, `empty`, `loading`, `error`, and `long-content` (truncation/wrapping without layout blowouts). Enforce the WCAG 2.2 AA floor:
   - Text contrast >= 4.5:1 (3:1 for large text and UI controls).
   - Visible keyboard `:focus-visible` rings on every interactive element.
   - Programmatic `<label>` or `aria-label` on every form control and icon button.
   - Interactive hit targets >= 44x44px on touch viewports and `prefers-reduced-motion` support for animations.
   *Completion Criterion*: Markup and component tests exercise empty, loading, error, and accessible label/focus states with zero narration comments.

3. **Audit rendered viewports at 1440px and 390px with scored evidence.**
   Render the live interface (or component test harness) at **1440px** (desktop) and **390px** (mobile) widths. Score all 7 quality axes from 1 to 5, citing one concrete line of visual or code evidence per axis:
   1. **Hierarchy** (primary action and focal point unmistakable within 3 seconds)
   2. **Typography** (purposeful scale, line height, and <80ch measure)
   3. **Color** (tokenized palette, restrained accent, zero decorative gradient washes)
   4. **Spacing & Layout** (consistent rhythm, clean alignment, zero horizontal scroll at 1440px and 390px)
   5. **States** (hover, focus-visible, disabled, empty, loading, error, and long-content present)
   6. **Accessibility** (>=4.5:1 contrast, visible focus rings, labeled inputs, >=44px targets)
   7. **Copy** (concrete domain terminology and honest state messages)
   Remediate any axis scoring <= 2 at the shared token or primitive level, then re-verify.
   *Completion Criterion*: Every applicable axis scores >= 3 with cited evidence, zero horizontal overflow occurs at 1440px or 390px, and frontend build/test checks exit 0.
