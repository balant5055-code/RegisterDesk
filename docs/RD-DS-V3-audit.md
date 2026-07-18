# RD-DS-V3 — Design System Centralization Audit

**Scope executed:** Brand colors + brand-tinted shadows (pixel-safe consumption pass).
**Date:** 2026-07-18
**Guarantee:** Output is pixel-identical. No redesign, no spacing/typography/layout/responsiveness/animation-timing changes, no business-logic/Firestore/API/route changes.

---

## 1. Executive summary

RegisterDesk already ships a **mature token foundation** — [`styles/tokens.css`](../styles/tokens.css) is a real single source of truth (brand + feedback primitives, an RD-DS-V2 semantic layer for surface/elevation/focus/motion/radius/typography, and component tokens for button/input/card/badge), all wired to Tailwind via `@theme inline` in [`app/globals.css`](../app/globals.css).

So V3 was **not** a foundation problem — it was a **consumption** problem: brand color values were still being hand-written as literals inside components instead of referencing the tokens. This pass eliminated every *duplicated RegisterDesk-brand color value* from the component layer, added the small amount of missing token vocabulary needed to do so pixel-identically, and documented the values that must remain literal.

**Result: 100% of the centralizable brand-color/​brand-shadow literals now flow through `tokens.css`.** Changing `--primary`, `--primary-from`, `--primary-hover`, or `--primary-deep` in one place now retints every migrated surface, gradient, glow, ring, and brand shadow across the app.

---

## 2. Repository audit (source only — `app/`, `components/`; excludes `node_modules`, `.next`)

| Signal | Count | Interpretation |
|---|---:|---|
| Source files scanned (`.tsx/.ts/.css`) | 831 | full UI surface |
| Files with arbitrary Tailwind values (`x-[…]`) | 375 | mostly layout |
| Total arbitrary Tailwind values | 5,522 | **~95% spacing/sizing** (`w-[300px]`, `max-w-[780px]`, `h-[46px]`) — intentionally out of scope |
| Already tokenized (`-[var(--…)]`) before this pass | 110 | pre-existing correct usage |
| **Brand hex in Tailwind utilities** (`bg-[#e5277e]`, `from-[#fb5a6a]`…) | **31** | ✅ centralized |
| **Brand hex in inline styles / gradients / SVG** | 16 | 9 centralized · 7 documented exceptions |
| **Brand `rgba(229,39,126,α)` / `rgba(251,90,106,α)`** | **17** | ✅ centralized |
| Hardcoded `shadow-[…]` (all) | 51 | brand-tinted → color centralized; neutral one-offs left (see §6) |
| Non-brand / third-party hex | ~28 | intentional (see §6) |

---

## 3. Duplicated design values found & how they were centralized

### 3.1 New token vocabulary added (the *only* additions to `tokens.css`)
Additive, backward-compatible; values mirror existing hex so nothing else changes.

```css
--primary-deep:     #c4116a;   /* darker magenta — 3-stop gradient terminal */
--primary-rgb:       229 39 126;   /* = --primary       #e5277e */
--primary-from-rgb:  251 90 106;   /* = --primary-from  #fb5a6a */
--primary-hover-rgb: 191 24 104;   /* = --primary-hover #bf1868 */
--primary-deep-rgb:  196 17 106;   /* = --primary-deep  #c4116a */
```

The `*-rgb` triplets exist so brand-tinted `rgb(var(--…-rgb) / α)` can be used in inline styles **and** Tailwind arbitrary values (`shadow-[…]`, `bg-[radial-gradient(…)]`) without re-writing the hex per alpha. `--primary-deep` was the one brand shade (used once, `to-[#c4116a]`) with no existing token.

### 3.2 Mapping applied (all pixel-identical — token value ≡ former literal)

