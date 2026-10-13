'use client'

// RD-PRINT-BILL-P2 — Super Admin · per-event ID badge billing (events/{slug}.printBadgeCommercial).
//
// Shows the three layers — GLOBAL badge settings, this event's OVERRIDE, and the EFFECTIVE result
// with the source of each value — plus the release state. A Super Admin can set or clear the
// override; every change needs a reason (3–500 characters) and is audited server-side
// (licenseHistory + adminAuditLogs, one transaction). Nothing here charges anything: badge
// purchases and paid generation are not released in this phase, so the effective mode is FREE.
//
// RD-PRINT-BILL-P2.1 — readable on a phone (stacked layers below `sm`), the reason rule stated
// before submission, and a safe recovery path for an UNREADABLE stored override: it is labelled as
// such, its stored value is shown read-only, it can be cleared explicitly (with a confirmation
// step), and a save only replaces it after the admin confirms — the server refuses otherwise.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertCircle, RotateCcw, Save, IdCard, Lock, ShieldAlert, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import {
  BADGE_OVERRIDE_PRICE_MIN_PAISE, BADGE_OVERRIDE_PRICE_MAX_PAISE,
  type PrintBadgeCommercialOverride, type EffectivePrintBadgeTerms, type GlobalPrintBadgeTerms,
} from '@/lib/licensing/printBadgeCommercial'
import { badgeReasonProblem, BADGE_REASON_MAX } from '@/lib/licensing/printBadgeSettings'
import { parseRupeesToPaise, paiseToRupeesInput } from '@/lib/licensing/moneyInput'
import { BadgeEventBilling } from '@/components/admin/printBadges/BadgeEventBilling'

interface PrintBadgeResponse {
  error?:          string
  global:          GlobalPrintBadgeTerms | null
  globalStatus:    { ok: true; saleState: string } | { ok: false; reason: string }
  eventOverride:   PrintBadgeCommercialOverride | null
  overrideStatus:  { ok: true } | { ok: false; errors: string[]; rawPreview: string; rawTruncated: boolean }
  effective:       EffectivePrintBadgeTerms | null
  /** RD-PRINT-P8 — whether this event's organizer is a paid ID-badge pilot organizer (server-decided). */
  pilot?:          { ok: true; member: boolean } | { ok: false; reason: string }
  released:        { purchase: boolean; paidGeneration: boolean }
  chargeableAssetTypes: string[]
}

type Tri = 'inherit' | 'on' | 'off'
const triOf = (v: boolean | undefined): Tri => (v === undefined ? 'inherit' : v ? 'on' : 'off')
const MODE_LABEL: Record<string, string> = { free: 'Free', complimentary: 'Complimentary', paid: 'Paid' }
const REASON_LABEL: Record<string, string> = {
  global_disabled:  'paid badge generation is off globally',
  override_invalid: 'the stored event override is unreadable — nothing is charged',
  event_disabled:   'paid billing is off for this event',
  complimentary:    'this event is complimentary',
  paid:             'paid at the effective price',
  not_in_pilot:     'the organizer is not a paid ID-badge pilot organizer — badges are free for them',
}
const SOURCE_LABEL: Record<string, string> = { global: 'global', event: 'this event', default: 'default' }
const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'
const REASON_HINT = `Reason — required, 3–${BADGE_REASON_MAX} characters, recorded in the audit log`

/** A stored-override validator message in administrator wording (the field path stays out). */
function overrideIssueText(raw: string): string {
  if (/unitPricePaise/.test(raw)) return `Unit price must be ${formatPaise(BADGE_OVERRIDE_PRICE_MIN_PAISE)}–${formatPaise(BADGE_OVERRIDE_PRICE_MAX_PAISE)} (whole paise).`
  const unknown = /^printBadgeCommercial\.(.+) is not a recognised setting$/.exec(raw)
  if (unknown) return `“${unknown[1]}” is not a badge setting.`
  const flag = /^printBadgeCommercial\.(enabled|complimentary|couponsAllowed) must be true or false$/.exec(raw)
  if (flag) return `${{ enabled: 'Paid billing', complimentary: 'Complimentary', couponsAllowed: 'Coupons allowed' }[flag[1]]} must be on or off.`
  if (/must be an object/.test(raw)) return 'The stored value is not a settings object.'
  return raw.replace(/^printBadgeCommercial\./, '')
}

