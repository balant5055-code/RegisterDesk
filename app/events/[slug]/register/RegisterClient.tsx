'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useRouter }              from 'next/navigation'
import { onAuthStateChanged }     from 'firebase/auth'
import { auth }                   from '@/lib/firebase/auth'
import type { FormSection, FormField, ConditionalRule, FieldType } from '@/components/wizard/registrationFormConfig'

// ─── Razorpay checkout (loaded dynamically from checkout.razorpay.com) ─────────

interface RazorpayPaymentSuccess {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}
interface RazorpayOptions {
  key:          string
  amount:       number
  currency:     string
  order_id:     string
  name?:        string
  description?: string
  prefill?:     { name?: string; email?: string; contact?: string }
  handler:      (response: RazorpayPaymentSuccess) => void
  modal?:       { ondismiss?: () => void }
  theme?:       { color?: string }
}
declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => { open(): void }
  }
}

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
  keyId:       string
  orderId:     string
  amount:      number    // paise
  currency:    string
  eventName:   string
  passName:    string
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
      theme:   { color: '#7C3AED' },
    })
    rzp.open()
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PassInfo {
  id:     string
  name:   string
  price:  number
  isFree: boolean
}

export interface RegisterClientProps {
  eventSlug:        string
  eventName:        string
  startDate:        string | null
  pass:             PassInfo
  sections:         FormSection[]
  conditionalRules: ConditionalRule[]
  approvalMode:     'auto' | 'manual'
  requireLogin:     boolean
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
  allFields:       FormField[],
  rules:           ConditionalRule[],
  values:          Record<string, string>,
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

function FieldRenderer({
  field,
  state,
  value,
  error,
  onChange,
}: {
  field:    FormField
  state:    FieldState
  value:    string
  error:    string | undefined
  onChange: (id: string, val: string) => void
}) {
  if (!state.visible) return null

  const { id, label, type, placeholder, helperText, options, required } = field
  const disabled = state.disabled
  const req      = state.required

  const labelEl = (
    <label htmlFor={id} className={labelCls}>
      {label}
      {req && <span className="ml-1 text-destructive" aria-hidden>*</span>}
    </label>
  )

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
          placeholder={placeholder || undefined}
          value={value}
          onChange={e => onChange(id, e.target.value)}
          className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 resize-y disabled:opacity-50"
          aria-invalid={!!error}
          aria-describedby={helperText || error ? `${id}-hint` : undefined}
        />
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {error && <p id={`${id}-hint`} className={errorCls}>{error}</p>}
      </div>
    )
  }

  // ── Dropdown / Select ───────────────────────────────────────────────────────
  if (type === 'dropdown') {
    return (
      <div>
        {labelEl}
        <select
          id={id}
          disabled={disabled}
          required={req}
          value={value}
          onChange={e => onChange(id, e.target.value)}
          className="h-10 w-full rounded-xl border border-border bg-background px-3.5 text-[13.5px] text-foreground outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
          aria-invalid={!!error}
        >
          <option value="">Select…</option>
          {options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {helperText && !error && <p className={hintCls}>{helperText}</p>}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    )
  }

  // ── Radio ───────────────────────────────────────────────────────────────────
  if (type === 'radio' || type === 'yesno') {
    const opts = type === 'yesno' ? ['Yes', 'No'] : options
    return (
      <div>
        {labelEl}
        <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
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
        {helperText && !error && <p className={hintCls}>{helperText}</p>}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    )
  }

  // ── Checkbox (single consent) or Checkbox group ──────────────────────────
  if (type === 'checkbox') {
    if (options.length === 0) {
      // Single boolean checkbox
      return (
        <div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              id={id}
              type="checkbox"
              disabled={disabled}
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
    // Checkbox group — value is comma-separated selected options
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <div>
        {labelEl}
        <div className="mt-1 flex flex-col gap-2">
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
        {helperText && !error && <p className={hintCls}>{helperText}</p>}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    )
  }

  // ── Multiselect (checkbox group) ─────────────────────────────────────────
  if (type === 'multiselect') {
    const selected = value ? value.split(',').map(s => s.trim()) : []
    return (
      <div>
        {labelEl}
        <div className="mt-1 flex flex-wrap gap-2">
          {options.map(opt => {
            const checked = selected.includes(opt)
            return (
              <button
                key={opt}
                type="button"
                disabled={disabled}
                onClick={() => {
                  const next = checked
                    ? selected.filter(s => s !== opt)
                    : [...selected, opt]
                  onChange(id, next.join(', '))
                }}
                className={`rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                  checked
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card text-foreground hover:border-primary/40'
                } disabled:opacity-50`}
              >
                {opt}
              </button>
            )
          })}
        </div>
        {helperText && !error && <p className={hintCls}>{helperText}</p>}
        {error && <p className={errorCls}>{error}</p>}
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
        placeholder={placeholder || undefined}
        value={value}
        onChange={e => onChange(id, e.target.value)}
        className={inputCls + (disabled ? ' opacity-50' : '')}
        aria-invalid={!!error}
        aria-describedby={helperText || error ? `${id}-hint` : undefined}
      />
      {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
      {error && <p id={`${id}-hint`} className={errorCls}>{error}</p>}
    </div>
  )
}

// ─── Section ──────────────────────────────────────────────────────────────────

function SectionBlock({
  section,
  fieldStates,
  values,
  errors,
  onChange,
}: {
  section:     FormSection
  fieldStates: Map<string, FieldState>
  values:      Record<string, string>
  errors:      Record<string, string>
  onChange:    (id: string, val: string) => void
}) {
  const visibleFields = section.fields.filter(f => {
    const s = fieldStates.get(f.id)
    return s?.visible !== false
  })
  if (visibleFields.length === 0) return null

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {section.title && (
        <div className="border-b border-border/60 bg-muted/[0.03] px-5 py-3.5">
          <p className="text-[14px] font-semibold text-foreground">{section.title}</p>
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
          />
        ))}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function RegisterClient({
  eventSlug,
  eventName,
  startDate,
  pass,
  sections,
  conditionalRules,
  approvalMode,
  requireLogin,
}: RegisterClientProps) {
  const router = useRouter()

  const allFields = useMemo(
    () => sections.flatMap(s => s.fields),
    [sections],
  )

  const [values,          setValues]          = useState<Record<string, string>>({})
  const [errors,          setErrors]          = useState<Record<string, string>>({})
  const [submitError,     setSubmitError]     = useState<string | null>(null)
  const [submitting,      setSubmitting]      = useState(false)
  const [idempotencyKey]  = useState(() => crypto.randomUUID())

  // H3: Always subscribe to auth state so logged-in users are always linked to
  //     registrations regardless of requireLogin.  authChecked only gates the
  //     login-wall UI when requireLogin is true; the form is never blocked for
  //     events where requireLogin is false.
  const [authChecked, setAuthChecked] = useState(!requireLogin)
  const [isLoggedIn,  setIsLoggedIn]  = useState(false)
  const [authToken,   setAuthToken]   = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      setIsLoggedIn(!!user)
      setAuthToken(user ? await user.getIdToken() : null)
      setAuthChecked(true)
    })
    return unsub
  }, [])

  const fieldStates = useMemo(
    () => computeFieldStates(allFields, conditionalRules, values),
    [allFields, conditionalRules, values],
  )

  const handleChange = useCallback((id: string, val: string) => {
    setValues(prev => ({ ...prev, [id]: val }))
    setErrors(prev => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // Client-side validation before submit
  function validate(): boolean {
    const newErrors: Record<string, string> = {}
    for (const field of allFields) {
      const state = fieldStates.get(field.id)
      if (!state?.visible || !state.required) continue
      const val = (values[field.id] ?? '').trim()
      if (!val) {
        newErrors[field.id] = `${field.label} is required`
      } else if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        newErrors[field.id] = 'Enter a valid email address'
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  // Extract attendee core fields for the API body
  function extractAttendee(): { name: string; email: string; phone?: string } {
    let name  = ''
    let email = ''
    let phone = ''

    for (const field of allFields) {
      const val = (values[field.id] ?? '').trim()
      if (!val) continue
      if (!name  && (field.type === 'text'  && /name/i.test(field.label)))  name  = val
      if (!email && field.type === 'email')  email = val
      if (!phone && field.type === 'mobile') phone = val
    }
    // Fallback — use first text field as name if still empty
    if (!name) {
      const first = allFields.find(f => f.type === 'text')
      if (first) name = (values[first.id] ?? '').trim()
    }
    return { name, email, ...(phone ? { phone } : {}) }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!validate()) {
      const firstError = document.querySelector('[aria-invalid="true"]')
      firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    setSubmitting(true)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    const attendee = extractAttendee()
    const requestBody = {
      slug:           eventSlug,
      passId:         pass.id,
      attendee,
      formResponses:  values,
      idempotencyKey,
    }

    try {
      // ── Paid flow ────────────────────────────────────────────────────────────
      if (!pass.isFree && pass.price > 0) {
        // 1. Create Razorpay order (server validates price — never trust client)
        const orderRes  = await fetch('/api/registrations/create-order', {
          method: 'POST', headers, body: JSON.stringify(requestBody),
        })
        const orderJson = await orderRes.json() as {
          orderId?: string; amount?: number; currency?: string; keyId?: string; error?: string
        }
        if (!orderRes.ok || !orderJson.orderId) {
          setSubmitError(orderJson.error ?? 'Failed to create payment order. Please try again.')
          return
        }

        // 2. Load Razorpay checkout script
        try {
          await loadRazorpayScript()
        } catch {
          setSubmitError('Failed to load payment checkout. Please check your connection.')
          return
        }

        // 3. Open Razorpay checkout — resolves on success, rejects on cancel
        let paymentResult: RazorpayPaymentSuccess
        try {
          paymentResult = await openRazorpayCheckout({
            keyId:         orderJson.keyId!,
            orderId:       orderJson.orderId!,
            amount:        orderJson.amount!,
            currency:      orderJson.currency ?? 'INR',
            eventName,
            passName:      pass.name,
            attendeeName:  attendee.name,
            attendeeEmail: attendee.email,
            attendeePhone: attendee.phone,
          })
        } catch (err) {
          if (err instanceof Error && err.message === 'PAYMENT_CANCELLED') {
            setSubmitError('Payment was cancelled. You can try again whenever you\'re ready.')
          } else {
            setSubmitError('Payment failed. Please try again.')
          }
          return
        }

        // 4. Verify payment server-side and create registration
        const verifyRes  = await fetch('/api/registrations/verify-payment', {
          method: 'POST', headers,
          body: JSON.stringify(paymentResult),
        })
        const verifyJson = await verifyRes.json() as {
          success?: boolean; registrationId?: string; error?: string; reason?: string
        }
        if (verifyJson.success && verifyJson.registrationId) {
          router.push(`/events/${eventSlug}/register/success?id=${verifyJson.registrationId}`)
          return
        }
        setSubmitError(verifyJson.error ?? 'Payment verification failed. Please contact support.')
        return
      }

      // ── Free flow ─────────────────────────────────────────────────────────────
      const res  = await fetch('/api/registrations/submit', {
        method: 'POST', headers, body: JSON.stringify(requestBody),
      })
      const json = await res.json() as {
        success: boolean; registrationId?: string; error?: string
      }
      if (json.success && json.registrationId) {
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

  // Auth-gate screens (requireLogin only)
  if (!authChecked) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

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
          href={`/login?redirect=/events/${eventSlug}/register?passId=${pass.id}`}
          className="mt-6 rounded-xl bg-primary px-6 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
        >
          Sign In to Continue
        </a>
      </div>
    )
  }

  const priceLabel = pass.isFree || pass.price === 0
    ? 'Free'
    : `₹${pass.price.toLocaleString('en-IN')}`

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      {/* Header */}
      <div className="mb-6">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-primary">
          Registering for
        </p>
        <h1 className="mt-0.5 text-[22px] font-bold text-foreground">{eventName}</h1>
        {startDate && (
          <p className="mt-1 text-[13px] text-muted-foreground">
            {new Date(startDate).toLocaleDateString('en-IN', {
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        )}
      </div>

      {/* Pass summary card */}
      <div className="mb-6 flex items-center justify-between rounded-xl border border-primary/20 bg-primary/[0.03] px-4 py-3.5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pass</p>
          <p className="mt-0.5 text-[14px] font-semibold text-foreground">{pass.name}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Amount</p>
          <p className="mt-0.5 text-[16px] font-bold text-foreground">{priceLabel}</p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4">
          {sections.map(section => (
            <SectionBlock
              key={section.id}
              section={section}
              fieldStates={fieldStates}
              values={values}
              errors={errors}
              onChange={handleChange}
            />
          ))}
        </div>

        {/* Approval mode note */}
        {approvalMode === 'manual' && (
          <p className="mt-4 rounded-xl border border-amber-200/60 bg-amber-50/50 px-4 py-3 text-[12.5px] text-amber-700">
            Your registration will be reviewed before confirmation. You will be notified by email once approved.
          </p>
        )}

        {/* Submit error */}
        {submitError && (
          <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
            {submitError}
          </div>
        )}

        {/* Submit button */}
        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded-xl bg-primary py-3 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting
            ? (pass.isFree || pass.price === 0 ? 'Submitting…' : 'Processing…')
            : pass.isFree || pass.price === 0
              ? 'Complete Registration'
              : `Pay ${priceLabel} & Register`}
        </button>

        <p className="mt-3 text-center text-[11.5px] text-muted-foreground">
          By registering, you agree to the event organiser's terms and conditions.
        </p>
      </form>
    </div>
  )
}
