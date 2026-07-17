'use client'

// "The Platform" — the right BrowserFrame that crossfades a different, real
// RegisterDesk interface for the active module (opacity 0→1, y 8→0, 220ms
// ease-out; no reload). Built from the product kit — no fake analytics/charts.

import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus, Search, Download, Send, CalendarClock, ShieldCheck, FileCheck2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { brandGradientStyle } from '@/lib/marketing/theme'
import { BrowserFrame } from '@/components/marketing/product/BrowserFrame'
import { StatusBadge, type BadgeTone } from '@/components/marketing/product/StatusBadge'
import { PlatformPreviewCard } from './PlatformPreviewCard'
import { PLATFORM_MODULES } from './platform.data'

function GradientBtn({ icon: Icon, children }: { icon: typeof Plus; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-fs-xs font-semibold text-white shadow-sm" style={brandGradientStyle}>
      <Icon className="size-3.5" strokeWidth={2} aria-hidden /> {children}
    </span>
  )
}
function GhostBtn({ icon: Icon, children }: { icon: typeof Search; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-white px-2.5 py-1.5 text-fs-xs font-medium text-foreground">
      <Icon className="size-3.5" strokeWidth={1.8} aria-hidden /> {children}
    </span>
  )
}
function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="min-w-0">
      <div className="text-fs-md font-bold text-foreground">{title}</div>
      <div className="truncate text-fs-xs text-muted-foreground">{sub}</div>
    </div>
  )
}
function Avatar({ initials }: { initials: string }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{initials}</span>
}

/* ── Previews ─────────────────────────────────────────────────────────────── */

function EventsPreview() {
  const rows: { name: string; date: string; label: string; tone: BadgeTone }[] = [
    { name: 'Spring Half Marathon', date: 'Apr 12, 2026', label: 'Live',     tone: 'success' },
    { name: 'City Cyclothon',       date: 'May 3, 2026',  label: 'Upcoming', tone: 'brand' },
    { name: 'Tech Summit',          date: 'Jun 20, 2026', label: 'Draft',    tone: 'neutral' },
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Head title="Events" sub="Manage all your events" />
        <GradientBtn icon={Plus}>Create event</GradientBtn>
      </div>
      <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
        {rows.map(r => (
          <div key={r.name} className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10"><CalendarClock className="size-4 text-primary" strokeWidth={1.8} aria-hidden /></span>
            <div className="min-w-0 flex-1"><div className="truncate text-fs-sm font-medium text-foreground">{r.name}</div><div className="text-fs-2xs text-muted-foreground">{r.date}</div></div>
            <StatusBadge label={r.label} tone={r.tone} />
          </div>
        ))}
      </div>
    </div>
  )
}

function RegistrationsPreview() {
  const rows: { ini: string; name: string; ticket: string; label: string; tone: BadgeTone }[] = [
    { ini: 'AS', name: 'Aarav Sharma', ticket: '10K Run',       label: 'Paid',     tone: 'success' },
    { ini: 'PN', name: 'Priya Nair',   ticket: 'Half Marathon', label: 'Paid',     tone: 'success' },
    { ini: 'RM', name: 'Rohan Mehta',  ticket: '5K Run',        label: 'Pending',  tone: 'warning' },
    { ini: 'KI', name: 'Karthik Iyer', ticket: 'Half Marathon', label: 'Refunded', tone: 'neutral' },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Head title="Registrations" sub="312 registered" />
        <div className="flex items-center gap-2"><GhostBtn icon={Search}>Search</GhostBtn><GhostBtn icon={Download}>Export</GhostBtn></div>
      </div>
      <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
        {rows.map(r => (
          <div key={r.name} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar initials={r.ini} />
            <span className="min-w-0 flex-1 truncate text-fs-sm font-medium text-foreground">{r.name}</span>
            <span className="hidden text-fs-xs text-muted-foreground sm:block">{r.ticket}</span>
            <StatusBadge label={r.label} tone={r.tone} />
          </div>
        ))}
      </div>
    </div>
  )
}

function PaymentsPreview() {
  const rows: { name: string; amount: string; label: string; tone: BadgeTone }[] = [
    { name: 'Aarav Sharma', amount: '₹1,200', label: 'Paid',     tone: 'success' },
    { name: 'Priya Nair',   amount: '₹1,800', label: 'Paid',     tone: 'success' },
    { name: 'Rohan Mehta',  amount: '₹800',   label: 'Refunded', tone: 'neutral' },
  ]
  return (
    <div className="space-y-3">
      <Head title="Payments" sub="Powered by Razorpay" />
      <PlatformPreviewCard title="Payment history">
        <div className="divide-y divide-border/50">
          {rows.map(r => (
            <div key={r.name} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-fs-xs font-medium text-foreground">{r.name}</span>
              <span className="text-fs-xs tabular-nums text-muted-foreground">{r.amount}</span>
              <StatusBadge label={r.label} tone={r.tone} />
            </div>
          ))}
        </div>
      </PlatformPreviewCard>
      <div className="flex items-center justify-between rounded-xl border border-border/60 bg-white p-3 shadow-sm">
        <span className="text-fs-xs font-medium text-muted-foreground">Next settlement</span>
        <span className="text-fs-base font-bold tabular-nums text-foreground">₹3,84,200</span>
        <StatusBadge label="Scheduled" tone="brand" />
      </div>
    </div>
  )
}

