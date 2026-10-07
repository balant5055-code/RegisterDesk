'use client'

// RD-CAPACITY-01 · Super Admin: one event's commercial configuration and its capacity money.
//
// ═══ WHAT THIS PANEL IS FOR ══════════════════════════════════════════════════
// Answering, for a single event: what terms is it on, are they the platform defaults or an
// override somebody set, what capacity does it actually enforce, and what has it paid.
//
// ═══ WHY THE THREE LAYERS ARE SHOWN SEPARATELY ═══════════════════════════════
// A merged "effective" blob makes an override INVISIBLE — an admin looking at ₹0.50 per
// registration cannot tell whether that is the platform rate or something a colleague set for
// this one event last month. So the global default, the event override and the resulting
// effective value are rendered side by side, and a field that differs from the default is
// marked. That distinction is the whole point of the panel.
//
// ═══ WHAT IT CANNOT DO ═══════════════════════════════════════════════════════
// Touch a payment. The POST behind it writes exactly one field (`events/{id}.commercial`) and
// appends an audit row; it cannot alter an order, an amount, or the enforced capacity. The
// payment history below is READ-ONLY and reports each order's own immutable snapshot, never a
// recomputation — recomputing is precisely how a historical figure starts drifting with
// configuration.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertCircle, RotateCcw, Save, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  COMMERCIAL_TERM_KEYS, type CommercialTerms,
} from '@/lib/licensing/capacityCommercial'
import { formatPaise } from '@/lib/licensing/capacityPricing'

interface CapacityPayment {
  orderId:          string
  purpose:          string
  status:           string
  amountPaise:      number
  isCapacityChange: boolean
  charge: null | {
    operation: string; capacity: number; previousCapacity: number | null
    basePaise: number; gstPaise: number; totalPaise: number
    chargeableCapacity: number; activationRatePaise: number; gstRatePercent: number
  }
  razorpayPaymentId: string | null
  razorpayOrderId?:  string | null
  // RD-EVENT-COMMERCE-02 — prepaid service lines on the same order.
  serviceItems?: Array<{ service: string; quantity: number; unitPricePaise: number; basePaise: number; gstRatePercent: number; gstPaise: number; totalPaise: number }>
  couponCode?:    string | null
  discountPaise?: number
}

interface CommercialResponse {
  eventId?:        string
  globalDefaults?: CommercialTerms
  eventOverride?:  Partial<CommercialTerms> | null
  effective?:      CommercialTerms
  hasOverride?:    boolean
  /** RD-EVENT-COMMERCE-04A — server-decided: only a Super Admin may change an event's terms. */
  canEdit?:        boolean
  /** RD-EVENT-COMMERCE-04A — the GLOBAL pricing group's integrity; when not ok nothing can be priced. */
  globalStatus?:   { ok: true } | { ok: false; reason: string; errors: string[] }
  capacity?: {
    enforced: number | null; onLicense: number | null
    changeCount: number; commercialModel: string | null
    activation: CapacityPayment['charge']
  }
  payments?:       CapacityPayment[]
  serviceAllowances?: { purchased: Record<string, number>; consumed: Record<string, number>; remaining: Record<string, number> } | null
  error?:          string
}

/** Human labels + how to render each term's value. */
const LABELS: Record<keyof CommercialTerms, { label: string; render: (v: number) => string }> = {
  freeRegistrationCapacity:      { label: 'Free capacity',            render: v => v.toLocaleString('en-IN') },
  activationRatePaise:           { label: 'Activation rate',          render: v => `${formatPaise(v)} / registration` },
  gstRatePercent:                { label: 'GST on activation',        render: v => `${v}%` },
  attendeeTransactionFeePercent: { label: 'Attendee transaction fee',  render: v => `${v}%` },
  capacityDecreaseFeePercent:    { label: 'Capacity reduction charge', render: v => `${v}%` },
  maximumEventCapacity:          { label: 'Maximum capacity',          render: v => v.toLocaleString('en-IN') },
}

const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