function TriSelect({ value, onChange, on, off }: { value: Tri; onChange: (t: Tri) => void; on: string; off: string }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as Tri)} className={inputCls}>
      <option value="inherit">Inherit</option><option value="on">{on}</option><option value="off">{off}</option>
    </select>
  )
}

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const problem = value.trim() ? badgeReasonProblem(value) : null
  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-[11px] text-muted-foreground">{REASON_HINT}</span>
      <textarea id={id} value={value} onChange={e => onChange(e.target.value)} maxLength={BADGE_REASON_MAX} rows={2}
        aria-describedby={`${id}-count`} className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px]" />
      <span id={`${id}-count`} className={cn('text-[10.5px] tabular-nums', problem ? 'text-destructive' : 'text-muted-foreground')}>
        {value.trim().length}/{BADGE_REASON_MAX} characters{problem ? ` — ${problem}` : ''}
      </span>
    </label>
  )
}

function PanelShell({ children, badge }: { children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="admin-print-badge-panel">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/[0.09] text-primary"><IdCard className="size-4" aria-hidden /></span>
        <h3 className="text-[13px] font-semibold text-foreground">ID badge billing</h3>
        {badge}
      </div>
      {children}
    </section>
  )
}

/**
 * RD-PRINT-BILL-P7 — the per-event badge panel: the existing billing SETTINGS panel, then the
 * generation-billing RECORDS (ledger, rounds, claims, usage, jobs, reconciliation). The records load
 * only when opened — every load is written to the admin audit log — and stay reachable even when the
 * settings above cannot be read.
 */
export function AdminPrintBadgePanel({ eventId, getToken }: { eventId: string; getToken: () => Promise<string | null> }) {
  const [showBilling, setShowBilling] = useState(false)
  return (
    <div className="space-y-3">
      <PrintBadgeSettingsPanel eventId={eventId} getToken={getToken} />
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[13px] font-semibold text-foreground">ID badge billing records</p>
            <p className="text-[11.5px] text-muted-foreground">Units, billing rounds, attendee claims (registration ids only), usage and reconciliation. Opening this view is audited.</p>
          </div>
          <button type="button" onClick={() => setShowBilling(v => !v)} aria-expanded={showBilling} data-testid="toggle-badge-billing"
            className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted">
            {showBilling ? 'Hide billing records' : 'Show billing records'}
          </button>
        </div>
        {showBilling && <div className="mt-3"><BadgeEventBilling slug={eventId} /></div>}
      </div>
    </div>
  )
}