function ParticipantsPreview() {
  return (
    <div className="space-y-3">
      <Head title="Participants" sub="Profile · Priya Nair" />
      <div className="rounded-xl border border-border/60 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-fs-sm font-semibold text-primary">PN</span>
          <div className="min-w-0"><div className="truncate text-fs-base font-semibold text-foreground">Priya Nair</div><div className="text-fs-xs text-muted-foreground">Bib #2048 · Half Marathon</div></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2.5 text-fs-xs">
          {[['Medical info', 'Provided'], ['Waiver', 'Signed'], ['T-shirt', 'Medium'], ['Wave', '06:30 AM']].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border/60 bg-muted/10 px-2.5 py-2"><div className="text-muted-foreground">{k}</div><div className="mt-0.5 font-medium text-foreground">{v}</div></div>
          ))}
        </div>
      </div>
    </div>
  )
}

const QR = [1,1,1,0,1, 1,0,1,1,0, 1,1,0,1,1, 0,1,1,0,1, 1,0,1,1,1]
function CheckinPreview() {
  return (
    <div className="space-y-3">
      <Head title="Check-in" sub="Gate A · live" />
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-white p-4 shadow-sm">
          <div className="grid size-16 grid-cols-5 gap-0.5 rounded-md border border-border/60 p-1.5" aria-hidden>
            {QR.map((on, i) => <span key={i} className={cn('rounded-[1px]', on ? 'bg-foreground/85' : 'bg-transparent')} />)}
          </div>
          <StatusBadge label="Scan ready" tone="success" />
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border/60 bg-white p-3 shadow-sm"><div className="text-fs-2xs text-muted-foreground">Checked in</div><div className="mt-1 text-[22px] font-bold tabular-nums leading-none text-foreground">180</div></div>
          <div className="rounded-xl border border-border/60 bg-white p-3 shadow-sm"><div className="text-fs-2xs text-muted-foreground">Pending</div><div className="mt-1 text-[22px] font-bold tabular-nums leading-none text-foreground">132</div></div>
        </div>
      </div>
    </div>
  )
}

function CertificatesPreview() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Head title="Certificates" sub="Finisher certificate" />
        <GradientBtn icon={Send}>Issue</GradientBtn>
      </div>
      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-white p-4 shadow-sm">
        <div className="flex aspect-[4/3] w-2/5 flex-col items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-muted/10 p-2">
          <span className="flex size-7 items-center justify-center rounded-full border border-primary/30"><FileCheck2 className="size-3.5 text-primary" strokeWidth={1.7} aria-hidden /></span>
          <div className="h-1.5 w-16 rounded bg-muted" /><div className="h-1 w-20 rounded bg-muted/60" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 text-fs-xs">
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Half Marathon</span><StatusBadge label="Issued" tone="brand" /></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Emailed</span><StatusBadge label="Sent" tone="success" /></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Verifiable</span><StatusBadge label="Live" tone="success" /></div>
        </div>
      </div>
    </div>
  )
}

function FinancePreview() {
  const rows: { label: string; amount: string; tone: BadgeTone; status: string }[] = [
    { label: 'Registrations', amount: '₹4,86,400', tone: 'success', status: 'Cleared' },
    { label: 'Refunds',       amount: '−₹18,600',  tone: 'neutral',  status: 'Processed' },
    { label: 'Net revenue',   amount: '₹4,67,800', tone: 'brand',    status: 'Payout Apr 8' },
  ]
  return (
    <div className="space-y-3">
      <Head title="Finance" sub="Revenue & settlements" />
      <PlatformPreviewCard title="Settlement schedule">
        <div className="divide-y divide-border/50">
          {rows.map(r => (
            <div key={r.label} className="flex items-center justify-between gap-2 py-2.5">
              <span className="text-fs-xs font-medium text-foreground">{r.label}</span>
              <span className="text-fs-xs font-semibold tabular-nums text-foreground">{r.amount}</span>
              <StatusBadge label={r.status} tone={r.tone} />
            </div>
          ))}
        </div>
      </PlatformPreviewCard>
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-white p-3 text-fs-xs text-muted-foreground shadow-sm">
        <ShieldCheck className="size-4 text-primary" strokeWidth={1.8} aria-hidden /> Settled straight to your bank or UPI.
      </div>
    </div>
  )
}

const PREVIEWS: Record<string, () => ReactNode> = {
  events:        EventsPreview,
  registrations: RegistrationsPreview,
  payments:      PaymentsPreview,
  participants:  ParticipantsPreview,
  checkin:       CheckinPreview,
  certificates:  CertificatesPreview,
  finance:       FinancePreview,
}

export function PlatformPreview({ active, panelId, labelId, className }: {
  active: string; panelId: string; labelId?: string; className?: string
}) {
  const mod = PLATFORM_MODULES.find(m => m.id === active) ?? PLATFORM_MODULES[0]
  const Preview = PREVIEWS[active] ?? EventsPreview
  return (
    <div id={panelId} role="tabpanel" aria-labelledby={labelId} className={className}>
      <BrowserFrame url={mod.url}>
        <div className="min-h-[360px] p-5">
          <AnimatePresence mode="wait">
            <motion.div key={active} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
              <Preview />
            </motion.div>
          </AnimatePresence>
        </div>
      </BrowserFrame>
    </div>
  )
}
