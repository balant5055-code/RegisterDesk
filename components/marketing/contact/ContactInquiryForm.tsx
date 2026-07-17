'use client'

// Enterprise inquiry form — UI SHELL ONLY.
//
// Fully designed + client-side validated using the existing design system (DS Button,
// token-styled native inputs, typography). It is intentionally NOT wired to a backend:
// there is no inquiry API yet, so submit is a SAFE CLIENT-SIDE NO-OP that shows a local
// confirmation. Wire the real submission in a future task at the marked TODO.
//
// No new shared components: `Field` is a local label/error wrapper for this form only.

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils/cn'
import { Send, CheckCircle2, CalendarClock } from 'lucide-react'

// ─── Field option registries (presentation config, not business data) ─────────────

const EVENT_TYPES = [
  'Marathon', 'Conference', 'Corporate Event', 'Workshop', 'NGO',
  'School', 'College', 'Festival', 'Sports Tournament', 'Other',
] as const

const ATTENDEE_RANGES = [
  '1–100', '100–500', '500–1000', '1000–5000', '5000+',
] as const

// ─── Shared control styling (reuses DS tokens) ────────────────────────────────────

const CONTROL =
  'h-11 w-full rounded-xl border border-border bg-background px-3.5 text-[14px] text-foreground ' +
  'placeholder:text-muted-foreground/50 transition-colors ' +
  'focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20'

const CONTROL_ERR = 'border-destructive/60 focus:border-destructive/60 focus:ring-destructive/15'

interface FormState {
  fullName: string; organization: string; workEmail: string; phone: string
  country: string; eventType: string; attendees: string; demoDate: string
  subject: string; message: string; agree: boolean
}

const EMPTY: FormState = {
  fullName: '', organization: '', workEmail: '', phone: '', country: '',
  eventType: '', attendees: '', demoDate: '', subject: '', message: '', agree: false,
}

// ─── Local label + error wrapper ──────────────────────────────────────────────────

function Field({ id, label, required, error, className, children }: {
  id: string; label: string; required?: boolean; error?: string; className?: string; children: React.ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-semibold text-foreground">
        {label}{required && <span className="text-primary" aria-hidden> *</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[12px] font-medium text-destructive">{error}</p>
      )}
    </div>
  )
}

// ─── Component ─────────────────────────────────────────────────────────────────────