function PrintBadgeSettingsPanel({ eventId, getToken }: { eventId: string; getToken: () => Promise<string | null> }) {
  const [data,    setData]    = useState<PrintBadgeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [notice,  setNotice]  = useState<string | null>(null)
  const [saving,  setSaving]  = useState(false)
  const [mode,    setMode]    = useState<'view' | 'edit' | 'confirmClear'>('view')
  const [reason,  setReason]  = useState('')
  const [enabled, setEnabled] = useState<Tri>('inherit')
  const [comp,    setComp]    = useState<Tri>('inherit')
  const [coupons, setCoupons] = useState<Tri>('inherit')
  const [price,   setPrice]   = useState('')   // rupees text; blank ⇒ inherit
  const [ackReplace, setAckReplace] = useState(false)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      setLoading(true)
      const res = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/print-badges`, {
        headers: { authorization: `Bearer ${token ?? ''}` }, cache: 'no-store',
      })
      const body = await res.json() as PrintBadgeResponse
      if (!res.ok) { setError(body.error ?? 'Could not load the badge billing configuration.'); setData(null) }
      else { setError(null); setData(body) }
    } catch {
      setError('Could not load the badge billing configuration.')
    } finally { setLoading(false) }
  }, [eventId, getToken])
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => (alive ? load() : undefined))
    return () => { alive = false }
  }, [load])

  const unreadable = data ? !data.overrideStatus.ok : false

  const startEdit = () => {
    const o = data?.eventOverride ?? {}
    setEnabled(triOf(o.enabled)); setComp(triOf(o.complimentary)); setCoupons(triOf(o.couponsAllowed))
    setPrice(o.unitPricePaise === undefined ? '' : paiseToRupeesInput(o.unitPricePaise))
    setReason(''); setAckReplace(false); setError(null); setNotice(null); setMode('edit')
  }
  const startClear = () => { setReason(''); setError(null); setNotice(null); setMode('confirmClear') }
  const cancel = () => { setMode('view'); setError(null); setReason(''); setAckReplace(false) }

  const send = useCallback(async (payload: Record<string, unknown>, done: string) => {
    // The server enforces 3–500 characters; checked here too so the admin is told before sending.
    const problem = badgeReasonProblem(reason)
    if (problem) { setError(problem); return }
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/print-badges`, {
        method: 'POST', headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, reason: reason.trim() }),
      })
      const body = await res.json() as { error?: string; unchanged?: boolean }
      if (!res.ok) { setError(body.error ?? 'The change was refused.'); return }
      setError(null); setMode('view'); setReason(''); setAckReplace(false)
      setNotice(body.unchanged ? 'Nothing changed — the event already has these settings.' : done)
      await load()
    } catch {
      setError('The change could not be sent.')
    } finally { setSaving(false) }
  }, [eventId, getToken, reason, load])

  const save = () => {
    const tri = (t: Tri): boolean | null => (t === 'inherit' ? null : t === 'on')
    let unitPricePaise: number | null = null
    if (price.trim() !== '') {
      const parsed = parseRupeesToPaise(price)
      const p = parsed.ok ? parsed.paise : null
      if (p === null || !Number.isInteger(p) || p < BADGE_OVERRIDE_PRICE_MIN_PAISE || p > BADGE_OVERRIDE_PRICE_MAX_PAISE) {
        setError(`The badge price must be ${formatPaise(BADGE_OVERRIDE_PRICE_MIN_PAISE)}–${formatPaise(BADGE_OVERRIDE_PRICE_MAX_PAISE)}, or blank to use the global price.`)
        return
      }
      unitPricePaise = p
    }
    if (unreadable && !ackReplace) { setError('Confirm that this save replaces the unreadable override.'); return }
    void send({
      override: { enabled: tri(enabled), complimentary: tri(comp), couponsAllowed: tri(coupons), unitPricePaise },
      ...(unreadable ? { replaceUnreadable: true } : {}),
    }, 'Badge billing saved for this event.')
  }

  if (loading && !data) {
    return <PanelShell><p className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…</p></PanelShell>
  }
  if (!data) {
    return <PanelShell><p className="flex items-start gap-2 text-[12px] text-destructive"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{error ?? 'Unavailable.'}</span></p></PanelShell>
  }

  const { global, effective, eventOverride, overrideStatus, released } = data
  const rows: { label: string; global: string; event: string; effective: string }[] = [
    {
      label: 'Unit price (incl. GST)',
      global: global?.unitPricePaise != null ? formatPaise(global.unitPricePaise) : 'Not set',
      event: unreadable ? 'Unreadable' : eventOverride?.unitPricePaise !== undefined ? formatPaise(eventOverride.unitPricePaise) : '—',
      effective: effective?.unitPricePaise != null ? `${formatPaise(effective.unitPricePaise)} · ${SOURCE_LABEL[effective.sources.unitPricePaise]}` : 'Not set',
    },
    { label: 'GST rate', global: global?.gstRatePercent != null ? `${global.gstRatePercent}%` : 'Not set', event: '—', effective: effective?.gstRatePercent != null ? `${effective.gstRatePercent}%` : 'Not set' },
    { label: 'Paid billing', global: global?.paidGenerationEnabled ? 'On' : 'Off', event: unreadable ? 'Unreadable' : eventOverride?.enabled === undefined ? '—' : eventOverride.enabled ? 'On' : 'Off', effective: effective ? MODE_LABEL[effective.mode] : '—' },
    { label: 'Complimentary', global: '—', event: unreadable ? 'Unreadable' : eventOverride?.complimentary === undefined ? '—' : eventOverride.complimentary ? 'Yes' : 'No', effective: effective?.mode === 'complimentary' ? 'Yes' : 'No' },
    { label: 'Coupons allowed', global: '—', event: unreadable ? 'Unreadable' : eventOverride?.couponsAllowed === undefined ? '—' : eventOverride.couponsAllowed ? 'Yes' : 'No', effective: effective ? `${effective.couponsAllowed ? 'Yes' : 'No'} · ${SOURCE_LABEL[effective.sources.couponsAllowed]}` : '—' },
  ]
  const eventCell = (v: string) => cn(v === 'Unreadable' ? 'font-semibold text-destructive' : v !== '—' && 'font-semibold text-amber-700')

  return (
    <PanelShell badge={<>
      {unreadable
        ? <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10.5px] font-semibold text-destructive" data-testid="override-status-pill"><ShieldAlert className="size-3" aria-hidden /> Unreadable override</span>
        : eventOverride
          ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700" data-testid="override-status-pill">Event override</span>
          : <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground" data-testid="override-status-pill">Global settings</span>}
      {(!released.purchase || !released.paidGeneration) && (
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground"><Lock className="size-3" aria-hidden /> Not released — badges are free</span>
      )}
    </>}>
      {!overrideStatus.ok && (
        <div className="mb-3 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-[11.5px]" data-testid="unreadable-override">
          <p className="font-semibold text-destructive">This event’s stored badge override is unreadable, so it is ignored — nothing is charged.</p>
          <ul className="list-disc space-y-0.5 pl-4 text-destructive">{overrideStatus.errors.map(e => <li key={e}>{overrideIssueText(e)}</li>)}</ul>
          <div>
            <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">Stored value (read-only{overrideStatus.rawTruncated ? ', truncated' : ''})</p>
            {/* Rendered as text — React escapes it; nothing here is interpreted or executed. */}
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground" data-testid="unreadable-override-raw">{overrideStatus.rawPreview}</pre>
          </div>
          <p className="text-muted-foreground">Clear it to return this event to the global badge settings, or set new values (you will be asked to confirm the replacement). The removed value is kept in the audit log.</p>
        </div>
      )}

      {/* Desktop / tablet: the three layers side by side. */}
      <table className="hidden w-full text-[12px] sm:table">
        <thead>
          <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <th className="pb-1.5 pr-3 font-semibold">Setting</th><th className="pb-1.5 pr-3 font-semibold">Global</th>
            <th className="pb-1.5 pr-3 font-semibold">This event</th><th className="pb-1.5 font-semibold">Effective</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map(r => (
            <tr key={r.label} className="border-t border-border/60">
              <td className="py-1.5 pr-3 text-muted-foreground">{r.label}</td><td className="py-1.5 pr-3">{r.global}</td>
              <td className={cn('py-1.5 pr-3', eventCell(r.event))}>{r.event}</td>
              <td className="py-1.5 font-medium text-foreground">{r.effective}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Phone: one stacked block per setting, each layer labelled. */}
      <dl className="space-y-2 sm:hidden" data-testid="print-badge-stacked">
        {rows.map(r => (
          <div key={r.label} className="rounded-lg border border-border/60 p-2.5 text-[12px]">
            <dt className="mb-1 font-semibold text-foreground">{r.label}</dt>
            <dd className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 tabular-nums">
              <span className="text-muted-foreground">Global</span><span>{r.global}</span>
              <span className="text-muted-foreground">This event</span><span className={eventCell(r.event)}>{r.event}</span>
              <span className="text-muted-foreground">Effective</span><span className="font-medium text-foreground">{r.effective}</span>
            </dd>
          </div>
        ))}
      </dl>
      {effective && <p className="mt-2 text-[11px] text-muted-foreground">Effective: <span className="font-semibold text-foreground">{MODE_LABEL[effective.mode]}</span> — {REASON_LABEL[effective.reason]}.</p>}
      {/* RD-PRINT-P8 — pilot membership is decided on the server; this line only reports it. */}
      {data.pilot && (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="badge-pilot-status">
          Paid ID-badge pilot: <span className="font-semibold text-foreground">{data.pilot.ok ? (data.pilot.member ? 'this organizer is a pilot organizer' : 'this organizer is not in the pilot') : 'pilot setting unavailable — nothing is charged and purchases are refused'}</span>
        </p>
      )}

      {mode === 'view' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={startEdit} className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted">
            {unreadable ? 'Replace with new settings' : 'Change this event’s badge billing'}
          </button>
          {unreadable && (
            <button type="button" onClick={startClear} className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-[12px] font-semibold text-destructive hover:bg-destructive/5" data-testid="clear-corrupt-override">
              <Trash2 className="size-3.5" aria-hidden /> Clear corrupt override
            </button>
          )}
        </div>
      )}

      {mode === 'confirmClear' && (
        <div className="mt-3 space-y-2 rounded-xl border border-destructive/40 p-3" data-testid="confirm-clear">
          <p className="text-[12px] font-semibold text-foreground">Clear the unreadable override?</p>
          <p className="text-[11.5px] text-muted-foreground">The event will follow the global badge settings. The stored value shown above is removed from the event and kept in the audit log.</p>
          <ReasonField id="pb-clear-reason" value={reason} onChange={setReason} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={saving || !!badgeReasonProblem(reason)} onClick={() => void send({ clear: true }, 'The unreadable override was cleared — the event follows the global settings.')}
              className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-[12px] font-semibold text-destructive-foreground disabled:opacity-60">
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />} Confirm clear
            </button>
            <button type="button" disabled={saving} onClick={cancel} className="rounded-lg px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="mt-3 space-y-2 rounded-xl border border-border/70 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Paid billing for this event</span>
              <TriSelect value={enabled} onChange={setEnabled} on="On" off="Off (free)" /></label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Complimentary</span>
              <TriSelect value={comp} onChange={setComp} on="Yes" off="No" /></label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Badge coupons</span>
              <TriSelect value={coupons} onChange={setCoupons} on="Allowed" off="Not allowed" /></label>
            <label className="flex flex-col gap-1"><span className="text-[11px] text-muted-foreground">Unit price, ₹ incl. GST ({formatPaise(BADGE_OVERRIDE_PRICE_MIN_PAISE)}–{formatPaise(BADGE_OVERRIDE_PRICE_MAX_PAISE)}; blank = global)</span>
              <input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" placeholder={global?.unitPricePaise != null ? paiseToRupeesInput(global.unitPricePaise) : 'Global'} className={inputCls} /></label>
          </div>
          <ReasonField id="pb-edit-reason" value={reason} onChange={setReason} />
          {unreadable && (
            <label className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-[11.5px] text-foreground" data-testid="ack-replace">
              <input type="checkbox" checked={ackReplace} onChange={e => setAckReplace(e.target.checked)} className="mt-0.5" />
              <span>I understand that saving <span className="font-semibold">replaces</span> the unreadable override shown above (its value is kept in the audit log).</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={saving || (unreadable && !ackReplace)} onClick={save} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-60">
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} {unreadable ? 'Replace override' : 'Save override'}
            </button>
            {eventOverride && !unreadable && (
              <button type="button" disabled={saving} onClick={() => void send({ clear: true }, 'The override was cleared — the event follows the global settings.')} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium disabled:opacity-60">
                <RotateCcw className="size-3.5" aria-hidden /> Clear override
              </button>
            )}
            <button type="button" disabled={saving} onClick={cancel} className="rounded-lg px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-destructive" role="alert"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{error}</p>}
      {notice && !error && <p className="mt-2 text-[11.5px] font-medium text-emerald-700" role="status" data-testid="panel-notice">{notice}</p>}
    </PanelShell>
  )
}
