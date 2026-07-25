'use client'

import { useState, useCallback, useMemo, useEffect, useRef, Fragment } from 'react'
import { useRouter }              from 'next/navigation'
import { useAuth }                from '@/components/auth/AuthProvider'
import { motion }                 from 'framer-motion'
import { Calendar, MapPin, Globe, ShieldCheck, Zap, RotateCcw, Check, AlertTriangle } from 'lucide-react'
import { cn }                     from '@/lib/utils/cn'
import { buildRegisterHref }      from '@/lib/events/registerHref'
import { buttonVariants }         from '@/components/ui/button'
import { CustomSelect }           from '@/components/ui/CustomSelect'
import type { FormSection, FormField, ConditionalRule, FieldType } from '@/components/wizard/registrationFormConfig'
import { resolveAttendeeIdentity } from '@/lib/registrations/attendeeIdentity'
import { collectFormErrors } from '@/lib/registrations/validateFormResponses'
import { TAX_INCLUSIVE_NOTE } from '@/lib/pricing/copy'
import type { FeeBreakdownRecord } from '@/lib/fees/types'
import { buildAttendeeFeeBreakdown, formatPaise, type AttendeeFeeBreakdown } from '@/lib/fees/attendeeBreakdown'

// ─── Razorpay checkout (loaded dynamically from checkout.razorpay.com) ─────────

interface RazorpayPaymentSuccess {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}
// Window.Razorpay is declared once, globally, in types/razorpay.d.ts.

function loadRazorpayScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script    = document.createElement('script')
    script.src      = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload   = () => resolve()
    script.onerror  = () => reject(new Error('Failed to load Razorpay checkout'))
    document.body.appendChild(script)
  })
}

function openRazorpayCheckout(opts: {
  keyId:         string
  orderId:       string
  amount:        number    // paise
  currency:      string
  eventName:     string
  passName:      string
  attendeeName:  string
  attendeeEmail: string
  attendeePhone?: string
}): Promise<RazorpayPaymentSuccess> {
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key:         opts.keyId,
      amount:      opts.amount,
      currency:    opts.currency,
      order_id:    opts.orderId,
      name:        opts.eventName,
      description: opts.passName,
      prefill: {
        name:    opts.attendeeName,
        email:   opts.attendeeEmail,
        contact: opts.attendeePhone,
      },
      handler: resolve,
      modal:   { ondismiss: () => reject(new Error('PAYMENT_CANCELLED')) },
      theme:   { color: '#e5277e' },   // GA-7D S2: brand primary (was an off-brand violet); Razorpay needs a hex, not a token
    })
    rzp.open()
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PassInfo {
  id:           string
  name:         string
  price:        number   // effective price (early-bird while active, else regular)
  regularPrice: number   // regular price — shown struck through when early bird is active
  isFree:       boolean
}

export interface RegisterClientProps {
  eventSlug:          string
  eventName:          string
  startDate:          string | null
  startTime?:         string | null
  bannerUrl?:         string
  venueName?:         string
  venueCity?:         string
  venueType?:         string
  // H-7: all selectable passes + the initially-selected one, so the pass can be switched
  // in-form. `sections` is the FULL set (all passes) — filtered per selected pass client-side.
  passes:             PassInfo[]
  initialPassId:      string
  sections:           FormSection[]
  conditionalRules:   ConditionalRule[]
  approvalMode:       'auto' | 'manual'
  requireLogin:       boolean
  requiresInviteCode: boolean
}

type FieldState = { visible: boolean; required: boolean; disabled: boolean }

// ─── Conditional logic (mirrors RegistrationFormBuilder.evaluateRule/applyRules) ─

function evaluateRule(rule: ConditionalRule, values: Record<string, string>): boolean {
  if (!rule.enabled) return false
  const v  = (values[rule.sourceFieldId] ?? '').toString()
  const rv = rule.value
  switch (rule.operator) {
    case 'equals':       return v.toLowerCase() === rv.toLowerCase()
    case 'not_equals':   return v.toLowerCase() !== rv.toLowerCase()
    case 'contains':     return v.toLowerCase().includes(rv.toLowerCase())
    case 'not_contains': return !v.toLowerCase().includes(rv.toLowerCase())
    case 'greater_than': return Number(v) > Number(rv)
    case 'less_than':    return Number(v) < Number(rv)
    case 'is_empty':     return v.trim() === ''
    case 'is_not_empty': return v.trim() !== ''
    default:             return false
  }
}

function computeFieldStates(
  allFields: FormField[],
  rules:     ConditionalRule[],
  values:    Record<string, string>,
): Map<string, FieldState> {
  const state = new Map<string, FieldState>(
    allFields.map(f => [f.id, { visible: f.visible, required: f.required, disabled: false }]),
  )
  for (const rule of rules) {
    if (!evaluateRule(rule, values)) continue
    const s = state.get(rule.targetFieldId)
    if (!s) continue
    switch (rule.action) {
      case 'show':          s.visible   = true;  break
      case 'hide':          s.visible   = false; break
      case 'require':       s.required  = true;  break
      case 'make_optional': s.required  = false; break
      case 'enable':        s.disabled  = false; break
      case 'disable':       s.disabled  = true;  break
    }
  }
  return state
}

// ─── Field Renderer ───────────────────────────────────────────────────────────

const inputCls =
  'h-10 w-full rounded-xl border border-border bg-background px-3.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1.5 block text-[13px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[11.5px] text-muted-foreground'
const errorCls = 'mt-1 text-[11.5px] text-destructive'

