'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useRouter }              from 'next/navigation'
import { useAuth }                from '@/components/auth/AuthProvider'
// RD-RT1.0: framer-motion, Fragment and the event-meta icons left with the presentation
// components that moved to ./RegistrationUI — this module no longer renders them.
import { ShieldCheck, RotateCcw, Check, AlertTriangle } from 'lucide-react'
import { cn }                     from '@/lib/utils/cn'
import { buildRegisterHref }      from '@/lib/events/registerHref'
import { buttonVariants }         from '@/components/ui/button'
import { CustomSelect }           from '@/components/ui/CustomSelect'
import type { FormSection, FormField, ConditionalRule, FieldType } from '@/components/wizard/registrationFormConfig'
import { resolveAttendeeIdentity } from '@/lib/registrations/attendeeIdentity'
import { collectFormErrors } from '@/lib/registrations/validateFormResponses'
import { resolveDobField, ageRangeLabel } from '@/lib/registrations/ageEligibility'
import { TAX_INCLUSIVE_NOTE } from '@/lib/pricing/copy'
import type { FeeBreakdownRecord } from '@/lib/fees/types'
import { buildAttendeeFeeBreakdown, formatPaise, type AttendeeFeeBreakdown } from '@/lib/fees/attendeeBreakdown'
// RD-RT1.0: the presentation layer now lives in RegistrationUI. Logic stays here.
import {
  RegistrationHeader, StepWizard, JourneyStepper, FormSectionCard, SummaryPanel, PassSwitcher,
  estimateMinutes, type EventIdentity, type SummaryPricing,
} from './RegistrationUI'
// RD-RT2.0: one visual system for every control.
import {
  FieldShell, FieldError, FIELD_HINT, controlCls, textareaCls,
  RadioOption, CheckOption, TogglePill, ErrorSummary,
} from './formControls'
import { PassPrice } from './PassPrice'
// RD-RT3.5: the recovery surface for the existing draft mechanism.
import { RecoveryBanner, AutosaveStatus, RecoveryReassurance } from './RecoveryUI'
// RD-RT3.0: the pre-payment review experience.
import {
  RegistrationReview, isReviewReady,
  type ReviewAnswerGroup, type ReviewConsent, type ReviewParticipant,
} from './RegistrationReview'

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
  /** RD-RT1.0: drives "Registration closes". Already on the pricing doc. */
  salesEndDate?: string
  /** RD-RT3.2.2: eligibility window from the pass editor. null = unbounded. */
  minAge?:      number | null
  maxAge?:      number | null
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
  /** RD-RT3.0: policy URLs for the review consent rows. Empty string = not published. */
  termsUrl?:          string
  refundPolicyUrl?:   string
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

