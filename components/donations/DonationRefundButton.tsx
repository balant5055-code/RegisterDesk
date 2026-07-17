'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth }                             from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import { RotateCcw, Loader2, CheckCircle2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import type { DonationRefundStateResponse } from '@/app/api/organizer/donations/[donationId]/refund/route'
import type { DonationRefundResponse }      from '@/app/api/organizer/donations/[donationId]/refund/route'

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
}

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

export default function DonationRefundButton({ donationId, disabled }: { donationId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <RotateCcw className="size-3" aria-hidden /> Refund
      </button>
      {open && <RefundModal donationId={donationId} onClose={() => setOpen(false)} />}
    </>
  )
}

function RefundModal({ donationId, onClose }: { donationId: string; onClose: () => void }) {
  const [state,   setState]   = useState<DonationRefundStateResponse | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [mode,    setMode]    = useState<'full' | 'partial'>('full')
  const [custom,  setCustom]  = useState('')
  const [reason,  setReason]  = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoadErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/organizer/donations/${donationId}/refund`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Failed to load (${res.status})`)
      }
      setState(await res.json() as DonationRefundStateResponse)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Failed to load refund state')
    }
  }, [donationId])

  useEffect(() => {
    const t = setTimeout(() => { void reload() }, 0)
    return () => clearTimeout(t)
  }, [reload])

  const refundable  = state?.refundablePaise ?? 0
  const amountPaise  = mode === 'full' ? refundable : Math.round(parseFloat(custom || '0') * 100)
  const amountValid  = amountPaise > 0 && amountPaise <= refundable

  async function submit() {
    if (!amountValid || !reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/organizer/donations/${donationId}/refund`, {
        method:  'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ amountPaise, reason: reason.trim() }),
      })
      const body = await res.json() as DonationRefundResponse
      if (!res.ok || !body.success) throw new Error(body.error ?? 'Refund failed')
      setDone(body.status === 'processed' ? 'Refund processed.' : 'Refund initiated — it will reflect shortly.')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refund failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="Refund donation" size="md">
        {loadErr ? (
          <p className="text-[13px] text-destructive">{loadErr}</p>
        ) : !state ? (
          <div className="py-8 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></div>
        ) : (
          <div className="space-y-3 text-[13.5px]">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Donated"    value={rupees(state.grossPaise)} />
              <Stat label="Refunded"   value={rupees(state.refundedPaise)} />
              <Stat label="Refundable" value={rupees(state.refundablePaise)} />
            </div>

            {done ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-[13px] font-medium text-emerald-700">
                <CheckCircle2 className="size-4" /> {done}
              </div>
            ) : state.refundablePaise <= 0 ? (
              <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground">This donation is fully refunded.</p>
            ) : (
              <>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setMode('full')}
                    className={cn('flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium', mode === 'full' ? 'border-primary bg-primary/10 text-primary' : 'border-border')}>
                    Full ({rupees(refundable)})
                  </button>
                  <button type="button" onClick={() => setMode('partial')}
                    className={cn('flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium', mode === 'partial' ? 'border-primary bg-primary/10 text-primary' : 'border-border')}>
                    Partial
                  </button>
                </div>
                {mode === 'partial' && (
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Amount (₹)</span>
                    <input type="number" min={1} value={custom} onChange={e => setCustom(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:ring-2 focus:ring-primary/30" />
                    {amountPaise > 0 && !amountValid && <p className="mt-1 text-[12px] text-destructive">Must be between ₹0.01 and {rupees(refundable)}.</p>}
                  </label>
                )}
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Reason (required)</span>
                  <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={500}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:ring-2 focus:ring-primary/30" />
                </label>
                {error && <p className="text-[13px] text-destructive">{error}</p>}
                <button type="button" onClick={submit} disabled={busy || !amountValid || !reason.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {busy ? 'Processing…' : `Refund ${amountValid ? rupees(amountPaise) : ''}`}
                </button>
              </>
            )}

            {state.refunds.length > 0 && (
              <div className="pt-1">
                <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Refund history</p>
                <div className="space-y-1">
                  {state.refunds.map(r => (
                    <div key={r.refundId} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 text-[12.5px]">
                      <span className="capitalize text-muted-foreground">{r.status}</span>
                      <span className="font-medium text-foreground">{rupees(r.amountPaise)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-center">
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[13px] font-semibold text-foreground">{value}</p>
    </div>
  )
}
