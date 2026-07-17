'use client'

// Admin Analytics & Insights (RD-ANA-01) — platform-wide metrics from aggregation
// (no full scans). Reuses the shared admin primitives + chart components.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, BarChart3, Building2, CalendarDays, Users, Banknote, KeyRound, Bell, Mail } from 'lucide-react'
import { AdminToolbar, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, ErrorBanner } from '@/components/admin'
import { Bars, HBars } from '@/components/analytics/Charts'
import type { AdminAnalytics } from '@/lib/analytics/adminAnalytics'
import type { LucideIcon } from 'lucide-react'

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

export default function AdminAnalyticsPage() {
  const [data, setData]     = useState<AdminAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const token = await getToken()
        const res = await fetch('/api/admin/analytics', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { analytics: AdminAnalytics }
        if (alive) setData(d.analytics)
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load analytics') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-5">
      <AdminToolbar title="Analytics" description="Platform revenue, growth, top organizers & events, and usage." icon={BarChart3} />
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading || !data ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={Banknote} label="Platform revenue (gross)" value={rupees(data.platform.lifetimeGrossPaise)} />
            <Kpi icon={Banknote} label="Platform fees earned" value={rupees(data.platform.lifetimeFeesPaise)} />
            <Kpi icon={Banknote} label="Net to organizers" value={rupees(data.platform.lifetimeNetPaise)} />
            <Kpi icon={Banknote} label="Pending settlement" value={rupees(data.platform.pendingSettlementPaise)} />
            <Kpi icon={Building2} label="Organizers" value={String(data.platform.organizers)} />
            <Kpi icon={CalendarDays} label="Published events" value={String(data.platform.publishedEvents)} />
            <Kpi icon={Users} label="Registrations" value={data.platform.totalRegistrations.toLocaleString('en-IN')} />
            <Kpi icon={KeyRound} label="License revenue" value={rupees(data.licenseSales.revenuePaise)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Platform growth — published events / day">
              <div className="p-4"><Bars data={data.growth.eventsByDay} /></div>
            </Card>
            <Card title="License sales by tier">
              <div className="p-4">
                {data.licenseSales.byTier.length ? <HBars data={data.licenseSales.byTier} /> : <p className="text-[13px] text-muted-foreground">No license sales yet.</p>}
                <div className="mt-3 flex gap-4 text-[12.5px] text-muted-foreground">
                  <span>Paid: <strong className="text-foreground">{data.licenseSales.paidCount}</strong></span>
                  <span>Refunded: <strong className="text-foreground">{data.licenseSales.refundedCount}</strong></span>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Top organizers by revenue">
              <TableFrame minWidth="min-w-[420px]">
                <THead><Th>Organizer</Th><Th align="right">Gross</Th><Th align="right">Net</Th></THead>
                <TBody>
                  {data.topOrganizers.length === 0 ? <TableStateRow colSpan={3}>No data.</TableStateRow>
                    : data.topOrganizers.map(o => (
                      <Tr key={o.uid}><Td className="font-medium text-foreground">{o.name}</Td><Td align="right" className="tabular-nums">{rupees(o.grossPaise)}</Td><Td align="right" className="tabular-nums">{rupees(o.netPaise)}</Td></Tr>
                    ))}
                </TBody>
              </TableFrame>
            </Card>
            <Card title="Top events by registrations">
              <TableFrame minWidth="min-w-[420px]">
                <THead><Th>Event</Th><Th align="right">Registrations</Th></THead>
                <TBody>
                  {data.topEvents.length === 0 ? <TableStateRow colSpan={2}>No data.</TableStateRow>
                    : data.topEvents.map(e => (
                      <Tr key={e.eventId}><Td className="font-medium text-foreground">{e.name}</Td><Td align="right" className="tabular-nums">{e.registrations.toLocaleString('en-IN')}</Td></Tr>
                    ))}
                </TBody>
              </TableFrame>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={Mail} label="Emails sent" value={data.communication.totalSent.toLocaleString('en-IN')} />
            <Kpi icon={Mail} label="Emails failed" value={data.communication.totalFailed.toLocaleString('en-IN')} />
            <Kpi icon={Bell} label="Reminders (total)" value={data.reminders.total.toLocaleString('en-IN')} />
            <Kpi icon={Bell} label="Reminders sent" value={data.reminders.sent.toLocaleString('en-IN')} />
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Icon className="size-3.5" />{label}</div>
      <p className="mt-1 text-[20px] font-bold text-foreground">{value}</p>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3"><p className="text-[14px] font-bold text-foreground">{title}</p></div>
      {children}
    </div>
  )
}
