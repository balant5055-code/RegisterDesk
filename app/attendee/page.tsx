'use client'

import { useCallback, useEffect, useState } from 'react'
import Link                    from 'next/link'
import { ClipboardList, Ticket, Heart, Award, ChevronRight } from 'lucide-react'
import { cn }                  from '@/lib/utils/cn'
import { AttendeePageHeader, ErrorState, fmtDate, fmtINR, StatusBadge } from '@/components/attendee/ui'
import type { Page, AttendeeRegistration, AttendeeTicket, AttendeeDonation, AttendeeCertificate } from '@/lib/attendee/data'

interface Loaded {
  registrations: AttendeeRegistration[]
  tickets:       AttendeeTicket[]
  donations:     AttendeeDonation[]
  certificates:  AttendeeCertificate[]
}

async function fetchList<T>(path: string): Promise<T[]> {
  const res = await fetch(path, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to load your account data.')
  return ((await res.json()) as Page<T>).items
}

export default function AttendeeDashboard() {
  const [data,    setData]    = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    Promise.all([
      fetchList<AttendeeRegistration>('/api/attendee/registrations'),
      fetchList<AttendeeTicket>('/api/attendee/tickets'),
      fetchList<AttendeeDonation>('/api/attendee/donations'),
      fetchList<AttendeeCertificate>('/api/attendee/certificates'),
    ])
      .then(([registrations, tickets, donations, certificates]) =>
        setData({ registrations, tickets, donations, certificates }))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  // Deferred so the fetch's setState calls don't run synchronously in the effect.
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  const cards = [
    { label: 'Registrations', href: '/attendee/registrations', icon: ClipboardList, count: data?.registrations.length },
    { label: 'Tickets',       href: '/attendee/tickets',       icon: Ticket,        count: data?.tickets.length },
    { label: 'Donations',     href: '/attendee/donations',     icon: Heart,         count: data?.donations.length },
    { label: 'Certificates',  href: '/attendee/certificates',  icon: Award,         count: data?.certificates.length },
  ]

  return (
    <div>
      <AttendeePageHeader title="My Account" subtitle="Your registrations, tickets, donations, and certificates." />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(c => (
          <Link key={c.label} href={c.href}
            className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.08] text-primary">
                <c.icon className="size-4.5 size-[18px]" aria-hidden />
              </div>
              <ChevronRight className="size-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </div>
            <div>
              <p className="text-[24px] font-bold leading-none text-foreground">
                {loading ? <span className="inline-block h-6 w-8 animate-pulse rounded bg-muted" /> : (c.count ?? 0)}
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">{c.label}</p>
            </div>
          </Link>
        ))}
      </div>

      {error && <div className="mt-5"><ErrorState message={error} onRetry={load} /></div>}

      {/* Recent activity */}
      {!error && (
        <section className="mt-6">
          <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Recent activity</h2>
          {loading ? (
            <div className="space-y-2.5">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-border bg-muted/30" />)}</div>
          ) : (
            <RecentActivity data={data!} />
          )}
        </section>
      )}
    </div>
  )
}

type ActivityItem = { key: string; icon: React.ElementType; title: string; meta: string; date: string | null; status?: string; href: string }

function RecentActivity({ data }: { data: Loaded }) {
  const items: ActivityItem[] = [
    ...data.registrations.map(r => ({ key: `r_${r.registrationId}`, icon: ClipboardList, title: r.eventName || 'Event', meta: 'Registration', date: r.registeredAt, status: r.status, href: '/attendee/registrations' })),
    ...data.donations.map(d => ({ key: `d_${d.donationId}`, icon: Heart, title: d.campaignName || 'Campaign', meta: fmtINR(d.amount), date: d.donatedAt, status: d.status, href: '/attendee/donations' })),
    ...data.certificates.map(c => ({ key: `c_${c.certificateId}`, icon: Award, title: c.eventName || 'Certificate', meta: 'Certificate', date: c.issuedAt, href: '/attendee/certificates' })),
  ]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, 6)

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-border py-14 text-center">
        <p className="text-[14px] font-medium text-foreground">Nothing here yet</p>
        <p className="text-[13px] text-muted-foreground">Your registrations and donations will appear here.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      {items.map(it => (
        <Link key={it.key} href={it.href} className={cn('flex items-center gap-3 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/20')}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground"><it.icon className="size-4" aria-hidden /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-foreground">{it.title}</p>
            <p className="text-[12px] text-muted-foreground">{it.meta} · {fmtDate(it.date)}</p>
          </div>
          {it.status && <StatusBadge status={it.status} />}
        </Link>
      ))}
    </div>
  )
}
