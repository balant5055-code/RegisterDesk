'use client'

// RD-CHECKIN-2.0 — on-site registration.
//
// ═══ WALK-IN IS SHOWN, NOT HIDDEN ════════════════════════════════════════════
// The old surface resolved a permission mismatch by hiding the control: the route
// demanded `registrations` while every label said check-in, so gate staff saw
// nothing and could do nothing. Walk-in now has its OWN permission (`walkin`), the
// server enforces exactly that, and this panel is rendered when the server says the
// caller holds it. The visibility and the authorization finally agree — and the
// panel is not the control either way, because POST /api/checkin/walkin re-checks
// the permission AND the event assignment on every request.
//
// ═══ PARTIAL FAILURE ═════════════════════════════════════════════════════════
// Creation and admission are ONE server transaction (`createRegistration` with
// `checkInOnCreate`), which is what makes capacity, duplicate rules, ticket-code
// uniqueness, the attendance counter and the check-in flag either all happen or
// none of them. This panel therefore has no "created but not admitted" state to
// recover from: it either gets a ticket code back or it gets an error.
//
// No payment architecture is invented here. The modes below are the ones the
// existing walk-in route already accepts; nothing touches a gateway.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface WalkInPass {
  id: string; name: string; price: number
  unlimited: boolean; quantity: number | null; sold: number; available: number | null
}

type PaymentMode = 'free' | 'cash' | 'upi' | 'complimentary'

const PAYMENT_MODES: { key: PaymentMode; label: string }[] = [
  { key: 'free',          label: 'Free' },
  { key: 'cash',          label: 'Cash' },
  { key: 'upi',           label: 'UPI' },
  { key: 'complimentary', label: 'Complimentary' },
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Props {
  slug:  string
  token: string | null
  /** Called after a successful walk-in so the header counts can be refreshed. */
  onRegistered: () => void
}

export default function WalkInPanel({ slug, token, onRegistered }: Props) {
  const [passes,  setPasses]  = useState<WalkInPass[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [name,   setName]   = useState('')
  const [email,  setEmail]  = useState('')
  const [phone,  setPhone]  = useState('')
  const [passId, setPassId] = useState('')
  const [mode,   setMode]   = useState<PaymentMode>('free')
  const [refNo,  setRefNo]  = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [done,       setDone]       = useState<{ name: string; ticketCode: string } | null>(null)

  const loadPasses = useCallback(async () => {
    if (!token) return
    setLoading(true); setLoadErr(null)
    try {
      const res = await fetch(`/api/checkin/walkin?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        // A permission refusal is stated plainly rather than shown as an empty form.
        throw new Error(body?.error ?? 'Could not load the pass list.')
      }
      const data = await res.json() as { passes: WalkInPass[] }
      setPasses(data.passes)
      setPassId(prev => prev || data.passes[0]?.id || '')
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not load the pass list.')
    } finally {
      setLoading(false)
    }
  }, [slug, token])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadPasses() }, [loadPasses])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    // Client validation is a courtesy, never the rule: the server re-validates every
    // field and owns capacity and duplicate policy.
    if (!name.trim())            { setError('Enter the attendee’s name.'); return }
    if (!EMAIL_RE.test(email.trim())) { setError('Enter a valid email address.'); return }
    if (!passId)                 { setError('Choose a category.'); return }
    if (!token)                  { setError('Your session has expired. Sign in again.'); return }

    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/checkin/walkin', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          slug, passId, name: name.trim(), email: email.trim(), phone: phone.trim(),
          paymentMode: mode, referenceNumber: refNo.trim(),
        }),
      })
      const data = await res.json().catch(() => null) as
        { registrationId?: string; ticketCode?: string; error?: string } | null

      if (!res.ok || !data?.registrationId) {
        setError(data?.error ?? 'Registration failed. Please try again.')
        return
      }
      setDone({ name: name.trim(), ticketCode: data.ticketCode ?? '' })
      onRegistered()
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }, [name, email, phone, passId, mode, refNo, slug, token, onRegistered])

  const reset = useCallback(() => {
    setDone(null); setError(null)
    setName(''); setEmail(''); setPhone(''); setRefNo(''); setMode('free')
    void loadPasses()   // remaining capacity has changed
  }, [loadPasses])

  const field = 'w-full rounded-xl border border-border bg-card px-4 py-3 text-fs-md text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus-visible:ring-2 focus-visible:ring-primary'

  /**
   * RD-CHECKIN-QA-01 — a validation message must never outlive the problem.
   *
   * Browser QA: the operator submitted with an empty name, saw "Enter the attendee's
   * name.", typed the name — and the message stayed. The banner then contradicted
   * the form it sat above, which at a gate reads as "the software is stuck" rather
   * than "you already fixed this". Editing any field clears it; the next submit
   * decides afresh.
   */
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); if (error) setError(null) }

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-6 text-fs-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading categories…
      </p>
    )
  }

  if (loadErr) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
        <p className="flex items-start gap-2 text-fs-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {loadErr}
        </p>
        <button type="button" onClick={() => void loadPasses()} className="self-start rounded-lg border border-border bg-card px-3 py-1.5 text-fs-sm font-semibold">
          Try again
        </button>
      </div>
    )
  }

  if (done) {
    return (
      <section role="status" aria-live="assertive" className="flex flex-col gap-4 rounded-2xl border border-success/40 bg-success/5 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-7 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="text-fs-2xs font-bold uppercase tracking-wider text-success">Registered and checked in</p>
            <p className="mt-1 break-words text-fs-xl font-bold leading-tight text-foreground">{done.name}</p>
            {done.ticketCode && (
              <p className="mt-0.5 font-mono text-fs-sm text-muted-foreground">{done.ticketCode}</p>
            )}
          </div>
        </div>
        <button type="button" onClick={reset} autoFocus className="rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground">
          Register another
        </button>
      </section>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-fs-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="wi-name" className="text-fs-sm font-medium">Full name</label>
          <input id="wi-name" value={name} onChange={e => edit(setName)(e.target.value)} autoComplete="off" className={field} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="wi-email" className="text-fs-sm font-medium">Email</label>
          <input id="wi-email" type="email" value={email} onChange={e => edit(setEmail)(e.target.value)} autoComplete="off" inputMode="email" className={field} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="wi-phone" className="text-fs-sm font-medium">
            Mobile <span className="text-muted-foreground">(optional)</span>
          </label>
          <input id="wi-phone" value={phone} onChange={e => edit(setPhone)(e.target.value)} autoComplete="off" inputMode="tel" className={field} />
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="wi-pass" className="text-fs-sm font-medium">Category</label>
          <select id="wi-pass" value={passId} onChange={e => edit(setPassId)(e.target.value)} className={field}>
            {passes.map(p => (
              <option key={p.id} value={p.id} disabled={p.available === 0}>
                {p.name}
                {p.available !== null && ` — ${p.available} left`}
                {p.available === 0 && ' (sold out)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-fs-sm font-medium">Payment</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PAYMENT_MODES.map(m => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              aria-pressed={mode === m.key}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-fs-sm font-semibold transition-colors',
                mode === m.key
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </fieldset>

      {(mode === 'cash' || mode === 'upi') && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wi-ref" className="text-fs-sm font-medium">
            Reference <span className="text-muted-foreground">(optional)</span>
          </label>
          <input id="wi-ref" value={refNo} onChange={e => edit(setRefNo)(e.target.value)} autoComplete="off" className={field} />
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground disabled:opacity-50"
      >
        {submitting ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <UserPlus className="size-5" aria-hidden />}
        {submitting ? 'Registering…' : 'Register and check in'}
      </button>
    </form>
  )
}
