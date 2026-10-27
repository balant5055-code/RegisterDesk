'use client'

// RD-COMMS-OVERVIEW-02 · Communication Center › Overview, reorganized into sections:
//   scope · activity · delivery performance · today & acceptance rate · attention required.
//
// Same data as before — the wallet overview (workspace-wide message counts), the broadcast list and
// the reminder analytics — arranged and labelled by lib/communications/overviewModel, which only
// presents those figures. Each source loads independently, so one unavailable source (e.g. a team
// member without the `wallet` permission) leaves the other sections usable and says so, instead of
// failing the whole page or showing zeros.

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import Link from 'next/link'
import {
  Mail, MessageSquare, Phone, Megaphone, Bell, CheckCircle2, XCircle, Clock, Send, CalendarClock,
  Gauge, Info, Loader2, AlertTriangle, Globe2, ShieldCheck,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { buildOverviewModel, type OverviewFigure, type OverviewInputs, type OverviewModel } from '@/lib/communications/overviewModel'
import type { WalletOverview } from '@/lib/wallet/types'

const nf = (n: number) => n.toLocaleString('en-IN')
const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`
const card = 'rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgb(15_23_42_/_0.04)]'

type Settled<T> = { ok: true; value: T } | { ok: false; error: string }
async function getJSON<T>(url: string): Promise<Settled<T>> {
  try {
    const token = await auth.currentUser?.getIdToken()
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
    const body = await res.json().catch(() => ({})) as T & { error?: string }
    return res.ok ? { ok: true, value: body } : { ok: false, error: body.error ?? `Request failed (${res.status})` }
  } catch {
    return { ok: false, error: 'Network error' }
  }
}

type Load = { kind: 'loading' } | { kind: 'ready'; inputs: OverviewInputs }

export function CommunicationOverview() {
  const { selectedEvent, isAllEvents } = useEventContext()
  const [state, setState] = useState<Load>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    Promise.all([
      getJSON<{ overview: WalletOverview }>('/api/organizer/wallet/overview'),
      getJSON<{ campaigns: unknown[] }>('/api/organizer/broadcasts'),
      getJSON<{ analytics: { scheduled: number }; reminders?: unknown[] }>('/api/organizer/reminders'),
    ]).then(([w, b, r]) => {
      if (!alive) return
      setState({
        kind: 'ready',
        inputs: {
          wallet: w.ok ? w.value.overview : null,
          walletError: w.ok ? null : w.error,
          broadcasts: b.ok ? { count: (b.value.campaigns ?? []).length } : null,
          reminders: r.ok ? { scheduled: r.value.analytics?.scheduled ?? 0, listed: (r.value.reminders ?? []).length } : null,
          smsAvailable: isChannelImplemented('sms'),
        },
      })
    })
    return () => { alive = false }
  }, [])

  const model = useMemo(() => (state.kind === 'ready' ? buildOverviewModel(state.inputs) : null), [state])
  const eventScoped = !isAllEvents && !!selectedEvent

  return (
    <div className="space-y-5">
      {/* Scope — the Overview has always covered the whole workspace; say so plainly. */}
      <div className={cn(card, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3')}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#4f46e5_0%,#7c3aed_100%)] px-2.5 py-1 text-[11.5px] font-semibold text-white">
          <Globe2 className="size-3.5" aria-hidden /> All events
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
          Workspace-wide activity across every event.
          {eventScoped && <> The event selector does not filter this page — for <span className="font-medium text-foreground">{selectedEvent.name}</span> only, open <Link href="/dashboard/communications?tab=analytics" prefetch={false} className="font-semibold text-primary hover:underline">Analytics</Link> or <Link href="/dashboard/communications?tab=usage" prefetch={false} className="font-semibold text-primary hover:underline">Usage</Link>.</>}
        </p>
      </div>

      {!model ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading overview…</div>
      ) : (
        <OverviewSections model={model} walletError={state.kind === 'ready' ? state.inputs.walletError ?? null : null} />
      )}
    </div>
  )
}

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  emails: Mail, whatsapp: MessageSquare, sms: Phone, broadcasts: Megaphone, reminders: Bell,
  sent: Send, delivered: CheckCircle2, failed: XCircle, pending: Clock, today: CalendarClock,
}
const TONE: Record<string, { icon: string; bar: string }> = {
  emails:     { icon: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300', bar: '' },
  whatsapp:   { icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', bar: '' },
  sms:        { icon: 'bg-sky-500/10 text-sky-600 dark:text-sky-300', bar: '' },
  broadcasts: { icon: 'bg-violet-500/10 text-violet-600 dark:text-violet-300', bar: '' },
  reminders:  { icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-300', bar: '' },
  sent:       { icon: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300', bar: 'bg-indigo-500' },
  delivered:  { icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', bar: 'bg-emerald-500' },
  failed:     { icon: 'bg-rose-500/10 text-rose-600 dark:text-rose-300', bar: 'bg-rose-500' },
  pending:    { icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-300', bar: 'bg-amber-500' },
  today:      { icon: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300', bar: '' },
}

/** Exported for tests (rendered with a fixed model). */
export function OverviewSections({ model, walletError }: { model: OverviewModel; walletError: string | null }) {
  return (
    <>
      <Section title="Activity overview" description="What your workspace has sent — monthly totals and current counts.">
        <div className={cn('grid grid-cols-2 gap-3', model.activity.length > 4 ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
          {model.activity.map(f => <FigureCard key={f.key} figure={f} unavailableNote={f.value === null ? (f.key === 'emails' || f.key === 'whatsapp' || f.key === 'sms' ? walletError : null) : null} />)}
        </div>
        {model.legacySpendPaise !== null && (
          <p className="mt-2 text-[12px] text-muted-foreground">Legacy balance spend this month: <span className="font-semibold text-foreground">{rupees(model.legacySpendPaise)}</span></p>
        )}
      </Section>

      <Section title="Delivery performance" description="Every message ever recorded, by its current status.">
          <div className={cn(card, 'flex flex-col gap-3 p-3 sm:p-4')}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {model.delivery.map(f => <OutcomeTile key={f.key} figure={f} />)}
            </div>
            <p className="mt-auto flex items-start gap-1.5 border-t border-border pt-3 text-[12px] leading-snug text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                “Sent / submitted” means the provider accepted the message and <span className="font-medium text-foreground">includes</span> the ones later confirmed as delivered — accepted is not proof of delivery.
                {model.unknownCount !== null && model.unknownCount > 0 && <> {nf(model.unknownCount)} message{model.unknownCount === 1 ? ' has' : 's have'} an unknown outcome and {model.unknownCount === 1 ? 'is' : 'are'} not counted as failed.</>}
                {model.deliveryUnavailable && <> Figures shown as “—” could not be loaded{walletError ? ` (${walletError})` : ''}.</>}
              </span>
            </p>
          </div>
        </Section>

        <Section title="Today & acceptance rate" description="Today’s volume and how often providers accepted your messages.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FigureCard figure={model.today} />
            <AcceptanceCard model={model} />
          </div>
        </Section>

      <Section title="Attention required" description="Issues worth a look. Nothing here retries or re-sends anything.">
        {model.attention.length === 0 ? (
          <p className={cn(card, 'flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground')}>
            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            {model.deliveryUnavailable ? 'Message figures are unavailable, so attention items cannot be checked right now.' : 'Nothing needs attention right now.'}
          </p>
        ) : (
          <ul className={cn(card, 'divide-y divide-border')}>
            {model.attention.map(a => (
              <li key={a.key} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span className={cn('mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
                  a.tone === 'action' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-muted text-muted-foreground')}>
                  {a.tone === 'action' ? <><AlertTriangle className="size-3" aria-hidden />Review</> : 'Note'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground">{a.title}</p>
                  <p className="text-[12px] text-muted-foreground">{a.detail}</p>
                </div>
                <Link href={a.href} prefetch={false} className="shrink-0 rounded-md text-[12.5px] font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{a.cta} →</Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = `ov-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <div>
        <h2 id={id} className="text-[14.5px] font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-[12.5px] text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

function Value({ figure }: { figure: OverviewFigure }) {
  if (figure.value === null) return <span className="text-muted-foreground" title="Could not be loaded">—</span>
  return <>{nf(figure.value)}{figure.atLeast && <span className="text-[0.7em] font-semibold text-muted-foreground">+</span>}</>
}

function FigureCard({ figure, unavailableNote }: { figure: OverviewFigure; unavailableNote?: string | null }) {
  const Icon = ICONS[figure.key] ?? Gauge
  return (
    <div className={cn(card, 'flex min-h-[104px] flex-col p-3.5')} title={figure.help}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium leading-tight text-muted-foreground">{figure.label}</p>
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', TONE[figure.key]?.icon ?? 'bg-muted text-muted-foreground')} aria-hidden><Icon className="size-3.5" /></span>
      </div>
      <p className="mt-1 text-[22px] font-bold leading-tight tracking-tight tabular-nums text-foreground"><Value figure={figure} /></p>
      <p className="mt-auto pt-1 text-[11px] text-muted-foreground">
        {figure.atLeast ? `${figure.period} · at least` : figure.period}
        {unavailableNote ? ` · ${unavailableNote}` : ''}
      </p>
      <span className="sr-only">{figure.help}</span>
    </div>
  )
}

function OutcomeTile({ figure }: { figure: OverviewFigure }) {
  const Icon = ICONS[figure.key] ?? Gauge
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-background p-3 pl-3.5" title={figure.help}>
      <span className={cn('absolute inset-y-0 left-0 w-1', TONE[figure.key]?.bar)} aria-hidden />
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground"><Icon className="size-3.5" aria-hidden />{figure.label}</p>
      <p className="mt-1 text-[20px] font-bold tabular-nums text-foreground"><Value figure={figure} /></p>
      <p className="text-[11px] text-muted-foreground">{figure.period}</p>
      <span className="sr-only">{figure.help}</span>
    </div>
  )
}

function AcceptanceCard({ model }: { model: OverviewModel }) {
  const a = model.acceptance
  return (
    <div className={cn(card, 'flex min-h-[104px] flex-col p-3.5')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium leading-tight text-muted-foreground">Provider acceptance rate</p>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" aria-hidden><Gauge className="size-3.5" /></span>
      </div>
      <p className="mt-1 text-[22px] font-bold leading-tight tracking-tight tabular-nums text-foreground">{a.rate === null ? <span className="text-muted-foreground">—</span> : `${a.rate}%`}</p>
      {a.rate !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${a.rate}% accepted`}>
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${a.rate}%` }} />
        </div>
      )}
      <p className="mt-auto pt-1.5 text-[11px] leading-snug text-muted-foreground">
        {a.reason ?? <>Accepted ÷ (accepted + failed){a.accepted !== null && a.failed !== null ? ` = ${nf(a.accepted)} ÷ ${nf(a.accepted + a.failed)}` : ''} · all time. Not confirmed delivery; unknown and pending excluded.</>}
      </p>
    </div>
  )
}
