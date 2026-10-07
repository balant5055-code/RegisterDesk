import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── AuthField ──────────────────────────────────────────────────────────────
// Labelled text input with an optional leading icon and optional trailing `suffix`
// (e.g. a password visibility toggle). Controlled. Brand-neutral.
//
// ═══ TWO PROPS, BOTH DEFAULTING TO WHAT SHIPPED ══════════════════════════════
// This component is mounted on BOTH the public /login and /admin/login (through
// LoginForm), and those two surfaces do not look alike. Rather than fork it, it
// takes two optional props whose defaults are byte-identical to the original
// component, so every existing caller renders exactly as it did:
//
//   accent  — 'primary' (default, organizer magenta) | 'action' (public ramp).
//             RegisterDesk runs two accents on purpose; before this prop existed
//             the fields on the indigo public page focused magenta.
//
//   variant — 'box' (default) | 'rule'.
//             'box' is the bordered control: a rounded rectangle with a leading
//             icon inside it. 'rule' is the same field with the box removed —
//             one hairline under the input and nothing else.
//
// ═══ WHY 'rule' EXISTS ═══════════════════════════════════════════════════════
// The signup form is six fields. As boxes, stacked with a segmented switch, a
// filled button and three bordered provider buttons, the column was thirteen
// outlined rectangles — which reads as clutter no amount of spacing fixes. The
// rule variant removes six of them and lets the type carry the form. It keeps the
// same 48px target height and the same label, so nothing is traded for the look.

export type AuthFieldAccent = 'primary' | 'action'
export type AuthFieldVariant = 'box' | 'rule'
/** 'lg' = --radius-lg (12px), the original. 'control' = --radius-control (6px),
 *  which styles/tokens.css names as THE radius for interactive controls. */
export type AuthFieldRadius = 'lg' | 'control'

export interface AuthFieldProps {
  id:            string
  label:         string
  type?:         string
  placeholder?:  string
  value:         string
  onChange:      (v: string) => void
  autoComplete?: string
  /** Leading icon. Drawn inside the box; ignored by the `rule` variant, which has
   *  no box to put it in and reads better without one. */
  Icon:          LucideIcon
  suffix?:       ReactNode
  accent?:       AuthFieldAccent
  variant?:      AuthFieldVariant
  /**
   * Drop the leading icon and reclaim its padding. Default false — every existing
   * caller keeps the icon it has always drawn.
   *
   * An icon inside every input is a scanning aid on a dense form; on a short,
   * centred sign-in column it is three glyphs competing with the labels that
   * already say the same thing. The public /login sets it.
   */
  hideIcon?:     boolean
  /**
   * Corner radius. Default 'lg' — byte-identical to what every existing caller has
   * always rendered. 'control' is the design system's own value for an interactive
   * control and is the sharper, more architectural of the two.
   */
  radius?:       AuthFieldRadius
}

/** Focus treatment per accent × variant. Exported so PhoneField dresses its own
 *  two controls identically rather than re-typing the class lists. */
export const AUTH_FIELD_ACCENT: Record<AuthFieldVariant, Record<AuthFieldAccent, string>> = {
  box: {
    primary: 'focus:border-primary focus:ring-2 focus:ring-primary/20',
    action:  'hover:border-border-strong focus:border-action focus:ring-2 focus:ring-action/25',
  },
  rule: {
    // No ring at all: a 2px rule in the accent is the entire focus state. A halo
    // around a borderless field is the one thing that would put the box back.
    primary: 'hover:border-border-strong focus:border-primary',
    action:  'hover:border-border-strong focus:border-action',
  },
}

/** Geometry per variant. The 48px height is shared — the box is what changes.
 *  The box variant carries NO radius of its own: RADIUS below supplies it, so the
 *  two cannot fight in twMerge. The rule variant is square by definition. */
const VARIANT_SHELL: Record<AuthFieldVariant, string> = {
  box:  'h-12 border border-border bg-background',
  rule: 'h-12 rounded-none border-0 border-b border-border bg-transparent focus:border-b-2',
}

/** Exported so PhoneField gives its dial-code pair the caller's radius too. */
export const AUTH_FIELD_RADIUS: Record<AuthFieldRadius, string> = {
  lg:      'rounded-lg',
  control: 'rounded-[var(--radius-control)]',
}

/** Label treatment. The rule variant sets it smaller and tracked, because with no
 *  box the label is the only thing that says where the field begins. */
const VARIANT_LABEL: Record<AuthFieldVariant, string> = {
  box:  'mb-2 block text-sm font-medium text-foreground',
  rule: 'mb-1 block text-fs-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground',
}

/** The public screens' label (accent="action", box): bronze-toned small caps, tracked —
 *  the editorial voice of the public site. The organizer product (accent="primary")
 *  keeps VARIANT_LABEL.box unchanged. Exported so PhoneField matches it. */
export const AUTH_LABEL_EDITORIAL =
  'mb-1.5 block text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow'

export function AuthField({
  id,
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  autoComplete,
  Icon,
  suffix,
  accent = 'primary',
  variant = 'box',
  hideIcon = false,
  radius = 'lg',
}: AuthFieldProps) {
  const isRule = variant === 'rule'
  // The rule variant has no box to put an icon in, so it never draws one.
  const withIcon = !isRule && !hideIcon

  return (
    <div>
      <label htmlFor={id} className={variant === 'box' && accent === 'action' ? AUTH_LABEL_EDITORIAL : VARIANT_LABEL[variant]}>
        {label}
      </label>

      {/*
        The input is FIRST in the DOM and the icon follows it, even though the icon
        is drawn on the left. Both are absolutely positioned decoration around a
        full-width field, so the visual result is unchanged — but `peer-focus:`
        only reaches siblings that come AFTER the peer, and that is what lets the
        icon light up with the border instead of staying grey beside it. The icon
        is aria-hidden, so nothing is reordered for a screen reader.
      */}
      <div className="relative">
        <input
          id={id}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={cn(
            'peer w-full text-[15px] text-foreground placeholder:text-muted-foreground',
            'outline-none transition-[border-color,box-shadow] duration-150 focus:ring-offset-0',
            VARIANT_SHELL[variant],
            !isRule && AUTH_FIELD_RADIUS[radius],
            isRule
              // No box means no inner padding: the text starts on the column's own
              // left edge, which is what lines the field up with the label above it
              // and the heading above that.
              ? cn('px-0', suffix && 'pr-9')
              : cn(withIcon ? 'pl-10' : 'pl-3.5', suffix ? 'pr-10' : 'pr-3.5'),
            AUTH_FIELD_ACCENT[variant][accent],
          )}
        />

        {withIcon && (
          <Icon
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground',
              // The icon tracks focus on the public accent, so the field lights as
              // one object rather than a border changing colour beside a grey glyph.
              accent === 'action' && 'transition-colors duration-150 peer-focus:text-action',
            )}
          />
        )}

        {suffix && (
          <div className={cn('absolute top-1/2 -translate-y-1/2', isRule ? 'right-0' : 'right-3.5')}>
            {suffix}
          </div>
        )}
      </div>
    </div>
  )
}
