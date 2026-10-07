# RD-THEME-01 — Global theme audit and foundation centralization

Date: 2026-09-04
Scope: repository-wide audit; implementation bounded to the **global/shared visual layer**.
Predecessors: `RD-DS-V3-audit.md`, `RD-DS-V3.1-audit.md`, `RD-DS-V3.2-audit.md`.

---

## 1. What the audit actually found

The brief assumed RegisterDesk had no coherent theme. It has one, and it is unusually
thorough — 1,022 lines in `styles/tokens.css`, wired to Tailwind v4 through `@theme inline`
in `app/globals.css`, with a `.dark` override block, semantic accent pairs, gradient tokens,
a font-size scale, radius tiers and component-dimension tokens.

**The problem is not absence. It is (a) non-adoption and (b) three generations of tokens
stacked on top of each other, the newest of which is barely used.**

Adoption of the RD-DS-V2/V3 semantic layer, counted across `app/ components/ lib/`:

| token family | consumers |
|---|---|
| `rounded-control` / `rounded-surface` (RD-ORG-FOUNDATION) | 44 / 37 |
| `bg-surface-3` | 2 |
| `shadow-elevation-1` | 1 |
| `bg-surface-1`, `bg-surface-2`, `border-border-subtle` | 0 |
| `text-display-xl`, `text-body-md`, `text-overline` (`--type-*` roles) | 0 |

So `--surface-1/2/3`, `--border-default/subtle`, the `--elevation-*` ladder and the entire
`--type-*` role layer were **written and never wired into a single component**. Only the
radius tier got real uptake.

### Duplicate semantics (same role, several names)

- text: `--muted-foreground` · `--text-secondary` · `--text-muted` (all the same value)
- background: `--background` · `--bg-page` · `--surface-1`
- card: `--card` · `--bg-card` · `--bg-elevated` · `--surface-2`
- border: `--border` · `--border-default` · `--border-subtle` (identical today)
- radius: `--radius-sm…2xl` (legacy) vs `--radius-control/surface/panel/pill` (RD-ORG)
- type: `--fs-*` (used) vs `--type-*` (unused alias layer over the same values)

None of these were changed in this pass — collapsing them is a rename across ~1,800 files
and belongs in its own phase. They are recorded here so the next phase does not re-derive it.

### The defect that mattered

`<body>` had **no painted background at all**:

```css
body {
 /*  background-color: var(--background); */   ← commented out
```

Every surface therefore had to carry its own `bg-white` literal to look right. Meanwhile
`useTheme` (`lib/hooks/useTheme.ts`, reachable from `components/dashboard/DashboardHeader.tsx`)
puts `.dark` on `<html>` and persists it in `localStorage`, with **nothing anywhere that
clears it**. A user who toggled dark once in the organizer dashboard and then opened a
marketing page got `bg-white` sections (a literal, never flips) carrying `text-foreground`
(a token, flips to `#F1F5F9`).

Measured in the browser before the fix:

```
/platform under .dark  → section #FFFFFF, heading #F1F5F9, contrast 1.1  (invisible)
/pricing  under .dark  → section #FFFFFF, heading #F1F5F9, contrast 1.1  (invisible)
```

After: **16.3, AA pass**, both pages.

---

## 2. Token architecture — what changed

The existing architecture (CSS custom properties in `styles/tokens.css` → `@theme inline`
in `app/globals.css` → Tailwind utilities) was **kept**. No `theme.ts` / `colors.ts` was
introduced. Two genuinely missing semantic roles were added:

```css
/* the deliberate dark contrast band — dark in BOTH themes, so it carries its own ink */
--surface-inverse:            #0E0E13;
--surface-inverse-foreground: #FFFFFF;

/* type and chips printed on a PHOTOGRAPH, not on a surface */
--ink-on-media:       #FFFFFF;
--ink-on-media-muted: rgb(255 255 255 / 0.78);
--ink-on-media-scrim: rgb(255 255 255 / 0.95);
```

