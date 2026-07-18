# RD-DS-V3.2 — Component Consolidation & Primitive Adoption Audit

**Scope executed:** Deduplicate exact-copy interactive primitives into shared components — new `IconButton` + `TextLink`, migrate every pixel-identical cluster.
**Date:** 2026-07-18
**Guarantee:** Pixel-identical and behaviour-identical output. No redesign / spacing / typography / animation / responsiveness / business-logic / Firestore / API / route changes.

---

## 1. Executive summary — the premise, corrected

The phase brief assumed ~127 hand-rolled buttons and ~416 hand-rolled cards were migratable duplicates. **They are not.** Those figures were *pattern-matches* (button-like / card-like markup), not duplicates of the shared primitives. Classified honestly under the pixel-identical rule:

- The existing `<Button>` **injects** focus-visible rings, a brand shadow, `hover:-translate-y-px`, `active:scale-[0.98]`, `font-semibold`, and size tokens. **Zero** hand-rolled `<button>` in the repo reproduces that signature — they are icon buttons, text links, tabs, toggles, and bespoke CTAs with their own padding/hover/disabled. Migrating them to `<Button>` would *add* those effects → a visible change → **forbidden**.
- **Zero** hand-rolled `<div>` matches `<Card>` exactly (Card adds `text-card-foreground` + fixed `p-4 sm:p-5`).

So migrating to the **existing** primitives yields ~0 pixel-safe changes. The **real** removable duplication is exact-copy clusters that correspond to **missing** primitives. This phase created those primitives and migrated the clusters — pixel-identically (same class *set*, same element, same attributes).

---

## 2. Classification (A / B / C)

| Primitive | Cat A — already shared | Cat B — migrated this phase | Cat C — genuinely unique (left) |
|---|---:|---|---:|
| **Buttons** | ~198 sites (`<Button>` + `buttonVariants()`) | **24** (14 → `IconButton`, 10 → `TextLink`) | remainder of ~961 `<button>` (bespoke) |
| **Cards** | 126 `<Card>` | 0 | ~108 bespoke surfaces |
| **Badges / chips** | 54 `<Badge>` (+`StatusChip`) | 0 | bespoke chips |

**Category B detail — the exact-duplicate clusters removed:**

| New primitive | Former repeated markup | Instances | Notes |
|---|---|---:|---|
| `IconButton` | `rounded-md p-1 text-muted-foreground hover:bg-muted` | 11 | modal/panel close buttons |
| `IconButton` (+`hover:text-foreground` via `className`) | `… hover:bg-muted hover:text-foreground` | 3 | close buttons |
| `TextLink` (`<button>`) | `text-[13px] text-primary hover:underline` | 4 | "Retry" re-load actions |
| `TextLink` (`<Link>`) | `text-[13px] text-primary hover:underline` | 6 | "← Back" navigation |
| **Total** | | **24** | |

---

## 3. New shared primitives created

Both reproduce the exact former class *set* (CSS is order-independent and no utilities conflict, so output is identical), and pass through every attribute.

- [`components/ui/IconButton.tsx`](../components/ui/IconButton.tsx) — icon-only button. Renders a plain `<button>` with `cn('rounded-md p-1 text-muted-foreground hover:bg-muted', className)`. **Deliberately injects no `type`, focus ring, shadow, or size** — so a caller that omitted `type` keeps the native default (no form-submit behaviour change) and callers keep their `type="button"`. Per-site variants (e.g. `hover:text-foreground`) pass via `className`.
- [`components/ui/TextLink.tsx`](../components/ui/TextLink.tsx) — inline text link. Polymorphic: renders a Next `<Link>` when `href` is given, else a `<button>` — matching the two element types the pattern appeared on. Class set identical.

Both barrel-exported from [`components/ui/index.ts`](../components/ui/index.ts).

---

## 4. Files modified (23)

**New (2):** `components/ui/IconButton.tsx`, `components/ui/TextLink.tsx`
**Barrel (1):** `components/ui/index.ts`