// C-2: an element whose focus opens the on-screen keyboard (so the mobile checkout bar
// can step out of the keyboard's way). CustomSelect is a div-combobox, not a native
// control, and never opens the keyboard — so it's intentionally excluded.
function isKeyboardField(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

// H-7: whether a field is shown for a given pass (mirrors the server's passShowsField).
function passShowsField(field: FormField, passId: string): boolean {
  return field.passVisibility === 'all'
    || (Array.isArray(field.passVisibility) && field.passVisibility.includes(passId))
}

function inputTypeFor(type: FieldType): React.HTMLInputTypeAttribute {
  switch (type) {
    case 'email':   return 'email'
    case 'mobile':  return 'tel'
    case 'number':  return 'number'
    case 'date':    return 'date'
    case 'time':    return 'time'
    case 'url':     return 'url'
    default:        return 'text'
  }
}

// H7: native mobile keyboard + autofill hints per field type. Attribute-only — no
// layout change. Name-like text fields get `autocomplete="name"`; email/tel/url get the
// matching keyboard + autofill and never auto-capitalize or spellcheck.
interface NativeInputProps {
  autoComplete?:   string
  inputMode?:      'text' | 'email' | 'tel' | 'url' | 'numeric' | 'decimal'
  enterKeyHint?:   'enter' | 'done' | 'go' | 'next' | 'search' | 'send'
  autoCapitalize?: string
  spellCheck?:     boolean
}
function nativeInputProps(field: FormField): NativeInputProps {
  switch (field.type) {
    case 'email':   return { autoComplete: 'email', inputMode: 'email', autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'next' }
    case 'mobile':  return { autoComplete: 'tel',   inputMode: 'tel',   autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'next' }
    case 'url':     return { autoComplete: 'url',   inputMode: 'url',   autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'next' }
    case 'number':  return { inputMode: 'numeric', autoCapitalize: 'none', spellCheck: false, enterKeyHint: 'next' }
    case 'city':    return { autoComplete: 'address-level2', autoCapitalize: 'words', enterKeyHint: 'next' }
    case 'state':   return { autoComplete: 'address-level1', autoCapitalize: 'words', enterKeyHint: 'next' }
    case 'country': return { autoComplete: 'country-name',   autoCapitalize: 'words', enterKeyHint: 'next' }
    case 'text': {
      const label = field.label.toLowerCase()
      if (/\bname\b/.test(label) && !/(company|organi|team|group|user|file|event|project|product|brand)/.test(label)) {
        return { autoComplete: 'name', autoCapitalize: 'words', enterKeyHint: 'next' }
      }
      return { autoCapitalize: 'sentences', enterKeyHint: 'next' }
    }
    default:        return {}
  }
}

// H9: the ids a field's control should be described by — its helper text and/or its
// (assertive) error — so screen readers announce both.
function describedBy(id: string, helperText: string, error: string | undefined): string | undefined {
  const ids: string[] = []
  if (helperText && !error) ids.push(`${id}-hint`)
  if (error) ids.push(`${id}-error`)
  return ids.length ? ids.join(' ') : undefined
}

function FieldRenderer({
  field,
  state,
  value,
  error,
  onChange,
  onBlur,
}: {
  field:    FormField
  state:    FieldState
  value:    string
  error:    string | undefined
  onChange: (id: string, val: string) => void
  onBlur?:  (id: string) => void
}) {
  if (!state.visible) return null

  const { id, label, type, placeholder, helperText, options } = field
  const disabled = state.disabled
  const req      = state.required

  const labelEl = (
    <label htmlFor={id} className={labelCls}>
      {label}
      {req && <span className="ml-1 text-destructive" aria-hidden>*</span>}
    </label>
  )
  // Groups (radio/checkbox/multiselect) have no single input, so their name is an
  // id'd span referenced by the group's aria-labelledby (H9).
  const groupLabelEl = (
    <span id={`${id}-label`} className={labelCls}>
      {label}
      {req && <span className="ml-1 text-destructive" aria-hidden>*</span>}
    </span>
  )
  // Errors are assertive live regions so screen readers announce them (H9).
  const errorEl = error ? <p id={`${id}-error`} role="alert" className={errorCls}>{error}</p> : null

  // ── Textarea ────────────────────────────────────────────────────────────────
  if (type === 'textarea' || type === 'address') {
    return (
      <div>
        {labelEl}
        <textarea
          id={id}
          rows={3}
          disabled={disabled}
          required={req}
          aria-required={req || undefined}
          placeholder={placeholder || undefined}
          value={value}
          onChange={e => onChange(id, e.target.value)}
          onBlur={() => onBlur?.(id)}
          className="w-full resize-y rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
          aria-invalid={!!error}
          aria-describedby={describedBy(id, helperText, error)}
        />
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {errorEl}
      </div>
    )
  }

  // ── Dropdown / Select ───────────────────────────────────────────────────────
  if (type === 'dropdown') {
    return (
      <div>
        {labelEl}
        <CustomSelect
          id={id}
          value={value}
          options={options}
          placeholder={placeholder || 'Select…'}
          disabled={disabled}
          onChange={v => onChange(id, v)}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, helperText, error)}
        />
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {errorEl}
      </div>
    )
  }

  // ── Radio ───────────────────────────────────────────────────────────────────
  if (type === 'radio' || type === 'yesno') {
    const opts = type === 'yesno' ? ['Yes', 'No'] : options
    return (
      <div>
        {groupLabelEl}
        <div
          className="mt-1 flex flex-wrap gap-2"
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-required={req || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {opts.map(opt => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/[0.04]"
            >
              <input
                type="radio"
                name={id}
                value={opt}
                checked={value === opt}
                disabled={disabled}
                onChange={() => onChange(id, opt)}
                className="accent-primary"
              />
              {opt}
            </label>
          ))}
        </div>
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {errorEl}
      </div>
    )
  }

  // ── Checkbox (single consent or group) ───────────────────────────────────
  if (type === 'checkbox') {
    if (options.length === 0) {
      return (
        <div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              id={id}
              type="checkbox"
              disabled={disabled}
              required={req}
              aria-required={req || undefined}
              aria-invalid={!!error}
              aria-describedby={describedBy(id, helperText, error)}
              checked={value === 'true'}
              onChange={e => onChange(id, e.target.checked ? 'true' : '')}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            />
            <span className="text-[13px] text-foreground">
              {label}
              {req && <span className="ml-1 text-destructive" aria-hidden>*</span>}
            </span>
          </label>
          {helperText && !error && <p className={hintCls}>{helperText}</p>}
          {error && <p className={errorCls}>{error}</p>}
        </div>
      )
    }
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <div>
        {groupLabelEl}
        <div
          className="mt-1 flex flex-col gap-2"
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {options.map(opt => {
            const checked = selected.includes(opt)
            return (
              <label key={opt} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? selected.filter(s => s !== opt)
                      : [...selected, opt]
                    onChange(id, next.join(', '))
                  }}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                />
                {opt}
              </label>
            )
          })}
        </div>
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {errorEl}
      </div>
    )
  }

  // ── Multiselect (pill toggle group) ───────────────────────────────────────
  if (type === 'multiselect') {
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <div>
        {groupLabelEl}
        <div
          className="mt-1 flex flex-wrap gap-2"
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {options.map(opt => {
            const checked = selected.includes(opt)
            return (
              <button
                key={opt}
                type="button"
                disabled={disabled}
                aria-pressed={checked}
                onClick={() => {
                  const next = checked
                    ? selected.filter(s => s !== opt)
                    : [...selected, opt]
                  onChange(id, next.join(', '))
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors disabled:opacity-50',
                  checked
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card text-foreground hover:border-primary/40',
                )}
              >
                {opt}
              </button>
            )
          })}
        </div>
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {errorEl}
      </div>
    )
  }

  // ── Default: text / email / tel / number / date / time / url / country / state / city ──
  return (
    <div>
      {labelEl}
      <input
        id={id}
        type={inputTypeFor(type)}
        disabled={disabled}
        required={req}
        aria-required={req || undefined}
        placeholder={placeholder || undefined}
        value={value}
        onChange={e => onChange(id, e.target.value)}
        onBlur={() => onBlur?.(id)}
        className={inputCls + (disabled ? ' opacity-50' : '')}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, helperText, error)}
        {...nativeInputProps(field)}
      />
      {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
      {errorEl}
    </div>
  )
}