// RD-RT2.0: the hand-set control classes moved to ./formControls, which owns ONE
// surface for every control (and adds the error/hover/read-only states the inputs
// never had). Nothing about field behaviour changed.

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
//
// RD-RT2.0: helper text now sits ABOVE the control and stays visible when a field
// fails, so guidance and failure are announced together instead of the hint being
// swapped out for the error.
function describedBy(id: string, helperText: string, error: string | undefined): string | undefined {
  const ids: string[] = []
  if (helperText) ids.push(`${id}-hint`)
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

  const hintId  = `${id}-hint`
  const errorId = `${id}-error`
  // Shared shell props — one label → hint → control → message rhythm for every branch.
  const shell = {
    label, required: req, hintId, errorId,
    hint:  helperText || undefined,
    error: error || undefined,
  }

  // ── Textarea ────────────────────────────────────────────────────────────────
  if (type === 'textarea' || type === 'address') {
    return (
      <FieldShell {...shell} htmlFor={id}>
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
          className={textareaCls(!!error)}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, helperText, error)}
        />
      </FieldShell>
    )
  }

  // ── Dropdown / Select ───────────────────────────────────────────────────────
  if (type === 'dropdown') {
    return (
      <FieldShell {...shell} htmlFor={id}>
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
      </FieldShell>
    )
  }

  // ── Radio ───────────────────────────────────────────────────────────────────
  // Selectable cards. The native radios stay in the DOM (sr-only), so grouping,
  // arrow-key roving and screen-reader semantics remain the browser's.
  if (type === 'radio' || type === 'yesno') {
    const opts = type === 'yesno' ? ['Yes', 'No'] : options
    return (
      <FieldShell {...shell} asSpan labelId={`${id}-label`}>
        <div
          className="grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-required={req || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {opts.map(opt => (
            <RadioOption
              key={opt}
              name={id}
              option={opt}
              checked={value === opt}
              disabled={disabled}
              onSelect={() => onChange(id, opt)}
            />
          ))}
        </div>
      </FieldShell>
    )
  }

  // ── Checkbox (single consent or group) ───────────────────────────────────
  if (type === 'checkbox') {
    if (options.length === 0) {
      // Single consent. The hint and error now carry the ids `aria-describedby`
      // already pointed at, and the error is an assertive live region like every
      // other field's — both were missing on this branch alone.
      return (
        <div>
          <CheckOption
            id={id}
            checked={value === 'true'}
            disabled={disabled}
            onToggle={next => onChange(id, next ? 'true' : '')}
          >
            {label}
            {req && (
              <>
                <span className="ml-1 text-destructive" aria-hidden>*</span>
                <span className="sr-only"> (required)</span>
              </>
            )}
          </CheckOption>
          {helperText && <p id={hintId} className={cn(FIELD_HINT, 'mt-1.5')}>{helperText}</p>}
          {error && <FieldError id={errorId}>{error}</FieldError>}
        </div>
      )
    }
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <FieldShell {...shell} asSpan labelId={`${id}-label`}>
        <div
          className="flex flex-col gap-2"
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {options.map(opt => {
            const checked = selected.includes(opt)
            return (
              <CheckOption
                key={opt}
                option={opt}
                checked={checked}
                disabled={disabled}
                onToggle={() => {
                  const next = checked
                    ? selected.filter(s => s !== opt)
                    : [...selected, opt]
                  onChange(id, next.join(', '))
                }}
              />
            )
          })}
        </div>
      </FieldShell>
    )
  }

  // ── Multiselect (pill toggle group) ───────────────────────────────────────
  if (type === 'multiselect') {
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <FieldShell {...shell} asSpan labelId={`${id}-label`}>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, helperText, error)}
        >
          {options.map(opt => {
            const checked = selected.includes(opt)
            return (
              <TogglePill
                key={opt}
                option={opt}
                checked={checked}
                disabled={disabled}
                onToggle={() => {
                  const next = checked
                    ? selected.filter(s => s !== opt)
                    : [...selected, opt]
                  onChange(id, next.join(', '))
                }}
              />
            )
          })}
        </div>
      </FieldShell>
    )
  }

  // ── Default: text / email / tel / number / date / time / url / country / state / city ──
  // NOTE: `file` also lands here. It has no dedicated branch and renders as a text
  // input — see the RT2.0 report. A real uploader needs storage logic, which this
  // sprint excludes, so the behaviour is deliberately left unchanged.
  return (
    <FieldShell {...shell} htmlFor={id}>
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
        className={controlCls(!!error)}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, helperText, error)}
        {...nativeInputProps(field)}
      />
    </FieldShell>
  )
}

// ─── Section Block ────────────────────────────────────────────────────────────

