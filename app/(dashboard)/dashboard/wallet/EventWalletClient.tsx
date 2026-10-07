'use client'

// The organizer Wallet — ONE event at a time, the event chosen in the dashboard header's event
// selector (components/dashboard/EventContextProvider). For that event: what was bought, used and
// remains for each service, what was paid, what is refundable now, and its refund / carry-forward
// requests. Every figure is the server's (GET /api/organizer/wallet/events/[draftId] and
// GET /api/organizer/wallet/service-requests?event=…, both ownership-checked); nothing here
// computes money. Buying more goes through the EXISTING purchase flow (Increase Limit →
// License & Services, lib/wallet/purchaseIntent) — there is no general "Add Funds" here: the
// communication balance and its top-up live on Communications › Billing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ArrowUpRight, CalendarDays, ChevronRight, Image as ImageIcon, Loader2, MessageSquare,
  Award, Users, Receipt, RotateCcw, Forward, Wallet as WalletIcon, Sparkles,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { Button, Card, Dialog, EmptyState, PageHeader, ProgressBar, StatusChip } from '@/components/ui'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils/cn'
import { InfoTip } from '@/components/wallet/InfoTip'
import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'
import { increaseLimitHref } from '@/lib/wallet/purchaseIntent'
import {
  REQUEST_KIND_LABEL, REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE, SERVICE_LABEL, SERVICE_UNIT, CARRYABLE_SERVICES,
  type EventRequestsView, type EventServiceView, type RequestableService, type ServiceRequestView, type ValuationPart,
} from '@/lib/wallet/serviceRequestRules'
import type { WalletEventDetail } from '@/lib/wallet/eventWalletView'
import { PHASE_LABEL, PHASE_TONE, SMS_NOTE, measuredText, qty, rupees } from './walletDisplay'

type View = EventRequestsView & { canSubmit: boolean }
type Loaded = { eventId: string; detail: WalletEventDetail; view: View }

const ICON: Record<RequestableService, React.ElementType> = { registrations: Users, whatsapp: MessageSquare, certificates: Award, media: ImageIcon }
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—')
// The refund window is 24 hours, so its deadline is shown to the minute (date in the tile, time beneath it).
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—')
const dates = (s: string | null, e: string | null) => {
  if (!s) return 'Date not set'
  const f = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return e && e.slice(0, 10) !== s.slice(0, 10) ? `${f(s)} – ${f(e)}` : f(s)
}

async function call(path: string, body?: unknown) {
  const token = await auth.currentUser?.getIdToken().catch(() => null)
  if (!token) return { ok: false, status: 401, body: { error: 'Not signed in.' } as Record<string, unknown> }
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null)
  if (!res) return { ok: false, status: 0, body: { error: 'Network error — please try again.' } as Record<string, unknown> }
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

// ─── small pieces ──────────────────────────────────────────────────────────────
function Tile({ icon: Icon, label, value, hint, info }: { icon: React.ElementType; label: string; value: string; hint?: string; info?: React.ReactNode }) {
  return (
    <Card variant="elevated" padded={false} className="flex min-w-0 flex-col gap-2 p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />{label}{info && <InfoTip label={`About ${label}`}>{info}</InfoTip>}
      </p>
      <p className="truncate text-[22px] font-bold leading-tight tracking-tight text-foreground">{value}</p>
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
    </Card>
  )
}

function Figure({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className={cn('text-[13.5px] font-semibold tabular-nums', muted ? 'text-muted-foreground' : 'text-foreground')}>{value}</dd>
    </div>
  )
}

function Valuation({ parts }: { parts: ValuationPart[] }) {
  if (parts.length === 0) return null
  return (
    <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
      {parts.map(p => (
        <li key={p.orderId} className="flex justify-between gap-3">
          <span className="truncate">{qty(p.units)} unit{p.units === 1 ? '' : 's'} from order <span className="font-mono">{p.orderId.split('#')[0]}</span></span>
          <span className="shrink-0 tabular-nums text-foreground">{rupees(p.valuePaise)}</span>
        </li>
      ))}
    </ul>
  )
}

