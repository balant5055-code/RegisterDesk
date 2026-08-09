'use client'

// Admin Communication Center (RD-COM-01) — platform-wide usage, failures,
// broadcasts, reminders, costs, and most-active organizers/events. Aggregation-
// based (no full-platform load). Reuses the shared admin primitives + charts.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, Radio, Mail, Megaphone, Bell, Wallet, Download } from 'lucide-react'
import { AdminToolbar, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, ErrorBanner } from '@/components/admin'
import { HBars } from '@/components/analytics/Charts'
import type { AdminCommunications } from '@/lib/analytics/adminCommunications'
import type { LucideIcon } from 'lucide-react'

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`
async function getToken(): Promise<string> { const u = auth.currentUser; if (!u) throw new Error('Not authenticated'); return u.getIdToken() }

export default function AdminCommunicationsPage() {
  const [data, setData]   = useState<AdminCommunications | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const token = await getToken()
        const res = await fetch('/api/admin/communications', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: AdminCommunications }
        if (alive) setData(d.data)
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  function exportCsv() {
    if (!data) return
    const lines = ['Type,Name,Messages,Cost (INR)']
    data.topOrganizers.forEach(o => lines.push(`Organizer,"${o.name.replace(/"/g, '""')}",${o.count},${(o.costPaise / 100).toFixed(2)}`))
    data.topEvents.forEach(e => lines.push(`Event,"${e.name.replace(/"/g, '""')}",${e.count},${(e.costPaise / 100).toFixed(2)}`))
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: 'platform-communications.csv' })
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <AdminToolbar title="Communications" description="Platform-wide communication usage, failures, costs, and activity." icon={Radio}
        actions={<button onClick={exportCsv} disabled={!data} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50"><Download className="size-3.5" /> Export CSV</button>} />
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading || !data ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={Mail} label="Messages sent" value={data.messages.sent.toLocaleString('en-IN')} />
            <Kpi icon={Mail} label="Delivered" value={data.messages.delivered.toLocaleString('en-IN')} />
            <Kpi icon={Mail} label="Failed" value={data.messages.failed.toLocaleString('en-IN')} />
            <Kpi icon={Mail} label="WhatsApp" value={data.messages.whatsapp.toLocaleString('en-IN')} />
            <Kpi icon={Megaphone} label="Broadcasts" value={data.broadcasts.total.toLocaleString('en-IN')} />
            <Kpi icon={Wallet} label="Broadcast cost" value={rupees(data.broadcasts.costPaise)} />
            <Kpi icon={Bell} label="Reminders" value={data.reminders.total.toLocaleString('en-IN')} />
            <Kpi icon={Wallet} label="Comm spend" value={rupees(data.spend.totalPaise)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Spend by channel">
              <div className="p-4">{data.spend.byChannel.length ? <HBars data={data.spend.byChannel} format={rupees} /> : <p className="text-[13px] text-muted-foreground">No spend recorded.</p>}</div>
            </Card>
            <Card title="Message status">
              <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                <Mini label="Total" value={data.messages.total.toLocaleString('en-IN')} />
                <Mini label="Skipped" value={data.messages.skipped.toLocaleString('en-IN')} />
                <Mini label="Queued" value={data.messages.queued.toLocaleString('en-IN')} />
                <Mini label="Reminders sent" value={data.reminders.sent.toLocaleString('en-IN')} />
              </div>
            </Card>
            <Card title="Reminder status">
              <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                <Mini label="Scheduled" value={data.reminders.scheduled.toLocaleString('en-IN')} />
                <Mini label="Sent" value={data.reminders.sent.toLocaleString('en-IN')} />
                <Mini label="Failed" value={data.reminders.failed.toLocaleString('en-IN')} />
                <Mini label="Cancelled" value={data.reminders.cancelled.toLocaleString('en-IN')} />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Most active organizers">
              <TableFrame minWidth="min-w-[420px]">
                <THead><Th>Organizer</Th><Th align="right">Messages</Th><Th align="right">Cost</Th></THead>
                <TBody>
                  {data.topOrganizers.length === 0 ? <TableStateRow colSpan={3}>No data.</TableStateRow>
                    : data.topOrganizers.map(o => <Tr key={o.uid}><Td className="font-medium text-foreground">{o.name}</Td><Td align="right" className="tabular-nums">{o.count.toLocaleString('en-IN')}</Td><Td align="right" className="tabular-nums">{rupees(o.costPaise)}</Td></Tr>)}
                </TBody>
              </TableFrame>
            </Card>
            <Card title="Top events by communication">
              <TableFrame minWidth="min-w-[420px]">
                <THead><Th>Event</Th><Th align="right">Messages</Th><Th align="right">Cost</Th></THead>
                <TBody>
                  {data.topEvents.length === 0 ? <TableStateRow colSpan={3}>No data.</TableStateRow>
                    : data.topEvents.map(e => <Tr key={e.eventId}><Td className="font-medium text-foreground">{e.name}</Td><Td align="right" className="tabular-nums">{e.count.toLocaleString('en-IN')}</Td><Td align="right" className="tabular-nums">{rupees(e.costPaise)}</Td></Tr>)}
                </TBody>
              </TableFrame>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-card p-4"><div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Icon className="size-3.5" />{label}</div><p className="mt-1 text-[20px] font-bold text-foreground">{value}</p></div>
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card"><div className="border-b border-border px-4 py-3"><p className="text-[14px] font-bold text-foreground">{title}</p></div>{children}</div>
}
function Mini({ label, value }: { label: string; value: string }) {
  return <div className="bg-card px-4 py-3"><p className="text-[12px] text-muted-foreground">{label}</p><p className="mt-1 text-[18px] font-bold tabular-nums text-foreground">{value}</p></div>
}