function SectionBlock({
  section,
  index,
  complete,
  fieldStates,
  values,
  errors,
  onChange,
  onBlur,
}: {
  section:     FormSection
  /** 1-based ordinal for the group header chip — presentation only. */
  index:       number
  /** RD-RT3.3: every required field in this section is filled. */
  complete:    boolean
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

  // RD-RT1.0: the card shell moved to FormSectionCard so every logical group shares one
  // rhythm. Field selection, ordering and rendering are untouched.
  return (
    <FormSectionCard title={section.title} description={section.description} index={index} complete={complete}>
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
    </FormSectionCard>
  )
}

// ─── Coupon state ─────────────────────────────────────────────────────────────
// RD-RT1.0: ProgressIndicator, SummaryCard, TrustBadges and PassSwitcher moved to
// ./RegistrationUI as StepWizard, SummaryPanel and PassSwitcher. Only their markup
// changed — every input they receive is computed here, exactly as before.

interface CouponState {
  code:          string
  discountPaise: number
  finalPaise:    number
  description:   string
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
  termsUrl,
  refundPolicyUrl,
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
  // RD-RT3.1: which stage of the journey is on screen. 'payment' is Razorpay (a modal)
  // and 'success' is a route, so only these two are rendered stages.
  const [step, setStep] = useState<'form' | 'review'>('form')
  // RD-RT3.0: review consent. Lives here — not inside the review — so the review CTA
  // and the sticky-summary CTA are gated by exactly ONE condition. Never persisted.
  const [consent, setConsent] = useState<ReviewConsent>({ info: false, terms: false, refund: false })
  // C-2: the mobile checkout bar steps aside while a keyboard field is focused.
  const [fieldFocused, setFieldFocused] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  // RD-RT3.3: focus target for the grouped error summary.
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  // M-4: brief "Draft saved" confirmation after the autosave settles.
  // RD-RT3.5 — recovery state. `pendingDraft` holds a draft that was FOUND but not yet
  // applied: restoring is now a decision, so "Start Over" genuinely starts over instead
  // of undoing a restore that already happened.
  const [pendingDraft, setPendingDraft] = useState<Record<string, string> | null>(null)
  const [savedAt,      setSavedAt]      = useState<number | null>(null)
  const [saving,       setSaving]       = useState(false)
  const [online,       setOnline]       = useState(true)
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
          // A value whose field no longer exists on this event is dropped here, so a
          // form the organiser has since edited can never restore into stale fields.
          if (validIds.has(k) && typeof v === 'string' && v.trim()) filtered[k] = v
        }
        // RD-RT3.5: OFFER the draft instead of applying it. Nothing is written to
        // `values` until the attendee chooses Continue.
        if (!cancelled && Object.keys(filtered).length > 0) setPendingDraft(filtered)
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

  // M-4 / RD-RT3.5: "Saving…" while the debounce is in flight, then a timestamp the
  // status line turns into "Saved just now" / "Saved 2 minutes ago". Same 600ms debounce
  // as before — this records WHEN the existing save happened, it does not save again.
  useEffect(() => {
    if (Object.keys(values).length === 0) return
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaving(true), 0)
    const t = setTimeout(() => {
      setSaving(false)
      setSavedAt(Date.now())
    }, 600)
    return () => clearTimeout(t)
  }, [values])

  // RD-RT3.5 — connectivity. The draft itself is written to sessionStorage, which needs
  // no network, so autosave already works offline; what actually breaks offline is
  // SUBMITTING. The indicator exists to set that expectation, never to block editing.
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    const raf  = requestAnimationFrame(sync)   // deferred out of the effect body
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const clearSavedForm = useCallback(() => {
    try { sessionStorage.removeItem(storageKey) } catch { /* ignore */ }
  }, [storageKey])

  // RD-RT3.5 — the two recovery decisions. Both use the EXISTING draft mechanism.
  const resumeDraft = useCallback(() => {
    // Draft first, current values second: anything already typed while the banner was
    // on screen wins, so resuming can never overwrite live input.
    setValues(v => ({ ...(pendingDraft ?? {}), ...v }))
    setPendingDraft(null)
  }, [pendingDraft])

  const discardDraft = useCallback(() => {
    clearSavedForm()
    setPendingDraft(null)
    setValues({})
  }, [clearSavedForm])

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
      // RD-RT3.2.3 ISSUE 2: a section with a visible ERROR is not complete, even when
      // every required box has something in it. An ineligible date of birth is filled in
      // — it is just wrong — and the stepper claiming that section is done while Review
      // refuses to open is exactly the contradiction this removes.
      const hasVisibleError = section.fields.some(
        f => errors[f.id] && fieldStates.get(f.id)?.visible !== false,
      )
      if (hasVisibleError) return false
      if (visibleRequired.length === 0) return true
      return visibleRequired.every(f => (values[f.id] ?? '').trim() !== '')
    })
  }, [passSections, fieldStates, values, errors])

  const activeStepIdx    = sectionCompleteness.findIndex(c => !c)  // -1 = all done
  const completedCount   = sectionCompleteness.filter(Boolean).length

  // RD-RT3.2.2: age limits for the SELECTED pass, measured on the EVENT date. Memoised so
  // it is a stable dependency, and rebuilt when the pass changes — switching pass
  // re-checks eligibility against that pass's window. Null limits mean unbounded, and the
  // rule is skipped entirely, so events without age limits behave exactly as before.
  const eligibility = useMemo(
    () => ({ eventDate: startDate, minAge: pass.minAge ?? null, maxAge: pass.maxAge ?? null }),
    [startDate, pass.minAge, pass.maxAge],
  )

  // The birth-date field, resolved once through the SAME canonical resolver the
  // validator uses — so "which field is the DOB" has exactly one answer.
  const dobFieldId = useMemo(() => resolveDobField(allFields)?.id ?? null, [allFields])

  /** This pass's age window, e.g. '12–17 years' / '18+'. Null when unrestricted. */
  const passAgeLabel = ageRangeLabel({ minAge: pass.minAge ?? null, maxAge: pass.maxAge ?? null })

  // RD-RT3.2.3 ISSUE 2: switching pass re-runs eligibility immediately. `eligibility` is
  // memoised on the pass's limits, so this fires only when the window actually changes —
  // not on every render — and only when a date of birth has been entered.
  useEffect(() => {
    if (!dobFieldId || !(values[dobFieldId] ?? '').trim()) return
    const raf = requestAnimationFrame(() => {
      const msg = collectFormErrors(sections, conditionalRules, selectedPassId, values, eligibility)
        .find(e => e.fieldId === dobFieldId)?.message
      setErrors(prev => {
        if (prev[dobFieldId] === msg) return prev          // no-op → no re-render
        const next = { ...prev }
        if (msg) next[dobFieldId] = msg
        else delete next[dobFieldId]
        return next
      })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibility, selectedPassId, dobFieldId])

  // H-3: validate ONE field against the shared server rules (identical messages).
  function validateField(id: string, vals: Record<string, string>) {
    const found = collectFormErrors(sections, conditionalRules, selectedPassId, vals, eligibility)
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
      // RD-RT3.2.3 ISSUE 1: the date of birth is checked on EVERY change, not only when
      // it is already showing an error. Age eligibility is decided by one pick from a
      // date control — there is no "still typing" state to protect, and discovering it
      // at Review is exactly the failure this closes. Every other field keeps the
      // original correct-as-you-type rule.
      const isDob = id === dobFieldId
      if (!prev[id] && !isDob) return prev
      const msg  = collectFormErrors(sections, conditionalRules, selectedPassId, nextValues, eligibility).find(e => e.fieldId === id)?.message
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
  }, [values, sections, conditionalRules, selectedPassId, eligibility, dobFieldId])

  // H3: validate with the SAME rules the server enforces (collectFormErrors), so a
  // form that passes here can't be rejected server-side for a rule the client skipped.
  function validate(): boolean {
    const found = collectFormErrors(sections, conditionalRules, selectedPassId, values, eligibility)
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
      // RD-RT3.1: the recovery card renders inside the form, so step back to it —
      // otherwise a cancelled payment would leave the retry action unreachable.
      setStep('form')
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
  // Second confirmation, unchanged from RD-PAYMENT-05 B1: the canonical amount has been
  // shown and accepted, so Razorpay may open.
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

  // RD-RT3.1: the form no longer submits straight through. It validates — unchanged —
  // and hands over to the Review step. Every registration now takes the same route,
  // paid or free, so Review is a stage of the journey rather than a payment panel.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setPaymentRecovery(null)
    if (!validate()) {
      // H9 + RD-RT3.3: focus moves to the grouped summary, which names EVERY problem and
      // links to each field — more useful than landing on the first one with no idea how
      // many follow. Falls back to the original first-invalid-control behaviour if the
      // summary has not painted yet.
      requestAnimationFrame(() => {
        const summary = errorSummaryRef.current
        if (summary) {
          summary.scrollIntoView({ behavior: 'smooth', block: 'center' })
          summary.focus({ preventScroll: true })
          return
        }
        const firstError = document.querySelector('[aria-invalid="true"]')
        firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        if (firstError instanceof HTMLElement) firstError.focus({ preventScroll: true })
      })
      return
    }
    setConsent({ info: false, terms: false, refund: false })
    setStep('review')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Everything below this line is the ORIGINAL handleSubmit body, moved verbatim: the
  // duplicate precheck, the create-order call, the RD-PAYMENT-05 B1 fee confirmation and
  // the free-registration submit. No request, payload, ordering or branch changed — only
  // the moment it is invoked, which is now the Review step's confirm action.
  async function finaliseRegistration(): Promise<void> {
    if (submitting) return
    setSubmitError(null)
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
          // RD-RT3.0: every review starts unconfirmed. Without this, a cancelled payment
          // followed by a re-submit would land on the review with the boxes still ticked.
          setConsent({ info: false, terms: false, refund: false })
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
          <h2 className="text-fs-lg font-bold text-foreground">Invite Only</h2>
          <p className="mt-2 text-fs-base text-muted-foreground">
            This event requires an invite code to register.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <label htmlFor="invite-code" className="mb-1.5 block text-fs-sm font-medium text-foreground">
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
            className="h-10 w-full rounded-xl border border-border bg-background px-3.5 text-fs-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            aria-invalid={!!inviteCodeError}
          />
          {inviteCodeError && (
            <p role="alert" className="mt-1.5 text-fs-xs text-destructive">{inviteCodeError}</p>
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
        <h2 className="text-fs-lg font-bold text-foreground">Sign in to Register</h2>
        <p className="mt-2 max-w-sm text-fs-base text-muted-foreground">
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

  // RD-RT1.0 — presentation-only derivations. Every value below is formatting over
  // state that already existed; no new source, no new request, no pricing maths.
  const isFreeCheckout   = !isPaid || couponApplied?.finalPaise === 0
  const ctaLabel         = isFreeCheckout ? 'Complete Registration' : `Pay ${priceLabel}`
  const processingLabel  = isFreeCheckout ? 'Submitting…' : 'Processing…'

  const fmtDay = (d: string | null) => {
    if (!d) return ''
    try {
      return new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    } catch { return d }
  }
  const fmtClock = (t: string | null | undefined) => {
    if (!t) return ''
    try {
      const [h, m] = t.split(':').map(Number)
      const dt = new Date(); dt.setHours(h, m ?? 0, 0)
      return dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    } catch { return t }
  }
  const fmtShort = (d: string) => {
    try {
      return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    } catch { return d }
  }

  const isOnlineVenue = venueType === 'online'
  const identity: EventIdentity = {
    eventSlug,
    eventName,
    bannerUrl:  bannerUrl ?? '',
    dateLabel:  fmtDay(startDate),
    timeLabel:  fmtClock(startTime),
    venueLabel: isOnlineVenue
      ? (venueName || 'Online event')
      : ([venueName, venueCity].filter(Boolean).join(', ') || null),
    isOnline:   isOnlineVenue,
    // Only when the organiser actually set a sales end date on this pass.
    closesLabel: pass.salesEndDate?.trim() ? fmtShort(pass.salesEndDate.trim()) : null,
  }

  // Early bird is active when the effective price is below the regular price, and is
  // suppressed while a coupon applies (the coupon strikethrough takes over) — the exact
  // rule the previous SummaryCard used.
  const isEarlyBird = isPaid && !couponApplied && pass.regularPrice > pass.price
  const summaryPricing: SummaryPricing = {
    isPaid,
    priceLabel,
    strikeLabel: isPaid && couponApplied
      ? `₹${pass.price.toLocaleString('en-IN')}`
      : isEarlyBird ? `₹${pass.regularPrice.toLocaleString('en-IN')}` : null,
    discountLabel: couponApplied
      ? `−₹${(couponApplied.discountPaise / 100).toLocaleString('en-IN')}`
      : null,
    couponCode:  couponApplied?.code ?? null,
    isEarlyBird,
    taxNote:     isPaid ? TAX_INCLUSIVE_NOTE : null,
  }

  // Derived from the real number of fields the attendee must fill — not a stored value.
  const estimateLabel = estimateMinutes(
    passSections.reduce(
      (n, s) => n + s.fields.filter(f => fieldStates.get(f.id)?.visible !== false).length,
      0,
    ),
  )

  // RD-RT3.0 — the attendee's own answers, grouped by the ORGANISER'S sections. The
  // grouping is theirs ("Personal", "Emergency Contact", …), not one we invented, and
  // only visible fields with a non-empty value appear. Formatting over existing state:
  // nothing is fetched, recomputed or transformed.
  // RD-RT3.3: the grouped error list, in FORM ORDER (not error-insertion order), so the
  // summary reads top-to-bottom like the page. Derived from the existing `errors` map —
  // no second validation pass.
  const errorList = passSections
    .flatMap(sec => sec.fields)
    .filter(f => errors[f.id] && fieldStates.get(f.id)?.visible !== false)
    .map(f => ({ id: f.id, label: f.label, message: errors[f.id]! }))

  function focusField(id: string) {
    const el = document.getElementById(id)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (el instanceof HTMLElement) el.focus({ preventScroll: true })
  }

  // ONE definition of "may proceed", shared by the review CTA and the sticky-summary
  // CTA so the summary can never become an ungated second path to payment.
  const reviewReady = isReviewReady(consent, termsUrl, refundPolicyUrl)

  // RD-RT3.1: mirrors the EXISTING branch in finaliseRegistration verbatim
  // (`!pass.isFree && effectivePricePaise > 0`). Read only — the decision itself is
  // still made inside finaliseRegistration and was not touched.
  const effectivePaiseNow = couponApplied ? couponApplied.finalPaise : Math.round((pass.price ?? 0) * 100)
  const paymentRequired   = !pass.isFree && effectivePaiseNow > 0

  const reviewGroups: ReviewAnswerGroup[] = passSections
    .map(section => ({
      title: section.title?.trim() || 'Details',
      items: section.fields
        .filter(f => fieldStates.get(f.id)?.visible !== false && (values[f.id] ?? '').trim())
        .map(f => ({ id: f.id, label: f.label, value: values[f.id]! .trim() })),
    }))
    .filter(g => g.items.length > 0)

  // ONE participant today. Shaped as a list so group registration is additive — see
  // ReviewParticipant. Identity comes from the same resolveAttendeeIdentity the
  // submission uses, so the review can never show a different person than it submits.
  const reviewIdentity  = resolveAttendeeIdentity(allFields, values)
  const reviewParticipants: ReviewParticipant[] = [{
    id:     'primary',
    name:   reviewIdentity.name,
    email:  reviewIdentity.email,
    phone:  reviewIdentity.phone,
    groups: reviewGroups,
  }]

  // ── Main layout ────────────────────────────────────────────────────────────
  return (
    // RD-RT1.0: the page now sits on the Event Details page container (max-w-7xl,
    // px-4/6/8) instead of max-w-4xl, so registration continues the same measure the
    // attendee just left. pb-28 (mobile) clears the sticky checkout bar.
    <div className="mx-auto w-full max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-16 lg:pt-8">

      {/* RD-RT3.2: compact checkout header (~110px) in place of the 350px poster hero.
          Poster, pass, date, venue, closing and the trust statements all moved into the
          sticky summary — relocated, not removed. Owns the page <h1>. */}
      <RegistrationHeader
        eventSlug={eventSlug}
        eventName={eventName}
        estimate={estimateLabel}
      />

      {/* RD-RT3.1: ONE journey, shown for every registration. Payment renders as
          "not required" rather than vanishing when nothing is due. */}
      <JourneyStepper current={step} paymentRequired={paymentRequired} />

      {/* 65 / 35 — the registration experience beside a sticky summary. */}
      {/* RD-RT3.2.1: `lg:items-start` was removed on purpose. It set align-items:start,
          which shrank the right grid item to its content height — so the sticky child
          exactly filled its containing block and had ZERO travel distance, which is why
          it never appeared to stick. With the default `stretch`, the right column spans
          the row height set by the (taller) form column and the sticky child can move
          within it. Native CSS only; no scroll listeners. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)] lg:gap-8">

        {/* LEFT: review, or progress + form.
            RD-RT3.0: during review the form is replaced rather than appended to, so the
            attendee confirms one screen instead of scrolling past every field again.
            `values` lives in component state (and the session draft), so unmounting the
            form loses nothing and "Edit Registration" restores it exactly. */}
        <div>
        {step === 'review' ? (
          <RegistrationReview
            identity={identity}
            passName={pass.name}
            passPriceLabel={priceLabel}
            strikeLabel={summaryPricing.strikeLabel}
            passAgeLabel={passAgeLabel}
            approvalMode={approvalMode}
            participants={reviewParticipants}
            paymentRequired={paymentRequired}
            pricing={{
              // Server-canonical once create-order has answered (RD-PAYMENT-05 B1);
              // until then, the pass price the page already displays.
              lines: feeConfirm
                ? feeConfirm.breakdown.lines
                : paymentRequired ? [{ label: 'Registration fee', paise: effectivePaiseNow }] : [],
              totalPaise: feeConfirm ? feeConfirm.breakdown.totalPaise : effectivePaiseNow,
              discount:   couponApplied
                ? { code: couponApplied.code, label: `−₹${(couponApplied.discountPaise / 100).toLocaleString('en-IN')}` }
                : null,
              authoritative: !!feeConfirm,
            }}
            termsUrl={termsUrl}
            refundPolicyUrl={refundPolicyUrl}
            submitting={submitting}
            consent={consent}
            onConsent={(key, value) => setConsent(c => ({ ...c, [key]: value }))}
            ready={reviewReady}
            onProceed={() => void (feeConfirm ? confirmAndPay() : finaliseRegistration())}
            onEdit={() => {
              setConsent({ info: false, terms: false, refund: false })
              setFeeConfirm(null)
              setStep('form')
            }}
          />
        ) : (
        <>
          {/* H-7: in-form pass switcher — change pass without losing entered data */}
          {passes.length > 1 && (
            <PassSwitcher
              passes={passes.map(p => ({
                ...p,
                ageLabel: ageRangeLabel({ minAge: p.minAge ?? null, maxAge: p.maxAge ?? null }),
              }))}
              selectedId={selectedPassId}
              onSelect={switchPass}
              switching={couponRevalidating}
            />
          )}

          <StepWizard
            sections={passSections}
            activeIdx={activeStepIdx}
            completedCount={completedCount}
          />

          {/* RD-RT3.5: the draft is OFFERED, never applied behind the attendee's back. */}
          {pendingDraft && (
            <RecoveryBanner
              fieldCount={Object.keys(pendingDraft).length}
              onResume={resumeDraft}
              onDiscard={discardDraft}
            />
          )}

          {/* M-4 / RD-RT3.5: autosave + connectivity. Height reserved either way, so the
              text changing never shifts the form. */}
          <AutosaveStatus savedAt={savedAt} saving={saving} online={online} />

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            onFocusCapture={e => { if (isKeyboardField(e.target)) setFieldFocused(true) }}
            onBlurCapture={e => { if (!isKeyboardField(e.relatedTarget)) setFieldFocused(false) }}
          >
            <ErrorSummary errors={errorList} onJump={focusField} innerRef={errorSummaryRef} />

            <div className="flex flex-col gap-4">
              {passSections.map((section, i) => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  index={i + 1}
                  complete={sectionCompleteness[i] ?? false}
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
                <p className="mb-1.5 text-fs-sm font-medium text-foreground">Have a coupon code?</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponInput}
                    onChange={e => { setCouponInput(e.target.value.toUpperCase()); setCouponError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleApplyCoupon() } }}
                    placeholder="Enter code"
                    aria-invalid={!!couponError}
                    aria-describedby={couponError ? "coupon-error" : undefined}
                    className={cn(controlCls(!!couponError), "flex-1 font-mono uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal")}
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
                {couponError && <FieldError id="coupon-error">{couponError}</FieldError>}
              </div>
            )}

            {/* Coupon applied badge (with remove) */}
            {isPaid && couponApplied && (
              <div className="mt-5 flex items-center justify-between rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-4 py-3">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Check className="size-3.5 text-emerald-600" aria-hidden />
                    <span className="font-mono text-fs-xs font-bold text-emerald-700">{couponApplied.code}</span>
                    {couponApplied.description && (
                      <span className="text-fs-xs text-emerald-600">{couponApplied.description}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-fs-2xs text-emerald-600">
                    −₹{(couponApplied.discountPaise / 100).toLocaleString('en-IN')} discount applied
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveCoupon}
                  className="ml-3 shrink-0 text-fs-2xs font-medium text-emerald-700 hover:underline"
                >
                  Remove
                </button>
              </div>
            )}

            {/* Approval mode note */}
            {approvalMode === 'manual' && (
              <div className="mt-5 rounded-xl border border-amber-200/60 bg-amber-50/50 px-4 py-3 text-fs-xs text-amber-700">
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
                    <p className="text-fs-base font-bold text-foreground">Payment wasn&apos;t completed</p>
                    <p className="mt-0.5 text-fs-xs leading-relaxed text-muted-foreground">
                      You have <strong className="font-semibold text-foreground">not been charged</strong>, and your
                      registration details are saved. You can safely resume payment — it reuses the same order, so
                      you will never be charged twice.
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
            ) : submitError ? (
              /* Submit error — assertive live region so failures are announced */
              <div role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-fs-sm text-destructive">
                {submitError}
              </div>
            ) : null}

            {/* RD-RT1.0: the standalone TrustBadges block is gone — its three claims now
                sit in the arrival header (before the form) and the summary panel (beside
                it), so trust is established on arrival rather than after scrolling. Same
                three statements, still gated on `isPaid`; nothing added. */}

            {/* RD-RT3.2: the in-form submit button is gone — it was a THIRD copy of the
                primary action (sticky summary on desktop, sticky bar below lg). One
                primary action per breakpoint now.

                This hidden submit stays so the form keeps a default button: pressing
                Enter in a text field still submits, exactly as before. `hidden` also
                keeps it out of the accessibility tree, so nothing is double-announced.
                The visible CTAs call formRef.current.requestSubmit(), which never needed
                a button at all. */}
            {!paymentRecovery && !feeConfirm && (
              <>
                <button type="submit" hidden aria-hidden tabIndex={-1} disabled={submitting}>
                  Continue to review
                </button>

                <p className="mt-5 text-center text-fs-2xs text-muted-foreground">
                  By registering, you agree to the event organiser&apos;s terms and conditions.
                </p>

                {/* RD-RT3.5: quiet reassurance, precise about scope — the draft lives in
                    this browser, not in an account. */}
                <RecoveryReassurance />
              </>
            )}
          </form>
        </>
        )}
        </div>

        {/* RIGHT: sticky summary — the desktop checkout surface. It carries the pass,
            the price, the primary action and the security note, and stays visible while
            the form scrolls, so the CTA is always reachable without rendering a third
            copy of the price in a floating bar. */}
        <div className="hidden lg:block">
          {/* RD-RT3.3: bounded to the viewport and scrollable internally, so a summary
              taller than the screen no longer hides its own CTA. Overflow lives on the
              STICKY element itself, never an ancestor, so stickiness is unaffected. */}
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto overscroll-contain">
            <SummaryPanel
              identity={identity}
              passName={pass.name}
              pricing={summaryPricing}
              action={paymentRecovery ? undefined : step === 'review' ? (
                <>
                  <button
                    type="button"
                    onClick={() => void (feeConfirm ? confirmAndPay() : finaliseRegistration())}
                    disabled={submitting || !reviewReady}
                    className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-full gap-1.5')}
                  >
                    <ShieldCheck className="size-4" aria-hidden />
                    {submitting ? 'Processing…' : paymentRequired ? 'Proceed to Secure Payment' : 'Complete Registration'}
                  </button>
                  <p className="mt-2.5 flex items-center justify-center gap-1.5 text-fs-2xs text-muted-foreground">
                    <ShieldCheck className="size-3 shrink-0 text-emerald-600" aria-hidden />
                    Encrypted payment via Razorpay
                  </p>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => formRef.current?.requestSubmit()}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-full')}
                  >
                    {submitting ? processingLabel : ctaLabel}
                  </button>
                  <p className="mt-2.5 flex items-center justify-center gap-1.5 text-fs-2xs text-muted-foreground">
                    <ShieldCheck className="size-3 shrink-0 text-emerald-600" aria-hidden />
                    {isPaid ? 'Encrypted payment via Razorpay' : 'Your details are sent securely'}
                  </p>
                </>
              )}
            />
          </div>
        </div>

      </div>

      {/* C-2: mobile-only sticky checkout bar (Total + Pay). Desktop keeps the right-column
          sticky SummaryCard — this is `lg:hidden`, so the desktop summary is never duplicated.
          Steps aside while a keyboard field is focused; clears the iOS safe-area inset. */}
      {/* RD-RT3.0: the bar now also serves the review step, showing the confirmed total
          and the SAME consent-gated proceed action. It stays hidden during payment
          recovery, where the recovery card owns the action. */}
      {!paymentRecovery && (
        <div className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgb(0_0_0/0.08)] backdrop-blur-md lg:hidden',
          fieldFocused && 'hidden',
        )}>
          <div className="mx-auto flex max-w-lg items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">Total</p>
              <p className="text-fs-lg font-bold leading-tight text-foreground">
                {feeConfirm
                  ? formatPaise(feeConfirm.breakdown.totalPaise)
                  : couponApplied
                    ? priceLabel
                    : <PassPrice price={pass.price} regularPrice={pass.regularPrice} isFree={pass.isFree} align="left" size="sm" showBadge={false} />}
              </p>
              <p className="sr-only">
                {step === 'review' ? 'Review your registration before confirming' : 'Total for this registration'}
              </p>
            </div>
            {step === 'review' ? (
              <button
                type="button"
                onClick={() => void (feeConfirm ? confirmAndPay() : finaliseRegistration())}
                disabled={submitting || !reviewReady}
                className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-w-[52%]')}
              >
                {submitting ? 'Processing…' : paymentRequired ? 'Proceed to Pay' : 'Complete'}
              </button>
            ) : (
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
            )}
          </div>
        </div>
      )}
    </div>
  )
}
