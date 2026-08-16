'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useRouter }              from 'next/navigation'
import { useAuth }                from '@/components/auth/AuthProvider'
// RD-RT1.0: framer-motion, Fragment and the event-meta icons left with the presentation
// components that moved to ./RegistrationUI — this module no longer renders them.
import { ShieldCheck, RotateCcw, Check, AlertTriangle, Tag, ChevronUp, Lock, Clock3, KeyRound, UserRound, Ruler } from 'lucide-react'
import { cn }                     from '@/lib/utils/cn'
import { buildRegisterHref }      from '@/lib/events/registerHref'
import { buttonVariants }         from '@/components/ui/button'
import { CustomSelect }           from '@/components/ui/CustomSelect'
import type { FormSection, FormField, ConditionalRule, FieldType } from '@/components/wizard/registrationFormConfig'
import { shouldShowSizeChart, type SizeChart } from '@/lib/registrations/sizeChart'
import { SizeChartDialog } from '@/components/registration/SizeChartDialog'
import { PLATFORM_TERMS_VERSION } from '@/lib/legal/platformTerms'
import { resolveAttendeeIdentity } from '@/lib/registrations/attendeeIdentity'
import { collectFormErrors } from '@/lib/registrations/validateFormResponses'
import { resolveDobField, ageRangeLabel } from '@/lib/registrations/ageEligibility'
// RD-PAY-P0-2 — the pure rules that decide whether a failed verification means "settled"
// or "we simply do not know yet". Everything about double-charge safety hangs off this.
import {
  classifyVerifyOutcome, VERIFY_RETRY_DELAYS_MS,
  classifyCreateOrderOutcome, CREATE_ORDER_TIMEOUT_MS,
  type VerifyOutcome, type VerifyResponseLike,
} from '@/lib/registrations/paymentVerification'
import { TAX_INCLUSIVE_NOTE } from '@/lib/pricing/copy'
import type { FeeBreakdownRecord } from '@/lib/fees/types'
import { buildAttendeeFeeBreakdown, formatPaise, type AttendeeFeeBreakdown } from '@/lib/fees/attendeeBreakdown'
// RD-RT1.0: the presentation layer now lives in RegistrationUI. Logic stays here.
import {
  CheckoutTopBar, RegistrationMasthead, FormSectionCard,
  SummaryPanel, SummaryDigest, PassSwitcher, estimateMinutes,
  type EventIdentity, type SummaryPricing,
} from './RegistrationUI'
// RD-RT4.0: the route's shared surface tokens (server-safe module).
import { CANVAS_STYLE, CANVAS, PAGE, PANEL, PANEL_BODY } from './registerTheme'
// RD-RT2.0: one visual system for every control.
import {
  FieldShell, FieldError, FIELD_HINT, controlCls, textareaCls,
  RadioOption, CheckOption, TogglePill, ErrorSummary,
} from './formControls'
import { PassPrice } from './PassPrice'
// RD-RT3.5: the recovery surface for the existing draft mechanism.
import { RecoveryBanner, AutosaveStatus, RecoveryReassurance } from './RecoveryUI'
// RD-RT5.0: the checkout blocks that live INSIDE the one form — consent and the itemised
// total. They replace the separate review screen; the gate helper is unchanged.
import {
  ConsentPanel, OrderSummaryPanel, PaymentSummaryDialog, PaymentProcessingLock,
  isConsentComplete, CONSENT_SECTION_ID,
  type ConsentState,
} from './CheckoutPanels'
import { useToast } from '@/components/ui/Toast'

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
/**
 * Does focusing this element raise the on-screen keyboard?
 *
 * Only such elements should hide the mobile checkout bar — the bar steps aside so the
 * keyboard does not cover the field being typed into.
 *
 * `tagName === 'INPUT'` was too broad: a checkbox is an <input>, so tapping "Medical
 * Consent" or "Sports Waiver" hid the payment CTA with no keyboard to justify it, and it
 * stayed hidden until focus moved elsewhere. Attendees were left unable to pay.
 *
 * Checked against the input's TYPE instead, so toggles and buttons never qualify.
 */
const NON_KEYBOARD_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden',
])

