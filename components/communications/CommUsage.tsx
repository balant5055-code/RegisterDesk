'use client'

// Communication Center › Usage (RD-COMMS-P1). READ-ONLY.
//
// One event at a time — the event chosen in the dashboard header's event selector
// (EventContextProvider), the same selector every event-scoped page uses. Every figure is the
// server's (GET /api/organizer/communications/usage, ownership- and event-scope-checked); nothing
// here computes or moves money. More capacity is bought in ONE place: the event's License &
// Services step (the CTA below opens it). There is no top-up, no Add Funds and no wallet here.
//
// Stale-response guard: a response is shown only while it still matches the selected event, so a
// slow answer for the previous event can never be displayed under the current one.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Award, CalendarDays, Loader2, Mail, MessageSquare } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { Card, EmptyState } from '@/components/ui'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils/cn'
import { LICENSE_SERVICES_CTA } from '@/lib/communications/capacity'
import type { EventCommunicationUsage, ServiceUsage } from '@/lib/communications/usage'
import { CAPACITY_PRIMARY, capacityBreakdown } from '@/lib/communications/capacityFigures'
import {
  USAGE_FIGURE_LABELS, USAGE_FIGURE_ORDER, USAGE_FIGURE_HELP, USAGE_FUNDED_LABELS,
  EMAIL_INCLUDED_NOTE, LEGACY_BALANCE_NOTE,
} from '@/lib/communications/usageLabels'

const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'))
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—')

type State =
  | { kind: 'idle' }
  | { kind: 'error'; eventId: string; message: string }
  | { kind: 'ready'; eventId: string; data: EventCommunicationUsage }

function Figure({ label, value, help, emphasis }: { label: string; value: string; help: string; emphasis?: boolean }) {
  return (
    <div className="min-w-0" title={help}>
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', emphasis ? 'text-[20px] font-bold text-foreground' : 'text-[14px] font-semibold text-foreground')}>{value}</dd>
    </div>
  )
}

function ServiceCard({ icon: Icon, title, unit, usage }: { icon: React.ElementType; title: string; unit: string; usage: ServiceUsage }) {
  const empty = usage.purchased + usage.carriedIn === 0
  return (
    <Card variant="elevated" padded={false} className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/[0.08] text-primary"><Icon className="size-4" aria-hidden /></span>
          {title}
        </p>
        <Link href={usage.manageHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-auto min-h-8 gap-1 whitespace-normal text-left')}>
          {LICENSE_SERVICES_CTA}<ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      {empty ? (
        <p className="text-[13px] text-muted-foreground">
          No {unit} capacity purchased for this event — nothing is sent or issued without it.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* RD-COMMS-L2 — the same three, and the same breakdown, as License & Services. */}
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            {CAPACITY_PRIMARY.map(k => (
              <Figure key={k} label={USAGE_FIGURE_LABELS[k]} value={n(usage[k])} help={USAGE_FIGURE_HELP[k]} emphasis={k === 'available'} />
            ))}
          </dl>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 sm:grid-cols-3">
            {capacityBreakdown(usage).map(({ key, value }) => (
              <Figure key={key} label={USAGE_FIGURE_LABELS[key]} value={n(value)} help={USAGE_FIGURE_HELP[key]} />
            ))}
          </dl>
        </div>
      )}
    </Card>
  )
}

export function CommUsage() {
  const { selectedEventId, selectedEvent, isAllEvents, loading: eventsLoading } = useEventContext()
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (!selectedEventId) return
    let alive = true
    const eventId = selectedEventId
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        const res = await fetch(`/api/organizer/communications/usage?eventId=${encodeURIComponent(eventId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store',
        })
        const body = await res.json().catch(() => ({})) as EventCommunicationUsage & { error?: string }
        if (!alive) return
        if (!res.ok) { setState({ kind: 'error', eventId, message: body.error ?? 'Could not load usage.' }); return }
        setState({ kind: 'ready', eventId, data: body })
      } catch {
        if (alive) setState({ kind: 'error', eventId, message: 'Network error — please try again.' })
      }
    })()
    return () => { alive = false }
  }, [selectedEventId])

  if (eventsLoading) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading" /></div>
  if (!selectedEventId) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={isAllEvents ? 'Choose an event to see its usage' : 'No event selected'}
        description="Communication capacity is bought and used per event. Pick an event in the event selector at the top of the page."
      />
    )
  }
  // Only ever render data for the event that is selected NOW — anything else is "still loading".
  const current = state.kind !== 'idle' && state.eventId === selectedEventId ? state : null
  if (!current) {
    return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading usage" /></div>
  }
  if (current.kind === 'error') return <p role="alert" className="text-[13px] text-destructive">{current.message}</p>

  const u = current.data
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Usage for</p>
          <h2 className="truncate text-[17px] font-bold text-foreground">{selectedEvent?.name ?? u.event.name}</h2>
        </div>
        <p className="text-[12.5px] text-muted-foreground">Capacity is purchased per event in License &amp; Services.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ServiceCard icon={MessageSquare} title="WhatsApp" unit="WhatsApp" usage={u.whatsapp} />
        <ServiceCard icon={Award} title="Certificates" unit="certificate" usage={u.certificates} />
      </div>

      {/* RD-COMMS-P2-F — what each figure means, in the organizer's words (usageLabels.ts). */}
      <details className="rounded-xl border border-border bg-card px-4 py-3 text-[12.5px]">
        <summary className="cursor-pointer font-semibold text-foreground">What these figures mean</summary>
        <dl className="mt-2 space-y-1.5">
          {USAGE_FIGURE_ORDER.map(k => (
            <div key={k}><dt className="inline font-semibold text-foreground">{USAGE_FIGURE_LABELS[k]}: </dt><dd className="inline text-muted-foreground">{USAGE_FIGURE_HELP[k]}</dd></div>
          ))}
        </dl>
      </details>

      <Card variant="elevated" padded={false} className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/[0.08] text-primary"><Mail className="size-4" aria-hidden /></span>
            Email
          </p>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700">Included</span>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {EMAIL_INCLUDED_NOTE}
          {u.email.sent !== null && <> {n(u.email.sent)} broadcast email{u.email.sent === 1 ? '' : 's'} sent for this event.</>}
        </p>
      </Card>

      {u.legacyBalancePaise !== null && u.legacyBalancePaise > 0 && (
        <Card variant="elevated" padded={false} className="p-4">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-foreground">
            Legacy communication balance · {rupees(u.legacyBalancePaise)}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Legacy · read-only</span>
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{LEGACY_BALANCE_NOTE}</p>
        </Card>
      )}

      <Card variant="elevated" padded={false} className="overflow-hidden">
        <p className="border-b border-border px-4 py-3 text-[14px] font-semibold text-foreground">Broadcast history</p>
        {u.broadcasts.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">No broadcasts for this event yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">Sent</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Channel</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Recipients</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Funded by</th>
                </tr>
              </thead>
              <tbody>
                {u.broadcasts.map(b => (
                  <tr key={b.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2 text-muted-foreground">{fmt(b.createdAt)}</td>
                    <td className="px-4 py-2 capitalize text-foreground">{b.channel === 'whatsapp' ? 'WhatsApp' : b.channel}</td>
                    <td className="px-4 py-2 capitalize text-foreground">{b.status.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground">{n(b.recipients)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{USAGE_FUNDED_LABELS[b.fundedBy]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {u.broadcastsTruncated && <p className="border-t border-border px-4 py-2 text-[12px] text-muted-foreground">Showing the most recent broadcasts only.</p>}
      </Card>
    </div>
  )
}
