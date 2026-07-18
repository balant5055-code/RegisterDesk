'use client'

import { useState }    from 'react'
import Link            from 'next/link'
import { TextLink } from '@/components/ui'
import { Building2, CheckCircle, ArrowLeft, Loader2 } from 'lucide-react'

interface Props {
  slug:          string
  eventName:     string
  enabled:       boolean
  closingDate:   string
  customMessage: string
}

const TIER_OPTIONS = [
  { value: 'title',   label: 'Title Sponsor' },
  { value: 'gold',    label: 'Gold' },
  { value: 'silver',  label: 'Silver' },
  { value: 'bronze',  label: 'Bronze' },
  { value: 'partner', label: 'Partner' },
  { value: 'media',   label: 'Media Partner' },
  { value: '',        label: 'Open to discussion' },
]

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors'
const labelCls = 'block text-[13px] font-medium text-foreground mb-1.5'
const fieldCls = 'flex flex-col gap-0'

export default function SponsorApplyClient({ slug, eventName, enabled, closingDate, customMessage }: Props) {
  const [form, setForm] = useState({
    companyName: '', contactName: '', email: '', phone: '',
    website: '', preferredTier: '', message: '',
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
      const res = await fetch(`/api/events/${slug}/apply/sponsor`, {
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

  if (!enabled || closed) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <Building2 className="size-7 text-muted-foreground" />
        </div>
        <h1 className="text-[20px] font-bold text-foreground">Sponsorship Applications {closed ? 'Closed' : 'Not Open'}</h1>
        <p className="max-w-md text-[14px] text-muted-foreground">
          {closed
            ? `The deadline for sponsorship applications for ${eventName} has passed.`
            : `Sponsorship opportunities for ${eventName} are not currently open.`}
        </p>
        <TextLink href={`/events/${slug}`}>← Back to event</TextLink>
      </div>
    )
  }

  if (success) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-green-100">
          <CheckCircle className="size-7 text-green-600" />
        </div>
        <h1 className="text-[20px] font-bold text-foreground">Application Submitted!</h1>
        <p className="max-w-md text-[14px] text-muted-foreground">
          Thank you for your interest in sponsoring <strong>{eventName}</strong>. We&apos;ll review your application and reach out soon.
        </p>
        <TextLink href={`/events/${slug}`}>← Back to event</TextLink>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Link href={`/events/${slug}`} className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Back to {eventName}
      </Link>

      <div className="mb-8">
        <div className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Building2 className="size-5 text-primary" />
        </div>
        <h1 className="text-[24px] font-bold text-foreground">Become a Sponsor</h1>
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
        {/* Company details */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Company Details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={fieldCls + ' sm:col-span-2'}>
              <label className={labelCls}>Company Name <span className="text-destructive">*</span></label>
              <input type="text" required value={form.companyName} onChange={set('companyName')} placeholder="Your company name" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Website</label>
              <input type="url" value={form.website} onChange={set('website')} placeholder="https://yourcompany.com" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Preferred Tier</label>
              <select value={form.preferredTier} onChange={set('preferredTier')} className={inputCls}>
                {TIER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Contact details */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Contact Person</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={fieldCls}>
              <label className={labelCls}>Contact Name <span className="text-destructive">*</span></label>
              <input type="text" required value={form.contactName} onChange={set('contactName')} placeholder="Full name" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Email <span className="text-destructive">*</span></label>
              <input type="email" required value={form.email} onChange={set('email')} placeholder="contact@company.com" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>Phone</label>
              <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" className={inputCls} />
            </div>
          </div>
        </div>

        {/* Message */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Sponsorship Interest</h2>
          <div className={fieldCls}>
            <label className={labelCls}>Message <span className="text-destructive">*</span></label>
            <textarea
              required
              rows={5}
              value={form.message}
              onChange={set('message')}
              placeholder="Tell us about your sponsorship goals, budget range, and what you'd like to get out of the partnership."
              className={inputCls + ' resize-y'}
              maxLength={1000}
            />
            <span className="mt-1 text-right text-[12px] text-muted-foreground">{form.message.length}/1000</span>
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
