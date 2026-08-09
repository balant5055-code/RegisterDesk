'use client'

// Enterprise inquiry form — the only interactive island on /contact.
//
// RD-LAUNCH-02: submit is REAL. The enquiry is POSTed to /api/contact, which stores
// it and notifies support; a failure reports honestly and leaves every typed value
// intact. (An earlier revision of this file was a client-side no-op — that comment
// was stale and is gone.)
//
// Presentation is composed from the shared design system only: Field + fieldControl
// for every label/control (components/ui/field.tsx), the semantic typography roles
// for text, and the centralized motion variants for the two state transitions. No
// local field wrapper, no local control class string.
//
// The form owns NO surface — no card, border, background or padding. It renders
// into whatever panel the page gives it (today: the white half of the contact
// split panel), so the page stays the single owner of the page's chrome.

import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Send, CheckCircle2, CalendarClock } from 'lucide-react'
import { IconChip } from '@/components/marketing/IconChip'
import { Button } from '@/components/ui/button'
import { Field, fieldControl, fieldErrorId } from '@/components/ui/field'
import { cn } from '@/lib/utils/cn'
import { fs, typography } from '@/lib/ds/typography'
import { fadeUp } from '@/lib/marketing/motion'

// ─── Field option registries (presentation config, not business data) ─────────────

const EVENT_TYPES = [
  'Marathon', 'Conference', 'Corporate Event', 'Workshop', 'NGO',
  'School', 'College', 'Festival', 'Sports Tournament', 'Other',
] as const

const ATTENDEE_RANGES = [
  '1–100', '100–500', '500–1000', '1000–5000', '5000+',
] as const

/** Empty <select> reads as placeholder text until a real value is chosen. */
const SELECT_PLACEHOLDER = 'text-muted-foreground/60'

interface FormState {
  fullName: string; organization: string; workEmail: string; phone: string
  country: string; eventType: string; attendees: string; demoDate: string
  subject: string; message: string; agree: boolean
}

const EMPTY: FormState = {
  fullName: '', organization: '', workEmail: '', phone: '', country: '',
  eventType: '', attendees: '', demoDate: '', subject: '', message: '', agree: false,
}

// ─── Component ─────────────────────────────────────────────────────────────────────

