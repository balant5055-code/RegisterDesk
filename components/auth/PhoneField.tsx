import { Phone } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { COUNTRY_DIAL_CODES } from '@/lib/communication/countryCodes'
import { AUTH_FIELD_ACCENT, AUTH_FIELD_RADIUS, AUTH_LABEL_EDITORIAL, type AuthFieldAccent, type AuthFieldVariant, type AuthFieldRadius } from './AuthField'

// ─── PhoneField ───────────────────────────────────────────────────────────────
// Labelled mobile-number input with a leading country-code <select> (RD-AUTH-02).
// Controlled. Styled to match AuthField (h-12, rounded-lg, brand-neutral). The
// national number and the selected dial code are separate controlled values; the
// caller composes the canonical E.164 form via lib/communication/phone.

export interface PhoneFieldProps {
  id:                  string
  label:               string
  /** Selected dial code WITH '+', e.g. '+91'. */
  countryCode:         string
  onCountryCodeChange: (v: string) => void
  /** National number as typed (no country code). */
  value:               string
  onChange:            (v: string) => void
  placeholder?:        string
  hint?:               string
  /** Focus accent, matched to AuthField. Defaults to the organizer magenta, as before. */
  accent?:             AuthFieldAccent
  /** Box or rule, matched to AuthField. Defaults to the bordered control, as before. */
  variant?:            AuthFieldVariant
  /** Drop the leading glyph, matched to AuthField. Defaults to drawing it, as before. */
  hideIcon?:           boolean
  /** Corner radius, matched to AuthField. Defaults to the 12px radius, as before. */
  radius?:             AuthFieldRadius
}

export function PhoneField({
  id,
  label,
  countryCode,
  onCountryCodeChange,
  value,
  onChange,
  placeholder,
  hint,
  accent = 'primary',
  variant = 'box',
  hideIcon = false,
  radius = 'lg',
}: PhoneFieldProps) {
  // One accent AND one geometry for BOTH controls in the pair — a dial-code select
  // that focuses one colour, or keeps its box while the number beside it loses one,
  // reads as two unrelated fields rather than one phone number.
  const accentClasses = AUTH_FIELD_ACCENT[variant][accent]
  const isRule = variant === 'rule'
  const withIcon = !isRule && !hideIcon

  // ── The rule variant puts the border on the WRAPPER, not on the two controls ──
  //
  // A dial code and a national number are one phone number. Drawn as two adjacent
  // hairlines with a gap between them they read as two fields that happen to sit
  // together — and the gap looks like a broken rule. So in the rule variant the
  // pair shares ONE hairline: the wrapper carries the border and the focus state
  // (via focus-within, since either child can hold focus), and the controls
  // themselves are transparent and border-free.
  //
  // The box variant is untouched: there each control keeps its own outline, which
  // is what /admin/login and dashboard settings have always rendered.
  const shell = isRule
    ? 'h-12 border-0 bg-transparent'
    : cn('h-12 border border-border bg-background', AUTH_FIELD_RADIUS[radius])
  const WRAPPER_FOCUS: Record<string, string> = {
    primary: 'focus-within:border-b-2 focus-within:border-primary',
    action:  'focus-within:border-b-2 focus-within:border-action',
  }
  return (
    <div>
      <label
        htmlFor={id}
        className={
          isRule
            ? 'mb-1 block text-fs-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground'
            : accent === 'action' ? AUTH_LABEL_EDITORIAL : 'mb-2 block text-sm font-medium text-foreground'
        }
      >
        {label}
      </label>
      <div
        className={cn(
          'flex',
          isRule
            ? cn(
                'h-12 items-center gap-2 border-b border-border transition-[border-color] duration-150',
                'hover:border-border-strong',
                WRAPPER_FOCUS[accent],
              )
            : 'gap-2',
        )}
      >
        <select
          aria-label="Country code"
          value={countryCode}
          onChange={(e) => onCountryCodeChange(e.target.value)}
          className={cn(
            'shrink-0 cursor-pointer text-[15px] text-foreground',
            'outline-none transition-[border-color,box-shadow] duration-150',
            shell,
            isRule ? 'pl-0 pr-0' : cn('px-2.5', accentClasses),
          )}
        >
          {COUNTRY_DIAL_CODES.map((c) => (
            <option key={c.iso} value={c.dialCode}>{c.dialCode}</option>
          ))}
        </select>
        <div className="relative flex-1">
          {withIcon && (
            <Phone
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          )}
          <input
            id={id}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required
            className={cn(
              'w-full text-[15px] text-foreground placeholder:text-muted-foreground',
              'outline-none transition-[border-color,box-shadow] duration-150 focus:ring-offset-0',
              shell,
              isRule ? 'px-0' : cn(withIcon ? 'pl-10' : 'pl-3.5', 'pr-3.5', accentClasses),
            )}
          />
        </div>
      </div>
      {hint && <p className="mt-1.5 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
