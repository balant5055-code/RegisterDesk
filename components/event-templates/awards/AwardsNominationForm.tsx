'use client'

import { useState } from 'react'
import { Trophy, Send, CheckCircle, AlertCircle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Props ────────────────────────────────────────────────────────────────────

interface AwardsNominationFormProps {
  slug:       string
  categories: { id: string; name: string; description: string }[]
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  category:     string
  nomineeName:  string
  organization: string
  description:  string
  supportingUrl: string
}

const BLANK: FormState = {
  category:     '',
  nomineeName:  '',
  organization: '',
  description:  '',
  supportingUrl: '',
}

// ─── Field ────────────────────────────────────────────────────────────────────

function Field({
  label, required, error, children,
}: {
  label:    string
  required?: boolean
  error?:   string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12px] font-semibold uppercase tracking-wide text-zinc-400">
        {label}{required && <span className="ml-0.5 text-yellow-400">*</span>}
      </label>
      {children}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

const INPUT_CLS =
  'w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-[13px] text-white placeholder:text-zinc-500 ' +
  'focus:border-yellow-400/50 focus:outline-none focus:ring-2 focus:ring-yellow-400/20 ' +
  'disabled:opacity-50 transition-colors'

// ─── Component ────────────────────────────────────────────────────────────────

export function AwardsNominationForm({ slug, categories }: AwardsNominationFormProps) {
  const [form,     setForm]     = useState<FormState>(BLANK)
  const [errors,   setErrors]   = useState<Partial<FormState>>({})
  const [loading,  setLoading]  = useState(false)
  const [success,  setSuccess]  = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  function update(field: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }))
  }

  function validate(): boolean {
    const e: Partial<FormState> = {}
    if (!form.category.trim())    e.category    = 'Please select a category.'
    if (!form.nomineeName.trim()) e.nomineeName  = 'Nominee name is required.'
    if (form.supportingUrl.trim()) {
      try { new URL(form.supportingUrl.trim()) }
      catch { e.supportingUrl = 'Enter a valid URL (https://...)' }
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setApiError(null)
    if (!validate()) return

    setLoading(true)
    try {
      const res = await fetch('/api/nominations/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug, ...form }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (!json.success) { setApiError(json.error ?? 'Submission failed.'); return }
      setSuccess(true)
      setForm(BLANK)
    } catch {
      setApiError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <section id="nominate" className="bg-zinc-950 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-yellow-400/20 bg-zinc-900 p-10 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-yellow-400/10">
              <CheckCircle className="size-7 text-yellow-400" aria-hidden />
            </div>
            <h3 className="text-xl font-black text-white">Nomination Submitted!</h3>
            <p className="max-w-sm text-[0.875rem] text-zinc-400">
              Thank you. Your nomination has been received and is under review. We'll be in touch if shortlisted.
            </p>
            <button
              onClick={() => setSuccess(false)}
              className="mt-2 rounded-xl border border-zinc-700 px-5 py-2 text-[13px] font-semibold text-zinc-300 transition-colors hover:border-yellow-400/40 hover:text-yellow-400"
            >
              Submit Another Nomination
            </button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section id="nominate" className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-10">
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Nominations
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Nominate Now
          </h2>
          <p className="mt-3 text-base text-zinc-400">
            Know someone deserving of recognition? Submit a nomination below.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-5">

          {/* Category */}
          <Field label="Award Category" required error={errors.category}>
            <div className="relative">
              <select
                value={form.category}
                onChange={e => update('category', e.target.value)}
                disabled={loading}
                className={cn(
                  INPUT_CLS,
                  'appearance-none pr-10',
                  !form.category && 'text-zinc-500',
                  errors.category && 'border-red-500/60',
                )}
              >
                <option value="" disabled>Select a category…</option>
                {categories.map(c => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" aria-hidden />
            </div>
          </Field>

          {/* Nominee Name */}
          <Field label="Nominee Name" required error={errors.nomineeName}>
            <input
              type="text"
              value={form.nomineeName}
              onChange={e => update('nomineeName', e.target.value)}
              placeholder="Full name of the nominee"
              disabled={loading}
              className={cn(INPUT_CLS, errors.nomineeName && 'border-red-500/60')}
            />
          </Field>

          {/* Organization */}
          <Field label="Organization">
            <input
              type="text"
              value={form.organization}
              onChange={e => update('organization', e.target.value)}
              placeholder="Company, NGO, or institution"
              disabled={loading}
              className={INPUT_CLS}
            />
          </Field>

          {/* Description */}
          <Field label="Why do they deserve this award?">
            <textarea
              value={form.description}
              onChange={e => update('description', e.target.value)}
              placeholder="Describe the nominee's achievements, impact, and why they stand out…"
              rows={4}
              disabled={loading}
              className={cn(INPUT_CLS, 'resize-none leading-relaxed')}
            />
          </Field>

          {/* Supporting URL */}
          <Field label="Supporting URL" error={errors.supportingUrl}>
            <input
              type="url"
              value={form.supportingUrl}
              onChange={e => update('supportingUrl', e.target.value)}
              placeholder="https://example.com/profile-or-work"
              disabled={loading}
              className={cn(INPUT_CLS, errors.supportingUrl && 'border-red-500/60')}
            />
          </Field>

          {/* API error */}
          {apiError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-3">
              <AlertCircle className="size-4 shrink-0 text-red-400" aria-hidden />
              <p className="text-[13px] text-red-300">{apiError}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 py-3 text-[14px] font-black text-zinc-900 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? (
              <>
                <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="45" />
                </svg>
                Submitting…
              </>
            ) : (
              <>
                <Trophy className="size-4" aria-hidden />
                Submit Nomination
                <Send className="size-3.5" aria-hidden />
              </>
            )}
          </button>

        </form>
      </div>
    </section>
  )
}