**IconButton migrations (12):** `app/(admin)/admin/audit/page.tsx`, `…/license-center/page.tsx` (×3), `…/licenses/page.tsx`, `…/organizers/page.tsx`, `app/(dashboard)/dashboard/communications/reminders/page.tsx`, `components/admin/commandPalette.tsx`, `components/certificates/builder/PreviewModal.tsx`, `components/certificates/hub/IssueBulkPanel.tsx`, `components/report/ReportButton.tsx`, `app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx`, `app/(dashboard)/dashboard/print-assets/PrintAssetsClient.tsx`, `components/print-assets/collections/CollectionLibrary.tsx`

**TextLink migrations (8):** `app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInPageClient.tsx`, `…/ManageEventClient.tsx`, `…/tabs/ExhibitionTab.tsx`, `…/tabs/NominationsTab.tsx`, `…/tabs/SpeakerApplicationsTab.tsx`, `…/tabs/SponsorApplicationsTab.tsx`, `app/events/[slug]/speak/SpeakerApplyClient.tsx`, `app/events/[slug]/sponsor/SponsorApplyClient.tsx`

---

## 5. Reduction in duplicated UI

| | Before | After |
|---|---:|---:|
| Copies of the icon-button class string | 14 across 12 files | **1** (in `IconButton`) |
| Copies of the text-link class string | 10 across 8 files | **1** (in `TextLink`) |
| Duplicated interactive-primitive class strings eliminated | 24 | **2 canonical definitions** |

24 hand-rolled interactive elements now derive from one shared component each. Changing the icon-button or text-link style is now a one-line edit.

---

## 6. Intentional exceptions (Category C — left in place)

| Group | Why not migrated |
|---|---|
| ~900 remaining `<button>` (icon toolbars, tabs, toggles, segmented controls, bespoke CTAs) | Genuinely unique styling/behaviour; migrating to `<Button>`/`IconButton` would change padding, hover, focus, or disabled visuals. "Do not force." |
| All hand-rolled cards (~108) | Zero match `<Card>` exactly; each is a bespoke surface (different radius/shadow/padding/overflow/positioning). |
| Recurring chip clusters — `rounded-full bg-muted/60 px-2 py-0.5 text-[12px] …` (×3), `bg-muted px-2 py-0.5 text-[11px] …` (×3) | Do **not** match `<Badge>` (`px-2.5 py-0.5 text-[13px]`). Removable only via a **new** Chip primitive — a clean follow-up (see §8), not done here to keep this pass tightly scoped. |
| Info-card cluster — `flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground` (×5) | Clean exact cluster; candidate for a new `InfoCard` primitive (§8). Deferred with the chips. |

---

## 7. Verification

| Check | Command | Result |
|---|---|---|
| Clusters removed | grep exact class strings on raw `<button>`/`<Link>` | ✅ **0 remaining** (14 `IconButton` + 10 `TextLink` in use) |
| Types | `tsc --noEmit` | ✅ **pass** (exit 0) |
| Build | `next build` | ✅ **pass** (exit 0) |
| Lint (all 23 changed files) | `eslint <files>` | ✅ **no new findings**. The 5 reported are pre-existing (`react-hooks/set-state-in-effect` in the tabs' `useEffect(() => { void load() }, [load])`, one unused-expression) on lines this pass didn't touch — no unused-import errors, confirming `X`/`Link`/`cn` all remain used. |

**Pixel-identical rationale:** each migrated site renders `cn('<exact former class string>', className)` on the same element type, with all attributes (`onClick`, `type`, `aria-label`, `href`) carried over verbatim. The class *set* is byte-preserved (CSS ignores class order; no utilities conflict), so computed styles are identical.

---

## 8. Recommended next steps (optional)

1. **`Chip` primitive** — for the two `rounded-full … px-2 py-0.5` clusters (6 instances). Pixel-identical via exact class reproduction.
2. **`InfoCard` primitive** — for the `flex items-center gap-2 rounded-xl border border-border bg-card p-4 …` cluster (5 instances).
3. **Additional `IconButton` variants** — the `size-7 … hover:bg-muted/50` (×5) and `rounded-lg p-1.5 … hover:text-foreground` (×3) icon-button shapes could be added as explicit variants and migrated.
4. **Lint guardrail** — flag raw `<button className="rounded-md p-1 text-muted-foreground hover:bg-muted">` to steer new code to `IconButton`.