export function ContactInquiryForm() {
  const [v, setV]           = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitted, setSubmitted] = useState(false)
  // RD-LAUNCH-02: real submission state. The form previously had none, because it never
  // made a request.
  const [sending,    setSending]    = useState(false)
  const [sendError,  setSendError]  = useState<string | null>(null)
  const demoRef  = useRef<HTMLInputElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  // Honeypot — hidden from humans; a bot that fills every input completes it.
  const [website, setWebsite] = useState('')
  const reduce = useReducedMotion()

  /** Entrance for the two state panels; static when the user asks for less motion. */
  const panelMotion = reduce ? {} : { variants: fadeUp, initial: 'hidden', animate: 'show' } as const

  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => {
    setV(prev => ({ ...prev, [k]: val }))
    if (errors[k]) setErrors(prev => ({ ...prev, [k]: undefined }))
  }

  // A failed submission moves focus to the alert, so keyboard and screen-reader
  // users land on the reason instead of hunting for it above the button.
  useEffect(() => {
    if (sendError) errorRef.current?.focus()
  }, [sendError])

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

  // RD-LAUNCH-02 — a real submission. The enquiry is stored and a notification is sent
  // before success is shown; a failure reports honestly and leaves the form intact so
  // nothing the visitor typed is lost.
  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault()
    setSendError(null)
    if (!validate()) return

    setSending(true)
    try {
      const res = await fetch('/api/contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fullName: v.fullName, workEmail: v.workEmail, message: v.message,
          organization: v.organization, phone: v.phone, country: v.country,
          eventType: v.eventType, attendees: v.attendees, demoDate: v.demoDate,
          subject: v.subject,
          website,   // honeypot
        }),
      })
      const json = await res.json() as {
        success?: boolean; error?: string
        fieldErrors?: { field: string; message: string }[]
      }

      if (res.ok && json.success) {
        setSubmitted(true)
        return
      }

      // Server-side field errors are mapped back onto the same inputs the client
      // validator marks, so both sources of truth surface identically.
      if (json.fieldErrors?.length) {
        const mapped: Partial<Record<keyof FormState, string>> = {}
        for (const fe of json.fieldErrors) mapped[fe.field as keyof FormState] = fe.message
        setErrors(prev => ({ ...prev, ...mapped }))
      }
      setSendError(json.error ?? 'We could not send your enquiry. Please try again.')
    } catch {
      setSendError('Network error — please check your connection and try again.')
    } finally {
      setSending(false)
    }
  }

  // "Book a Demo" — pre-tags demo intent and jumps to the date field (no route/backend).
  function prefillDemo() {
    setV(prev => ({ ...prev, subject: prev.subject || 'Book a demo' }))
    demoRef.current?.focus()
    demoRef.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }

  if (submitted) {
    return (
      <motion.div
        {...panelMotion}
        className="flex min-h-full flex-col items-center justify-center py-10 text-center"
      >
        <IconChip className="size-12 rounded-2xl">
          <CheckCircle2 className="size-6 text-primary" aria-hidden />
        </IconChip>
        <h2 className={cn(typography.subsectionHeading, 'mt-5 text-foreground')}>Thanks for reaching out</h2>
        <p className={cn(typography.body, 'mt-2 max-w-sm text-muted-foreground')}>
          We&apos;ve got your details. Our team will follow up at{' '}
          <span className="font-medium text-foreground">{v.workEmail}</span>.
        </p>
        <button
          type="button"
          onClick={() => { setV(EMPTY); setSubmitted(false) }}
          className={cn(typography.caption, 'mt-6 rounded font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary')}
        >
          Send another inquiry
        </button>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Enterprise inquiry">
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">

        <Field id="cf-name" label="Full name" required error={errors.fullName}>
          <input id="cf-name" type="text" autoComplete="name" placeholder="Priya Sharma"
            value={v.fullName} onChange={e => set('fullName', e.target.value)}
            aria-required aria-invalid={!!errors.fullName}
            aria-describedby={errors.fullName ? fieldErrorId('cf-name') : undefined}
            className={fieldControl({ invalid: !!errors.fullName })} />
        </Field>

        <Field id="cf-org" label="Organization" error={errors.organization}>
          <input id="cf-org" type="text" autoComplete="organization" placeholder="Acme Events"
            value={v.organization} onChange={e => set('organization', e.target.value)}
            className={fieldControl()} />
        </Field>

        <Field id="cf-email" label="Work email" required error={errors.workEmail}>
          <input id="cf-email" type="email" autoComplete="email" placeholder="you@company.com"
            value={v.workEmail} onChange={e => set('workEmail', e.target.value)}
            aria-required aria-invalid={!!errors.workEmail}
            aria-describedby={errors.workEmail ? fieldErrorId('cf-email') : undefined}
            className={fieldControl({ invalid: !!errors.workEmail })} />
        </Field>

        <Field id="cf-phone" label="Phone number" error={errors.phone}>
          <input id="cf-phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210"
            value={v.phone} onChange={e => set('phone', e.target.value)}
            className={fieldControl()} />
        </Field>

        <Field id="cf-country" label="Country" error={errors.country}>
          <input id="cf-country" type="text" autoComplete="country-name" placeholder="India"
            value={v.country} onChange={e => set('country', e.target.value)}
            className={fieldControl()} />
        </Field>

        <Field id="cf-type" label="Event type" error={errors.eventType}>
          <select id="cf-type" value={v.eventType} onChange={e => set('eventType', e.target.value)}
            className={fieldControl({ className: !v.eventType ? SELECT_PLACEHOLDER : undefined })}>
            <option value="">Select event type…</option>
            {EVENT_TYPES.map(t => <option key={t} value={t} className="text-foreground">{t}</option>)}
          </select>
        </Field>

        <Field id="cf-attendees" label="Expected attendees" error={errors.attendees}>
          <select id="cf-attendees" value={v.attendees} onChange={e => set('attendees', e.target.value)}
            className={fieldControl({ className: !v.attendees ? SELECT_PLACEHOLDER : undefined })}>
            <option value="">Select a range…</option>
            {ATTENDEE_RANGES.map(r => <option key={r} value={r} className="text-foreground">{r}</option>)}
          </select>
        </Field>

        <Field id="cf-demo" label="Preferred demo date" error={errors.demoDate}>
          <div className="relative">
            <CalendarClock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
            <input id="cf-demo" ref={demoRef} type="date"
              value={v.demoDate} onChange={e => set('demoDate', e.target.value)}
              className={fieldControl({ className: 'pl-10' })} />
          </div>
        </Field>

        <Field id="cf-subject" label="Subject" error={errors.subject} className="sm:col-span-2">
          <input id="cf-subject" type="text" placeholder="How can we help?"
            value={v.subject} onChange={e => set('subject', e.target.value)}
            className={fieldControl()} />
        </Field>

        <Field id="cf-message" label="Message" required error={errors.message} className="sm:col-span-2">
          <textarea id="cf-message" rows={4} placeholder="Tell us about your event, timeline and goals…"
            value={v.message} onChange={e => set('message', e.target.value)}
            aria-required aria-invalid={!!errors.message}
            aria-describedby={errors.message ? fieldErrorId('cf-message') : undefined}
            className={fieldControl({ invalid: !!errors.message, className: 'h-auto resize-y py-2.5 leading-relaxed' })} />
        </Field>
      </div>

      {/* Privacy consent */}
      <div className="mt-4">
        <label htmlFor="cf-agree" className={cn(typography.caption, 'flex items-start gap-3 leading-relaxed text-muted-foreground')}>
          <input id="cf-agree" type="checkbox" checked={v.agree} onChange={e => set('agree', e.target.checked)}
            aria-invalid={!!errors.agree}
            aria-describedby={errors.agree ? fieldErrorId('cf-agree') : undefined}
            className="mt-0.5 size-4 shrink-0 rounded border-border text-primary focus:ring-2 focus:ring-primary/30" />
          <span>
            I agree to the{' '}
            <a href="/privacy" className="font-medium text-foreground underline underline-offset-2 hover:text-primary">privacy policy</a>.
          </span>
        </label>
        {errors.agree && (
          <p id={fieldErrorId('cf-agree')} role="alert" className={cn(fs.xs, 'mt-1.5 font-medium text-destructive')}>
            {errors.agree}
          </p>
        )}
      </div>

      {/* RD-LAUNCH-02 — honeypot. Hidden from humans (and from assistive tech via
          aria-hidden + tabIndex -1); only an indiscriminate bot fills it. */}
      <div aria-hidden className="hidden">
        <label htmlFor="cf-website">Website</label>
        <input
          id="cf-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={e => setWebsite(e.target.value)}
        />
      </div>

      {/* Submission failure — announced, focused, and never clears what was typed. */}
      {sendError && (
        <motion.p
          {...panelMotion}
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className={cn(fs.sm, 'mt-5 rounded-xl border border-destructive/30 bg-destructive/[0.04] px-4 py-3 font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40')}
        >
          {sendError}
        </motion.p>
      )}

      {/* Actions — full-width on mobile so the primary action is thumb-reachable. */}
      <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <Button type="submit" variant="gradient" size="lg" isLoading={sending} className="w-full sm:w-auto">
          {!sending && <Send className="size-4" aria-hidden />}
          {sending ? 'Sending…' : 'Send Inquiry'}
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={prefillDemo} disabled={sending} className="w-full sm:w-auto">
          Book a Demo
        </Button>
      </div>
    </form>
  )
}
