'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, UserPlus, CheckCircle2, AlertCircle, Printer, ExternalLink, RotateCcw,
} from 'lucide-react'

interface WalkInPass {
  id: string; name: string; price: number; unlimited: boolean; quantity: number | null; sold: number; available: number | null
}
type PaymentMode = 'free' | 'cash' | 'upi' | 'complimentary'

const PAYMENT_MODES: { key: PaymentMode; label: string }[] = [
  { key: 'free',          label: 'Free' },
  { key: 'cash',          label: 'Cash' },
  { key: 'upi',           label: 'UPI' },
  { key: 'complimentary', label: 'Complimentary' },
]

interface Props { slug: string; token: string; onRegistered?: () => void }

export default function WalkInForm({ slug, token, onRegistered }: Props) {
  const [passes,  setPasses]  = useState<WalkInPass[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [name,    setName]    = useState('')
  const [email,   setEmail]   = useState('')
  const [phone,   setPhone]   = useState('')
  const [passId,  setPassId]  = useState('')
  const [mode,    setMode]    = useState<PaymentMode>('free')
  const [refNo,   setRefNo]   = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [result,     setResult]     = useState<{ registrationId: string; ticketCode: string } | null>(null)

  const loadPasses = useCallback(() => {
    setLoading(true); setLoadErr(null)
    fetch(`/api/checkin/walkin?slug=${encodeURIComponent(slug)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async res => { if (!res.ok) throw new Error('Could not load passes.'); return res.json() as Promise<{ passes: WalkInPass[] }> })
      .then(data => { setPasses(data.passes); setPassId(prev => prev || data.passes[0]?.id || '') })
      .catch(e => setLoadErr(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [slug, token])

  useEffect(() => {
    const t = setTimeout(loadPasses, 0)
    return () => clearTimeout(t)
  }, [loadPasses])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim() || !passId) return
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/checkin/walkin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug, passId, name, email, phone, paymentMode: mode, referenceNumber: refNo }),
      })
      const data = await res.json().catch(() => null) as { registrationId?: string; ticketCode?: string; error?: string } | null
      if (!res.ok || !data?.registrationId) throw new Error(data?.error ?? 'Registration failed.')
      setResult({ registrationId: data.registrationId, ticketCode: data.ticketCode ?? '' })
      onRegistered?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally { setSubmitting(false) }
  }

  function reset() {
    setResult(null); setError(null)
    setName(''); setEmail(''); setPhone(''); setRefNo(''); setMode('free')
    loadPasses()   // refresh remaining capacity
  }

  // ── Success view ──────────────────────────────────────────────────────────
  if (result) {
    const ticketUrl = `/tickets/${result.registrationId}`
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center">
        <CheckCircle2 className="mx-auto size-9 text-emerald-500" aria-hidden />
        <p className="mt-2 text-[15px] font-bold text-emerald-900">Registered &amp; checked in</p>
        <p className="text-[13px] text-emerald-700">{name}</p>

        <div className="mx-auto mt-4 max-w-xs space-y-2 text-left">
          <div className="rounded-lg bg-background px-3 py-2">
            <p className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">Ticket Code</p>
            <p className="font-mono text-[18px] font-bold tracking-[0.12em] text-foreground">{result.ticketCode}</p>
          </div>
          <div className="rounded-lg bg-background px-3 py-2">
            <p className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">Registration ID</p>
            <p className="font-mono text-[12px] break-all text-foreground">{result.registrationId}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <a href={ticketUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90"
            style={{ backgroundImage: 'var(--primary-gradient)' }}>
            <Printer className="size-4" aria-hidden /> Print Ticket
          </a>
          <a href={ticketUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-2 text-[13.5px] font-medium text-foreground hover:bg-muted">
            <ExternalLink className="size-4" aria-hidden /> Open Ticket
          </a>
        </div>

        <button onClick={reset} className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-3.5" aria-hidden /> Register another attendee
        </button>
      </div>
    )
  }

  // ── Form view ───────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <UserPlus className="size-4 text-primary" aria-hidden />
        <h3 className="text-[14px] font-semibold text-foreground">Walk-In Registration</h3>
      </div>

      {loadErr && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          <AlertCircle className="size-4" aria-hidden /> {loadErr}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <input value={name} onChange={e => setName(e.target.value)} required placeholder="Attendee name" className={inputCls} />
          </Field>
          <Field label="Email" required>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="attendee@example.com" className={inputCls} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="Phone number" className={inputCls} />
          </Field>
          <Field label="Pass" required>
            <select value={passId} onChange={e => setPassId(e.target.value)} required disabled={loading} className={inputCls}>
              {loading && <option>Loading…</option>}
              {passes.map(p => (
                <option key={p.id} value={p.id} disabled={p.available === 0}>
                  {p.name}{p.price > 0 ? ` — ₹${p.price}` : ' — Free'}{p.available === 0 ? ' (sold out)' : p.available !== null ? ` (${p.available} left)` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Payment Mode">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {PAYMENT_MODES.map(pm => (
              <button key={pm.key} type="button" onClick={() => setMode(pm.key)}
                className={cn('rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors',
                  mode === pm.key ? 'border-primary bg-primary/[0.08] text-primary' : 'border-border text-muted-foreground hover:bg-muted')}
                aria-pressed={mode === pm.key}>
                {pm.label}
              </button>
            ))}
          </div>
        </Field>

        {mode === 'upi' && (
          <Field label="Reference Number">
            <input value={refNo} onChange={e => setRefNo(e.target.value)} placeholder="UPI reference (optional)" className={inputCls} />
          </Field>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden /> {error}
          </div>
        )}

        <button type="submit" disabled={submitting || loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60"
          style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
          Register &amp; Check In
        </button>
      </form>
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none focus:ring-2 focus:ring-primary/30'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">{label}{required && <span className="text-destructive"> *</span>}</span>
      {children}
    </label>
  )
}
