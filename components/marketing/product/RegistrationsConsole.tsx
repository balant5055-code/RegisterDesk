// Marketing product UI kit — the RegisterDesk operations console (master-detail).
// A realistic application screen: sidebar · registrations table · a detail rail
// (participant · QR check-in · certificate · settlement). Sample application data
// only — no charts, no fake analytics. Razorpay is the real provider. Reusable.

import { LayoutDashboard, Calendar, Ticket, Users, QrCode, Award, Wallet, Settings, Search, Download, Plus, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { brandGradientStyle } from '@/lib/marketing/theme'
import { StatusBadge, type BadgeTone } from './StatusBadge'
import { MetricTile } from './MetricTile'

const NAV = [
  { icon: LayoutDashboard, label: 'Overview',      active: false },
  { icon: Calendar,        label: 'Events',         active: false },
  { icon: Ticket,          label: 'Registrations', active: true  },
  { icon: Users,           label: 'Participants',  active: false },
  { icon: QrCode,          label: 'Check-in',      active: false },
  { icon: Award,           label: 'Certificates',  active: false },
  { icon: Wallet,          label: 'Finance',       active: false },
  { icon: Settings,        label: 'Settings',      active: false },
]

const METRICS = [
  { icon: Ticket, label: 'Registrations', value: '312' },
  { icon: Users,  label: 'Participants',  value: '248' },
  { icon: QrCode, label: 'Checked in',    value: '180' },
  { icon: Award,  label: 'Certificates',  value: '96'  },
]

const FILTERS = ['All', 'Paid', 'Pending', 'Refunded']

const ROWS: { initials: string; name: string; ticket: string; amount: string; status: string; tone: BadgeTone; selected?: boolean }[] = [
  { initials: 'AS', name: 'Aarav Sharma',  ticket: '10K Run',       amount: '₹1,200', status: 'Paid',     tone: 'success' },
  { initials: 'PN', name: 'Priya Nair',    ticket: 'Half Marathon', amount: '₹1,800', status: 'Paid',     tone: 'success', selected: true },
  { initials: 'RM', name: 'Rohan Mehta',   ticket: '5K Run',        amount: '₹800',   status: 'Pending',  tone: 'warning' },
  { initials: 'AR', name: 'Ananya Rao',    ticket: '10K Run',       amount: '₹1,200', status: 'Paid',     tone: 'success' },
  { initials: 'KI', name: 'Karthik Iyer',  ticket: 'Half Marathon', amount: '₹1,800', status: 'Refunded', tone: 'neutral' },
]

const QR = [1,1,1,0,1, 1,0,1,1,0, 1,1,0,1,1, 0,1,1,0,1, 1,0,1,1,1]
const COLS = 'grid grid-cols-[1.5fr_1fr_0.8fr_0.9fr] items-center gap-2'

function RailCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border/60 bg-white p-3">{children}</div>
}

