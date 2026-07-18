# RD-DS-V3.1 — Enterprise Component Tokenization Audit

**Scope executed:** Structural (height / padding / gap / width) tokens in the shared `components/ui/*` primitives.
**Date:** 2026-07-18
**Guarantee:** Pixel-identical output. No redesign, no spacing-hierarchy/typography/color/layout/responsive/animation changes, no business-logic/Firestore/API/route changes. Build green.

---

## 1. Executive summary — the reframe

The premise "changing one token updates every instance" was **already true** for most of the design system before this phase. The `@theme inline` block in [`app/globals.css`](../app/globals.css) maps every named Tailwind utility to a `tokens.css` variable:

| Utility family | Already resolves to | Instances | Status |
|---|---|---:|---|
| `rounded-{sm..2xl,full}` | `var(--radius-{sm..full})` | ~3,900 | ✅ token-driven |
| `shadow-{sm..xl}`, `shadow-brand-{sm..lg}` | `var(--shadow-{sm..xl})` | many | ✅ token-driven |
| `bg-primary`, `text-foreground`, `bg-card`, `border-border`… | the mapped `var(--…)` token | many | ✅ token-driven |
| `text-fs-{2xs..5xl}` / typography roles | `var(--fs-{2xs..5xl})` | many | ✅ token-driven |

**The only component styles NOT token-driven were the fixed spacing-scale utilities** — `h-10`, `px-4`, `py-0.5`, `gap-2`, `p-4 sm:p-5` — because Tailwind's spacing scale emits literal `rem` values, not semantic tokens. Retuning "button md height" globally still meant editing utility classes.

RD-DS-V3.1 closes that gap for the **canonical reusable primitives**: it gives their heights/paddings/gaps a semantic home in `tokens.css` and has the primitives consume it — **pixel-identically**, because every token value equals the utility it replaced.

A second finding drove the token design: the pre-existing V2 component tokens (`--button-*`, `--input-*`, `--card-*`, `--badge-*`) had **zero consumers** and some **did not match reality** (e.g. `--input-height: 2.75rem` while the actual select trigger is `h-10` = 2.5rem). They were aspirational. This phase replaced them with a set aligned 1:1 to what the primitives actually render.

---

## 2. Audit — repeated component styles

| Primitive (`components/ui/*`) | Usage | Structural values found | Already-tokenized parts (left as-is) |
|---|---:|---|---|
| `button.tsx` (`Button`, `buttonVariants`) | ~198 (30 `<Button>` + 168 `buttonVariants()`) | `h-7/9/10/11/14`, `px-2.5/4/4/5/7`, `gap-1/1.5/2/2/2.5` | `rounded-xl`/`rounded-lg`, `bg-primary`, `shadow-[…primary-rgb…]`, `text-*` |
| `card.tsx` (`Card`) | 126 | `p-4 sm:p-5`, `p-5 sm:p-6`, `p-6 sm:p-7` | `rounded-xl/2xl`, `shadow-sm/md/xl`, `bg-card`, `border-border` |
| `badge.tsx` (`Badge`) | 54 | `px-2.5`, `py-0.5` | `rounded-full`, `bg-*`, `text-[13px]` |
| `StatusChip.tsx` | — | *(wraps `Badge`)* | inherits Badge tokens |
| `Dialog.tsx` (modal) | shared | header/body `px-5 py-4`, footer `px-5 py-3` | `rounded-2xl`, `shadow-xl`, `bg-card`, `max-w-*` |
| `CustomSelect.tsx` (select/combobox) | shared | trigger `h-10`, `px-3.5` | `rounded-xl`, `bg-background`, `border-*` |

The values repeat across each primitive's size/variant maps — the definition of "repeated component style."

---

## 3. Tokens created (28 structural tokens, added to [`styles/tokens.css`](../styles/tokens.css))

All aligned 1:1 to the actual utility they replace (so consuming them is pixel-identical). The old unconsumed/mismatched V2 block was replaced.

```css
/* Buttons — matches button.tsx sizeClasses exactly */
--button-height-xs:1.75rem; --button-height-sm:2.25rem; --button-height-md:2.5rem;
--button-height-lg:2.75rem; --button-height-xl:3.5rem;               /* h-7/9/10/11/14 */
--button-px-xs:.625rem; --button-px-sm:1rem; --button-px-md:1rem;
--button-px-lg:1.25rem; --button-px-xl:1.75rem;                      /* px-2.5/4/4/5/7 */
--button-gap-xs:.25rem; --button-gap-sm:.375rem; --button-gap-md:.5rem;
--button-gap-lg:.5rem; --button-gap-xl:.625rem;                      /* gap-1/1.5/2/2/2.5 */

/* Select / combobox trigger — CustomSelect.tsx */
--select-height:2.5rem;  /* h-10 */   --select-px:.875rem;  /* px-3.5 */

/* Cards — per-variant padding (base + sm:) — card.tsx */
--card-px-default:1rem;    --card-px-default-sm:1.25rem;   /* p-4 sm:p-5 */
--card-px-elevated:1.25rem;--card-px-elevated-sm:1.5rem;   /* p-5 sm:p-6 */
--card-px-modal:1.5rem;    --card-px-modal-sm:1.75rem;     /* p-6 sm:p-7 */

/* Badges / chips — badge.tsx */
--badge-px:.625rem;  /* px-2.5 */   --badge-py:.125rem;  /* py-0.5 */

/* Modal / dialog padding — Dialog.tsx */
--modal-px:1.25rem; /* px-5 */  --modal-py:1rem; /* py-4 */  --modal-py-footer:.75rem; /* py-3 */
```