// `getToken` rather than a token STRING: this page mints a fresh ID token per request, and a
// token captured in a prop would be the one thing here that could silently expire.
export function AdminEventCommercialPanel({ eventId, getToken }: {
  eventId:  string
  getToken: () => Promise<string | null>
}) {
  const [data,    setData]    = useState<CommercialResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [saving,  setSaving]  = useState(false)
  const [editing, setEditing] = useState(false)
  const [reason,  setReason]  = useState('')
  const [draft,   setDraft]   = useState<Partial<Record<keyof CommercialTerms, string>>>({})
  // RD-PHASE4-S3 — terms whose event value the admin chose to REMOVE (the event then inherits global).
  const [toInherit, setToInherit] = useState<Partial<Record<keyof CommercialTerms, true>>>({})

  // `loading` starts true, so the mount path needs no synchronous setState — and doing it
  // after the first await is what keeps this a legitimate effect rather than a cascading
  // render (react-hooks/set-state-in-effect). On a RELOAD after a save the flag still flips.
  const load = useCallback(async () => {
    try {
      const token = await getToken()
      setLoading(true)
      const res = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/commercial`, {
        headers: { authorization: `Bearer ${token ?? ''}` }, cache: 'no-store',
      })
      const body = await res.json() as CommercialResponse
      if (!res.ok) { setError(body.error ?? 'Could not load the commercial configuration.'); setData(null) }
      else { setError(null); setData(body) }
    } catch {
      setError('Could not load the commercial configuration.')
    } finally { setLoading(false) }
  }, [eventId, getToken])

  // Deferred by one microtask so NOTHING in `load` — not even its first line — executes
  // while the effect body is running. That is what `react-hooks/set-state-in-effect` is
  // guarding: a setState during the effect forces a second render pass. The `alive` flag then
  // stops a write landing after the drawer closes mid-request.
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => (alive ? load() : undefined))
    return () => { alive = false }
  }, [load])

  const send = useCallback(async (payload: Record<string, unknown>) => {
    // A reason is mandatory server-side for every mutation; blocking here too means the admin
    // is told before the round trip rather than after.
    if (!reason.trim()) { setError('A reason is required.'); return }
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/commercial`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token ?? ''}` },
        body:    JSON.stringify({ ...payload, reason: reason.trim() }),
      })
      const body = await res.json() as CommercialResponse
      if (!res.ok) { setError(body.error ?? 'The change was refused.'); return }
      setError(null); setEditing(false); setReason(''); setDraft({}); setToInherit({})
      await load()
    } catch {
      setError('The change could not be sent.')
    } finally { setSaving(false) }
  }, [eventId, getToken, reason, load])

  const save = useCallback(() => {
    // Only fields the admin actually typed are sent — an override is a PARTIAL by design, so
    // an admin changing the rate alone does not have to restate the other five.
    // RD-PHASE4-S3 — a term marked "Use global" is sent as null: the server REMOVES this event's value
    // for that term (it then inherits the global default). An untouched field keeps its stored value.
    const terms: Record<string, number | null> = {}
    for (const k of COMMERCIAL_TERM_KEYS) {
      if (toInherit[k]) { terms[k] = null; continue }
      const raw = draft[k]
      if (raw === undefined || raw.trim() === '') continue
      terms[k] = Number(raw)
    }
    if (Object.keys(terms).length === 0) { setError('Change at least one value, or clear the override.'); return }
    void send({ terms })
  }, [draft, toInherit, send])

  if (loading) {
    return (
      <PanelShell>
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading commercial configuration…
        </p>
      </PanelShell>
    )
  }

  if (!data?.effective || !data.globalDefaults) {
    return (
      <PanelShell>
        <p className="flex items-start gap-2 text-[12px] text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{data?.globalStatus && !data.globalStatus.ok
            ? `Global capacity pricing is ${data.globalStatus.reason === 'CONFIG_UNREADABLE' ? 'unreadable' : 'invalid'} — every capacity purchase is refused until it is corrected in Business Configuration. ${data.globalStatus.errors.join('; ')}`
            : (error ?? 'No commercial configuration is available for this event.')}</span>
        </p>
      </PanelShell>
    )
  }

  const { globalDefaults, effective, eventOverride, hasOverride, capacity, payments, serviceAllowances } = data

  return (
    <PanelShell
      badge={hasOverride
        ? <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700">
            <ShieldAlert className="size-3" aria-hidden /> Event override
          </span>
        : <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">Platform defaults</span>}
    >
      {/* ── The three layers ──────────────────────────────────────────────────── */}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <th className="pb-1.5 font-semibold">Term</th>
            <th className="pb-1.5 font-semibold">Global default</th>
            <th className="pb-1.5 font-semibold">Event override</th>
            <th className="pb-1.5 font-semibold">Effective</th>
          </tr>
        </thead>
        <tbody>
          {COMMERCIAL_TERM_KEYS.map(k => {
            const overridden = eventOverride != null && eventOverride[k] !== undefined
            return (
              <tr key={k} className="border-t border-border/60">
                <td className="py-1.5 text-muted-foreground">{LABELS[k].label}</td>
                <td className="py-1.5 tabular-nums text-muted-foreground">{LABELS[k].render(globalDefaults[k])}</td>
                <td className="py-1.5 tabular-nums">
                  {overridden
                    ? <span className="font-semibold text-amber-700">{LABELS[k].render(eventOverride[k] as number)}</span>
                    : <span className="text-muted-foreground/60">—</span>}
                </td>
                <td className={cn('py-1.5 tabular-nums font-semibold', overridden ? 'text-amber-700' : 'text-foreground')}>
                  {LABELS[k].render(effective[k])}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* ── Capacity ──────────────────────────────────────────────────────────── */}
      {capacity && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border/70 p-2.5 text-[12px] sm:grid-cols-4">
          <Stat label="Enforced capacity" value={capacity.enforced === null ? 'Unlimited' : capacity.enforced.toLocaleString('en-IN')} />
          <Stat label="On the licence" value={capacity.onLicense === null ? '—' : capacity.onLicense.toLocaleString('en-IN')} />
          <Stat label="Capacity changes" value={String(capacity.changeCount)} />
          <Stat label="Model" value={capacity.commercialModel ?? 'tier (legacy)'} />
        </div>
      )}

      {/* ── Edit ──────────────────────────────────────────────────────────────── */}
      <div className="mt-3">
        {!editing && data.canEdit !== true ? (
          // RD-EVENT-COMMERCE-04A — mirrors the server: the POST answers 403 for a non-Super-Admin.
          <p className="text-[11.5px] text-muted-foreground">View only. Changing an event’s commercial terms requires a Super Admin.</p>
        ) : !editing ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setEditing(true); setError(null) }}
              className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted/60">
              Override for this event
            </button>
            {hasOverride && (
              <button type="button" disabled={saving}
                onClick={() => { setEditing(true); setError('Enter a reason, then confirm Clear override.') }}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-50">
                <RotateCcw className="size-3" aria-hidden /> Clear override
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
            <p className="mb-2 text-[11px] text-amber-800">
              A term with no event value follows the global default (shown as the placeholder). Type a
              value to set it for this event; a field you leave untouched keeps its current value. To
              make one term follow the global default again, use “Use global”. Changes apply to FUTURE
              activations, capacity changes and attendee checkouts for this event only —
              completed payments keep the terms they were charged under and are never recalculated,
              and checkouts already started keep the terms they were created with.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {COMMERCIAL_TERM_KEYS.map(k => (
                <label key={k} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
                    {LABELS[k].label}
                    {eventOverride?.[k] !== undefined && (
                      <button type="button" disabled={saving}
                        onClick={() => {
                          setToInherit(t => ({ ...t, [k]: !t[k] || undefined }))
                          setDraft(d => { const n = { ...d }; delete n[k]; return n })
                        }}
                        className="rounded px-1 text-[10.5px] font-medium text-primary hover:underline disabled:opacity-50">
                        {toInherit[k] ? 'Keep event value' : 'Use global'}
                      </button>
                    )}
                  </span>
                  <input
                    type="number" min={0} step="any"
                    placeholder={String(globalDefaults[k])}
                    disabled={toInherit[k] === true}
                    value={toInherit[k] ? '' : (draft[k] ?? (eventOverride?.[k] !== undefined ? String(eventOverride[k]) : ''))}
                    onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                    className={cn(inputCls, toInherit[k] && 'opacity-60')}
                  />
                </label>
              ))}
            </div>
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-[10.5px] text-muted-foreground">Reason (required, recorded in the audit trail)</span>
              <input value={reason} onChange={e => setReason(e.target.value)} className={inputCls}
                placeholder="e.g. negotiated rate for the 2026 season" />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={saving} onClick={save}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
                {saving ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Save className="size-3" aria-hidden />} Save override
              </button>
              {hasOverride && (
                <button type="button" disabled={saving} onClick={() => void send({ clear: true })}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-50">
                  <RotateCcw className="size-3" aria-hidden /> Clear override
                </button>
              )}
              <button type="button" disabled={saving}
                onClick={() => { setEditing(false); setDraft({}); setToInherit({}); setReason(''); setError(null) }}
                className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 flex items-start gap-2 text-[12px] text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{error}</span>
        </p>
      )}

      {/* ── RD-EVENT-COMMERCE-02 · prepaid service allowances (read-only ledger) ── */}
      {serviceAllowances && Object.values(serviceAllowances.purchased).some(n => n > 0) && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Prepaid service allowances</p>
          <div className="space-y-1">
            {Object.keys(serviceAllowances.purchased).filter(k => serviceAllowances.purchased[k] > 0).map(k => (
              <p key={k} className="text-[12px] tabular-nums text-foreground">
                <span className="capitalize">{k}</span> · purchased {serviceAllowances.purchased[k].toLocaleString('en-IN')} · used {serviceAllowances.consumed[k].toLocaleString('en-IN')} · remaining {serviceAllowances.remaining[k].toLocaleString('en-IN')}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* ── Capacity payments (read-only, from each order's own snapshot) ─────── */}
      <div className="mt-3">
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          Capacity payments
        </p>
        {!payments || payments.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No capacity payments recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {payments.map(pay => (
              <div key={pay.orderId} className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium capitalize text-foreground">{pay.purpose.replace(/_/g, ' ')}</span>
                  <span className="flex items-center gap-2">
                    <span className={cn('rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold',
                      pay.status === 'paid' ? 'bg-emerald-100 text-emerald-700'
                      : pay.status === 'failed' || pay.status === 'refunded' ? 'bg-red-100 text-red-700'
                      : 'bg-muted text-muted-foreground')}>{pay.status}</span>
                    <span className="font-semibold tabular-nums text-foreground">{formatPaise(pay.amountPaise)}</span>
                  </span>
                </div>
                {pay.charge && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    {pay.charge.previousCapacity === null
                      ? `Activated at ${pay.charge.capacity.toLocaleString('en-IN')}`
                      : `${pay.charge.previousCapacity.toLocaleString('en-IN')} → ${pay.charge.capacity.toLocaleString('en-IN')}`}
                    {' · '}{pay.charge.chargeableCapacity.toLocaleString('en-IN')} × {formatPaise(pay.charge.activationRatePaise)}
                    {' = '}{formatPaise(pay.charge.basePaise)} + GST {pay.charge.gstRatePercent}% {formatPaise(pay.charge.gstPaise)}
                    {' = '}{formatPaise(pay.charge.totalPaise)}
                  </p>
                )}
                {(pay.serviceItems ?? []).map(i => (
                  <p key={i.service} className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    Prepaid {i.service} · {i.quantity.toLocaleString('en-IN')} × {formatPaise(i.unitPricePaise)} = {formatPaise(i.basePaise)}
                    {' '}+ GST {i.gstRatePercent}% {formatPaise(i.gstPaise)} = {formatPaise(i.totalPaise)}
                  </p>
                ))}
                {pay.couponCode && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">Coupon {pay.couponCode} · −{formatPaise(pay.discountPaise ?? 0)} (activation)</p>
                )}
                {(pay.razorpayOrderId || pay.razorpayPaymentId) && (
                  <p className="mt-0.5 break-all text-[10.5px] text-muted-foreground">{pay.orderId} · {pay.razorpayOrderId ?? '—'} · {pay.razorpayPaymentId ?? 'unpaid'}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </PanelShell>
  )
}

function PanelShell({ children, badge }: { children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Commercial configuration
        </p>
        {badge}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