// ─── service card ──────────────────────────────────────────────────────────────
function ServiceCard({ svc, detail, closed, canSubmit, onRefund, onCarry }: {
  svc: EventServiceView; detail: WalletEventDetail; closed: boolean; canSubmit: boolean
  onRefund: () => void; onCarry: () => void
}) {
  const s = svc.state
  const Icon = ICON[s.service]
  const unit = SERVICE_UNIT[s.service]
  const photos = detail.event.photos
  // Usable total: what was bought here plus what was carried in (capacity: the event's capacity).
  const total = s.service === 'registrations' ? (s.facts.capacity ?? null) : s.purchased + s.carriedIn
  const used = s.used
  const donation = detail.event.registrations.state === 'not_applicable' && detail.event.registrations.reason === 'donation_campaign'
  // RD-INTEG — once the event's dates have passed, more REGISTRATIONS cannot be used; extra
  // certificate/photo/WhatsApp units still can (they are sent and uploaded after the event).
  const ended = detail.event.phase === 'completed'
  // RD-PHOTO-01 — photo capacity is capped at 3,000 per event: no "Increase limit" once reached.
  const photoMaxed = s.service === 'media' && photos.state === 'limited' && photos.maxAdditional <= 0
  const canIncrease = !closed && !donation && !photoMaxed && !(ended && s.service === 'registrations')
  const refundable = svc.refund.eligible ? svc.refund : null
  return (
    <Card variant="elevated" padded={false} className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.08]"><Icon className="size-4 text-primary" aria-hidden /></span>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold text-foreground">{SERVICE_LABEL[s.service]}</h3>
            <p className="text-[12px] text-muted-foreground">
              {s.applicable || s.service === 'registrations'
                ? (used === null || total === null ? 'Usage not measurable' : `${qty(used)} of ${qty(total)} ${unit} used`)
                : 'Not purchased'}
            </p>
          </div>
        </div>
        {canIncrease
          ? <Link href={increaseLimitHref(detail.event.draftId, s.service)}
              className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 text-[12.5px] font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Increase limit<ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          : <span className="shrink-0 text-[11.5px] text-muted-foreground">{closed ? 'Event closed' : photoMaxed ? 'Maximum photo capacity reached' : ended && s.service === 'registrations' ? 'Event ended' : ''}</span>}
      </div>

      {used !== null && total !== null && total > 0 && (
        <ProgressBar value={Math.min(used, total)} max={total} tone={used >= total ? 'warning' : 'primary'} label={`${SERVICE_LABEL[s.service]} used`} />
      )}

      {(s.applicable || s.service === 'registrations') && !s.notApplicableReason ? (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 border-t border-border pt-3">
          <Figure label={s.service === 'registrations' ? 'Paid capacity' : 'Purchased'} value={qty(s.purchased)} />
          <Figure label="Used" value={used === null ? '—' : qty(used)} />
          <Figure label="Remaining" value={s.remaining === null ? '—' : qty(s.remaining)} />
          {s.service !== 'registrations' && <Figure label="Carried in" value={qty(s.carriedIn)} muted={s.carriedIn === 0} />}
          {s.service !== 'registrations' && <Figure label="Carried out" value={qty(s.carriedOut)} muted={s.carriedOut === 0} />}
          <Figure label="Refunded" value={qty(s.refunded)} muted={s.refunded === 0} />
          <Figure label="Paid" value={rupees(s.paidPaise)} />
          {/* Paid capacity removed by a charged capacity reduction (not a refund) — so the paid figures add up. */}
          {s.service === 'registrations' && (s.facts.reducedCapacity ?? 0) > 0 && <Figure label="Reduced" value={qty(s.facts.reducedCapacity ?? 0)} />}
          {s.service === 'registrations' && <Figure label="Free allowance" value={s.facts.freeCapacity === null || s.facts.freeCapacity === undefined ? '—' : qty(s.facts.freeCapacity)} muted />}
          {s.service === 'media' && <Figure label="Refundable" value={qty(s.ownUnused)} muted={s.ownUnused === 0} />}
        </dl>
      ) : (
        <p className="border-t border-border pt-3 text-[12.5px] text-muted-foreground">{s.notApplicableReason ?? 'Nothing was bought for this service on this event.'}</p>
      )}

      {/* Refund / carry-forward */}
      {closed && s.applicable && (
        <div className="rounded-lg bg-muted/40 p-3">
          {refundable ? (
            <>
              <p className="flex items-center gap-1 text-[12.5px] text-foreground">
                <span><span className="font-semibold">{qty(refundable.quantity)}</span> unused {unit} · up to <span className="font-semibold">{rupees(refundable.upperBoundPaise ?? 0)}</span></span>
                <InfoTip label="How the refund is calculated" align="end">
                  Only unused units of this event&apos;s own purchase. Each is valued at the price you actually paid for it (incl. GST);
                  units used first come from your earliest purchase. A Super Admin reviews and approves the amount.
                </InfoTip>
              </p>
              <Valuation parts={refundable.valuation ?? []} />
            </>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Refund: {svc.refund.eligible ? '' : svc.refund.reason}</p>
          )}
          {canSubmit && (refundable || svc.carryForward.eligible) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {refundable && <Button size="sm" variant="outline" onClick={onRefund}><RotateCcw className="size-3.5" aria-hidden />Request refund</Button>}
              {svc.carryForward.eligible && CARRYABLE_SERVICES.includes(s.service) && (
                <Button size="sm" variant="outline" onClick={onCarry}><Forward className="size-3.5" aria-hidden />Carry forward</Button>
              )}
            </div>
          )}
        </div>
      )}
      {/* On a closed event the refund box above already states the reason. */}
      {s.problem && !(closed && s.applicable) && <p className="flex items-start gap-1.5 text-[12px] text-amber-700"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{s.problem.reason}</p>}
    </Card>
  )
}