Legacy aliases kept unchanged for back-compat: `--button-radius/-shadow`, `--input-radius/-border`, `--card-radius/-shadow`, `--badge-radius`.

---

## 4. Components migrated (6 files)

| File | Change |
|---|---|
| `styles/tokens.css` | Replaced the unconsumed V2 component-token block with the 28-token reality-aligned set (§3) |
| `components/ui/button.tsx` | `sizeClasses` consumes `--button-height-{xs..xl}`, `--button-px-{xs..xl}`, `--button-gap-{xs..xl}` (one explicit token per size) |
| `components/ui/card.tsx` | `variantPadding` consumes `--card-px-{default,elevated,modal}` (+ `-sm` responsive) |
| `components/ui/badge.tsx` | `px-2.5 py-0.5` → `px-[var(--badge-px)] py-[var(--badge-py)]` |
| `components/ui/Dialog.tsx` | header/body/footer padding → `px-[var(--modal-px)]` + `py-[var(--modal-py)]` / `py-[var(--modal-py-footer)]` |
| `components/ui/CustomSelect.tsx` | trigger `h-10 px-3.5` → `h-[var(--select-height)] px-[var(--select-px)]` |

`StatusChip.tsx` and `EmptyState.tsx` (CTA) inherit tokenization transitively via `Badge`/`buttonVariants`.

**Why arbitrary utilities are safe here:** `twMerge` groups `h-[…]`/`px-[…]`/`gap-[…]`/`p-[…]` in the same conflict classes as their named counterparts (`h-*`, `px-*`, …), so a caller passing `className="h-12"` still overrides exactly as before. Sizes are single-value (button/badge/select) or explicitly responsive (card `sm:`), so no breakpoint behaviour changed.

---

## 5. Coverage

Measured over **structural (height/padding/gap/width) values in the shared `components/ui/*` primitives** — the target of this scope.

| Metric | Before | After |
|---|---:|---:|
| Radius / shadow / color / font-size in primitives token-driven | ~100% (via theme) | ~100% (unchanged) |
| **Structural values in migrated primitives token-driven** | **0%** | **100%** |
| Reusable component *instances* now token-driven end-to-end (button ~198 · card 126 · badge/chip 54 · dialog · select) | 0 | **all** |
| Distinct structural tokens with a live consumer | 0 / (aspirational) | **28 / 28** |

Editing e.g. `--button-height-md` in `tokens.css` now retunes every primitive-based medium button in the app.

---

## 6. Remaining intentional exceptions (documented, not debt)

| Location | Value | Why left literal |
|---|---|---|
| `button.tsx` (xl), `badge.tsx`, `CustomSelect.tsx` | `text-[15px]`, `text-[13px]`, `text-[13.5px]` | **Typography**, out of this phase's structural scope. `15px`≡`--fs-md` and `13px`≡`--fs-sm` (candidates for a future type-role pass); `13.5px` has no scale token. |
| `button.tsx` | `rounded-xl` base vs `rounded-lg` for primary/gradient | Intentional two-radius design; both **already** token-driven via `--radius-*`. |
| `Dialog.tsx` | `max-w-sm / max-w-lg / max-w-2xl` | Tailwind max-width scale (widths), not a repeated semantic value; left per "no spacing-scale replacement." |
| `EmptyState.tsx` | `px-5 py-8` / `px-6 py-12` / `px-8 py-16`, `size-10/12/16` | Single-component, size-specific, **not repeated** elsewhere with a semantic name — tokenizing would invent values. |
| Hand-rolled buttons/cards across `app/**` (127 / 416 sites) | — | Out of the agreed "shared primitives only" scope; migrating them to the primitives is a separate, higher-risk effort (see §8). |

---

## 7. Verification

| Check | Command | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ **pass** (exit 0) |
| Build | `next build` | ✅ **pass** (exit 0) |
| Compiled CSS emits token utilities | grep `.next/static/chunks/*.css` | ✅ `{height:var(--button-height-md)}`, `{padding-inline:var(--button-px-lg)}`, `padding:var(--card-px-default-sm)`, badge/modal/select all present — **no silent Tailwind drop** |
| Token values intact | grep compiled tokens | ✅ `--button-height-md:2.5rem`, `--card-px-default:1rem`, `--modal-px:1.25rem`, `--select-height:2.5rem` — equal to former `h-10`/`p-4`/`px-5`/`h-10` |
| Lint (changed primitives) | `eslint components/ui/{button,card,badge,Dialog,CustomSelect}.tsx` | ✅ **no new errors** (button/card/badge/Dialog clean; CustomSelect's 2 findings are pre-existing effect/aria issues on lines this pass didn't touch) |

**Honesty note:** repo-wide `eslint` still carries its pre-existing baseline (unrelated files, `set-state-in-effect` etc.) documented in RD-DS-V3. This phase added zero new lint findings and every value is identical (token value ≡ former utility), so rendering is unchanged.

---

## 8. Recommended next steps (optional)

1. **Hand-rolled migration** — replace the 127 bespoke `<button>` / 416 hand-rolled card sites with `<Button>` / `<Card>` so they inherit the tokens (behaviour-review each; not pixel-trivial).
2. **Type-role pass** — convert the `text-[15px]`/`text-[13px]` literals in primitives to `text-[var(--fs-md)]`/`text-[var(--fs-sm)]`.
3. **Lint guardrail** — forbid raw `h-[0-9]`/`px-[0-9]` inside `components/ui/*` to keep primitives on tokens.