`--ink-on-media` is the one colour in the system that must **not** follow the theme: the
photograph underneath is the same photograph in dark mode. It is a different role from
`--primary-foreground` ("on the brand fill") and from `--foreground` ("on the page"), and
naming it is what will let a future dark-mode pass convert the ~450 bare `text-white`
occurrences without destroying every image overlay in the product.

`body { background-color: var(--background) }` was restored. In the light theme
`--background` is `#FFFFFF`, so **nothing that renders today changed** — it is what makes
the surface tokens mean anything at all.

---

## 3. Hardcoded colour audit

Scanner: `app/ components/ lib/ content/ hooks/`, 1,834 `.ts`/`.tsx` files, **comments
stripped** so documentation hexes are not counted as UI code. Arbitrary Tailwind values are
only counted when the value is colour-like, so `w-[122%]` and `text-[13px]` are excluded.

| category | before | after |
|---|---:|---:|
| Tailwind palette classes (`bg-emerald-100`, …) | 4,319 | 4,211 |
| hex literals | 591 | 585 |
| `bg-white` / `text-black` etc. | 521 | 453 |
| `bg-white/90` etc. | 448 | 444 |
| `rgb()` / `rgba()` | 88 | 88 |
| arbitrary colour values (`bg-[#…]`, `text-[#…]`) | 60 | 54 |
| `hsl()`, arbitrary shadow/fill/gradient | 0 | 0 |
| **total** | **6,027** | **5,835** |

### Classification of the remaining 5,835