// ─── dialogs ───────────────────────────────────────────────────────────────────
function RefundDialog({ view, services, onClose, onDone }: {
  view: View; services: EventServiceView[]; onClose: () => void; onDone: () => void
}) {
  const { showToast } = useToast()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const all = services.length > 1
  const total = services.reduce((n, s) => n + (s.refund.eligible ? s.refund.upperBoundPaise ?? 0 : 0), 0)
  const submit = async () => {
    setBusy(true)
    const r = await call('/api/organizer/wallet/service-requests', {
      kind: 'refund', draftId: view.draftId, ...(all ? { services: 'all' } : { service: services[0].state.service }), note,
    })
    setBusy(false)
    if (r.ok) { showToast(all ? 'Refund requests submitted for review.' : 'Refund request submitted for review.', 'success'); onDone() }
    else showToast(typeof r.body.error === 'string' ? r.body.error : `Request failed (${r.status})`, 'error')
  }
  return (
    <Dialog open onClose={onClose} size="md" title={all ? 'Refund all unused services' : `Refund unused ${SERVICE_LABEL[services[0].state.service].toLowerCase()}`}>
      <div className="-mr-2 max-h-[calc(100dvh-10rem)] space-y-4 overflow-y-auto pr-2 text-[13px]">
        <ul className="divide-y divide-border rounded-xl border border-border">
          {services.map(s => s.refund.eligible && (
            <li key={s.state.service} className="px-3 py-2.5">
              <div className="flex justify-between gap-3">
                <span className="font-medium text-foreground">{SERVICE_LABEL[s.state.service]}</span>
                <span className="tabular-nums text-foreground">{qty(s.refund.quantity)} unused · up to <strong>{rupees(s.refund.upperBoundPaise ?? 0)}</strong></span>
              </div>
              <Valuation parts={s.refund.valuation ?? []} />
            </li>
          ))}
        </ul>
        {all && <p className="text-right text-[13px]">Estimated total: <strong>{rupees(total)}</strong></p>}
        <p className="text-[12.5px] text-muted-foreground">
          The quantities and amounts are calculated by RegisterDesk from your paid orders. A Super Admin reviews the request and approves the
          amount; the refund is then paid to you outside RegisterDesk and shows here as Refunded with its reference. Approved units can no longer be used.
        </p>
        <label className="block space-y-1">
          <span className="text-[12.5px] text-muted-foreground">Note for the reviewer (optional)</span>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={500}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}Submit request</Button>
        </div>
      </div>
    </Dialog>
  )
}

