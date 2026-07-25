import { Phone } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { COUNTRY_DIAL_CODES } from '@/lib/communication/countryCodes'

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
}: PhoneFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <select
          aria-label="Country code"
          value={countryCode}
          onChange={(e) => onCountryCodeChange(e.target.value)}
          className={cn(
            'h-12 shrink-0 rounded-lg border border-border bg-background px-2.5 text-[15px] text-foreground',
            'outline-none transition-[border-color,box-shadow] duration-150',
            'focus:border-primary focus:ring-2 focus:ring-primary/20',
          )}
        >
          {COUNTRY_DIAL_CODES.map((c) => (
            <option key={c.iso} value={c.dialCode}>{c.dialCode}</option>
          ))}
        </select>
        <div className="relative flex-1">
          <Phone
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
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
              'h-12 w-full rounded-lg border border-border bg-background text-[15px]',
              'text-foreground placeholder:text-muted-foreground pl-10 pr-3.5',
              'outline-none transition-[border-color,box-shadow] duration-150',
              'focus:border-primary focus:ring-2 focus:ring-primary/20 focus:ring-offset-0',
            )}
          />
        </div>
      </div>
      {hint && <p className="mt-1.5 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
