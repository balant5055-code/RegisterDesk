// ─── RegisterDesk Form Field Primitives ──────────────────────────────────────
//
// The canonical label + control + error wrapper, and the ONE control surface
// shared by <input>, <select> and <textarea>. Before this, every form in the app
// re-declared the same "h-11 rounded-xl border border-border bg-background …"
// string and its own local `Field` wrapper, so control height, focus ring and
// error styling drifted per screen.
//
// Owns ONLY the control surface and the label/error scaffold. Layout (column
// spans, grid placement) stays in the consumer's className, exactly like Card
// and IconChip. Typography comes from the semantic roles — no pixel literals.
//
//   <Field id="cf-email" label="Work email" required error={errors.email}>
//     <input id="cf-email" className={fieldControl({ invalid: !!errors.email })}
//            aria-describedby={errors.email ? fieldErrorId('cf-email') : undefined} />
//   </Field>
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { fs, typography } from '@/lib/ds/typography'

/**
 * The shared control surface.
 *
 * Sizing steps down at `sm`: 16px (--fs-input) on touch widths because iOS
 * Safari zooms the viewport on any focused control below 16px, then the 14px
 * body step from 640px up so desktop density matches the rest of the DS.
 */
export const FIELD_CONTROL =
  'h-10 w-full rounded-sm border border-border bg-background px-3.5 ' +
  'text-fs-input sm:text-fs-base text-foreground placeholder:text-muted-foreground/50 ' +
  'transition-[color,border-color,box-shadow] duration-150 ' +
  'hover:border-border-strong ' +
  'focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

/** Invalid state — border + ring only, so the surface itself never forks. */
export const FIELD_CONTROL_INVALID =
  'border-destructive/60 focus:border-destructive/60 focus:ring-destructive/15'

/** Class builder for any native control. `className` merges last (twMerge). */
export function fieldControl(opts: { invalid?: boolean; className?: string } = {}): string {
  return cn(FIELD_CONTROL, opts.invalid && FIELD_CONTROL_INVALID, opts.className)
}

/** Canonical ids for a field's error / hint nodes — pass to aria-describedby. */
export const fieldErrorId = (id: string) => `${id}-error`
export const fieldHintId  = (id: string) => `${id}-hint`

export interface FieldProps {
  /** Must match the control's `id` — wires the label and the describedby ids. */
  id:         string
  label:      string
  required?:  boolean
  /** Helper copy. Hidden while an error is showing so only one message speaks. */
  hint?:      string
  error?:     string
  className?: string
  children:   ReactNode
}

export function Field({ id, label, required, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className={cn(typography.caption, 'block font-semibold text-foreground')}>
        {label}
        {required && <span className="text-primary" aria-hidden> *</span>}
      </label>

      {children}

      {hint && !error && (
        <p id={fieldHintId(id)} className={cn(fs.xs, 'text-muted-foreground')}>{hint}</p>
      )}
      {error && (
        <p id={fieldErrorId(id)} role="alert" className={cn(fs.xs, 'font-medium text-destructive')}>
          {error}
        </p>
      )}
    </div>
  )
}