| count | files | class |
|---:|---:|---|
| 2,519 | 118 | **PROTECTED** — `components/event-templates/**`, `app/events/[slug]/**`, `lib/events/breadcrumbs.ts`, `lib/firebase/firestore/publicEvents.ts`, `app/api/events/**`. This phase was forbidden to modify them. |
| 325 | 21 | **ALLOWED** — email HTML. Mail clients strip `<style>` and drop CSS custom properties; inline hex is mandatory. |
| 284 | 38 | **ALLOWED** — PDF / print / canvas raster (`lib/printAssets`, `components/certificates`, `lib/receipts/pdf.ts`, `next/og` routes). No CSS layer exists. |
| 109 | 2 | **ALLOWED** — organizer-authored brand data (an organizer picks their event's colours; these are values, not theme). |
| 1,530 | 84 | **NOT ALLOWED — backlog**: organizer dashboard + event builder + wizard. |
| 544 | 25 | **NOT ALLOWED — backlog**: admin console. |
| 524 | 79 | **NOT ALLOWED — backlog**: public + shared UI (`components/discovery/cards`, `components/admin/StatusPill.tsx`, `lib/finance/txnMeta.ts`, `lib/settlements/statusMeta.ts`, `components/analytics/Charts.tsx`, …). |

**2,598 of the 5,835 remaining literals are legitimate or protected.** The genuine debt is
**~3,237 in 188 files**, and it is concentrated: the dashboard and admin consoles are 64% of it.

---

## 4. Migration order for the remaining debt

Each step is independently shippable and independently verifiable.

1. **Status-meaning modules** — `components/admin/StatusPill.tsx`, `lib/finance/txnMeta.ts`,
   `lib/settlements/statusMeta.ts`, `lib/dashboard/accents.ts`, `components/marketing/product/StatusBadge.tsx`,
   `components/auth/VerifiedBadge.tsx`. Same shape as `lib/ui/statusColors.ts` (done here):
   a small map, many consumers, high leverage. ~90 literals, maybe 6 files.
2. **`components/discovery/cards` + `sections`** — mostly `text-white` / `bg-white/95`
   over photography. Convert to `--ink-on-media*`, which now exists. ~53 literals.
3. **Category artwork** — `components/discovery/cards/CategoryArt.tsx` (10 gradient pairs)
   and `components/marketing/discovery/discoveryTaxonomy.ts` (10 tint/ink pairs). These are
   a closed decorative set; either promote to `--category-*` tokens or formally declare them
   data. A decision, not a mechanical edit.
4. **Admin console** (544) then **organizer dashboard** (1,530), screen by screen, each with
   a browser pass. These are the surfaces with no visual coverage today.
5. **Only then** consider collapsing the duplicate token names in §1 — it is a rename across
   the whole repo and must land on a codebase that already routes through tokens.

**Do not attempt 4 as one mechanical find-and-replace.** A palette weight does not carry its
meaning: `bg-amber-100` is "pending" on one screen and "selected row" on another, and a blind
substitution silently recolours the second.

---

## 5. Files changed in this phase

**Tokens / wiring (2)**
- `styles/tokens.css` — added `--surface-inverse{,-foreground}`, `--ink-on-media{,-muted,-scrim}`
- `app/globals.css` — registered them under `@theme inline`; restored `body { background-color }`

**Shared modules (5)**
- `lib/ui/statusColors.ts` — all 6 status maps → semantic accent pairs (0 palette classes left)
- `lib/marketing/theme.ts` — `SURFACES` and `sectionHeading` → tokens
- `components/ui/Toast.tsx` — success/error/warning → accent pairs (41 consumers)
- `components/ui/PageHeader.tsx` — `TONE` map → accent pairs
- `components/ui/Breadcrumbs.tsx` — grey ramp → tokens; `text-[13px]` → `text-fs-sm`

**Marketing surface layer (24)** — `bg-white` → `bg-background` (page/section grounds) or
`bg-card` (cards, panels, chips); `text-white` on the brand gradient → `text-primary-foreground`:
`components/marketing/` — `layout/MarketingLayout`, `hero/Hero`, `hero/HeroContent`, `Card`,
`Eyebrow`, `footer/MarketingFooter{,Link,Social}`, `navigation/{MarketingNavbar,MegaMenu,MobileDrawer}`,
`journey/TimelineBadge`, `discovery/SearchBar`, `platform/{PlatformHero,PlatformSection,PlatformCTA}`,
`platform-overview/{PlatformPreview,PlatformPreviewCard,PlatformSwitcher}`,
`product/{BrowserFrame,MetricTile,RegistrationsConsole}`, `screenshots/ScreenshotFrame`,
`sections/{PlatformHero,IntegrationsSection,OrganizerWorkspace,ParticipantExperience,SecuritySection,WhyRegisterDesk,PricingPreview}`,
`support/SupportSearch`

**Pages (4)** — `app/platform/page.tsx`, `app/pricing/page.tsx`, `app/contact/page.tsx`,
`app/causes/CausesClient.tsx`

**31 files total.** `HeroContent`'s `#0F172A` was byte-identical to `--foreground`; its
`#64748B` became `--muted-foreground` (`#475569`), a deliberate contrast gain (2.77 → 7.58).

---

## 6. Two colour distinctions were deliberately collapsed

The semantic accent set is a closed seven, smaller than the status taxonomy. In
`lib/ui/statusColors.ts`:

- `cancelled` / `rejected` / `changes_requested` all now read **critical** (were red / rose / orange)
- `pending_review` / `registration_closed` both now read **pending** (already both amber)

No information is lost: every pill carries its word, and colour was never the only signal —
the file's own header has said so since RD-EVENT-12. The alternative was inventing three more
accents, which is how the palette drifted in the first place.

---

## 7. Gates

- `tsc --noEmit` — **0 errors**
- `eslint` on changed files — **0 errors, 0 warnings**
- `eslint .` repo-wide — 88 errors / 103 warnings, **all pre-existing** (`react-hooks/set-state-in-effect`,
  `react-hooks/refs`) in 36 files, **none of them touched by this phase**
- `vitest run` — **327 files, 8,640 tests passed**, 41 files / 779 tests skipped
- `next build` — **exit 0**; `/` still `○ Static` with `revalidate 1m`; `[slug]` routes still `ƒ Dynamic`
- Routes 200: `/` `/events` `/causes` `/platform` `/pricing` `/contact` `/solutions/sports`
- Browser (production build, 1440×1000): zero console/page errors; light theme byte-identical
  on all six public pages; home hero unchanged (h1 545×136 @ x=112, Playfair Display 68px/68px,
  weight 700, tracking −1.904px; panels 278×390 @ 689/869; no horizontal overflow)
