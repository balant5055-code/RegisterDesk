'use client'

// formControls — ONE visual system for every registration control.
//
// RD-RT2.0. RT1.0 rebuilt the page architecture on framework tokens, but the controls
// inside it were still hand-set: four raw font sizes across the field layer
// (13.5 / 13 / 12.5 / 11.5px), five different option-row heights, and a label/hint/error
// rhythm that changed per branch. Three things were missing outright:
//
//   • an ERROR state on the control itself — `aria-invalid` was set, but the input's
//     border never changed, so a validation message pointed at nothing;
//   • hover, read-only and disabled states on most branches;
//   • ids on the single-checkbox hint/error, which `aria-describedby` already referenced.
//
// Everything here is presentation. No validation, no conditional evaluation, no value
// transformation — controls receive a value and an onChange and render them.
//
// Control height is `h-10` (40px) to stay in exact lockstep with CustomSelect, which
// reads --select-height: 2.5rem. Option rows are deliberately taller for touch.

import type { ReactNode } from 'react'
import { AlertCircle, Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Type + rhythm tokens ───────────────────────────────────────────────────────

export const FIELD_LABEL = 'text-fs-sm font-semibold text-foreground'
export const FIELD_HINT  = 'text-fs-xs leading-relaxed text-muted-foreground'
export const FIELD_ERROR = 'text-fs-xs font-medium text-destructive'

/** One vertical rhythm for every field: label → hint → control → message. */
const LABEL_GAP   = 'mb-1'
const HINT_GAP    = 'mb-1.5'
const MESSAGE_GAP = 'mt-1.5'

// ─── Control surface ────────────────────────────────────────────────────────────
// One string for text, textarea, date, time, number, email, tel and url so a date
// field can never drift from a text field again.
//
// RD-RT4.0. The control used to be a white box on a white card — a rectangle you could
// only find by its 1px border, which is why a long form read as a list of outlines. It
// is now RECESSED at rest (a faint muted fill plus a 1px inset shadow) and LIFTS to a
// clean white surface with a soft brand halo on focus. The state you are in is now
// legible from the fill, not just from the border, and the focused field is the only
// lit object on the card.
//
// Height stays `h-10` (40px) to remain in exact lockstep with CustomSelect, which reads
// the global `--select-height: 2.5rem`.

const CONTROL_SHARED =
  'w-full rounded-xl border text-fs-sm text-foreground placeholder:text-muted-foreground/50 ' +
  'outline-none transition-[background-color,border-color,box-shadow] duration-150 ' +
  'disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 disabled:shadow-none ' +
  'read-only:bg-muted/50 read-only:text-muted-foreground read-only:shadow-none'

/** Recessed at rest → lit on focus. Shared by every control branch. */
const CONTROL_OK =
  'border-border bg-muted/30 shadow-[inset_0_1px_2px_rgb(15_23_42_/_0.05)] ' +
  'hover:border-border-strong hover:bg-muted/45 ' +
  'focus:border-primary/70 focus:bg-background focus:shadow-[0_0_0_4px_rgb(var(--primary-rgb)_/_0.12)]'

const CONTROL_ERR =
  'border-destructive/60 bg-destructive/[0.035] ' +
  'hover:border-destructive/80 ' +
  'focus:border-destructive focus:bg-background focus:shadow-[0_0_0_4px_rgb(220_38_38_/_0.14)]'

/** `error` swaps the whole surface channel so the control shows its own failure. */
export function controlCls(error?: boolean, extra?: string): string {
  return cn(CONTROL_SHARED, 'h-10 px-3.5', error ? CONTROL_ERR : CONTROL_OK, extra)
}

/** Same channel, but auto-height and vertical-only resize. */
export function textareaCls(error?: boolean): string {
  return cn(
    CONTROL_SHARED,
    'min-h-[92px] resize-y px-3.5 py-2.5 leading-relaxed',
    error ? CONTROL_ERR : CONTROL_OK,
  )
}

// ─── Label / hint / message ─────────────────────────────────────────────────────

export function FieldLabel({ label, required, htmlFor, id, asSpan }: {
  label:     string
  required?: boolean
  htmlFor?:  string
  id?:       string
  /** Groups (radio / checkbox / multiselect) have no single control to point at. */
  asSpan?:   boolean
}) {
  // RD-RT3.3: optional fields now say so. Previously only required fields were marked,
  // so an unmarked field was ambiguous — "did I miss something?" — and people filled in
  // things they could have skipped. Marking BOTH states removes the guesswork, and the
  // optional tag is deliberately quiet so it never competes with the label.
  const inner = (
    <>
      {label}
      {required ? (
        <>
          <span className="ml-1 text-destructive" aria-hidden>*</span>
          <span className="sr-only"> (required)</span>
        </>
      ) : (
        <span className="ml-1.5 text-fs-2xs font-medium text-muted-foreground/70">Optional</span>
      )}
    </>
  )
  return asSpan
    ? <span id={id} className={cn('block', FIELD_LABEL, LABEL_GAP)}>{inner}</span>
    : <label htmlFor={htmlFor} className={cn('block', FIELD_LABEL, LABEL_GAP)}>{inner}</label>
}

/** Helper text sits ABOVE the control — it is guidance for filling it in, not a footnote. */
export function FieldHint({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className={cn(FIELD_HINT, HINT_GAP)}>{children}</p>
}

/** Assertive so screen readers announce a failure the moment it is rendered. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className={cn('flex items-start gap-1.5', FIELD_ERROR, MESSAGE_GAP)}>
      <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

// ─── Field shell ────────────────────────────────────────────────────────────────
// Guarantees the same order and the same gaps for every field type.

export function FieldShell({ label, required, htmlFor, labelId, asSpan, hintId, hint, errorId, error, children }: {
  label:     string
  required?: boolean
  htmlFor?:  string
  labelId?:  string
  asSpan?:   boolean
  hintId:    string
  hint?:     string
  errorId:   string
  error?:    string
  children:  ReactNode
}) {
  return (
    <div>
      <FieldLabel label={label} required={required} htmlFor={htmlFor} id={labelId} asSpan={asSpan} />
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {children}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
}

// ─── Error summary ──────────────────────────────────────────────────────────────
// RD-RT3.3. On a failed submit the page scrolled to the first invalid control and left
// it at that: with six errors spread across four sections you fixed one, submitted, and
// were thrown to the next — with no idea how many remained. This is the standard
// error-summary pattern: one grouped, focusable region naming every problem, each entry
// jumping straight to its field.

export function ErrorSummary({ errors, onJump, innerRef }: {
  errors:    { id: string; label: string; message: string }[]
  onJump:    (id: string) => void
  innerRef?: React.Ref<HTMLDivElement>
}) {
  if (errors.length === 0) return null

  return (
    <div
      ref={innerRef}
      role="alert"
      tabIndex={-1}
      className="mb-4 overflow-hidden rounded-2xl border border-destructive/25 bg-card shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_18px_36px_-28px_rgb(220_38_38_/_0.45)] outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
    >
      <p className="flex items-center gap-2.5 border-b border-destructive/15 bg-destructive/[0.05] px-4 py-3 text-fs-sm font-bold text-destructive">
        <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
          <AlertCircle className="size-3.5" />
        </span>
        {errors.length === 1
          ? 'There is 1 problem to fix before continuing'
          : `There are ${errors.length} problems to fix before continuing`}
      </p>
      <ul className="flex flex-col divide-y divide-border/50">
        {errors.map(e => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onJump(e.id)}
              className="group flex w-full items-start gap-2 px-4 py-2.5 text-left text-fs-xs text-muted-foreground outline-none transition-colors hover:bg-destructive/[0.03] focus-visible:bg-destructive/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive/40"
            >
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-destructive underline underline-offset-2 group-hover:text-destructive/80">{e.label}</span>
                <span className="text-muted-foreground"> — {e.message}</span>
              </span>
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-destructive/50 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Option rows ────────────────────────────────────────────────────────────────
// Radio and checkbox options become selectable CARDS. The native control stays in the
// DOM (sr-only), so selection, keyboard behaviour, arrow-key roving inside a
// radiogroup and screen-reader semantics are exactly what the browser provides — only
// the paint is ours. `min-h-11` gives a 44px touch target on every option.

const OPTION_ROW =
  'group relative flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-xl border px-3.5 py-2.5 ' +
  'text-fs-sm text-foreground transition-[background-color,border-color,box-shadow,transform] duration-150 ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/50 has-[:focus-visible]:ring-offset-2 ' +
  'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60'

// RD-REGISTRATION-UX — the CHECK MARK is the selected signal (primary gradient fill).
// The row previously added a second border, a wash AND a coloured drop shadow on top of
// it; stacked with the section's own primary border that read as an error state rather
// than a selection. The wash stays (it still distinguishes the row), the border softens,
// and the redundant coloured shadow goes. The focus ring in OPTION_ROW is untouched.
const OPTION_STATE =
  'border-border bg-muted/25 hover:border-border-strong hover:bg-muted/45 motion-safe:hover:-translate-y-px ' +
  'has-[:checked]:border-primary/25 has-[:checked]:bg-[rgb(var(--primary-rgb)_/_0.04)] ' +
  'has-[:checked]:motion-safe:translate-y-0'

/** Radio dot — an empty ring that fills with the brand gradient when checked. */
const RADIO_MARK =
  'flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-border-strong bg-card transition-all duration-150 ' +
  'peer-checked:border-transparent peer-checked:bg-[image:var(--primary-gradient)] ' +
  'peer-checked:shadow-[0_2px_8px_rgb(var(--primary-rgb)_/_0.40)] ' +
  'peer-checked:[&>span]:scale-100'

/** Checkbox mark — box fills with the brand gradient, tick fades in. */
const CHECK_MARK =
  'flex size-5 shrink-0 items-center justify-center rounded-[7px] border-2 border-border-strong bg-card transition-all duration-150 ' +
  'peer-checked:border-transparent peer-checked:bg-[image:var(--primary-gradient)] ' +
  'peer-checked:shadow-[0_2px_8px_rgb(var(--primary-rgb)_/_0.40)] ' +
  'peer-checked:[&>svg]:opacity-100'

export function RadioOption({ name, option, checked, disabled, onSelect }: {
  name:     string
  option:   string
  checked:  boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <label className={cn(OPTION_ROW, OPTION_STATE)}>
      <input
        type="radio"
        name={name}
        value={option}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="peer sr-only"
      />
      <span className={RADIO_MARK} aria-hidden>
        <span className="size-2 scale-0 rounded-full bg-white transition-transform duration-150" />
      </span>
      <span className="min-w-0 font-medium">{option}</span>
    </label>
  )
}

export function CheckOption({ id, option, checked, disabled, onToggle, children }: {
  id?:       string
  option?:   string
  checked:   boolean
  disabled:  boolean
  onToggle:  (next: boolean) => void
  /** Rich label (consent copy). Falls back to `option`. */
  children?: ReactNode
}) {
  return (
    <label className={cn(OPTION_ROW, OPTION_STATE, 'items-start')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onToggle(e.target.checked)}
        className="peer sr-only"
      />
      <span className={cn(CHECK_MARK, 'mt-px')} aria-hidden>
        <Check className="size-3 text-white opacity-0 transition-opacity duration-150" strokeWidth={3} />
      </span>
      <span className="min-w-0 font-medium">{children ?? option}</span>
    </label>
  )
}

/** Multi-select pills — same height rules as the option rows, pill shape retained. */
export function TogglePill({ option, checked, disabled, onToggle }: {
  option:   string
  checked:  boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked}
      onClick={onToggle}
      className={cn(
        'inline-flex min-h-10 items-center rounded-full border px-4 text-fs-sm font-semibold outline-none',
        'transition-[background-color,border-color,box-shadow,color] duration-150',
        'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60',
        checked
          ? 'border-transparent bg-[image:var(--primary-gradient)] text-white shadow-[0_2px_12px_-4px_rgb(var(--primary-rgb)_/_0.50)]'
          : 'border-border bg-muted/25 text-foreground hover:border-border-strong hover:bg-muted/45',
      )}
    >
      {option}
    </button>
  )
}