// ─── Section Block ────────────────────────────────────────────────────────────

function SectionBlock({
  section,
  fieldStates,
  values,
  errors,
  onChange,
  onBlur,
}: {
  section:     FormSection
  fieldStates: Map<string, FieldState>
  values:      Record<string, string>
  errors:      Record<string, string>
  onChange:    (id: string, val: string) => void
  onBlur?:     (id: string) => void
}) {
  const visibleFields = section.fields.filter(f => {
    const s = fieldStates.get(f.id)
    return s?.visible !== false
  })
  if (visibleFields.length === 0) return null

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {section.title && (
        <div className="border-b border-border/60 bg-muted/[0.03] px-5 py-3.5">
          {/* M-4: section titles are proper headings for screen-reader structure */}
          <h2 className="text-[14px] font-semibold text-foreground">{section.title}</h2>
          {section.description && (
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{section.description}</p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-4 px-5 py-5">
        {visibleFields.map(field => (
          <FieldRenderer
            key={field.id}
            field={field}
            state={fieldStates.get(field.id) ?? { visible: true, required: field.required, disabled: false }}
            value={values[field.id] ?? ''}
            error={errors[field.id]}
            onChange={onChange}
            onBlur={onBlur}
          />
        ))}
      </div>
    </section>
  )
}

// ─── Progress Indicator ───────────────────────────────────────────────────────

function ProgressIndicator({
  sections,
  activeIdx,
  completedCount,
}: {
  sections:       FormSection[]
  activeIdx:      number   // -1 = all complete
  completedCount: number
}) {
  if (sections.length <= 1) return null
  const total      = sections.length
  const allDone    = activeIdx === -1
  const activeStep = allDone ? total - 1 : activeIdx

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13.5px] font-semibold text-foreground">
          {allDone
            ? sections[total - 1]?.title ?? `Step ${total}`
            : sections[activeStep]?.title ?? `Step ${activeStep + 1}`}
        </p>
        <p className="text-[12px] font-medium text-muted-foreground">
          {allDone ? total : completedCount} of {total} complete
        </p>
      </div>

      <div className="flex items-center">
        {sections.map((s, i) => {
          const done   = allDone || i < activeIdx
          const active = !allDone && i === activeIdx
          return (
            <Fragment key={s.id}>
              {/* Step dot */}
              <div
                className={cn(
                  'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold transition-all duration-300',
                  done
                    ? 'border-primary bg-primary text-white'
                    : active
                      ? 'border-primary bg-background text-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]'
                      : 'border-border bg-background text-muted-foreground/50',
                )}
                aria-label={`Step ${i + 1}${done ? ' (complete)' : active ? ' (current)' : ''}`}
              >
                {done ? <Check className="size-3" aria-hidden /> : i + 1}
              </div>

              {/* Connector line */}
              {i < total - 1 && (
                <div className="relative h-0.5 flex-1 bg-border">
                  <motion.div
                    className="absolute inset-y-0 left-0 bg-primary"
                    initial={{ width: '0%' }}
                    animate={{ width: done ? '100%' : '0%' }}
                    transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

interface CouponState {
  code:          string
  discountPaise: number
  finalPaise:    number
  description:   string
}

function SummaryCard({
  eventName,
  bannerUrl,
  venueName,
  venueCity,
  venueType,
  startDate,
  startTime,
  passName,
  isPaid,
  price,
  regularPrice,
  couponApplied,
}: {
  eventName:     string
  bannerUrl:     string
  venueName:     string
  venueCity:     string
  venueType:     string
  startDate:     string | null
  startTime:     string | null
  passName:      string
  isPaid:        boolean
  price:         number          // rupees (effective)
  regularPrice:  number          // rupees (regular, for early-bird strikethrough)
  couponApplied: CouponState | null
}) {
  function fmtDate(d: string | null) {
    if (!d) return ''
    try {
      return new Date(d).toLocaleDateString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
      })
    } catch { return d }
  }
  function fmtTime(t: string | null) {
    if (!t) return ''
    try {
      const [h, m] = t.split(':').map(Number)
      const dt = new Date(); dt.setHours(h, m ?? 0, 0)
      return dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    } catch { return t }
  }

  const dateStr    = fmtDate(startDate)
  const timeStr    = fmtTime(startTime)
  const isOnline   = venueType === 'online'
  const venueLabel = isOnline
    ? (venueName || 'Online Event')
    : [venueName, venueCity].filter(Boolean).join(', ') || null

  const originalPrice = price
  const finalPrice    = couponApplied ? couponApplied.finalPaise / 100 : price
  const discount      = couponApplied ? couponApplied.discountPaise / 100 : 0
  // Early bird is active when the effective price is below the regular price.
  // Suppressed while a coupon is applied (the coupon strikethrough takes over).
  const isEarlyBird   = isPaid && !couponApplied && regularPrice > price

  const priceDisplay = !isPaid
    ? 'Free'
    : couponApplied
      ? couponApplied.finalPaise === 0 ? 'Free' : `₹${finalPrice.toLocaleString('en-IN')}`
      : `₹${originalPrice.toLocaleString('en-IN')}`

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">

      {/* Banner or fallback header */}
      {bannerUrl ? (
        <div className="relative aspect-[16/7] overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-4">
            <p className="text-[14px] font-bold leading-snug text-white drop-shadow">{eventName}</p>
          </div>
        </div>
      ) : (
        <div className="border-b border-border bg-gradient-to-br from-primary/[0.08] to-primary/[0.03] px-4 py-3.5">
          <p className="text-[15px] font-bold text-foreground">{eventName}</p>
        </div>
      )}

      <div className="divide-y divide-border/50">

        {/* Pass + price */}
        <div className="px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Pass</p>
              <p className="mt-0.5 text-[13.5px] font-semibold text-foreground">{passName}</p>
            </div>
            <div className="shrink-0 text-right">
              {isPaid && couponApplied ? (
                <>
                  <p className="text-[12px] text-muted-foreground line-through">
                    ₹{originalPrice.toLocaleString('en-IN')}
                  </p>
                  <p className={cn(
                    'text-[16px] font-bold',
                    couponApplied.finalPaise === 0 ? 'text-emerald-600' : 'text-emerald-600',
                  )}>
                    {priceDisplay}
                  </p>
                </>
              ) : isEarlyBird ? (
                <>
                  <p className="text-[12px] text-muted-foreground line-through">
                    ₹{regularPrice.toLocaleString('en-IN')}
                  </p>
                  <p className="text-[16px] font-bold text-emerald-600">{priceDisplay}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">Early bird</p>
                </>
              ) : (
                <p className="text-[16px] font-bold text-foreground">{priceDisplay}</p>
              )}
            </div>
          </div>
        </div>

        {/* Date + venue */}
        {(dateStr || venueLabel) && (
          <div className="space-y-2.5 px-4 py-3.5">
            {dateStr && (
              <div className="flex items-start gap-2.5 text-[12.5px]">
                <Calendar className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-foreground">
                  {dateStr}
                  {timeStr && <span className="text-muted-foreground"> · {timeStr}</span>}
                </span>
              </div>
            )}
            {venueLabel && (
              <div className="flex items-start gap-2.5 text-[12.5px]">
                {isOnline
                  ? <Globe  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  : <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                }
                <span className="text-foreground">{venueLabel}</span>
              </div>
            )}
          </div>
        )}

        {/* Coupon breakdown */}
        {isPaid && couponApplied && (
          <div className="bg-emerald-50/70 px-4 py-3.5">
            <div className="space-y-1.5 text-[12.5px]">
              <div className="flex justify-between text-muted-foreground">
                <span>Original price</span>
                <span>₹{originalPrice.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between text-emerald-700">
                <span className="flex items-center gap-1.5">
                  Discount
                  <span className="rounded bg-emerald-100 px-1 py-0.5 font-mono text-[10px] font-bold">
                    {couponApplied.code}
                  </span>
                </span>
                <span>−₹{discount.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between border-t border-emerald-200/80 pt-1.5 font-semibold text-foreground">
                <span>Total</span>
                <span className="text-emerald-700">{priceDisplay}</span>
              </div>
            </div>
          </div>
        )}

        {/* M3: tax messaging consistent with Event Details / ticket cards */}
        {isPaid && (
          <div className="px-4 py-2.5 text-[11.5px] text-muted-foreground">{TAX_INCLUSIVE_NOTE}</div>
        )}

        {/* Razorpay trust note */}
        <div className="flex items-center gap-2 px-4 py-3 text-[11.5px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
          <span>Secured by Razorpay</span>
        </div>
      </div>
    </div>
  )
}

// ─── Trust Badges ─────────────────────────────────────────────────────────────

function TrustBadges({ isPaid }: { isPaid: boolean }) {
  return (
    <div className="mt-5 rounded-xl border border-border/50 bg-muted/[0.03] px-4 py-3.5">
      <div className="flex flex-col gap-2">
        {isPaid && (
          <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            <span>Secure payment processed by Razorpay</span>
          </div>
        )}
        <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
          <Zap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span>Ticket delivered instantly to your email</span>
        </div>
        <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
          <RotateCcw className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>Refund policy set by the event organiser</span>
        </div>
      </div>
    </div>
  )
}

// ─── Pass switcher (H-7) ────────────────────────────────────────────────────────

function PassSwitcher({ passes, selectedId, onSelect, switching }: {
  passes:     PassInfo[]
  selectedId: string
  onSelect:   (id: string) => void
  switching:  boolean
}) {
  return (
    <div className="mb-6" role="radiogroup" aria-label="Select your pass">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Your pass</p>
      <div className="flex flex-col gap-2">
        {passes.map(p => {
          const active = p.id === selectedId
          const price  = p.isFree || p.price === 0 ? 'Free' : `₹${p.price.toLocaleString('en-IN')}`
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={switching}
              onClick={() => onSelect(p.id)}
              className={cn(
                'flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60',
                active ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/20' : 'border-border bg-card hover:border-primary/40',
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-primary' : 'border-border')}>
                  {active && <span className="size-2 rounded-full bg-primary" aria-hidden />}
                </span>
                <span className="truncate text-[13.5px] font-semibold text-foreground">{p.name}</span>
              </span>
              <span className="shrink-0 text-[13.5px] font-bold text-foreground">{price}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function RegisterClient({
  eventSlug,
  eventName,
  startDate,
  startTime    = null,
  bannerUrl    = '',
  venueName    = '',
  venueCity    = '',
  venueType    = 'physical',
  passes,
  initialPassId,
  sections,
  conditionalRules,
  approvalMode,
  requireLogin,
  requiresInviteCode,
}: RegisterClientProps) {
  const router = useRouter()

  // H-7: the selected pass is client state → switchable in-form without navigation.
  const [selectedPassId, setSelectedPassId] = useState(initialPassId)
  const pass = (passes.find(p => p.id === selectedPassId) ?? passes[0])!

  // Full field set (all passes) drives conditional state exactly like the server validator.
  const fullFields = useMemo(() => sections.flatMap(s => s.fields), [sections])

  // Sections actually shown for the SELECTED pass (visibility + passVisibility); empty
  // sections dropped. Mirrors the server's per-pass filter, applied client-side so the pass
  // can change without a round-trip. Entered `values` are untouched by a switch.
  const passSections = useMemo(
    () => sections
      .map(s => ({ ...s, fields: s.fields.filter(f => f.visible !== false && passShowsField(f, selectedPassId)) }))
      .filter(s => s.fields.length > 0),
    [sections, selectedPassId],
  )
  const allFields = useMemo(() => passSections.flatMap(s => s.fields), [passSections])

  const [values,         setValues]         = useState<Record<string, string>>({})
  const [errors,         setErrors]         = useState<Record<string, string>>({})
  const [submitError,    setSubmitError]    = useState<string | null>(null)
  const [submitting,     setSubmitting]     = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  // H-4: a cancelled/failed Razorpay payment parks the still-valid order here so the
  // attendee can retry the SAME order (no new order, no duplicate registration) or return.
  const [paymentRecovery, setPaymentRecovery] = useState<{
    order:    { orderId: string; amount: number; currency: string; keyId: string }
    attendee: { name: string; email: string; phone?: string }
  } | null>(null)
  // RD-PAYMENT-05 B1: when the attendee bears the fees (attendee_pays), the order is parked
  // here with its canonical breakdown so the exact charge is shown and explicitly confirmed
  // BEFORE Razorpay opens. Null for organizer_absorbs / free → checkout is unchanged.
  const [feeConfirm, setFeeConfirm] = useState<{
    order:     { orderId: string; amount: number; currency: string; keyId: string }
    attendee:  { name: string; email: string; phone?: string }
    breakdown: AttendeeFeeBreakdown
  } | null>(null)
  // C-2: the mobile checkout bar steps aside while a keyboard field is focused.
  const [fieldFocused, setFieldFocused] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  // M-4: brief "Draft saved" confirmation after the autosave settles.
  const [draftSaved, setDraftSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // C2: persist entered answers per-EVENT (not per-pass) so changing the selected pass —
  // which is a URL param that remounts this component — restores the attendee's completed
  // fields instead of wiping them. Pass-dependent state (the coupon, the pass itself) still
  // resets on the remount. Cleared on successful submit.
  const storageKey  = `rd:reg:${eventSlug}`
  const restoredRef = useRef(false)

  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    let cancelled = false
    const run = async () => {
      try {
        const saved = sessionStorage.getItem(storageKey)
        if (cancelled || !saved) return
        const parsed   = JSON.parse(saved) as Record<string, string>
        const validIds = new Set(fullFields.map(f => f.id))  // keep values for ALL passes' fields (H-7 switch)
        const filtered: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (validIds.has(k) && typeof v === 'string') filtered[k] = v
        }
        if (!cancelled && Object.keys(filtered).length > 0) setValues(filtered)
      } catch { /* ignore corrupt / unavailable storage */ }
    }
    void run()
    return () => { cancelled = true }
  }, [storageKey, fullFields])

  useEffect(() => {
    try {
      if (Object.keys(values).length > 0) sessionStorage.setItem(storageKey, JSON.stringify(values))
    } catch { /* ignore quota / disabled storage */ }
  }, [values, storageKey])

  // M-4: show a small "Draft saved" note ~0.6s after the last edit (debounced, not per keystroke).
  useEffect(() => {
    if (Object.keys(values).length === 0) return
    const t = setTimeout(() => {
      setDraftSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setDraftSaved(false), 1600)
    }, 600)
    return () => clearTimeout(t)
  }, [values])

  const clearSavedForm = useCallback(() => {
    try { sessionStorage.removeItem(storageKey) } catch { /* ignore */ }
  }, [storageKey])

  const isPaid = !pass.isFree && (pass.price ?? 0) > 0

  // M5: prefetch the Razorpay checkout script the moment registration becomes likely —
  // i.e. once the attendee starts filling a PAID form — so it's already loaded when they
  // submit, instead of being fetched after order creation (latency at the worst moment).
  // Idempotent (loadRazorpayScript no-ops if already present); never runs for free passes.
  const rzpPrefetchedRef = useRef(false)
  useEffect(() => {
    if (!isPaid || rzpPrefetchedRef.current) return
    if (Object.keys(values).length === 0) return
    rzpPrefetchedRef.current = true
    void loadRazorpayScript().catch(() => {})
  }, [values, isPaid])

  // ── Invite code gate ──────────────────────────────────────────────────────
  const [inviteCodeVerified, setInviteCodeVerified] = useState(!requiresInviteCode)
  const [inviteCodeInput,    setInviteCodeInput]    = useState('')
  const [inviteCodeError,    setInviteCodeError]    = useState<string | null>(null)
  const [inviteCodeChecking, setInviteCodeChecking] = useState(false)
  const [verifiedCode,       setVerifiedCode]       = useState('')

  // ── Coupon state ──────────────────────────────────────────────────────────
  const [couponInput,    setCouponInput]    = useState('')
  const [couponChecking, setCouponChecking] = useState(false)
  const [couponError,    setCouponError]    = useState<string | null>(null)
  const [couponApplied,  setCouponApplied]  = useState<CouponState | null>(null)
  const [couponRevalidating, setCouponRevalidating] = useState(false)   // H-7: while re-checking a coupon after a pass switch

  // H-7: switch the selected pass in-form. Entered `values` are preserved; the coupon is
  // re-validated against the new pass (kept if still valid, cleared otherwise); pricing and
  // the summary recompute from the derived `pass`. No navigation, no checkout-API change.
  async function switchPass(newId: string) {
    if (newId === selectedPassId) return
    setSelectedPassId(newId)
    setSubmitError(null)
    setPaymentRecovery(null)
    setIdempotencyKey(crypto.randomUUID())   // a switched pass is a distinct registration attempt

    const applied = couponApplied
    if (!applied) return
    const target = passes.find(p => p.id === newId)
    if (!target || target.isFree || target.price <= 0) { setCouponApplied(null); return }

    setCouponRevalidating(true)
    try {
      const res  = await fetch('/api/registrations/validate-coupon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: eventSlug, passId: newId, couponCode: applied.code }),
      })
      const json = await res.json() as { valid: boolean; discountPaise?: number; finalPaise?: number; description?: string; error?: string }
      if (json.valid) {
        setCouponApplied({ code: applied.code, discountPaise: json.discountPaise!, finalPaise: json.finalPaise!, description: json.description ?? '' })
      } else {
        setCouponApplied(null)
        setCouponError(`Coupon ${applied.code} isn't valid for this pass.`)
      }
    } catch {
      setCouponApplied(null)   // never keep a stale discount from another pass
    } finally {
      setCouponRevalidating(false)
    }
  }

  async function handleApplyCoupon() {
    const code = couponInput.trim().toUpperCase()
    if (!code) { setCouponError('Please enter a coupon code.'); return }
    setCouponError(null)
    setCouponChecking(true)
    try {
      const res  = await fetch('/api/registrations/validate-coupon', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug: eventSlug, passId: pass.id, couponCode: code }),
      })
      const json = await res.json() as {
        valid: boolean; discountPaise?: number; finalPaise?: number
        description?: string; error?: string
      }
      if (json.valid) {
        setCouponApplied({
          code,
          discountPaise: json.discountPaise!,
          finalPaise:    json.finalPaise!,
          description:   json.description ?? '',
        })
        setCouponInput('')
      } else {
        setCouponError(json.error ?? 'Invalid coupon code.')
      }
    } catch {
      setCouponError('Network error. Please try again.')
    } finally {
      setCouponChecking(false)
    }
  }

  function handleRemoveCoupon() {
    setCouponApplied(null)
    setCouponError(null)
  }

  async function handleVerifyInviteCode() {
    const code = inviteCodeInput.trim()
    if (!code) { setInviteCodeError('Please enter an invite code.'); return }
    setInviteCodeError(null)
    setInviteCodeChecking(true)
    try {
      const res  = await fetch('/api/registrations/validate-invite-code', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug: eventSlug, inviteCode: code }),
      })
      const json = await res.json() as { valid: boolean; error?: string }
      if (json.valid) {
        setVerifiedCode(code)
        setInviteCodeVerified(true)
      } else {
        setInviteCodeError(json.error ?? 'Invalid invite code.')
      }
    } catch {
      setInviteCodeError('Network error. Please try again.')
    } finally {
      setInviteCodeChecking(false)
    }
  }

  // H3: Always subscribe so logged-in users are linked to registrations
  const [authChecked, setAuthChecked] = useState(!requireLogin)
  const [isLoggedIn,  setIsLoggedIn]  = useState(false)
  const [authToken,   setAuthToken]   = useState<string | null>(null)

  const { user: authUser, getToken } = useAuth()

  useEffect(() => {
    if (authUser === undefined) return
    let cancelled = false
    const run = async () => {
      setIsLoggedIn(!!authUser)
      const t = authUser ? await getToken() : null
      if (cancelled) return
      setAuthToken(t)
      setAuthChecked(true)
    }
    void run()
    return () => { cancelled = true }
  }, [authUser, getToken])

  const fieldStates = useMemo(
    () => computeFieldStates(fullFields, conditionalRules, values),
    [fullFields, conditionalRules, values],
  )

  // Per-section completion for progress indicator
  const sectionCompleteness = useMemo(() => {
    return passSections.map(section => {
      const visibleRequired = section.fields.filter(f => {
        const s = fieldStates.get(f.id)
        return s?.visible !== false && (s?.required ?? f.required)
      })
      if (visibleRequired.length === 0) return true
      return visibleRequired.every(f => (values[f.id] ?? '').trim() !== '')
    })
  }, [passSections, fieldStates, values])

  const activeStepIdx    = sectionCompleteness.findIndex(c => !c)  // -1 = all done
  const completedCount   = sectionCompleteness.filter(Boolean).length

  // H-3: validate ONE field against the shared server rules (identical messages).
  function validateField(id: string, vals: Record<string, string>) {
    const found = collectFormErrors(sections, conditionalRules, selectedPassId, vals)
    const msg   = found.find(e => e.fieldId === id)?.message
    setErrors(prev => {
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
  }

  // H-3: on blur, validate the field the user just left (required + format).
  function handleBlur(id: string) {
    validateField(id, values)
  }

  const handleChange = useCallback((id: string, val: string) => {
    const nextValues = { ...values, [id]: val }
    setValues(nextValues)
    // H-3: correct-as-you-type — only re-check a field that is ALREADY showing an error
    // (so a fix clears instantly), never introduce a new error while first typing.
    setErrors(prev => {
      if (!prev[id]) return prev
      const msg  = collectFormErrors(sections, conditionalRules, selectedPassId, nextValues).find(e => e.fieldId === id)?.message
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
  }, [values, sections, conditionalRules, selectedPassId])

  // H3: validate with the SAME rules the server enforces (collectFormErrors), so a
  // form that passes here can't be rejected server-side for a rule the client skipped.
  function validate(): boolean {
    const found = collectFormErrors(sections, conditionalRules, selectedPassId, values)
    const newErrors: Record<string, string> = {}
    for (const e of found) newErrors[e.fieldId] = e.message
    setErrors(newErrors)
    return found.length === 0
  }

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authToken) h['Authorization'] = `Bearer ${authToken}`
    return h
  }

  // H-4: open Razorpay for an ALREADY-CREATED order and verify on success. On cancel/
  // failure it parks the order for retry instead of dead-ending on an alert. Shared by
  // the initial submit AND retryPayment, so a retry re-opens the SAME order — no second
  // create-order, no duplicate registration (verify-payment is idempotent per its intent).
  async function runPayment(
    order:    { orderId: string; amount: number; currency: string; keyId: string },
    attendee: { name: string; email: string; phone?: string },
    headers:  Record<string, string>,
  ): Promise<void> {
    try {
      await loadRazorpayScript()
    } catch {
      setSubmitError('Failed to load payment checkout. Please check your connection.')
      return
    }

    let paymentResult: RazorpayPaymentSuccess
    try {
      paymentResult = await openRazorpayCheckout({
        keyId:         order.keyId,
        orderId:       order.orderId,
        amount:        order.amount,
        currency:      order.currency,
        eventName,
        passName:      pass.name,
        attendeeName:  attendee.name,
        attendeeEmail: attendee.email,
        attendeePhone: attendee.phone,
      })
    } catch {
      // Cancelled or failed → recovery card (retry reuses THIS order).
      setPaymentRecovery({ order, attendee })
      return
    }

    const verifyRes  = await fetch('/api/registrations/verify-payment', {
      method: 'POST', headers, body: JSON.stringify(paymentResult),
    })
    const verifyJson = await verifyRes.json() as {
      success?: boolean; registrationId?: string; error?: string; reason?: string
    }
    if (verifyJson.success && verifyJson.registrationId) {
      clearSavedForm()
      router.push(`/events/${eventSlug}/register/success?id=${verifyJson.registrationId}`)
      return
    }
    setSubmitError(verifyJson.error ?? 'Payment verification failed. Please contact support.')
  }

  async function retryPayment(): Promise<void> {
    const rec = paymentRecovery
    if (!rec || submitting) return
    setSubmitError(null)
    setPaymentRecovery(null)
    setSubmitting(true)
    try {
      await runPayment(rec.order, rec.attendee, buildHeaders())
    } finally {
      setSubmitting(false)
    }
  }

  // RD-PAYMENT-05 B1: attendee confirmed the itemized charge → open Razorpay for the SAME
  // already-created order (no new create-order, no duplicate). Total shown === order.amount.
  async function confirmAndPay(): Promise<void> {
    const fc = feeConfirm
    if (!fc || submitting) return
    setSubmitError(null)
    setFeeConfirm(null)
    setSubmitting(true)
    try {
      await runPayment(fc.order, fc.attendee, buildHeaders())
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setPaymentRecovery(null)
    if (!validate()) {
      // H9: move both scroll AND keyboard/AT focus to the first invalid control.
      const firstError = document.querySelector('[aria-invalid="true"]')
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (firstError instanceof HTMLElement) firstError.focus({ preventScroll: true })
      return
    }

    setSubmitting(true)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    const attendee = resolveAttendeeIdentity(allFields, values)

    // H2: pre-payment duplicate check — surface an existing registration BEFORE opening
    // Razorpay, so an attendee is never charged for a registration the server rejects as
    // a duplicate. Advisory only; a failure falls through to the authoritative server gate.
    try {
      const dupRes  = await fetch('/api/registrations/check-duplicate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: eventSlug, email: attendee.email, phone: attendee.phone }),
      })
      const dupJson = await dupRes.json() as { duplicate?: boolean; field?: 'email' | 'mobile' }
      if (dupJson.duplicate) {
        setSubmitError(
          dupJson.field === 'mobile'
            ? 'You already have a registration for this event with this mobile number. Please check your email for your ticket.'
            : 'You already have a registration for this event with this email address. Please check your inbox for your ticket.',
        )
        setSubmitting(false)
        return
      }
    } catch { /* precheck is advisory — let the server make the final decision */ }

    const effectivePricePaise = couponApplied
      ? couponApplied.finalPaise
      : Math.round((pass.price ?? 0) * 100)

    const requestBody = {
      slug:          eventSlug,
      passId:        pass.id,
      attendee,
      formResponses: values,
      idempotencyKey,
      ...(verifiedCode  ? { inviteCode: verifiedCode         } : {}),
      ...(couponApplied ? { couponCode: couponApplied.code   } : {}),
    }

    try {
      // ── Paid flow ──────────────────────────────────────────────────────────
      if (!pass.isFree && effectivePricePaise > 0) {
        const orderRes  = await fetch('/api/registrations/create-order', {
          method: 'POST', headers, body: JSON.stringify(requestBody),
        })
        const orderJson = await orderRes.json() as {
          orderId?: string; amount?: number; currency?: string; keyId?: string; error?: string
          financials?: FeeBreakdownRecord
        }
        if (!orderRes.ok || !orderJson.orderId) {
          setSubmitError(orderJson.error ?? 'Failed to create payment order. Please try again.')
          return
        }

        const order = { orderId: orderJson.orderId, amount: orderJson.amount!, currency: orderJson.currency ?? 'INR', keyId: orderJson.keyId! }

        // RD-PAYMENT-05 B1: when the attendee bears fees, show the EXACT canonical breakdown
        // (from the server financials — total === order.amount) and require explicit
        // confirmation before opening Razorpay. Absent (organizer_absorbs / free) → the flow
        // is unchanged: open Razorpay directly via runPayment.
        const breakdown = buildAttendeeFeeBreakdown(orderJson.financials)
        if (breakdown) {
          setFeeConfirm({ order, attendee, breakdown })
          return
        }

        // H-4: open + verify via the shared runPayment so a cancel/failure produces the
        // recovery card (retry reuses this order) rather than a dead-end alert.
        await runPayment(order, attendee, headers)
        return
      }

      // ── Free flow ──────────────────────────────────────────────────────────
      const res  = await fetch('/api/registrations/submit', {
        method: 'POST', headers, body: JSON.stringify(requestBody),
      })
      const json = await res.json() as {
        success: boolean; registrationId?: string; error?: string
      }
      if (json.success && json.registrationId) {
        clearSavedForm()
        router.push(`/events/${eventSlug}/register/success?id=${json.registrationId}`)
        return
      }
      setSubmitError(json.error ?? 'Registration failed. Please try again.')
    } catch {
      setSubmitError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Invite code gate screen ────────────────────────────────────────────────
  if (requiresInviteCode && !inviteCodeVerified) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <svg className="size-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <h2 className="text-[20px] font-bold text-foreground">Invite Only</h2>
          <p className="mt-2 text-[14px] text-muted-foreground">
            This event requires an invite code to register.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <label htmlFor="invite-code" className="mb-1.5 block text-[13px] font-medium text-foreground">
            Invite Code
          </label>
          <input
            id="invite-code"
            type="text"
            autoFocus
            placeholder="Enter invite code"
            value={inviteCodeInput}
            onChange={e => { setInviteCodeInput(e.target.value); setInviteCodeError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') void handleVerifyInviteCode() }}
            className="h-10 w-full rounded-xl border border-border bg-background px-3.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            aria-invalid={!!inviteCodeError}
          />
          {inviteCodeError && (
            <p role="alert" className="mt-1.5 text-[12px] text-destructive">{inviteCodeError}</p>
          )}
          <button
            type="button"
            onClick={() => void handleVerifyInviteCode()}
            disabled={inviteCodeChecking}
            className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'mt-4 w-full')}
          >
            {inviteCodeChecking ? 'Verifying…' : 'Continue'}
          </button>
        </div>
      </div>
    )
  }

  // ── Auth loading ───────────────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  if (requireLogin && !isLoggedIn) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-16 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <svg className="size-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <h2 className="text-[20px] font-bold text-foreground">Sign in to Register</h2>
        <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">
          The organiser requires you to be signed in before registering for this event.
        </p>
        <a
          href={`/login?redirect=${encodeURIComponent(buildRegisterHref(eventSlug, pass.id))}`}
          className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'mt-6')}
        >
          Sign In to Continue
        </a>
      </div>
    )
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const priceLabel = !isPaid
    ? 'Free'
    : couponApplied
      ? couponApplied.finalPaise === 0
        ? 'Free'
        : `₹${(couponApplied.finalPaise / 100).toLocaleString('en-IN')}`
      : `₹${pass.price.toLocaleString('en-IN')}`

  // ── Main layout ────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-4xl px-4 pb-28 pt-8 lg:py-12">{/* pb-28 (mobile) clears the sticky checkout bar */}

      {/* Mobile compact summary header */}
      <div className="mb-5 overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:hidden">
        {bannerUrl && (
          <div className="relative aspect-[21/6] overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/70 to-black/30" />
            <div className="absolute inset-0 flex items-center px-4">
              <p className="text-[15px] font-bold text-white drop-shadow-sm">{eventName}</p>
            </div>
          </div>
        )}
        <div className={cn('flex items-center justify-between px-4 py-3', bannerUrl && 'border-t border-border/50')}>
          {!bannerUrl && (
            <p className="mr-3 min-w-0 truncate text-[14px] font-bold text-foreground">{eventName}</p>
          )}
          {bannerUrl && (
            <p className="mr-3 min-w-0 truncate text-[13.5px] font-medium text-muted-foreground">{pass.name}</p>
          )}
          {!bannerUrl && (
            <p className="text-[13px] shrink-0 text-muted-foreground">{pass.name}</p>
          )}
          <p className="shrink-0 text-[15px] font-bold text-foreground">{priceLabel}</p>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-10">

        {/* LEFT: Progress + form */}
        <div>
          {/* H-7: in-form pass switcher — change pass without losing entered data */}
          {passes.length > 1 && (
            <PassSwitcher
              passes={passes}
              selectedId={selectedPassId}
              onSelect={switchPass}
              switching={couponRevalidating}
            />
          )}

          <ProgressIndicator
            sections={passSections}
            activeIdx={activeStepIdx}
            completedCount={completedCount}
          />

          {/* M-4: autosave confirmation (space reserved to avoid layout shift) */}
          <div className="mb-3 flex h-4 items-center justify-end" aria-live="polite">
            {draftSaved && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Check className="size-3 text-emerald-600" aria-hidden />
                Draft saved
              </span>
            )}
          </div>

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            onFocusCapture={e => { if (isKeyboardField(e.target)) setFieldFocused(true) }}
            onBlurCapture={e => { if (!isKeyboardField(e.relatedTarget)) setFieldFocused(false) }}
          >
            <div className="flex flex-col gap-4">
              {passSections.map(section => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  fieldStates={fieldStates}
                  values={values}
                  errors={errors}
                  onChange={handleChange}
                  onBlur={handleBlur}
                />
              ))}
            </div>

            {/* Coupon input — only for paid passes without applied coupon */}
            {isPaid && !couponApplied && (
              <div className="mt-5">
                <p className="mb-1.5 text-[13px] font-medium text-foreground">Have a coupon code?</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponInput}
                    onChange={e => { setCouponInput(e.target.value.toUpperCase()); setCouponError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleApplyCoupon() } }}
                    placeholder="Enter code"
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-[13px] uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-primary/40"
                    disabled={couponChecking}
                  />
                  <button
                    type="button"
                    onClick={() => void handleApplyCoupon()}
                    disabled={couponChecking || !couponInput.trim()}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {couponChecking ? 'Checking…' : 'Apply'}
                  </button>
                </div>
                {couponError && (
                  <p role="alert" className="mt-1.5 text-[12px] text-destructive">{couponError}</p>
                )}
              </div>
            )}

            {/* Coupon applied badge (with remove) */}
            {isPaid && couponApplied && (
              <div className="mt-5 flex items-center justify-between rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-4 py-3">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Check className="size-3.5 text-emerald-600" aria-hidden />
                    <span className="font-mono text-[12.5px] font-bold text-emerald-700">{couponApplied.code}</span>
                    {couponApplied.description && (
                      <span className="text-[12px] text-emerald-600">{couponApplied.description}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-emerald-600">
                    −₹{(couponApplied.discountPaise / 100).toLocaleString('en-IN')} discount applied
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveCoupon}
                  className="ml-3 shrink-0 text-[11.5px] font-medium text-emerald-700 hover:underline"
                >
                  Remove
                </button>
              </div>
            )}

            {/* Approval mode note */}
            {approvalMode === 'manual' && (
              <div className="mt-5 rounded-xl border border-amber-200/60 bg-amber-50/50 px-4 py-3 text-[12.5px] text-amber-700">
                Your registration will be reviewed before confirmation. You will be notified by email once approved.
              </div>
            )}

            {/* H-4: payment recovery card — shown when a payment was cancelled/failed.
                Retry reuses the same order (idempotent, no duplicate registration). */}
            {paymentRecovery ? (
              <div role="alert" className="mt-4 rounded-2xl border border-amber-200/70 bg-amber-50/60 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-foreground">Payment not completed</p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                      Your payment wasn&apos;t completed and you have not been charged. Your details are saved — retry the payment, or go back to review your registration.
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void retryPayment()}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'flex-1 gap-1.5')}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    {submitting ? 'Processing…' : isPaid ? `Retry Payment · ${priceLabel}` : 'Retry Payment'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentRecovery(null)}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'outline', size: 'md' }), 'flex-1')}
                  >
                    Return to Registration
                  </button>
                </div>
              </div>
            ) : feeConfirm ? (
              /* RD-PAYMENT-05 B1: itemized charge shown from canonical server financials.
                 Total === order.amount === Razorpay === ledger. Explicit confirm to pay. */
              <div role="group" aria-label="Confirm payment amount" className="mt-4 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
                <p className="text-[14px] font-bold text-foreground">Review your payment</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  Platform fees are added on top of the ticket price. Here&apos;s exactly what you&apos;ll pay.
                </p>
                <dl className="mt-3 space-y-1.5">
                  {feeConfirm.breakdown.lines.map(l => (
                    <div key={l.label} className="flex items-center justify-between text-[13px]">
                      <dt className="text-muted-foreground">{l.label}</dt>
                      <dd className="tabular-nums text-foreground">{formatPaise(l.paise)}</dd>
                    </div>
                  ))}
                  <div className="mt-1 flex items-center justify-between border-t border-border pt-2">
                    <dt className="text-[13.5px] font-bold text-foreground">Total payable</dt>
                    <dd className="text-[15px] font-bold tabular-nums text-foreground">{formatPaise(feeConfirm.breakdown.totalPaise)}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void confirmAndPay()}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'flex-1 gap-1.5')}
                  >
                    <ShieldCheck className="size-4" aria-hidden />
                    {submitting ? 'Processing…' : `Confirm & Pay ${formatPaise(feeConfirm.breakdown.totalPaise)}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeeConfirm(null)}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'outline', size: 'md' }), 'flex-1')}
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : submitError ? (
              /* Submit error — assertive live region so failures are announced */
              <div role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
                {submitError}
              </div>
            ) : null}

            {/* Trust badges */}
            <TrustBadges isPaid={isPaid} />

            {/* Submit button — hidden while the recovery card or fee-confirm owns the action */}
            {!paymentRecovery && !feeConfirm && (
              <>
                <button
                  type="submit"
                  disabled={submitting}
                  className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-4 w-full')}
                >
                  {submitting
                    ? (!isPaid || couponApplied?.finalPaise === 0 ? 'Submitting…' : 'Processing Payment…')
                    : !isPaid || couponApplied?.finalPaise === 0
                      ? 'Complete Registration →'
                      : `Pay ${priceLabel} & Register →`}
                </button>

                <p className="mt-3 text-center text-[11px] text-muted-foreground">
                  By registering, you agree to the event organiser&apos;s terms and conditions.
                </p>
              </>
            )}
          </form>
        </div>

        {/* RIGHT: Sticky summary card (desktop only) */}
        <div className="hidden lg:block">
          <div className="sticky top-6">
            <SummaryCard
              eventName={eventName}
              bannerUrl={bannerUrl}
              venueName={venueName}
              venueCity={venueCity}
              venueType={venueType}
              startDate={startDate}
              startTime={startTime}
              passName={pass.name}
              isPaid={isPaid}
              price={pass.price}
              regularPrice={pass.regularPrice}
              couponApplied={couponApplied}
            />
          </div>
        </div>

      </div>

      {/* C-2: mobile-only sticky checkout bar (Total + Pay). Desktop keeps the right-column
          sticky SummaryCard — this is `lg:hidden`, so the desktop summary is never duplicated.
          Steps aside while a keyboard field is focused; clears the iOS safe-area inset. */}
      {!paymentRecovery && !feeConfirm && (
        <div className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgb(0_0_0/0.08)] backdrop-blur-md lg:hidden',
          fieldFocused && 'hidden',
        )}>
          <div className="mx-auto flex max-w-lg items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total</p>
              <p className="text-[17px] font-bold leading-tight text-foreground">{priceLabel}</p>
            </div>
            <button
              type="button"
              onClick={() => formRef.current?.requestSubmit()}
              disabled={submitting}
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-w-[52%]')}
            >
              {submitting
                ? (!isPaid || couponApplied?.finalPaise === 0 ? 'Submitting…' : 'Processing…')
                : (!isPaid || couponApplied?.finalPaise === 0 ? 'Complete Registration' : `Pay ${priceLabel}`)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