function isKeyboardField(el: EventTarget | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !NON_KEYBOARD_INPUT_TYPES.has(el.type.toLowerCase())
  return false
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

/** "Size Chart" action + its modal. Owns ONLY its own open/closed boolean — it never
 *  reads or writes the field's value, so opening and closing it cannot disturb the form. */
function SizeChartTrigger({ chart, label }: { chart: SizeChart; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 inline-flex items-center gap-1 text-fs-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
      >
        <Ruler className="size-3.5" aria-hidden />
        Size Chart
      </button>
      <SizeChartDialog
        open={open}
        onClose={() => setOpen(false)}
        chart={chart}
        title={`${label} — Size Chart`}
      />
    </>
  )
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
        {/* Optional size chart. Rendered ONLY when the field opts in, so every existing
            event — none of which carry `sizeChart` — is byte-identical to before.
            type="button" is load-bearing: inside a <form>, a bare <button> defaults to
            submit, which would post the registration on click. */}
        {shouldShowSizeChart(field.sizeChart) && (
          <SizeChartTrigger chart={field.sizeChart!} label={label} />
        )}
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
  active,
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
  /** RD-RT4.0: the first not-yet-complete section — presentation emphasis only. */
  active:      boolean
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
    <FormSectionCard title={section.title} description={section.description} index={index} complete={complete} active={active}>
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

/**
 * A payment attempt whose outcome is not yet known — the ONE shape that is parked in state
 * and mirrored to sessionStorage. Two things can produce it:
 *
 *   · checkout succeeded but verification did not resolve → `payment` is set (P0-2)
 *   · create-order gave no usable answer                  → `attemptKey` is set (P0-5),
 *     and `order.orderId` is empty because we never received one.
 *
 * While one of these is parked, every Pay affordance is suppressed and create-order is
 * unreachable, so no second order can originate from either case.
 */
interface ParkedPayment {
  order:    { orderId: string; amount: number; currency: string; keyId: string }
  attendee: { name: string; email: string; phone?: string }
  /** Present once Razorpay's handler fired — money has very likely been taken. */
  payment?: RazorpayPaymentSuccess
  /** The attempt's idempotency key, when it is the only handle we hold. */
  attemptKey?: string
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
  // RD-PAY-P0-2 — THE double-charge guard.
  //
  // Razorpay's `handler` fires only AFTER the gateway has taken the money. The moment it
  // fires we record the order + the signed result here, and from that instant the Pay CTA
  // is replaced — not merely disabled — until the payment resolves. Previously a failed
  // verify-payment re-armed Pay, and the next tap minted a SECOND Razorpay order.
  //
  // Mirrored into sessionStorage so a refresh, a backgrounded tab or a reopened browser
  // resumes settlement instead of presenting a fresh, payable form.
  const [unresolvedPayment, setUnresolvedPayment] = useState<ParkedPayment | null>(null)
  const [verifying, setVerifying] = useState(false)

  // RD-RT6.0 — the explicit confirmation step.
  //
  // `reviewOpen` drives the Payment Summary dialog. Opening it creates NOTHING: no order,
  // no intent, no Razorpay. `reviewQuote` holds the previewed charge (from the read-only
  // fee-preview route) so the dialog can name the exact amount before anything exists.
  const [reviewOpen,  setReviewOpen]  = useState(false)
  const [reviewQuote, setReviewQuote] = useState<{
    amountPaise: number
    discountPaise?: number
    couponCode?: string
    financials?: FeeBreakdownRecord
  } | null>(null)
  const [quoting, setQuoting] = useState(false)

  // RD-PAYMENT-05 B1: when the attendee bears the fees (attendee_pays), the order is parked
  // here with its canonical breakdown so the exact charge is shown and explicitly confirmed
  // BEFORE Razorpay opens. Null for organizer_absorbs / free → checkout is unchanged.
  const [feeConfirm, setFeeConfirm] = useState<{
    order:     { orderId: string; amount: number; currency: string; keyId: string }
    attendee:  { name: string; email: string; phone?: string }
    breakdown: AttendeeFeeBreakdown
  } | null>(null)
  // RD-RT5.0: there is no `step`. Registration is ONE page — the form, the consent gate
  // and the total are all on screen at once, and Pay goes straight to Razorpay.
  // Consent lives here — not inside the panel — so the sticky-summary CTA, the mobile
  // checkout bar and the submit handler are gated by exactly ONE condition. Never persisted.
  const [consent, setConsent] = useState<ConsentState>({ info: false, terms: false, refund: false })

  // RD-REGISTRATION-UX — the payment CTA used to be `disabled` while consent was missing,
  // so clicking it fired NO event at all: no scroll, no message, nothing. That is what
  // "stuck" was. The button is now always clickable and this flag carries the reason.
  const [needsConsent, setNeedsConsent] = useState(false)
  const { showToast } = useToast()


  // …and otherwise fades after a short window so it never becomes permanent chrome.
  useEffect(() => {
    if (!needsConsent) return
    const t = setTimeout(() => setNeedsConsent(false), 6000)
    return () => clearTimeout(t)
  }, [needsConsent])
  // C-2: the mobile checkout bar steps aside while a keyboard field is focused.
  const [fieldFocused, setFieldFocused] = useState(false)
  // RD-RT4.0: on mobile the desktop summary column is hidden, so the checkout bar can
  // now unfold the SAME summary facts as a sheet. Presentation state only — it renders
  // the identical `identity` / `summaryPricing` objects the desktop panel receives.
  const [mobileSummaryOpen, setMobileSummaryOpen] = useState(false)
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

  // The first not-yet-complete section — presentation emphasis on the one long page.
  // -1 = every section is complete.
  const activeStepIdx = sectionCompleteness.findIndex(c => !c)

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

  // ── RD-PAY-P0-2 · unresolved-payment persistence ──────────────────────────
  // Survives a refresh, a killed tab and a backgrounded browser, so "I paid but the page
  // reloaded" resumes settlement rather than showing a payable form again.

  const pendingPayKey = `rd:pay:${eventSlug}`

  const rememberPayment = useCallback((p: ParkedPayment | null) => {
    setUnresolvedPayment(p)
    try {
      if (p) sessionStorage.setItem(pendingPayKey, JSON.stringify(p))
      else   sessionStorage.removeItem(pendingPayKey)
    } catch { /* private mode / quota — in-memory state still guards this session */ }
  }, [pendingPayKey])

  /**
   * ONE verification attempt, reduced to a decision. Never throws: a rejected fetch and an
   * unparseable body are both "we learned nothing", which is TRANSIENT, not failure.
   */
  async function verifyOnce(
    payment: RazorpayPaymentSuccess,
    headers: Record<string, string>,
  ): Promise<VerifyOutcome> {
    try {
      const res = await fetch('/api/registrations/verify-payment', {
        method: 'POST', headers, body: JSON.stringify(payment),
      })
      let body: VerifyResponseLike | null = null
      try { body = await res.json() as VerifyResponseLike } catch { /* HTML 504, empty body … */ }
      return classifyVerifyOutcome({ status: res.status, body })
    } catch {
      return classifyVerifyOutcome({ threw: true })
    }
  }

  /**
   * Verify with a bounded backoff. Retrying is SAFE and is the whole recovery mechanism:
   * verify-payment is idempotent per intent — its transaction returns the existing
   * registrationId when the intent is already `paid` — so N attempts settle exactly once.
   */
  async function verifyWithRetry(
    payment: RazorpayPaymentSuccess,
    headers: Record<string, string>,
  ): Promise<VerifyOutcome> {
    let outcome = await verifyOnce(payment, headers)
    for (let i = 0; outcome.kind === 'transient' && i < VERIFY_RETRY_DELAYS_MS.length; i++) {
      await new Promise(r => setTimeout(r, VERIFY_RETRY_DELAYS_MS[i]))
      outcome = await verifyOnce(payment, headers)
    }
    return outcome
  }

  /**
   * Settle a payment whose money has already been taken.
   *
   *   confirmed → ticket.
   *   final     → the server DECIDED and refused; it has already refunded anything it took,
   *               so the form is released and a fresh attempt is safe.
   *   transient → we do not know. Stay parked. Pay is NOT re-armed.
   */
  const settlePayment = useCallback(async (p: ParkedPayment, headers: Record<string, string>): Promise<void> => {
    if (!p.payment) return
    setVerifying(true)
    setSubmitError(null)
    try {
      const outcome = await verifyWithRetry(p.payment, headers)
      if (outcome.kind === 'confirmed') {
        rememberPayment(null)
        clearSavedForm()
        router.push(`/events/${eventSlug}/register/success?fresh=1&id=${outcome.registrationId}`)
        return
      }
      if (outcome.kind === 'final') {
        rememberPayment(null)
        setSubmitError(outcome.error)
        return
      }
      // Unresolved — keep the parked payment exactly where it is.
      rememberPayment(p)
    } finally {
      setVerifying(false)
    }
    // verifyOnce / verifyWithRetry are stable closures over module-level constants only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberPayment, clearSavedForm, router, eventSlug])

  /**
   * The recovery card's action. Re-runs verification when we hold the signed result (which
   * both QUERIES and SETTLES, idempotently); otherwise asks the read-only status endpoint,
   * which reports what Razorpay actually holds without creating anything.
   */
  async function checkPaymentStatus(): Promise<void> {
    const p = unresolvedPayment
    if (!p || verifying) return

    if (p.payment) { await settlePayment(p, buildHeaders()); return }

    setVerifying(true)
    try {
      const res  = await fetch('/api/registrations/payment-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // RD-PAY-P0-5 — by order id when we have one; otherwise by ATTEMPT, for a
        // create-order whose response never arrived.
        body: JSON.stringify(p.order.orderId
          ? { orderId: p.order.orderId }
          : { idempotencyKey: p.attemptKey, slug: eventSlug }),
      })
      const json = await res.json() as {
        state?: string; registrationId?: string; canRetry?: boolean; reason?: string
      }

      // RD-PAY-P0-5 — the attempt never claimed an order, so the browser never received one
      // and no payment can exist against it. Releasing the form here is provably safe, and
      // the next press reuses the SAME idempotency key, so even a stranded order is reused
      // rather than duplicated.
      if (json.state === 'no_order') {
        rememberPayment(null)
        setSubmitError('We could not start that payment. Nothing was charged — please try again.')
        return
      }
      if (json.state === 'confirmed' && json.registrationId) {
        rememberPayment(null)
        clearSavedForm()
        router.push(`/events/${eventSlug}/register/success?fresh=1&id=${json.registrationId}`)
        return
      }
      if (json.state === 'failed') {
        // Terminal server-side: anything captured was refunded before the intent was marked
        // failed, so releasing the form here cannot double-charge.
        rememberPayment(null)
        setSubmitError('That payment could not be used to register. If you were charged, a full refund has been initiated.')
        return
      }
      if (json.state === 'awaiting_payment') {
        // Razorpay holds nothing for this order, so it is safe to let the attendee proceed.
        rememberPayment(null)
        if (p.order.orderId) {
          // We hold the full order (amount + keyId) — reopen THAT one. No new order.
          setPaymentRecovery({ order: p.order, attendee: p.attendee })
        } else {
          // RD-PAY-P0-5 — resolved by attempt, so we have an order id but not the keyId
          // needed to open checkout. Release the form instead: the next press runs
          // create-order with the SAME idempotency key, which the server answers with
          // `reused: true` and the existing order. Still exactly one Razorpay order.
          setSubmitError('Your payment was not completed. You can safely continue — you will not be charged twice.')
        }
        return
      }
      // captured_unsettled | unknown | throttled → stay parked.
      rememberPayment(p)
    } catch {
      rememberPayment(p)
    } finally {
      setVerifying(false)
    }
  }

  // Resume on mount: a payment recorded before a refresh is settled automatically, so the
  // attendee lands on "confirming your payment", never on a fresh payable form.
  const resumedRef = useRef(false)
  useEffect(() => {
    if (resumedRef.current || !authChecked) return
    resumedRef.current = true
    let parsed: { order?: unknown; attendee?: unknown; payment?: unknown } | null = null
    try {
      const raw = sessionStorage.getItem(pendingPayKey)
      parsed = raw ? JSON.parse(raw) as typeof parsed : null
    } catch { return }
    const p = parsed as Parameters<typeof settlePayment>[0] | null
    if (!p?.order) return
    // Deferred out of the effect body — this repo forbids synchronous setState there
    // (react-hooks/set-state-in-effect), the same pattern RecoveryUI/AutosaveStatus use.
    const raf = requestAnimationFrame(() => {
      setUnresolvedPayment(p)
      if (p.payment) void settlePayment(p, buildHeaders())
    })
    return () => cancelAnimationFrame(raf)
    // buildHeaders reads authToken, which `authChecked` already gates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, pendingPayKey, settlePayment])

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
      // RD-RT5.0: the recovery card renders inside the one form, which is already on
      // screen, so there is no step to return to.
      setPaymentRecovery({ order, attendee })
      return
    }

    // RD-PAY-P0-2 — THE critical line. Razorpay's handler has fired, which means the money
    // has been taken. Record that BEFORE any network call, so every subsequent failure mode
    // — timeout, 429, 500, tab close, crash — lands on the recovery state instead of on a
    // form whose Pay button would mint a second order.
    const pending = { order, attendee, payment: paymentResult }
    rememberPayment(pending)

    // settlePayment owns the outcome: retries transient failures, redirects on success, and
    // releases the form ONLY when the server has definitively decided (and refunded).
    await settlePayment(pending, headers)
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

  // RD-RT5.0: the form submits straight through again. It validates — with the SAME
  // rules as before — and, when everything passes, goes directly to checkout. There is
  // no Review step to hand over to: the consent gate and the total are already on this
  // page, and `finaliseRegistration` still enforces consent before any order is created.
  //
  // ORDER MATTERS: fields first, consent second. A form with three empty required fields
  // AND no consent should name the fields, not send the attendee to a checkbox.
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
    // RD-RT6.0 — FIRST CLICK ends here. Valid form → open the Payment Summary dialog.
    // This creates NOTHING: no Razorpay order, no payment intent, no checkout. The only
    // control that reaches the payment pipeline is "Proceed to Pay" inside the dialog.
    void openPaymentReview()
  }

  /**
   * FIRST CLICK · "Review & Pay".
   *
   * Enforces the consent gate (unchanged), fetches a READ-ONLY quote so the dialog can name
   * the exact amount, and opens it. `fee-preview` runs the same resolution chain
   * create-order runs and stops before Razorpay — it writes nothing and creates no order.
   *
   * A preview failure is NOT fatal: the dialog still opens showing the price the page
   * already knows, and create-order remains the authority at the moment of charge.
   */
  async function openPaymentReview(): Promise<void> {
    if (submitting || quoting || reviewOpen) return   // triple-tap → exactly one dialog

    if (!isConsentComplete(consent, termsUrl, refundPolicyUrl)) {
      guideToConfirmation()
      return
    }
    setSubmitError(null)

    const localPaise = couponApplied ? couponApplied.finalPaise : Math.round((pass.price ?? 0) * 100)
    // Free / fully discounted → no fees to itemise and no quote to fetch.
    if (pass.isFree || localPaise <= 0) {
      setReviewQuote({ amountPaise: 0 })
      setReviewOpen(true)
      return
    }

    setQuoting(true)
    try {
      const res  = await fetch('/api/registrations/fee-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: eventSlug, passId: pass.id, ...(couponApplied ? { couponCode: couponApplied.code } : {}) }),
      })
      const json = await res.json() as {
        amountPaise?: number; discountPaise?: number; couponCode?: string
        financials?: FeeBreakdownRecord; error?: string
      }
      setReviewQuote(res.ok && typeof json.amountPaise === 'number'
        ? { amountPaise: json.amountPaise, discountPaise: json.discountPaise, couponCode: json.couponCode, financials: json.financials }
        : { amountPaise: localPaise })
    } catch {
      setReviewQuote({ amountPaise: localPaise })
    } finally {
      setQuoting(false)
      setReviewOpen(true)
    }
  }

  /**
   * SECOND CLICK · "Proceed to Pay ₹X".
   *
   * The ONLY control that reaches the payment pipeline. It calls the EXISTING
   * finaliseRegistration — same duplicate precheck, same create-order (with its P0-2
   * attempt idempotency and order reuse), same Razorpay initialisation, same verification
   * and recovery. Nothing is duplicated here.
   */
  function proceedToPay(): void {
    if (submitting) return
    setReviewOpen(false)
    void (feeConfirm ? confirmAndPay() : finaliseRegistration())
  }

  // The duplicate precheck, the create-order call, the RD-PAYMENT-05 B1 fee confirmation
  // and the free-registration submit. No request, payload, ordering or branch changed.
  /** Send the attendee to the confirmation control and mark it for attention.
   *  Same scroll/focus pattern as HashScrollLink: ONE scroll, then focus with
   *  preventScroll so focusing cannot cause a second competing jump. */
  function guideToConfirmation(): void {
    setNeedsConsent(true)   // idempotent — repeated clicks re-arm, never stack
    const el = document.getElementById(CONSENT_SECTION_ID)
    if (!el) return
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  }

  async function finaliseRegistration(): Promise<void> {
    if (submitting) return

    // RD-PAY-P0-2 — THE double-charge stop. A payment whose outcome we do not yet know
    // blocks every path to create-order. This is checked FIRST, before consent, before the
    // duplicate precheck, before anything: no combination of taps, refreshes or resubmits
    // can reach order creation while money may already be in flight.
    if (unresolvedPayment) {
      void checkPaymentStatus()
      return
    }

    // GATE — before the duplicate precheck, before create-order, before Razorpay.
    if (!isConsentComplete(consent, termsUrl, refundPolicyUrl)) {
      guideToConfirmation()
      return
    }
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
        const dupMessage = dupJson.field === 'mobile'
          ? 'You already have a registration for this event with this mobile number. Please check your email for your ticket.'
          : 'You already have a registration for this event with this email address. Please check your inbox for your ticket.'
        // Inline error stays for persistent context; the toast is the immediate
        // acknowledgement, because the inline banner sits below the fold on a long review.
        // Fired here inside the submit handler — an EVENT path, not a render path — so a
        // re-render can never re-trigger it. Toast.tsx already routes error variants to an
        // assertive live region.
        setSubmitError(dupMessage)
        showToast(dupMessage, 'error', { title: 'Already registered' })
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
      // Mandatory consent. The server re-validates this on BOTH endpoints — the client
      // gate above is UX, this is the value the server actually checks and stores.
      termsAccepted: consent.terms,
      termsVersion:  PLATFORM_TERMS_VERSION,
    }

    try {
      // ── Paid flow ──────────────────────────────────────────────────────────
      if (!pass.isFree && effectivePricePaise > 0) {
        // RD-PAY-P0-5 — bounded. Without this the request could hang forever, leaving
        // `submitting` true and the processing lock on screen with no way out. The abort
        // stops the WAIT; it says nothing about whether the server created an order, which
        // is why the outcome below is treated as unknown rather than as a failure.
        type OrderJson = {
          orderId?: string; amount?: number; currency?: string; keyId?: string; error?: string
          reason?: string; reused?: boolean
          alreadyRegistered?: boolean; registrationId?: string
          financials?: FeeBreakdownRecord
        }
        let orderRes:  Response | null = null
        let orderJson: OrderJson | null = null
        try {
          orderRes = await fetch('/api/registrations/create-order', {
            method: 'POST', headers, body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(CREATE_ORDER_TIMEOUT_MS),
          })
          orderJson = await orderRes.json() as OrderJson
        } catch {
          orderRes = null   // abort / offline / connection reset / unparseable body
        }

        // RD-PAY-P0-2 — the server refused to mint a replacement because Razorpay still
        // holds a payment against this attempt's previous order. Park it; do not offer Pay.
        if (orderRes?.status === 409 && orderJson?.reason === 'PAYMENT_IN_PROGRESS' && orderJson.orderId) {
          rememberPayment({
            order: { orderId: orderJson.orderId, amount: effectivePricePaise, currency: 'INR', keyId: '' },
            attendee,
          })
          return
        }

        if (!orderRes || !orderRes.ok || !orderJson?.orderId) {
          // RD-PAY-P0-5 — split "the server refused" from "we never found out".
          const outcome = classifyCreateOrderOutcome(
            orderRes
              ? { status: orderRes.status, body: orderJson }
              : { threw: true },
          )

          if (outcome.kind === 'definite') {
            // Every 4xx create-order returns is emitted BEFORE razorpay.orders.create, so
            // nothing exists to protect and the attendee can safely fix the problem.
            setSubmitError(outcome.error)
            return
          }

          // UNKNOWN. A Razorpay order and a payment intent may both already exist for this
          // attempt. Park it exactly like a post-capture unknown: the Pay affordance is
          // suppressed, nothing is auto-retried, and "Check payment status" resolves it
          // through the attempt claim. `orderId` is empty because we never received one —
          // `attemptKey` is the handle instead.
          rememberPayment({
            order: { orderId: '', amount: effectivePricePaise, currency: 'INR', keyId: '' },
            attendee,
            attemptKey: idempotencyKey,
          })
          return
        }

        // RD-PAY-P0-2 — this attempt already settled (a webhook, or an earlier verification
        // that did land). Send the attendee to their ticket instead of to Razorpay.
        if (orderJson.alreadyRegistered && orderJson.registrationId) {
          rememberPayment(null)
          clearSavedForm()
          router.push(`/events/${eventSlug}/register/success?fresh=1&id=${orderJson.registrationId}`)
          return
        }

        // `reused: true` means this is the SAME order a previous call minted for this
        // attempt — the server declined to create a second one. Checkout opens on it
        // exactly as it would on a new order.
        const order = { orderId: orderJson.orderId, amount: orderJson.amount!, currency: orderJson.currency ?? 'INR', keyId: orderJson.keyId! }

        // RD-PAYMENT-05 B1: when the attendee bears fees, show the EXACT canonical breakdown
        // (from the server financials — total === order.amount) and require explicit
        // confirmation before opening Razorpay. Absent (organizer_absorbs / free) → the flow
        // is unchanged: open Razorpay directly via runPayment.
        // RD-PAYMENT-05 B1 — the attendee must have seen and accepted the EXACT amount
        // before Razorpay opens.
        //
        // RD-RT6.0: they normally already have. The Payment Summary dialog showed the
        // previewed charge and they pressed "Proceed to Pay ₹X", so when the server agrees
        // with that number the acceptance stands and checkout opens with no further step.
        //
        // If the server disagrees (a price or coupon changed between the preview and the
        // charge), the acceptance no longer covers what is about to be taken — so the
        // dialog RE-OPENS with the authoritative breakdown and requires an explicit second
        // confirmation. The guarantee is preserved; only the redundant confirmation is not.
        const breakdown = buildAttendeeFeeBreakdown(orderJson.financials)
        if (breakdown && breakdown.totalPaise !== reviewQuote?.amountPaise) {
          setFeeConfirm({ order, attendee, breakdown })
          setReviewQuote({ amountPaise: breakdown.totalPaise, financials: orderJson.financials })
          setReviewOpen(true)
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
        router.push(`/events/${eventSlug}/register/success?fresh=1&id=${json.registrationId}`)
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
  // RD-RT4.0: the gates now open on the same canvas + checkout bar as the form, so an
  // invite-only or sign-in-required event does not feel like a different product before
  // it feels like a registration. Behaviour, handlers and copy are unchanged.
  if (requiresInviteCode && !inviteCodeVerified) {
    return (
      <div style={CANVAS_STYLE} className={cn('min-h-screen', CANVAS)}>
        <CheckoutTopBar eventSlug={eventSlug} secure={false} />
        <div className={cn(PAGE, 'flex min-h-[calc(100vh-3.5rem)] items-center justify-center py-12')}>
          <div className="w-full max-w-md">
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <KeyRound className="size-6" aria-hidden />
              </div>
              <h1 className="text-fs-lg font-bold tracking-tight text-foreground">Invite Only</h1>
              <p className="mt-2 text-fs-base text-muted-foreground">
                This event requires an invite code to register.
              </p>
            </div>

            <div className={cn(PANEL, PANEL_BODY)}>
              <label htmlFor="invite-code" className="mb-1.5 block text-fs-sm font-semibold text-foreground">
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
                className={cn(controlCls(!!inviteCodeError), 'font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal')}
                aria-invalid={!!inviteCodeError}
              />
              {inviteCodeError && (
                <FieldError id="invite-code-error">{inviteCodeError}</FieldError>
              )}
              <button
                type="button"
                onClick={() => void handleVerifyInviteCode()}
                disabled={inviteCodeChecking}
                className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-4 w-full')}
              >
                {inviteCodeChecking ? 'Verifying…' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Auth loading ───────────────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <div style={CANVAS_STYLE} className={cn('flex min-h-screen items-center justify-center', CANVAS)}>
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
        <span className="sr-only">Checking your session…</span>
      </div>
    )
  }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  if (requireLogin && !isLoggedIn) {
    return (
      <div style={CANVAS_STYLE} className={cn('min-h-screen', CANVAS)}>
        <CheckoutTopBar eventSlug={eventSlug} secure={false} />
        <div className={cn(PAGE, 'flex min-h-[calc(100vh-3.5rem)] items-center justify-center py-12')}>
          <div className={cn(PANEL, PANEL_BODY, 'w-full max-w-md text-center')}>
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <UserRound className="size-6" aria-hidden />
            </div>
            <h1 className="text-fs-lg font-bold tracking-tight text-foreground">Sign in to Register</h1>
            <p className="mx-auto mt-2 max-w-sm text-fs-base leading-relaxed text-muted-foreground">
              The organiser requires you to be signed in before registering for this event.
            </p>
            <a
              href={`/login?redirect=${encodeURIComponent(buildRegisterHref(eventSlug, pass.id))}`}
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-6 w-full')}
            >
              Sign In to Continue
            </a>
          </div>
        </div>
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
  const processingLabel  = isFreeCheckout ? 'Submitting…' : 'Processing…'

  // RD-RT3.1: mirrors the EXISTING branch in finaliseRegistration verbatim
  // (`!pass.isFree && effectivePricePaise > 0`). Read only — the decision itself is
  // still made inside finaliseRegistration and was not touched.
  const effectivePaiseNow = couponApplied ? couponApplied.finalPaise : Math.round((pass.price ?? 0) * 100)
  const paymentRequired   = !pass.isFree && effectivePaiseNow > 0

  // RD-RT5.0 — THE amount on the button. Server-canonical once create-order has returned
  // an itemised attendee charge (feeConfirm); until then the page's own effective price,
  // which is the same number create-order will charge under organizer_pays. Never a
  // hardcoded value, and always the same number the Payment Summary above it shows.
  // RD-RT6.0 — the on-page CTA opens the confirmation dialog, so it must not promise
  // payment. "Review & Pay" says what the press actually does; the dialog's own CTA names
  // the amount and says where it goes. A free registration has nothing to review a price
  // for, so it keeps its direct label.
  const ctaLabel      = isFreeCheckout ? 'Complete Registration' : 'Review & Pay'

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

  // ONE definition of "may proceed", shared by the submit handler, the sticky-summary
  // CTA and the mobile checkout bar, so no surface can become an ungated path to payment.
  const consentReady = isConsentComplete(consent, termsUrl, refundPolicyUrl)

  // RD-RT5.0 — the invoice rows shown in the on-page Payment Summary. Server-canonical
  // once create-order has answered with an itemised attendee charge; until then, the
  // single "Registration fee" line for the price this page already displays. Formatting
  // over existing state — no fetch, no pricing maths.
  // RD-RT6.0 — the inline summary is now STABLE. It used to swap to the server's itemised
  // breakdown the moment `feeConfirm` arrived, which is precisely the silent mid-flow change
  // that made attendees think they had already paid. Itemisation belongs to the confirmation
  // dialog; this panel just states, unchangingly, what the page has always known.
  const orderLines = paymentRequired ? [{ label: 'Registration fee', paise: effectivePaiseNow }] : []

  // RD-RT6.0 — what the confirmation dialog shows. Server-previewed when available (the
  // itemised ticket / platform fee / GST / gateway rows), otherwise the single ticket line
  // the page already knows. Formatting only: every figure is produced by the fee engine,
  // none is recomputed here.
  const reviewBreakdown = buildAttendeeFeeBreakdown(reviewQuote?.financials)
  const reviewTotalPaise = reviewQuote?.amountPaise ?? effectivePaiseNow
  const reviewLines: { label: string; paise: number }[] = reviewBreakdown
    ? reviewBreakdown.lines
    : reviewTotalPaise > 0
      ? [{ label: 'Ticket price', paise: reviewQuote?.discountPaise !== undefined
            ? reviewTotalPaise + reviewQuote.discountPaise
            : reviewTotalPaise }]
      : []
  const reviewDiscount = reviewQuote?.discountPaise
    ? { code: reviewQuote.couponCode ?? couponApplied?.code ?? '', label: `−${formatPaise(reviewQuote.discountPaise)}` }
    : couponApplied
      ? { code: couponApplied.code, label: `−${formatPaise(couponApplied.discountPaise)}` }
      : null

  // ── Main layout ────────────────────────────────────────────────────────────
  return (
    // RD-RT4.0: THE canvas. Every panel below is white; the page is not. That one
    // separation is what lets the form sections, the journey and the summary read as
    // objects sitting on a surface instead of as regions of a single white sheet.
    // RD-RT7.0: `inert` while a payment attempt is in flight. The overlay already swallows
    // pointer events and useFocusTrap swallows Tab, but `inert` is the primitive that makes
    // "background controls are unreachable" true rather than merely hard — it removes every
    // descendant from the tab order, the a11y tree and hit-testing at once. The lock and the
    // summary dialog are PORTALLED to document.body, so they sit outside this subtree and
    // stay fully interactive; Razorpay's own container does too.
    <div style={CANVAS_STYLE} className={cn('relative min-h-screen', CANVAS)} inert={submitting}>

      {/* A single brand bloom behind the masthead — the only large-area colour on the
          page, and deliberately at ~0.05 alpha so it registers as warmth, not as pink. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(100%_100%_at_50%_0%,rgb(var(--primary-rgb)_/_0.06)_0%,transparent_70%)]"
      />

      {/* Checkout chrome — pinned for the whole flow, so "where am I / how do I leave"
          is answerable from any scroll position. */}
      <CheckoutTopBar eventSlug={eventSlug} secure={isPaid} />

      {/* pb-32 (mobile) clears the sticky checkout bar and its safe-area inset. */}
      <div className={cn(PAGE, 'relative pb-32 lg:pb-20')}>

        {/* Breadcrumb → eyebrow → title → one sentence → three quiet facts. The poster,
            pass, price and venue live in the summary, which is on screen the whole
            way down — relocated, not removed. Owns the page <h1>. */}
        <RegistrationMasthead
          eventSlug={eventSlug}
          eventName={eventName}
          estimate={estimateLabel}
          isPaid={isPaid}
        />

      {/* RD-RT5.0: the journey stepper is gone. It described a four-stage flow
          (Registration → Review → Payment → Confirmation) that no longer exists — there is
          one page, and the only thing after it is Razorpay. A "Step 1 of 4" on a page with
          no step 2 is worse than no indicator at all. */}

      {/* 64 / 36 — the registration experience beside a sticky summary. */}
      {/* RD-RT3.2.1: `lg:items-start` was removed on purpose. It set align-items:start,
          which shrank the right grid item to its content height — so the sticky child
          exactly filled its containing block and had ZERO travel distance, which is why
          it never appeared to stick. With the default `stretch`, the right column spans
          the row height set by the (taller) form column and the sticky child can move
          within it. Native CSS only; no scroll listeners. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,64fr)_minmax(0,36fr)] lg:gap-8">

        {/* LEFT: the one and only registration surface. RD-RT5.0 removed the branch that
            used to swap this whole column for a review screen — the form is never
            unmounted, so nothing has to be restored and there is nothing to navigate
            back from. */}
        <div>
          {/* RD-RT3.5: the draft is OFFERED, never applied behind the attendee's back.
              RD-RT4.0 moves it ABOVE the pass selector — a pure sibling reorder. "Resume
              or start over" is the first decision of the visit; asking it after the pass
              has already been chosen made the answer feel like it might undo that. */}
          {pendingDraft && (
            <RecoveryBanner
              fieldCount={Object.keys(pendingDraft).length}
              onResume={resumeDraft}
              onDiscard={discardDraft}
            />
          )}

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

          {/* RD-RT5.0: the segmented section meter ("2 of 4 complete") is gone with the
              stepper. Each section card still carries its own complete/active state, which
              answers "where am I" without implying the page is a wizard. */}

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
                  active={i === activeStepIdx}
                  fieldStates={fieldStates}
                  values={values}
                  errors={errors}
                  onChange={handleChange}
                  onBlur={handleBlur}
                />
              ))}
            </div>

            {/* RD-RT5.0 · Terms & Consent — ON THIS PAGE, directly after the organiser's
                own fields. It was the only part of the review screen the attendee had to
                ACT on, which is exactly why it belongs in the form rather than behind it.
                Same three checkboxes, same gate, same URL-conditional rules.

                The consent inputs are checkboxes, so `isKeyboardField` returns false for
                them and ticking one can never hide the mobile checkout bar. */}
            <ConsentPanel
              consent={consent}
              onConsent={(key, value) => setConsent(c => ({ ...c, [key]: value }))}
              termsUrl={termsUrl}
              refundPolicyUrl={refundPolicyUrl}
              submitting={submitting}
              needsConsent={needsConsent && !consentReady}
            />

            {/* Coupon — RD-RT4.0 gives it the same panel language as a form section, so
                the last thing before the total stops looking like an afterthought bolted
                to the bottom of the form. Same input, same handlers, same states. */}
            {isPaid && !couponApplied && (
              <div className={cn(PANEL, 'mt-4 p-4 sm:p-5')}>
                <div className="mb-2.5 flex items-center gap-2.5">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Tag className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-fs-sm font-bold text-foreground">Have a coupon code?</p>
                    <p className="text-fs-2xs text-muted-foreground">Applied to your total before payment.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponInput}
                    onChange={e => { setCouponInput(e.target.value.toUpperCase()); setCouponError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleApplyCoupon() } }}
                    placeholder="Enter code"
                    aria-invalid={!!couponError}
                    aria-describedby={couponError ? "coupon-error" : undefined}
                    className={cn(controlCls(!!couponError), "flex-1 font-mono uppercase tracking-widest placeholder:font-sans placeholder:normal-case placeholder:tracking-normal")}
                    disabled={couponChecking}
                  />
                  <button
                    type="button"
                    onClick={() => void handleApplyCoupon()}
                    disabled={couponChecking || !couponInput.trim()}
                    className={cn(buttonVariants({ variant: 'outline', size: 'md' }), 'shrink-0')}
                  >
                    {couponChecking ? 'Checking…' : 'Apply'}
                  </button>
                </div>
                {couponError && <FieldError id="coupon-error">{couponError}</FieldError>}
              </div>
            )}

            {/* Coupon applied badge (with remove) */}
            {isPaid && couponApplied && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600">
                    <Check className="size-3.5" strokeWidth={3} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-fs-2xs font-bold text-emerald-700">{couponApplied.code}</span>
                      {couponApplied.description && (
                        <span className="text-fs-xs text-emerald-700/90">{couponApplied.description}</span>
                      )}
                    </div>
                    <p className="mt-1 text-fs-xs font-semibold text-emerald-700">
                      −₹{(couponApplied.discountPaise / 100).toLocaleString('en-IN')} applied to your total
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveCoupon}
                  className="-my-1 inline-flex min-h-9 shrink-0 items-center rounded-md px-2 text-fs-2xs font-semibold text-emerald-700 underline underline-offset-2 outline-none transition-colors hover:bg-emerald-500/10 hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600/40"
                >
                  Remove
                </button>
              </div>
            )}

            {/* Approval mode note */}
            {approvalMode === 'manual' && (
              <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
                  <Clock3 className="size-3.5" />
                </span>
                <p className="text-fs-xs leading-relaxed text-amber-800">
                  <span className="font-bold">Reviewed before confirmation.</span>{' '}
                  Your registration will be reviewed by the organiser. You will be notified by email once approved.
                </p>
              </div>
            )}

            {/* RD-RT5.0 · Payment Summary — the itemised total, immediately above the
                action that authorises it. This is the second half of what the review
                screen owned. Hidden during payment recovery, where the recovery card is
                the only thing that should be asking for a decision.

                SCOPED to below `lg`, because at `lg` and up the sticky ticket in the right
                column already carries the pass, the discount row, the total and the CTA —
                and both columns are on screen at once, so rendering this too would print
                "Total payable ₹X" twice within one viewport. Below `lg` that ticket is
                `hidden` and the checkout bar shows a bare total, so this block is the only
                place the attendee can see what the number is made of.

                The one exception is `feeConfirm`: when the server has returned an itemised
                attendee-borne charge, the breakdown is the whole point and must be legible
                at every width, so it un-hides on desktop too. */}
            {!paymentRecovery && !unresolvedPayment && (
              <div className={cn('lg:hidden', feeConfirm && 'lg:block')}>
              <OrderSummaryPanel
                passName={pass.name}
                passPriceLabel={priceLabel}
                strikeLabel={summaryPricing.strikeLabel}
                passAgeLabel={passAgeLabel}
                lines={orderLines}
                discount={couponApplied
                  ? { code: couponApplied.code, label: `−₹${(couponApplied.discountPaise / 100).toLocaleString('en-IN')}` }
                  : null}
                totalPaise={effectivePaiseNow}
                paymentRequired={paymentRequired}
                // Never "authoritative" inline any more — the dialog is where the exact,
                // server-itemised charge is shown and accepted, so this panel keeps its
                // honest "fees are itemised before payment opens" note.
                authoritative={false}
              />
              </div>
            )}

            {/* RD-PAY-P0-2 — UNRESOLVED PAYMENT. Outranks every other state on this page.
                The attendee's money has (probably) been taken and we cannot yet prove what
                happened to it, so this card REPLACES the payment affordance rather than
                sitting beside it: there is deliberately no control here that can create a
                second order. The only actions are "check again" and "go to my ticket". */}
            {unresolvedPayment ? (
              <div role="status" aria-live="polite" className={cn(PANEL, 'mt-4 border-primary/35 p-4 sm:p-5')}>
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    {verifying
                      ? <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
                      : <ShieldCheck className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-fs-base font-bold text-foreground">
                      {verifying ? 'Checking payment status…' : 'Confirming your payment'}
                    </p>
                    {/* RD-PAY-P0-5 — the same card serves two unknowns, and they need
                        different reassurance. A capture-side unknown means money may have
                        moved; a create-order unknown (no `payment`, resolved by attempt)
                        means checkout never opened, so promising a ticket would be wrong. */}
                    <p className="mt-1 text-fs-xs leading-relaxed text-muted-foreground">
                      <strong className="font-semibold text-foreground">Please do not pay again.</strong>{' '}
                      {unresolvedPayment.payment || unresolvedPayment.order.orderId
                        ? <>If you were charged, your registration will be completed automatically and your
                           ticket emailed to you. You can close this page safely.</>
                        : <>We are checking whether your payment started. This takes a moment — please do
                           not refresh or start another payment.</>}
                    </p>
                  </div>
                </div>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => void checkPaymentStatus()}
                    disabled={verifying}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full gap-1.5')}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    {verifying ? 'Checking…' : 'Check payment status'}
                  </button>
                </div>
                {submitError && (
                  <p role="alert" className="mt-3 text-fs-xs leading-relaxed text-destructive">{submitError}</p>
                )}
              </div>
            ) : /* H-4: payment recovery card — shown when a payment was cancelled/failed.
                Retry reuses the same order (idempotent, no duplicate registration). */
            paymentRecovery ? (
              <div role="alert" className={cn(PANEL, 'mt-4 border-amber-500/30 p-4 sm:p-5')}>
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
                    <AlertTriangle className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-fs-base font-bold text-foreground">Payment wasn&apos;t completed</p>
                    <p className="mt-1 text-fs-xs leading-relaxed text-muted-foreground">
                      You have <strong className="font-semibold text-foreground">not been charged</strong>, and your
                      registration details are saved. You can safely resume payment — it reuses the same order, so
                      you will never be charged twice.
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
                  <button
                    type="button"
                    onClick={() => void retryPayment()}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'flex-1 gap-1.5')}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    {submitting ? 'Processing…' : isPaid ? `Retry Payment · ${priceLabel}` : 'Retry Payment'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentRecovery(null)}
                    disabled={submitting}
                    className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'flex-1')}
                  >
                    Return to Registration
                  </button>
                </div>
              </div>
            ) : submitError ? (
              /* Submit error — assertive live region so failures are announced */
              <div role="alert" className="mt-4 flex items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/[0.04] p-4 text-fs-sm leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0">{submitError}</span>
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
            {!paymentRecovery && !unresolvedPayment && (
              <>
                <button type="submit" hidden aria-hidden tabIndex={-1} disabled={submitting}>
                  {ctaLabel}
                </button>

                {/* RD-RT4.0: one quiet closing block instead of two stacked footnotes —
                    the legal line, the security line and the draft reassurance are all
                    the same register of information, so they share one strip. */}
                <div className="mt-6 rounded-2xl border border-border/60 bg-card/60 px-4 py-3.5">
                  <p className="flex items-center justify-center gap-1.5 text-fs-2xs font-semibold text-muted-foreground">
                    <Lock className="size-3 shrink-0 text-emerald-600" aria-hidden />
                    {isPaid ? 'Encrypted payment via Razorpay' : 'Your details are sent securely'}
                  </p>
                  <p className="mt-2 text-center text-fs-2xs leading-relaxed text-muted-foreground">
                    By registering, you agree to the event organiser&apos;s terms and conditions.
                  </p>

                  {/* RD-RT3.5: quiet reassurance, precise about scope — the draft lives
                      in this browser, not in an account. */}
                  <RecoveryReassurance />
                </div>
              </>
            )}
          </form>
        </div>

        {/* RIGHT: sticky summary — the desktop checkout surface. It carries the pass,
            the price, the primary action and the security note, and stays visible while
            the form scrolls, so the CTA is always reachable without rendering a third
            copy of the price in a floating bar. */}
        <div className="hidden lg:block">
          {/* RD-RT3.3: bounded to the viewport and scrollable internally, so a summary
              taller than the screen no longer hides its own CTA. Overflow lives on the
              STICKY element itself, never an ancestor, so stickiness is unaffected.
              RD-RT4.0: `top-20` clears the 56px sticky checkout bar with a 24px gutter.

              The horizontal `-mx-3 px-3` that used to be here is GONE: it existed only to
              stop `overflow-y-auto` (which forces overflow-x to `auto`) from clipping the
              perforation notches where they overhung the card edge. The notches no longer
              overhang — they are half-discs inside the border box — so the compensation is
              dead. Measured after the change: scrollWidth === clientWidth, no overflow.

              `pb-2` stays and IS load-bearing: the panel's ambient shadow extends ~8px
              below its border box (18px offset + 36px blur / 2 − 28px spread), and
              box-shadow does not contribute to scrollable overflow, so a smaller pad cuts
              the bottom of the shadow off at the scroll container's padding edge. */}
          <div className="sticky top-20 max-h-[calc(100vh-6.5rem)] overflow-y-auto overscroll-contain pb-2">
            {/* RD-RT5.0: ONE action, not two. There is no review branch left — this
                submits the form, which validates and goes straight to Razorpay.
                Deliberately NOT disabled on missing consent: a disabled button fires no
                event, so pressing it did nothing and read as broken. It stays live and
                `finaliseRegistration` brings the attendee to the consent block instead. */}
            <SummaryPanel
              identity={identity}
              passName={pass.name}
              pricing={summaryPricing}
              action={(paymentRecovery || unresolvedPayment) ? undefined : (
                <>
                  <button
                    type="button"
                    onClick={() => formRef.current?.requestSubmit()}
                    disabled={submitting || quoting}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full gap-2')}
                  >
                    {!submitting && !quoting && isPaid && <ShieldCheck className="size-4" aria-hidden />}
                    {submitting ? processingLabel : quoting ? 'Checking…' : ctaLabel}
                  </button>
                  <p className="mt-2.5 flex items-center justify-center gap-1.5 text-fs-2xs font-medium text-muted-foreground">
                    <Lock className="size-3 shrink-0 text-emerald-600" aria-hidden />
                    {isPaid ? 'Encrypted payment via Razorpay' : 'Your details are sent securely'}
                  </p>
                </>
              )}
            />
          </div>
        </div>

      </div>
      </div>

      {/* C-2: mobile-only sticky checkout bar (Total + Pay). Desktop keeps the right-column
          sticky SummaryCard — this is `lg:hidden`, so the desktop summary is never duplicated.
          Steps aside while a keyboard field is focused; clears the iOS safe-area inset. */}
      {/* RD-RT6.0 · THE explicit confirmation step. Opening it creates nothing — no order,
          no intent, no Razorpay. Its "Proceed to Pay ₹X" is the ONLY control on this page
          that reaches the payment pipeline, and it calls the existing finaliseRegistration.
          Rendered outside the sticky bar so it is never trapped behind it. */}
      {/* RD-RT7.0 · THE UI LOCK. Rendered from the EXISTING `submitting` flag — the state
          that already means "an active payment attempt is in flight", spanning create-order
          → Razorpay → verification → resolution. No new state, no second submission path,
          and every duplicate-order guard (`if (submitting) return`, the parked
          unresolvedPayment, the server-side attempt claim) is untouched.

          z-[400] sits above the page and the summary dialog, and far below Razorpay's own
          container — so checkout stays fully usable while this waits underneath it. */}
      <PaymentProcessingLock open={submitting} free={!paymentRequired} />

      <PaymentSummaryDialog
        // …and can never co-exist with the lock.
        open={reviewOpen && !submitting && !unresolvedPayment && !paymentRecovery}
        onClose={() => { if (!submitting) setReviewOpen(false) }}
        onProceed={proceedToPay}
        submitting={submitting}
        passName={pass.name}
        lines={reviewLines}
        discount={reviewDiscount}
        totalPaise={reviewTotalPaise}
        paymentRequired={reviewTotalPaise > 0}
        error={submitError}
      />

      {/* RD-RT5.0: ONE bar, ONE action, for the whole registration — there is no review
          step for it to change shape for. It stays hidden during payment recovery, where
          the recovery card owns the action.

          `fieldFocused` is driven by isKeyboardField(), which tests the input's TYPE:
          checkboxes and radios never qualify, so ticking a consent box cannot hide this
          bar. Only a field that actually raises the on-screen keyboard does. */}
      {!paymentRecovery && !unresolvedPayment && (
        <div className={cn('fixed inset-x-0 bottom-0 z-40 lg:hidden', fieldFocused && 'hidden')}>

          {/* RD-RT4.0: the summary the desktop keeps in view all the way down, folded
              into a sheet the bar can open. It renders the SAME `identity` and
              `summaryPricing` objects the desktop panel receives, so the two surfaces
              can never disagree. Collapsed via grid-rows so the height animates without
              a measured pixel value; `motion-reduce` snaps it. */}
          <div
            id="rd-mobile-summary"
            className={cn(
              'grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none',
              mobileSummaryOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div className="overflow-hidden">
              <div className="mx-auto max-w-lg px-3 pb-2">
                <div className={cn(PANEL, 'max-h-[46vh] overflow-y-auto overscroll-contain p-4')}>
                  <SummaryDigest identity={identity} passName={pass.name} pricing={summaryPricing} />
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-border bg-card/95 shadow-[0_-10px_30px_-12px_rgb(15_23_42_/_0.28)] backdrop-blur-xl">
            {/* RD-RT5.0: the hairline completion meter is gone with the step model it was
                derived from. `pt-3` replaces the 2px strip so the bar keeps its height. */}
            <div className="mx-auto flex max-w-lg items-center justify-between gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => setMobileSummaryOpen(o => !o)}
                aria-expanded={mobileSummaryOpen}
                aria-controls="rd-mobile-summary"
                className="min-w-0 shrink rounded-lg px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="flex items-center gap-1 text-fs-2xs font-bold uppercase tracking-wider text-muted-foreground">
                  Total
                  <ChevronUp
                    className={cn(
                      'size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                      mobileSummaryOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </span>
                <span className="block text-fs-lg font-extrabold leading-tight tracking-tight text-foreground">
                  {feeConfirm
                    ? formatPaise(feeConfirm.breakdown.totalPaise)
                    : couponApplied
                      ? priceLabel
                      : <PassPrice price={pass.price} regularPrice={pass.regularPrice} isFree={pass.isFree} align="left" size="lg" showBadge={false} />}
                </span>
                <span className="sr-only">
                  {mobileSummaryOpen ? 'Hide registration summary' : 'Show registration summary'}
                </span>
              </button>

              <p className="sr-only">Total for this registration</p>

              {/* THE one primary action. Submits the form → validates → Razorpay.
                  Same `disabled={submitting}` double-tap guard as before, and the same
                  deliberate choice not to disable on missing consent. */}
              <button
                type="button"
                onClick={() => formRef.current?.requestSubmit()}
                disabled={submitting || quoting}
                className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-w-[52%] gap-1.5')}
              >
                {!submitting && !quoting && isPaid && <ShieldCheck className="size-4 shrink-0" aria-hidden />}
                {submitting ? processingLabel : quoting ? 'Checking…' : ctaLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