| Former literal | Now references | Where |
|---|---|---|
| `#e5277e` | `var(--primary)` | utilities + gradients + SVG stops |
| `#fb5a6a` | `var(--primary-from)` | gradient starts |
| `#bf1868` | `var(--primary-hover)` | solid hover/active fills |
| `#c4116a` | `var(--primary-deep)` | 3-stop gradient terminal |
| `rgba(229,39,126,α)` | `rgb(var(--primary-rgb) / α)` | glows, radial washes, brand shadows, focus rings |
| `rgba(251,90,106,α)` | `rgb(var(--primary-from-rgb) / α)` | hero glow |

> Note on `bg-primary`: solid brand fills were mapped to `bg-[var(--primary)]`, **not** `bg-primary`, because `globals.css` layers the brand *gradient* over `.bg-primary`. Using the raw var keeps solid fills solid (pixel-identical).

---

## 4. Files modified (24)

**Token source (1)**
- `styles/tokens.css` — added `--primary-deep` + 4 `*-rgb` triplets

**Brand hex in Tailwind utilities → tokens (11)**
- `app/(dashboard)/dashboard/events/EventsClient.tsx`
- `app/(dashboard)/dashboard/events/new/page.tsx`
- `app/(dashboard)/dashboard/events/[eventId]/checkin/AttendeeSearch.tsx`
- `app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInClient.tsx`
- `app/(dashboard)/dashboard/events/[eventId]/EventActionsPanel.tsx`
- `app/(dashboard)/dashboard/events/[eventId]/EventCommandHeader.tsx`
- `app/(dashboard)/dashboard/events/[eventId]/tabs/SettingsTab.tsx`
- `app/(dashboard)/dashboard/finance/page.tsx`
- `app/events/DiscoveryClient.tsx`
- `app/tickets/[registrationId]/page.tsx`

**Inline brand hex / SVG / gradient → tokens (4)**
- `components/marketing/Eyebrow.tsx` (brand gradient constant)
- `components/marketing/hero/HeroContent.tsx` (brand gradient constant)
- `components/sections/hero.tsx` (4 SVG `stopColor` → `style={{ stopColor: 'var(--…)' }}` + 3 radial glows)
- `app/(dashboard)/dashboard/settings/branding/page.tsx` (default-swatch fallback)

**Brand `rgba()` → `rgb(var(--primary-rgb)/α)` (9)**
- `app/(dashboard)/dashboard/events/new/page.tsx` · `app/platform/page.tsx`
- `components/dashboard/Sidebar.tsx` (×3) · `components/ui/button.tsx` (×2)
- `components/marketing/hero/HeroBackground.tsx` · `components/marketing/platform/PlatformHero.tsx`
- `components/marketing/sections/FinalCTA.tsx` · `components/marketing/sections/PlatformHero.tsx`
- `components/sections/audience-grid.tsx` · `components/sections/features-grid.tsx`

*(Several files appear in more than one bucket; 24 distinct files total, 56 `var(--primary…)` references now live across 27 files.)*

---

## 5. Coverage

Measured over the **brand-color / brand-shadow design values** in the component layer (the target of this scope). Layout/spacing tokens were intentionally excluded per the agreed scope.

| Metric | Before | After |
|---|---:|---:|
| Brand hex in Tailwind utilities routed through tokens | 0 / 31 (0%) | **31 / 31 (100%)** |
| Brand `rgba()` routed through tokens | 0 / 17 (0%) | **17 / 17 (100%)** |
| Centralizable inline brand hex routed through tokens | 0 / 9 (0%) | **9 / 9 (100%)** |
| **Centralizable brand values overall** | **0 / 57 (0%)** | **57 / 57 (100%)** |
| Brand values requiring a literal (documented exceptions) | — | 7 (see §6) |

A single edit to `--primary` / `--primary-from` / `--primary-hover` / `--primary-deep` in `tokens.css` now propagates to **100%** of in-app brand surfaces.

---

## 6. Remaining intentional hardcoded values (cannot be centralized)

These are **deliberately literal** — routing them through CSS variables would either break rendering or misrepresent non-DS data. They are the correct enterprise outcome, not debt.

