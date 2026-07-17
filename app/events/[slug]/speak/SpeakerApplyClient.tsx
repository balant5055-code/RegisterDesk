'use client'

import { useState }              from 'react'
import Link                      from 'next/link'
import { Mic, CheckCircle, ArrowLeft, Loader2 } from 'lucide-react'

interface Props {
  slug:          string
  eventName:     string
  enabled:       boolean
  closingDate:   string
  customMessage: string
}

const DURATION_OPTIONS = [
  { value: '15',    label: '15 minutes (Lightning)' },
  { value: '30',    label: '30 minutes' },
  { value: '45',    label: '45 minutes' },
  { value: '60',    label: '60 minutes (Full session)' },
  { value: 'other', label: 'Open to organiser preference' },
]

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors'
const labelCls = 'block text-[13px] font-medium text-foreground mb-1.5'
const fieldCls = 'flex flex-col gap-0'

export default function SpeakerApplyClient({ slug, eventName, enabled, closingDate, customMessage }: Props) {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', jobTitle: '', company: '',
    bio: '', talkTitle: '', talkAbstract: '', talkDuration: '',
    previousSpeaking: '', portfolioUrl: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const closed = !!closingDate && new Date().toISOString().slice(0, 10) > closingDate

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setForm(f => ({ ...f, [field]: e.target.value }))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch(`/api/events/${slug}/apply/speaker`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Submission failed')
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Not enabled ─────────────────────────────────────────────────────────────
  if (!enabled || closed) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <Mic className="size-7 text-muted-foreground" />
        </div>
        <h1 className="text-[20px] font-bold text-foreground">Speaker Applications {closed ? 'Closed' : 'Not Open'}</h1>
        <p className="max-w-md text-[14px] text-muted-foreground">
          {closed
            ? `The deadline for speaker applications for ${eventName} has passed.`
            : `Speaker applications are not currently open for ${eventName}.`}
        </p>
        <Link href={`/events/${slug}`} className="text-[13px] text-primary hover:underline">← Back to event</Link>
      </div>
    )
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (success) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-green-100">
          <CheckCircle className="size-7 text-green-600" />
        </div>
        <h1 className="text-[20px] font-bold text-foreground">Application Submitted!</h1>
        <p className="max-w-md text-[14px] text-muted-foreground">
          Thanks for applying to speak at <strong>{eventName}</strong>. We&apos;ll review your application and get back to you by email.
        </p>
        <Link href={`/events/${slug}`} className="text-[13px] text-primary hover:underline">← Back to event</Link>
      </div>
    )
  }

  // ── Form ─────────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      {/* Back */}
      <Link href={`/events/${slug}`} className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Back to {eventName}
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Mic className="size-5 text-primary" />
        </div>
        <h1 className="text-[24px] font-bold text-foreground">Apply to Speak</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">{eventName}</p>
        {customMessage && (
          <div className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-[14px] text-muted-foreground">
            {customMessage}
          </div>
        )}
        {closingDate && (
          <p className="mt-3 text-[13px] text-amber-600">
            Applications close on {new Date(closingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Personal details */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Personal Details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={fieldCls}>
              <label className={labelCls}>Full Name <span className="text-destructive">*</span></label>
              <input type="text" required value={form.name} onChange={set('name')} placeholder="Your full name" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Email <span className="text-destructive">*</span></label>
              <input type="email" required value={form.email} onChange={set('email')} placeholder="you@example.com" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Phone</label>
              <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Job Title</label>
              <input type="text" value={form.jobTitle} onChange={set('jobTitle')} placeholder="e.g. Senior Engineer" className={inputCls} />
            </div>
            <div className={fieldCls + ' sm:col-span-2'}>
              <label className={labelCls}>Company / Organisation</label>
              <input type="text" value={form.company} onChange={set('company')} placeholder="Where do you work?" className={inputCls} />
            </div>
          </div>
        </div>

        {/* Talk details */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Talk Details</h2>
          <div className="space-y-4">
            <div className={fieldCls}>
              <label className={labelCls}>Talk Title <span className="text-destructive">*</span></label>
              <input type="text" required value={form.talkTitle} onChange={set('talkTitle')} placeholder="What will you talk about?" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Abstract <span className="text-destructive">*</span></label>
              <textarea required rows={5} value={form.talkAbstract} onChange={set('talkAbstract')} placeholder="Describe your talk — what will attendees learn?" className={inputCls + ' resize-y'} maxLength={1000} />
              <span className="mt-1 text-right text-[12px] text-muted-foreground">{form.talkAbstract.length}/1000</span>
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Preferred Duration</label>
              <select value={form.talkDuration} onChange={set('talkDuration')} className={inputCls}>
                <option value="">Select duration</option>
                {DURATION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Speaker profile */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Speaker Profile</h2>
          <div className="space-y-4">
            <div className={fieldCls}>
              <label className={labelCls}>Bio <span className="text-destructive">*</span></label>
              <textarea required rows={4} value={form.bio} onChange={set('bio')} placeholder="Brief professional bio (shown on event page if selected)" className={inputCls + ' resize-y'} maxLength={500} />
              <span className="mt-1 text-right text-[12px] text-muted-foreground">{form.bio.length}/500</span>
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Previous Speaking Experience</label>
              <textarea rows={3} value={form.previousSpeaking} onChange={set('previousSpeaking')} placeholder="Past conferences, meetups, webinars, etc." className={inputCls + ' resize-y'} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Portfolio / LinkedIn / Website</label>
              <input type="url" value={form.portfolioUrl} onChange={set('portfolioUrl')} placeholder="https://" className={inputCls} />
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? <><Loader2 className="size-4 animate-spin" /> Submitting…</> : 'Submit Application'}
        </button>
      </form>
    </div>
  )
}