function CarryDialog({ view, svc, onClose, onDone }: { view: View; svc: EventServiceView; onClose: () => void; onDone: () => void }) {
  const { showToast } = useToast()
  const [dest, setDest] = useState(view.destinations[0]?.draftId ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const q = svc.carryForward.eligible ? svc.carryForward.quantity : 0
  const submit = async () => {
    setBusy(true)
    const r = await call('/api/organizer/wallet/service-requests', { kind: 'carry_forward', draftId: view.draftId, service: svc.state.service, destinationDraftId: dest, note })
    setBusy(false)
    if (r.ok) { showToast('Carry-forward request submitted for review.', 'success'); onDone() }
    else showToast(typeof r.body.error === 'string' ? r.body.error : `Request failed (${r.status})`, 'error')
  }
  return (
    <Dialog open onClose={onClose} size="md" title={`Carry forward ${SERVICE_LABEL[svc.state.service].toLowerCase()}`}>
      <div className="space-y-4 text-[13px]">
        <p className="text-foreground"><strong>{qty(q)}</strong> unused {SERVICE_UNIT[svc.state.service]} move to another of your events once a Super Admin approves. No money changes hands.</p>
        {view.destinations.length === 0 ? (
          <p className="text-muted-foreground">None of your events can receive units right now (it must be open and not a donation campaign).</p>
        ) : (
          <label className="block space-y-1">
            <span className="text-[12.5px] text-muted-foreground">Move to</span>
            <select value={dest} onChange={e => setDest(e.target.value)} className="h-10 w-full rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground">
              {view.destinations.map(d => <option key={d.draftId} value={d.draftId}>{d.name}</option>)}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-[12.5px] text-muted-foreground">Note for the reviewer (optional)</span>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || !dest} onClick={() => void submit()}>{busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}Submit request</Button>
        </div>
      </div>
    </Dialog>
  )
}

function RequestRow({ r }: { r: ServiceRequestView }) {
  const decided = [...r.history].reverse().find(h => h.role === 'super_admin')
  return (
    <li className="space-y-1 px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {REQUEST_KIND_LABEL[r.kind]} · {qty(r.quantity)} {SERVICE_UNIT[r.service]}
          {r.destination && <span className="font-normal text-muted-foreground"> → {r.destination.name}</span>}
        </span>
        <StatusChip tone={REQUEST_STATUS_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusChip>
      </div>
      <p className="text-[12px] text-muted-foreground">
        {SERVICE_LABEL[r.service]} · submitted {fmtDate(r.createdAt)}
        {r.kind === 'refund' && r.refundUpperBoundPaise !== null && <> · up to {rupees(r.refundUpperBoundPaise)}</>}
        {r.approvedAmountPaise !== null && <> · approved {rupees(r.approvedAmountPaise)}</>}
        {r.status === 'processed' && r.refundedAmountPaise !== null && <> · refunded {rupees(r.refundedAmountPaise)}</>}
        {r.externalReference && <> · reference <span className="font-mono">{r.externalReference}</span></>}
      </p>
      {r.kind === 'refund' && r.status === 'approved' && <p className="text-[12px] text-muted-foreground">Approved — not refunded yet. It shows as Refunded once it is paid.</p>}
      {decided && decided.note && <p className="text-[12px] text-muted-foreground">Decision: {decided.note}</p>}
      {r.kind === 'refund' && r.window && <p className="text-[12px] text-muted-foreground">Requested {fmtDateTime(r.window.submittedAt)} · {r.window.submittedWithinWindow ? `within the 24-hour window (closed ${fmtDateTime(r.window.deadlineAt)})` : 'outside the refund window'}</p>}
    </li>
  )
}

// ─── page ──────────────────────────────────────────────────────────────────────
export function EventWalletClient() {
  const { selectedEventId, selectedEvent, isAllEvents, loading: eventsLoading } = useEventContext()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ eventId: string; message: string } | null>(null)
  const [refundOf, setRefundOf] = useState<EventServiceView[] | null>(null)
  const [carryOf, setCarryOf] = useState<EventServiceView | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async (eventId: string) => {
    const [d, v] = await Promise.all([
      call(`/api/organizer/wallet/events/${encodeURIComponent(eventId)}`),
      call(`/api/organizer/wallet/service-requests?event=${encodeURIComponent(eventId)}`),
    ])
    if (d.ok && v.ok) { setData({ eventId, detail: d.body as unknown as WalletEventDetail, view: v.body as unknown as View }); setError(null) }
    else setError({ eventId, message: (typeof d.body.error === 'string' && d.body.error) || (typeof v.body.error === 'string' && v.body.error) || 'Could not load this event’s Wallet.' })
  }, [])
  useEffect(() => {
    if (!selectedEventId || isAllEvents) return
    const t = setTimeout(() => { void load(selectedEventId) }, 0)
    return () => clearTimeout(t)
  }, [selectedEventId, isAllEvents, load, reloadKey])

  // Only the SELECTED event's data is ever shown (a late response for another event is ignored).
  const current = data && data.eventId === selectedEventId ? data : null
  const currentError = error && error.eventId === selectedEventId ? error.message : null
  const services = useMemo(() => current?.view.services ?? [], [current])
  const eligibleRefunds = useMemo(() => services.filter(s => s.refund.eligible), [services])
  // Whether the window has closed is the SERVER's verdict at read time, never the browser clock.
  const windowClosed = current?.view.refundWindowOpen === false
  const refundableTotal = eligibleRefunds.reduce((n, s) => n + (s.refund.eligible ? s.refund.upperBoundPaise ?? 0 : 0), 0)
  const openRequests = current?.view.requests.filter(r => r.status === 'submitted').length ?? 0
  const done = () => { setRefundOf(null); setCarryOf(null); setReloadKey(k => k + 1) }

  const header = (
    <PageHeader
      title="Event Wallet"
      subtitle={selectedEvent && !isAllEvents ? `Purchases, usage and refunds for ${selectedEvent.name}.` : 'Purchases, usage and refunds — one event at a time.'}
      action={current?.view.canSubmit && eligibleRefunds.length > 0
        ? <Button variant="gradient" size="md" onClick={() => setRefundOf(eligibleRefunds)}><RotateCcw className="size-4" aria-hidden />Refund all unused</Button>
        : undefined}
    />
  )

  if (eventsLoading) return <div className="space-y-5">{header}<div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div></div>
  if (!selectedEventId || isAllEvents) {
    return (
      <div className="space-y-5">
        {header}
        <Card className="p-2"><EmptyState icon={CalendarDays} title="Select an event" description="Choose an event in the header to see what it bought, used and paid, and what can be refunded." /></Card>
        <OtherBalances />
      </div>
    )
  }

  const ev = current?.detail.event
  return (
    <div className="space-y-5">
      {header}
      {currentError ? (
        <p className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive"><AlertCircle className="size-4 shrink-0" />{currentError}</p>
      ) : !current || !ev ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl border border-border bg-muted/30" />)}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <StatusChip tone={PHASE_TONE[ev.phase]}>{PHASE_LABEL[ev.phase]}</StatusChip>
            <span>{dates(ev.startDate, ev.endDate)}</span>
          </div>

          <section aria-label="Summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Tile icon={Receipt} label="Paid for this event" value={measuredText(ev.paidPaise, rupees)} hint={`${current.detail.payments.filter(p => p.status === 'paid').length} verified payment(s)`} />
            <Tile icon={RotateCcw} label="Refundable now" value={rupees(refundableTotal)}
              hint={current.view.closed ? `${eligibleRefunds.length} service(s) eligible` : 'After the event closes'}
              info="Only unused units of this event’s own purchases, valued at what you paid for them (incl. GST). A Super Admin reviews every refund." />
            <Tile icon={Sparkles} label="Requests" value={String(openRequests)} hint={openRequests === 1 ? 'awaiting review' : 'awaiting review'} />
            <Tile icon={CalendarDays} label="Refund window"
              value={current.view.refundDeadline ? fmtDate(current.view.refundDeadline) : current.view.closed ? 'Not recorded' : 'Not open'}
              hint={current.view.refundDeadline ? (windowClosed ? `Closed at ${fmtTime(current.view.refundDeadline)}` : `Requests close at ${fmtTime(current.view.refundDeadline)}`) : current.view.closed ? 'Super Admin review needed' : 'Opens when the event is completed, cancelled or archived'}
              info="Refund requests are available for 24 hours after the event is completed, cancelled, or archived." />
          </section>

          <section aria-label="Services" className="grid gap-4 lg:grid-cols-2">
            {services.map(s => (
              <ServiceCard key={s.state.service} svc={s} detail={current.detail} closed={current.view.closed} canSubmit={current.view.canSubmit}
                onRefund={() => setRefundOf([s])} onCarry={() => setCarryOf(s)} />
            ))}
          </section>
          {!current.view.canSubmit && current.view.closed && <p className="text-[12.5px] text-muted-foreground">Only the account owner can submit refund or carry-forward requests.</p>}

          <section className="grid gap-4 lg:grid-cols-2">
            <Card variant="elevated" padded={false} className="min-w-0 p-4 sm:p-5">
              <h2 className="mb-3 text-[14px] font-semibold text-foreground">Paid by service</h2>
              <PaidBars services={services} />
            </Card>
            <Card variant="elevated" padded={false} className="min-w-0 p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-[14px] font-semibold text-foreground">Payments</h2>
                {current.detail.links.licenceCenter && <Link href={current.detail.links.licenceCenter} className="text-[12.5px] font-semibold text-primary hover:underline">License Center</Link>}
              </div>
              {current.detail.payments.length === 0 ? <p className="text-[13px] text-muted-foreground">No verified payments for this event.</p> : (
                <ul className="divide-y divide-border">
                  {current.detail.payments.map(p => (
                    <li key={p.orderId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2 text-[13px]">
                      <span className="min-w-0"><span className="font-medium text-foreground">{p.purpose}</span> <span className="block font-mono text-[11px] text-muted-foreground">{p.orderId}</span></span>
                      <span className="flex items-center gap-2">
                        <span className="text-[12px] text-muted-foreground">{fmtDate(p.paidAt)}</span>
                        {p.status === 'refunded' && <StatusChip tone="warning">Refunded</StatusChip>}
                        <span className="font-semibold tabular-nums text-foreground">{rupees(p.amountPaise)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <Card variant="elevated" padded={false} className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1 text-[14px] font-semibold text-foreground">
                Pay-as-you-go for this event
                <InfoTip label="About pay-as-you-go charges">Messages beyond a prepaid allowance are charged to your communication balance, only for messages WhatsApp accepts; anything charged for a broadcast recipient WhatsApp did not accept is returned when the broadcast ends. Only entries that record this event are counted.</InfoTip>
              </h2>
              <Link href={`/dashboard/wallet/transactions?event=${encodeURIComponent(ev.draftId)}`} className="text-[12.5px] font-semibold text-primary hover:underline">View charges</Link>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Broadcast emails" value={measuredText(current.detail.communication.emailMessages, qty, 'None')} />
              <Figure label="WhatsApp accepted" value={measuredText(current.detail.communication.whatsappMessages, qty, 'None')} />
              <Figure label="Net charged to balance" value={measuredText(current.detail.communication.walletChargesPaise, rupees)} />
              <Figure label="Charge entries" value={measuredText(current.detail.communication.walletChargeCount, qty)} />
            </dl>
          </Card>

          <Card variant="elevated" padded={false} className="overflow-hidden">
            <h2 className="border-b border-border px-4 py-3 text-[14px] font-semibold text-foreground">Refund and carry-forward requests</h2>
            {current.view.requests.length === 0
              ? <p className="px-4 py-4 text-[13px] text-muted-foreground">No requests for this event.</p>
              : <ul className="divide-y divide-border">{current.view.requests.map(r => <RequestRow key={r.id} r={r} />)}</ul>}
          </Card>

          <OtherBalances />
          <p className="text-[12px] text-muted-foreground">{SMS_NOTE}</p>
        </>
      )}

      {refundOf && current && <RefundDialog view={current.view} services={refundOf} onClose={() => setRefundOf(null)} onDone={done} />}
      {carryOf && current && <CarryDialog view={current.view} svc={carryOf} onClose={() => setCarryOf(null)} onDone={done} />}
    </div>
  )
}

/** A compact horizontal bar per service: paid amount, scaled to the largest. */
function PaidBars({ services }: { services: EventServiceView[] }) {
  const rows = services.filter(s => s.state.paidPaise > 0)
  if (rows.length === 0) return <p className="text-[13px] text-muted-foreground">Nothing paid for services on this event.</p>
  const max = Math.max(...rows.map(s => s.state.paidPaise))
  return (
    <ul className="space-y-2.5">
      {rows.map(s => (
        <li key={s.state.service} className="text-[12.5px]">
          <div className="mb-1 flex justify-between gap-2"><span className="text-foreground">{SERVICE_LABEL[s.state.service]}</span><span className="font-semibold tabular-nums text-foreground">{rupees(s.state.paidPaise)}</span></div>
          <div className="h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(4, Math.round((s.state.paidPaise / max) * 100))}%` }} /></div>
        </li>
      ))}
    </ul>
  )
}

/** The balance that is NOT this event's: kept visibly separate, never added to it. */
function OtherBalances() {
  // RD-PHOTO-01 — no organizer-wide photo-credit card any more: photos are this event's paid
  // photo capacity (the Photos card above), bought on License & Services. Media Credits are retired.
  return (
    <section aria-label="Other balances" className="grid gap-3 sm:grid-cols-2">
      <Link href={COMMUNICATION_BALANCE_HREF} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 hover:bg-muted/40">
        <WalletIcon className="size-5 text-primary" aria-hidden />
        <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-semibold text-foreground">Communication balance</span><span className="block text-[12px] text-muted-foreground">Pay-as-you-go messages and broadcasts — managed in Communications.</span></span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>
    </section>
  )
}