export function RegistrationsConsole() {
  return (
    <div className="flex min-h-[440px] text-left">
      {/* Sidebar */}
      <aside className="hidden w-[200px] shrink-0 flex-col gap-4 border-r border-border/60 bg-muted/20 px-3 py-4 lg:flex">
        <div className="flex items-center gap-2 px-1.5">
          <span className="size-6 shrink-0 rounded-md shadow-sm" style={brandGradientStyle} aria-hidden />
          <span className="text-fs-sm font-bold tracking-tight text-foreground">RegisterDesk</span>
        </div>
        <div>
          <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Menu</div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map(({ icon: Icon, label, active }) => (
              <span key={label} className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium', active ? 'bg-white text-foreground shadow-sm ring-1 ring-border/60' : 'text-muted-foreground')}>
                <Icon className={cn('size-4 shrink-0', active && 'text-primary')} strokeWidth={1.8} aria-hidden />
                {label}
              </span>
            ))}
          </nav>
        </div>
        <div className="mt-auto flex items-center gap-2 rounded-lg border border-border/60 bg-white p-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">RO</span>
          <div className="min-w-0">
            <div className="truncate text-fs-2xs font-semibold text-foreground">Race Office</div>
            <div className="truncate text-[10px] text-muted-foreground">Organizer</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col xl:border-r xl:border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="min-w-0">
            <div className="text-fs-md font-bold tracking-tight text-foreground">Registrations</div>
            <div className="truncate text-fs-xs text-muted-foreground">Spring Half Marathon · 312 registered</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-lg border border-border/60 bg-white px-3 py-1.5 text-fs-xs text-muted-foreground sm:inline-flex">
              <Search className="size-3.5" strokeWidth={1.8} aria-hidden /><span className="hidden md:inline">Search registrations</span><span className="md:hidden">Search</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-white px-2.5 py-1.5 text-fs-xs font-medium text-foreground">
              <Download className="size-3.5" strokeWidth={1.8} aria-hidden /> Export
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-fs-xs font-semibold text-white shadow-sm" style={brandGradientStyle}>
              <Plus className="size-3.5" strokeWidth={2} aria-hidden /> Add
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 px-5 pt-3.5 sm:grid-cols-4">
          {METRICS.map(m => <MetricTile key={m.label} icon={m.icon} label={m.label} value={m.value} />)}
        </div>

        <div className="flex flex-col px-5 pb-4 pt-3.5">
          <div className="mb-2 inline-flex w-fit items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5">
            {FILTERS.map((f, i) => (
              <span key={f} className={cn('rounded-md px-2.5 py-1 text-fs-xs font-medium', i === 0 ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground')}>{f}</span>
            ))}
          </div>
          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className={cn(COLS, 'border-b border-border/60 bg-muted/20 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground')}>
              <span>Participant</span><span>Ticket</span><span>Amount</span><span>Status</span>
            </div>
            {ROWS.map(r => (
              <div key={r.name} className={cn(COLS, 'border-b border-border/50 px-4 py-2.5 transition-colors last:border-0', r.selected ? 'bg-primary/[0.06]' : 'hover:bg-muted/30')}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{r.initials}</span>
                  <span className="truncate text-[12.5px] font-medium text-foreground">{r.name}</span>
                </div>
                <span className="truncate text-fs-xs text-muted-foreground">{r.ticket}</span>
                <span className="text-fs-xs font-medium tabular-nums text-foreground">{r.amount}</span>
                <span><StatusBadge label={r.status} tone={r.tone} /></span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Detail rail */}
      <aside className="hidden w-[300px] shrink-0 flex-col gap-3 bg-muted/10 p-4 xl:flex">
        <RailCard>
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-fs-xs font-semibold text-primary">PN</span>
            <div className="min-w-0">
              <div className="truncate text-fs-sm font-semibold text-foreground">Priya Nair</div>
              <div className="truncate text-fs-2xs text-muted-foreground">Bib #2048 · Half Marathon</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-fs-2xs">
            <div><div className="text-muted-foreground">Status</div><div className="mt-1"><StatusBadge label="Paid" tone="success" /></div></div>
            <div><div className="text-muted-foreground">Wave</div><div className="mt-1 font-medium text-foreground">06:30 AM</div></div>
          </div>
          <span className="mt-3 flex items-center justify-center gap-1 rounded-lg border border-border/60 bg-white py-1.5 text-fs-xs font-medium text-foreground">
            View profile <ChevronRight className="size-3.5" strokeWidth={1.8} aria-hidden />
          </span>
        </RailCard>

        <RailCard>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-fs-xs font-semibold text-foreground"><QrCode className="size-3.5 text-primary" strokeWidth={1.8} aria-hidden /> Check-in</div>
            <StatusBadge label="Checked in" tone="success" />
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <div className="grid size-12 shrink-0 grid-cols-5 gap-0.5 rounded-md border border-border/60 p-1" aria-hidden>
              {QR.map((on, i) => <span key={i} className={cn('rounded-[1px]', on ? 'bg-foreground/85' : 'bg-transparent')} />)}
            </div>
            <div className="text-fs-2xs text-muted-foreground"><div className="font-medium text-foreground">Gate A</div>10:24 AM · scanned</div>
          </div>
        </RailCard>

        <RailCard>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-fs-xs font-semibold text-foreground"><Award className="size-3.5 text-primary" strokeWidth={1.8} aria-hidden /> Certificate</div>
            <StatusBadge label="Issued" tone="brand" />
          </div>
          <div className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-2">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-white"><Award className="size-4 text-primary" strokeWidth={1.6} aria-hidden /></div>
            <div className="min-w-0 text-fs-2xs"><div className="truncate font-medium text-foreground">Finisher Certificate</div><div className="truncate text-muted-foreground">Half Marathon · 2026</div></div>
          </div>
        </RailCard>

        <RailCard>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-fs-xs font-semibold text-foreground"><Wallet className="size-3.5 text-primary" strokeWidth={1.8} aria-hidden /> Settlement</div>
            <StatusBadge label="Cleared" tone="success" />
          </div>
          <div className="mt-2 text-[18px] font-bold tracking-tight tabular-nums text-foreground">₹3,84,200</div>
          <div className="text-fs-2xs text-muted-foreground">Razorpay · next payout Apr 8</div>
        </RailCard>
      </aside>
    </div>
  )
}
