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
import { AlertCircle, Check } from 'lucide-react'
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

const CONTROL_SHARED =
  'w-full rounded-xl border bg-background text-fs-sm text-foreground placeholder:text-muted-foreground/50 ' +
  'outline-none transition-colors ' +
  'disabled:cursor-not-allowed disabled:bg-muted/30 disabled:opacity-60 ' +
  'read-only:bg-muted/20 read-only:text-muted-foreground'

/** `error` swaps the whole border/ring channel so the control shows its own failure. */
export function controlCls(error?: boolean, extra?: string): string {
  return cn(
    CONTROL_SHARED,
    'h-10 px-3.5',
    error
      ? 'border-destructive/70 focus:border-destructive focus:ring-2 focus:ring-destructive/20'
      : 'border-border hover:border-border/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/20',
    extra,
  )
}

/** Same channel, but auto-height and vertical-only resize. */
export function textareaCls(error?: boolean): string {
  return cn(
    CONTROL_SHARED,
    'min-h-[88px] resize-y px-3.5 py-2.5 leading-relaxed',
    error
      ? 'border-destructive/70 focus:border-destructive focus:ring-2 focus:ring-destructive/20'
      : 'border-border hover:border-border/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/20',
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
      className="mb-4 rounded-2xl border border-destructive/30 bg-destructive/[0.04] p-4 outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
    >
      <p className="flex items-center gap-2 text-fs-sm font-bold text-destructive">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        {errors.length === 1
          ? 'There is 1 problem to fix before continuing'
          : `There are ${errors.length} problems to fix before continuing`}
      </p>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {errors.map(e => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onJump(e.id)}
              className="rounded text-left text-fs-xs text-destructive underline underline-offset-2 outline-none hover:text-destructive/80 focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:ring-offset-2"
            >
              <span className="font-semibold">{e.label}</span> — {e.message}
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
  'text-fs-sm text-foreground transition-colors ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/50 has-[:focus-visible]:ring-offset-2 ' +
  'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60'

const OPTION_STATE =
  'border-border bg-card hover:border-primary/40 hover:bg-muted/20 ' +
  'has-[:checked]:border-primary has-[:checked]:bg-primary/[0.04] has-[:checked]:ring-1 has-[:checked]:ring-primary/20'

/** Radio dot — a ring that thickens into a filled dot when checked. */
const RADIO_MARK =
  'size-[18px] shrink-0 rounded-full border-2 border-border transition-all ' +
  'peer-checked:border-[5px] peer-checked:border-primary'

/** Checkbox mark — box fills, tick fades in. */
const CHECK_MARK =
  'flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border-2 border-border transition-colors ' +
  'peer-checked:border-primary peer-checked:bg-primary peer-checked:[&>svg]:opacity-100'

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
      <span className={RADIO_MARK} aria-hidden />
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
        <Check className="size-3 text-white opacity-0 transition-opacity" strokeWidth={3} />
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
        'inline-flex min-h-9 items-center rounded-full border px-4 text-fs-sm font-medium outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60',
        checked
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-muted/20',
      )}
    >
      {option}
    </button>
  )
}
