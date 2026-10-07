import { cn } from '@/lib/utils/cn'
import { buttonVariants, type ButtonVariant, type ButtonSize } from '@/components/ui/button'

// Phase P.1.3 — Marketing theme extensions.
//
// ADDITIVE, marketing-only design tokens. Does NOT modify the application design
// system (styles/tokens.css) — it only centralizes the few marketing-scale
// extensions (large display sizes, surface bands) as Tailwind class strings so
// components never hardcode them. White-first; no dark theme (the inverse band is
// a deliberate contrast section, not a page theme).

// Marketing-only display sizes (the app `fs` scale tops out at 48px; heroes need
// larger). Centralized here via clamp() so they are standardized, not arbitrary.
export const marketingType = {
  /** ~40 → 72px — hero headline on large screens */
  display: 'text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold tracking-tight leading-[1.05]',
  /** ~32 → 52px — hero headline on small/medium screens, page titles */
  hero:    'text-[clamp(2rem,5vw,3.25rem)] font-bold tracking-tight leading-[1.1]',
  /** ~28 → 40px — homepage section H2. Single shared source for every homepage
      Section H2 (LS2.2A convergence). LS2.2B calibration: reduced from
      clamp(34→48)/extrabold to clamp(28→40)/bold for a lighter, more premium
      feel (Stripe/Linear/Vercel). Same 4vw slope, tracking, line-height, color. */
  sectionHeading: 'text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-foreground',
} as const

// L1 foundation: every marketing section sits on the page canvas. `white` and
// `muted` both resolve to the same surface — sections never carry a gray band; only
// cards/components use subtle surfaces. `inverse` is a deliberate dark contrast
// band (currently unused).
//
// RD-THEME-01 · these were `bg-white text-foreground`. The two halves disagreed:
// bg-white is a literal that never changes, while text-foreground resolves through the
// token and flips to #F1F5F9 under `.dark` — which the organizer header's theme toggle
// sets on <html> and persists in localStorage. A user who had ever toggled dark then
// loaded a marketing page got near-white type on a white band. Routing the background
// through the same token layer as the text is what makes the pair consistent.
export const SURFACES = {
  white:   'bg-background text-foreground',
  muted:   'bg-background text-foreground',
  inverse: 'bg-surface-inverse text-surface-inverse-foreground',
} as const
export type SurfaceBand = keyof typeof SURFACES

/** The public brand gradient as an inline style. Named, never re-typed — the one
    definition is --action-gradient in styles/tokens.css. */
export const brandGradientStyle = { backgroundImage: 'var(--action-gradient)' } as const

/** Eyebrow / overline class (brand, uppercase) — reused by SectionHeader. */
export const EYEBROW_CLASS = 'text-fs-xs font-semibold uppercase tracking-[0.08em] text-action'

// ─── The public brand's button ────────────────────────────────────────────────
//
// `components/ui/button.tsx` is the PRODUCT's button: its `primary` variant is
// `bg-primary` — #e5277e — and its focus ring is `ring-primary`. Organizer and admin
// still run on that colour, so the variant itself must not move; changing it would
// repaint every dashboard CTA in the app.
//
// But the public site no longer looks like that. Its accent is --action → --action-end.
// So marketing composes the SAME button and then names the public accent after it.
// twMerge keeps only the last class in each conflicting group, so the four groups below
// (background, ring, shadow, hover shadow) resolve to the action ramp and everything
// else about the button — geometry, size, weight, motion, disabled state — is still the
// shared component's, unforked.
//
// No hex is typed here: --action-rgb is the same token pair the footer washes use.
const PUBLIC_PRIMARY = [
  'bg-action hover:bg-action-hover',
  'focus-visible:ring-action',
  'shadow-[0_2px_12px_rgb(var(--action-rgb)_/_0.28)]',
  'hover:shadow-[0_4px_20px_rgb(var(--action-rgb)_/_0.42)]',
].join(' ')

// The focus ring is on EVERY variant of the shared button, not just `primary`, so an
// outline or ghost CTA on a marketing page would still flash magenta on keyboard focus.
const PUBLIC_RING = 'focus-visible:ring-action'

// The PUBLIC EVENT experience's primary action — the same button, on the brand GRADIENT.
//
// Event pages (hero CTA, ticket cards, the sticky mobile bar, the certificate centre) used
// `buttonVariants('primary')`, which is `bg-primary`; and globals.css overrides `.bg-primary`
// to paint --primary-gradient — coral → magenta. So every "Register" on the public site
// was the OLD brand ramp while the chrome around it had moved to indigo → violet.
//
// `bg-transparent` matters: twMerge drops `bg-primary` for it (same background-color
// group), which is what removes the `.bg-primary` gradient override. `.rd-brand-gradient`
// then supplies the ONE definition of --action-gradient. Hover is opacity, not a second
// gradient — there is no --action-gradient-hover and this file must not invent one.
const PUBLIC_GRADIENT = [
  'bg-transparent rd-brand-gradient text-action-foreground',
  'hover:opacity-90 focus-visible:ring-action',
  'shadow-[0_2px_12px_rgb(var(--action-rgb)_/_0.28)]',
  'hover:shadow-[0_4px_20px_rgb(var(--action-rgb)_/_0.42)]',
].join(' ')

/**
 * The shared button, wearing the public brand. Every marketing CTA goes through this
 * instead of calling `buttonVariants` directly.
 *
 * `emphasis: 'gradient'` is the public EVENT primary — the brand ramp rather than the
 * solid action fill. Only meaningful with `variant: 'primary'`.
 */
export function marketingButton(opts: {
  variant?: ButtonVariant; size?: ButtonSize; className?: string; emphasis?: 'solid' | 'gradient'
} = {}): string {
  const { variant = 'primary', size, className, emphasis = 'solid' } = opts
  const skin = variant !== 'primary' ? PUBLIC_RING : emphasis === 'gradient' ? PUBLIC_GRADIENT : PUBLIC_PRIMARY
  return buttonVariants({ variant, size, className: cn(skin, className) })
}

/**
 * The same skins, for a caller that renders the `<Button>` COMPONENT rather than composing
 * `buttonVariants` — the component takes `className` and merges it last, so these land
 * exactly as marketingButton would have landed them. Nothing else may type these strings.
 */
export const marketingButtonSkin = {
  /** The public event primary: brand gradient, white foreground, action ring. */
  gradient: PUBLIC_GRADIENT,
  /** Every non-primary variant: only the focus ring moves to the public accent. */
  ring:     PUBLIC_RING,
} as const