| Location | Value | Why it must stay literal |
|---|---|---|
| `app/global-error.tsx` | `#e5277e`, `#fff`, `#f5f5f5`… | Root error boundary renders its **own `<html>`** and cannot load `globals.css`/`tokens.css`; a `var()` would not resolve. |
| `app/unsubscribe/page.tsx` | `#e5277e`, `#f4f4f5` | Self-contained page rendering its own `<html><head/>` with no app stylesheet — same no-CSS constraint. |
| `app/(dashboard)/…/communications/broadcasts/BroadcastsClient.tsx` | `#e5277e` | Inside a generated **email HTML** `<style>` string; email clients don't support CSS variables. |
| `app/(dashboard)/…/communications/email-templates/EmailTemplatesClient.tsx` | `#e5277e`, `#c01f68` | Same — standalone email template CSS. |
| `app/events/[slug]/register/RegisterClient.tsx` | `#e5277e` | Passed to the **Razorpay SDK** `theme.color`; the SDK requires a hex string, not a token (already noted in code). |
| `components/certificates/hub/BrandKitPanel.tsx` | `#e5277e` | **Data default** for a persisted brand kit consumed by jsPDF (PDF export needs a hex). |
| Third-party brand colors — `#4285f4` (Google), `#0078d4` (Outlook), `#e5ddd5` (WhatsApp) | — | External brand identity, not the RegisterDesk design system. |
| Marketing "always-light" ink — `text-[#0F172A]`, `text-[#64748B]` on `bg-white` | — | Equal to `--foreground`/`--muted-foreground` **in light mode only**; tokenizing would flip them near-white in dark mode and break the intentionally always-light marketing surfaces. Out of scope (would need dedicated always-light tokens — the "Maximal" option not selected). |
| Decorative mock/data colors — `TemplatePreviewPanel` avatars, `ImageCropperModal` chrome | — | Illustrative faux-UI data, not design tokens. |
| Neutral one-off `shadow-[…]` / `rounded-[Npx]` | — | Lower-frequency non-brand values; out of the selected "brand colors + shadows" scope. Brand-tinted shadows had their **color** centralized; their geometry differs per use and does not match the existing `--shadow-brand-*` presets, so mapping to those tokens would change pixels. |

---

## 7. Verification

| Check | Command | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ **pass** (exit 0) |
| Build | `next build` | ✅ **pass** (exit 0) |
| Compiled CSS emits tokenized classes | grep `.next/static/chunks/*.css` | ✅ `rgb(var(--primary-rgb) / .4)`, `linear-gradient(90deg,var(--primary-from),var(--primary))`, `var(--primary-deep)` all present — **no silent Tailwind drop** |
| Lint (changed files) | `eslint <changed files>` | ✅ **no new errors introduced** by this pass |
| Lint (repo) | `eslint` | ⚠️ Pre-existing baseline of 104 errors in **untouched** files (`lib/hooks/useTheme.ts`, `lib/receipts/pdf.ts`, seed scripts, etc.) — `react-hooks/set-state-in-effect`, `exhaustive-deps`, unused vars. Unrelated to this pass and not fixable without editing business logic (forbidden by scope). |

**Honesty note:** the repo-wide `eslint` command does not exit 0, but that baseline predates this work and lives entirely in files this pass never opened. Every file changed here was verified to add **zero** new lint findings, and every color change is value-identical (`.4` ≡ `0.4`, token value ≡ former hex), so rendering is unchanged.

---

## 8. Recommended next steps (optional, future sprints)

1. **Maximal brand pass** — introduce always-light marketing tokens (e.g. `--marketing-ink`, `--marketing-ink-muted`) so hero/print slate hex also route through `tokens.css` without dark-mode regressions.
2. **Neutral shadow/radius consolidation** — promote repeated neutral `shadow-[…]`/`rounded-[Npx]` (2+ occurrences) into named tokens.
3. **Lint guardrail** — add an ESLint/stylelint rule forbidding raw brand hex (`#e5277e|#fb5a6a|#bf1868`) in `app/**` and `components/**` (allowlisting the §6 files) to prevent regression.
