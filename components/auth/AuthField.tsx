import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── AuthField ──────────────────────────────────────────────────────────────
// Labelled text input with a leading icon and optional trailing `suffix`
// (e.g. a password visibility toggle). Controlled. Brand-neutral.

export interface AuthFieldProps {
  id:            string
  label:         string
  type?:         string
  placeholder?:  string
  value:         string
  onChange:      (v: string) => void
  autoComplete?: string
  Icon:          LucideIcon
  suffix?:       ReactNode
}

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
}: AuthFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Icon
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={id}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={cn(
            'h-12 w-full rounded-lg border border-border bg-background text-[15px]',
            'text-foreground placeholder:text-muted-foreground',
            'pl-10',
            suffix ? 'pr-10' : 'pr-3.5',
            'outline-none transition-[border-color,box-shadow] duration-150',
            'focus:border-primary focus:ring-2 focus:ring-primary/20 focus:ring-offset-0',
          )}
        />
        {suffix && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2">{suffix}</div>
        )}
      </div>
    </div>
  )
}
