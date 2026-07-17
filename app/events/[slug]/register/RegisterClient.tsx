'use client'

import { useState, useCallback, useMemo, useEffect, Fragment } from 'react'
import { useRouter }              from 'next/navigation'
import { onAuthStateChanged }     from 'firebase/auth'
import { auth }                   from '@/lib/firebase/auth'
import { motion }                 from 'framer-motion'
import { Calendar, MapPin, Globe, ShieldCheck, Zap, RotateCcw, Check } from 'lucide-react'
import { cn }                     from '@/lib/utils/cn'
import { buttonVariants }         from '@/components/ui/button'
import { CustomSelect }           from '@/components/ui/CustomSelect'
import type { FormSection, FormField, ConditionalRule, FieldType } from '@/components/wizard/registrationFormConfig'

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
  pass:               PassInfo
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
          className="w-full resize-y rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
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
        <CustomSelect
          id={id}
          value={value}
          options={options}
          placeholder={placeholder || 'Select…'}
          disabled={disabled}
          onChange={v => onChange(id, v)}
          aria-invalid={!!error}
          aria-describedby={helperText || error ? `${id}-hint` : undefined}
        />
        {helperText && !error && <p id={`${id}-hint`} className={hintCls}>{helperText}</p>}
        {error && <p id={`${id}-hint`} className={errorCls}>{error}</p>}
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

  // ── Multiselect (pill toggle group) ───────────────────────────────────────
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

// ─── Section Block ────────────────────────────────────────────────────────────

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
  pass,
  sections,
  conditionalRules,
  approvalMode,
  requireLogin,
  requiresInviteCode,
}: RegisterClientProps) {
  const router = useRouter()

  const allFields = useMemo(
    () => sections.flatMap(s => s.fields),
    [sections],
  )

  const [values,         setValues]         = useState<Record<string, string>>({})
  const [errors,         setErrors]         = useState<Record<string, string>>({})
  const [submitError,    setSubmitError]    = useState<string | null>(null)
  const [submitting,     setSubmitting]     = useState(false)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

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

  // Per-section completion for progress indicator
  const sectionCompleteness = useMemo(() => {
    return sections.map(section => {
      const visibleRequired = section.fields.filter(f => {
        const s = fieldStates.get(f.id)
        return s?.visible !== false && (s?.required ?? f.required)
      })
      if (visibleRequired.length === 0) return true
      return visibleRequired.every(f => (values[f.id] ?? '').trim() !== '')
    })
  }, [sections, fieldStates, values])

  const activeStepIdx    = sectionCompleteness.findIndex(c => !c)  // -1 = all done
  const completedCount   = sectionCompleteness.filter(Boolean).length

  const handleChange = useCallback((id: string, val: string) => {
    setValues(prev => ({ ...prev, [id]: val }))
    setErrors(prev => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

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

  function extractAttendee(): { name: string; email: string; phone?: string } {
    let name  = ''
    let email = ''
    let phone = ''

    for (const field of allFields) {
      const val = (values[field.id] ?? '').trim()
      if (!val) continue
      if (!name  && field.type === 'text'  && /name/i.test(field.label))  name  = val
      if (!email && field.type === 'email')  email = val
      if (!phone && field.type === 'mobile') phone = val
    }
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
        }
        if (!orderRes.ok || !orderJson.orderId) {
          setSubmitError(orderJson.error ?? 'Failed to create payment order. Please try again.')
          return
        }

        try {
          await loadRazorpayScript()
        } catch {
          setSubmitError('Failed to load payment checkout. Please check your connection.')
          return
        }

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
            setSubmitError("Payment was cancelled. You can try again whenever you're ready.")
          } else {
            setSubmitError('Payment failed. Please try again.')
          }
          return
        }

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

      // ── Free flow ──────────────────────────────────────────────────────────
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
          href={`/login?redirect=/events/${eventSlug}/register?passId=${pass.id}`}
          className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'mt-6')}
        >
          Sign In to Continue
        </a>
      </div>
    )
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const isPaid     = !pass.isFree && (pass.price ?? 0) > 0
  const priceLabel = !isPaid
    ? 'Free'
    : couponApplied
      ? couponApplied.finalPaise === 0
        ? 'Free'
        : `₹${(couponApplied.finalPaise / 100).toLocaleString('en-IN')}`
      : `₹${pass.price.toLocaleString('en-IN')}`

  // ── Main layout ────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:py-12">

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
          <ProgressIndicator
            sections={sections}
            activeIdx={activeStepIdx}
            completedCount={completedCount}
          />

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

            {/* Submit error — assertive live region so payment failures are announced */}
            {submitError && (
              <div role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
                {submitError}
              </div>
            )}

            {/* Trust badges */}
            <TrustBadges isPaid={isPaid} />

            {/* Submit button */}
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
              By registering, you agree to the event organiser's terms and conditions.
            </p>
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
    </div>
  )
}