export function ContactInquiryForm() {
  const [v, setV]           = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitted, setSubmitted] = useState(false)
  const demoRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => {
    setV(prev => ({ ...prev, [k]: val }))
    if (errors[k]) setErrors(prev => ({ ...prev, [k]: undefined }))
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {}
    if (!v.fullName.trim())     e.fullName  = 'Please enter your full name.'
    if (!v.workEmail.trim())    e.workEmail = 'Please enter your work email.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.workEmail.trim())) e.workEmail = 'Enter a valid email address.'
    if (!v.message.trim())      e.message   = 'Tell us a little about your event.'
    if (!v.agree)               e.agree     = 'Please accept the privacy policy to continue.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault()
    if (!validate()) return
    // TODO(contact-backend): POST this inquiry to the (not-yet-built) inquiry endpoint.
    // Until that exists, submit is a safe client-side no-op showing a local confirmation.
    setSubmitted(true)
  }

  // "Book a Demo" — pre-tags demo intent and jumps to the date field (no route/backend).
  function prefillDemo() {
    setV(prev => ({ ...prev, subject: prev.subject || 'Book a demo' }))
    demoRef.current?.focus()
    demoRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-border/60 bg-white px-6 py-14 text-center shadow-sm">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-inset ring-primary/20">
          <CheckCircle2 className="size-6 text-primary" aria-hidden />
        </span>
        <h3 className="mt-5 text-[19px] font-bold text-foreground">Thanks for reaching out</h3>
        <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-muted-foreground">
          We&apos;ve got your details. Our team will follow up at{' '}
          <span className="font-medium text-foreground">{v.workEmail}</span>.
        </p>
        <button
          type="button"
          onClick={() => { setV(EMPTY); setSubmitted(false) }}
          className="mt-6 text-[13px] font-semibold text-primary hover:underline"
        >
          Send another inquiry
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Enterprise inquiry"
      className="rounded-2xl border border-border/60 bg-white p-6 shadow-sm sm:p-8"
    >
      <div className="grid gap-5 sm:grid-cols-2">

        <Field id="cf-name" label="Full name" required error={errors.fullName}>
          <input id="cf-name" type="text" autoComplete="name" placeholder="Priya Sharma"
            value={v.fullName} onChange={e => set('fullName', e.target.value)}
            aria-required aria-invalid={!!errors.fullName} aria-describedby={errors.fullName ? 'cf-name-error' : undefined}
            className={cn(CONTROL, errors.fullName && CONTROL_ERR)} />
        </Field>

        <Field id="cf-org" label="Organization" error={errors.organization}>
          <input id="cf-org" type="text" autoComplete="organization" placeholder="Acme Events"
            value={v.organization} onChange={e => set('organization', e.target.value)}
            className={CONTROL} />
        </Field>

        <Field id="cf-email" label="Work email" required error={errors.workEmail}>
          <input id="cf-email" type="email" autoComplete="email" placeholder="you@company.com"
            value={v.workEmail} onChange={e => set('workEmail', e.target.value)}
            aria-required aria-invalid={!!errors.workEmail} aria-describedby={errors.workEmail ? 'cf-email-error' : undefined}
            className={cn(CONTROL, errors.workEmail && CONTROL_ERR)} />
        </Field>

        <Field id="cf-phone" label="Phone number" error={errors.phone}>
          <input id="cf-phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210"
            value={v.phone} onChange={e => set('phone', e.target.value)}
            className={CONTROL} />
        </Field>

        <Field id="cf-country" label="Country" error={errors.country}>
          <input id="cf-country" type="text" autoComplete="country-name" placeholder="India"
            value={v.country} onChange={e => set('country', e.target.value)}
            className={CONTROL} />
        </Field>

        <Field id="cf-type" label="Event type" error={errors.eventType}>
          <select id="cf-type" value={v.eventType} onChange={e => set('eventType', e.target.value)}
            className={cn(CONTROL, !v.eventType && 'text-muted-foreground/60')}>
            <option value="">Select event type…</option>
            {EVENT_TYPES.map(t => <option key={t} value={t} className="text-foreground">{t}</option>)}
          </select>
        </Field>

        <Field id="cf-attendees" label="Expected attendees" error={errors.attendees}>
          <select id="cf-attendees" value={v.attendees} onChange={e => set('attendees', e.target.value)}
            className={cn(CONTROL, !v.attendees && 'text-muted-foreground/60')}>
            <option value="">Select a range…</option>
            {ATTENDEE_RANGES.map(r => <option key={r} value={r} className="text-foreground">{r}</option>)}
          </select>
        </Field>

        <Field id="cf-demo" label="Preferred demo date" error={errors.demoDate}>
          <div className="relative">
            <CalendarClock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
            <input id="cf-demo" ref={demoRef} type="date"
              value={v.demoDate} onChange={e => set('demoDate', e.target.value)}
              className={cn(CONTROL, 'pl-10')} />
          </div>
        </Field>

        <Field id="cf-subject" label="Subject" error={errors.subject} className="sm:col-span-2">
          <input id="cf-subject" type="text" placeholder="How can we help?"
            value={v.subject} onChange={e => set('subject', e.target.value)}
            className={CONTROL} />
        </Field>

        <Field id="cf-message" label="Message" required error={errors.message} className="sm:col-span-2">
          <textarea id="cf-message" rows={5} placeholder="Tell us about your event, timeline and goals…"
            value={v.message} onChange={e => set('message', e.target.value)}
            aria-required aria-invalid={!!errors.message} aria-describedby={errors.message ? 'cf-message-error' : undefined}
            className={cn(CONTROL, 'h-auto resize-y py-3 leading-relaxed', errors.message && CONTROL_ERR)} />
        </Field>
      </div>

      {/* Privacy consent */}
      <div className="mt-5">
        <label htmlFor="cf-agree" className="flex items-start gap-3 text-[13px] leading-relaxed text-muted-foreground">
          <input id="cf-agree" type="checkbox" checked={v.agree} onChange={e => set('agree', e.target.checked)}
            aria-invalid={!!errors.agree} aria-describedby={errors.agree ? 'cf-agree-error' : undefined}
            className="mt-0.5 size-4 shrink-0 rounded border-border text-primary focus:ring-2 focus:ring-primary/30" />
          <span>
            I agree to the{' '}
            <a href="/privacy" className="font-medium text-foreground underline underline-offset-2 hover:text-primary">privacy policy</a>.
          </span>
        </label>
        {errors.agree && <p id="cf-agree-error" role="alert" className="mt-1.5 text-[12px] font-medium text-destructive">{errors.agree}</p>}
      </div>

      {/* Actions */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="gradient" size="lg">
          <Send className="size-4" aria-hidden />Send Inquiry
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={prefillDemo}>
          Book a Demo
        </Button>
      </div>
    </form>
  )
}
