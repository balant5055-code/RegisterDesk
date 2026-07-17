'use client'

// Communication Center tab views (RD-COM-01). PURE ORCHESTRATION — these compose
// EXISTING endpoints (wallet/overview, /communications, reminders, broadcasts,
// wallet/usage) and the shared chart/card components. No new runtime, no new
// storage, no new communication logic.

import { useEffect, useState, type ReactNode } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  Loader2, Mail, MessageSquare, Phone, Megaphone, Bell, CheckCircle2, XCircle,
  Clock, Wallet, TrendingUp, Percent,
} from 'lucide-react'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { Bars, Donut, HBars, type ChartPoint } from '@/components/analytics/Charts'
import { NOTIFICATION_META, NotificationType, isOrganizerNotification } from '@/lib/notifications/catalog'
import { WHATSAPP_TEMPLATE_REGISTRY } from '@/lib/whatsapp/registry'
import { REMINDER_KINDS, REMINDER_KIND_LABELS, KIND_AUDIENCE } from '@/lib/reminders/types'
import { buildReminderContent } from '@/lib/reminders/templates'

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
async function getJSON<T>(url: string): Promise<T> {
  const token = await getToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return await res.json() as T
}

function useLoaded<T>(loader: () => Promise<T>): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => { void (async () => {
      try { const d = await loader(); if (alive) setData(d) }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })() }, 0)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { data, loading, error }
}

// ─── Shared shapes (from existing endpoints) ───────────────────────────────────

interface WalletOverview { balancePaise: number; emailsSent: number; smsSent: number; whatsappSent: number; thisMonthSpendPaise: number }
interface ReminderAnalytics { scheduled: number; sent: number; failed: number; skipped: number; cancelled: number; recipients: number; costPaise: number }
interface CommRow { id: string; createdAt: string | null; channel: string; status: string; notificationType?: string; templateKey?: string; costPaise?: number; error?: string }
interface Broadcast { id: string; status: string; recipientCount: number; successCount: number; failCount: number; actualCostPaise?: number; estimatedCostPaise?: number }
interface CommUsageRow { channel: string; costPaise: number; quantity: number; createdAt: string | null }

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3"><p className="text-[14px] font-bold text-foreground">{title}</p>{action}</div>
      <div className="p-5">{children}</div>
    </div>
  )
}
function Loading() { return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> }

// ─── Overview tab ───────────────────────────────────────────────────────────────

export function CommOverview() {
  const { data, loading, error } = useLoaded(async () => {
    const [wallet, reminders, broadcasts, logs] = await Promise.all([
      getJSON<{ overview: WalletOverview }>('/api/organizer/wallet/overview'),
      getJSON<{ analytics: ReminderAnalytics }>('/api/organizer/reminders'),
      getJSON<{ campaigns: Broadcast[] }>('/api/organizer/broadcasts'),
      getJSON<{ logs: { status: string; createdAt: string | null }[] }>('/api/organizer/email-logs?limit=200'),
    ])
    return { wallet: wallet.overview, reminders: reminders.analytics, broadcasts: broadcasts.campaigns, logs: logs.logs }
  })

  if (loading) return <Loading />
  if (error || !data) return <p className="text-[13px] text-destructive">{error ?? 'No data.'}</p>

  const { wallet, reminders, broadcasts, logs } = data
  const delivered = logs.filter(l => l.status === 'delivered').length
  const sent = logs.filter(l => l.status === 'sent' || l.status === 'delivered').length
  const failed = logs.filter(l => l.status === 'failed').length
  const pending = logs.filter(l => l.status === 'queued').length
  const today = new Date().toISOString().slice(0, 10)
  const todaySends = logs.filter(l => (l.createdAt ?? '').slice(0, 10) === today).length
  const successRate = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 100

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <MetricCard label="Emails sent" value={String(wallet.emailsSent)} hint="This month" icon={Mail} iconColor="text-primary" iconBg="bg-primary/10" />
        <MetricCard label="WhatsApp sent" value={String(wallet.whatsappSent)} hint="This month" icon={MessageSquare} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
        <MetricCard label="SMS sent" value={String(wallet.smsSent)} hint="This month" icon={Phone} iconColor="text-sky-700" iconBg="bg-sky-50" />
        <MetricCard label="Broadcasts" value={String(broadcasts.length)} icon={Megaphone} iconColor="text-violet-700" iconBg="bg-violet-50" />
        <MetricCard label="Scheduled reminders" value={String(reminders.scheduled)} icon={Bell} iconColor="text-amber-700" iconBg="bg-amber-50" />
        <MetricCard label="Delivered" value={String(delivered)} icon={CheckCircle2} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
        <MetricCard label="Failed" value={String(failed)} icon={XCircle} iconColor="text-rose-700" iconBg="bg-rose-50" />
        <MetricCard label="Pending" value={String(pending)} icon={Clock} iconColor="text-amber-700" iconBg="bg-amber-50" />
        <MetricCard label="Comm spend" value={rupees(wallet.thisMonthSpendPaise)} hint="This month" icon={Wallet} iconColor="text-slate-700" iconBg="bg-slate-100" />
        <MetricCard label="Today's sends" value={String(todaySends)} icon={TrendingUp} iconColor="text-primary" iconBg="bg-primary/10" />
        <MetricCard label="Wallet balance" value={rupees(wallet.balancePaise)} icon={Wallet} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/wallet" />
        <MetricCard label="Success rate" value={`${successRate}%`} icon={Percent} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
      </section>
    </div>
  )
}

// ─── Analytics tab ──────────────────────────────────────────────────────────────

export function CommAnalytics() {
  const { data, loading, error } = useLoaded(async () => {
    const from = new Date(); from.setDate(from.getDate() - 30)
    const [comm, reminders, broadcasts] = await Promise.all([
      getJSON<{ rows: CommRow[] }>(`/api/organizer/communications?dateFrom=${from.toISOString().slice(0, 10)}`),
      getJSON<{ analytics: ReminderAnalytics }>('/api/organizer/reminders'),
      getJSON<{ campaigns: Broadcast[] }>('/api/organizer/broadcasts'),
    ])
    return { rows: comm.rows ?? [], reminders: reminders.analytics, broadcasts: broadcasts.campaigns }
  })

  if (loading) return <Loading />
  if (error || !data) return <p className="text-[13px] text-destructive">{error ?? 'No data.'}</p>

  const { rows, reminders, broadcasts } = data
  const days: { key: string; label: string }[] = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); days.push({ key: d.toISOString().slice(0, 10), label: `${d.getMonth() + 1}/${d.getDate()}` }) }
  const dailyMap = new Map<string, number>(days.map(d => [d.key, 0]))
  const channelMap = new Map<string, number>()
  const templateMap = new Map<string, number>()
  let sent = 0, failed = 0, cost = 0
  for (const r of rows) {
    const k = (r.createdAt ?? '').slice(0, 10); if (dailyMap.has(k)) dailyMap.set(k, (dailyMap.get(k) ?? 0) + 1)
    channelMap.set(r.channel || 'email', (channelMap.get(r.channel || 'email') ?? 0) + 1)
    const t = r.notificationType || r.templateKey || 'other'; templateMap.set(t, (templateMap.get(t) ?? 0) + 1)
    if (r.status === 'sent' || r.status === 'delivered') sent++; else if (r.status === 'failed') failed++
    cost += r.costPaise ?? 0
  }
  const total = sent + failed
  const successPct = total ? Math.round((sent / total) * 100) : 100
  const avgCost = rows.length ? Math.round(cost / rows.length) : 0
  const toPoints = (m: Map<string, number>): ChartPoint[] => [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Daily sends (14d)"><Bars data={days.map(d => ({ label: d.label, value: dailyMap.get(d.key) ?? 0 }))} /></Section>
      <Section title="Channel split"><Donut segments={toPoints(channelMap)} /></Section>
      <Section title="Most used templates">{templateMap.size ? <HBars data={toPoints(templateMap).slice(0, 8)} /> : <p className="text-[13px] text-muted-foreground">No sends yet.</p>}</Section>
      <div className="space-y-4">
        <Section title="Delivery">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><p className="text-[22px] font-bold text-emerald-600">{successPct}%</p><p className="text-[12px] text-muted-foreground">Success</p></div>
            <div><p className="text-[22px] font-bold text-rose-600">{total ? 100 - successPct : 0}%</p><p className="text-[12px] text-muted-foreground">Failure</p></div>
            <div><p className="text-[22px] font-bold text-foreground">{rupees(avgCost)}</p><p className="text-[12px] text-muted-foreground">Avg cost</p></div>
          </div>
        </Section>
        <Section title="Reminder & broadcast performance">
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <Kv k="Reminders sent" v={reminders.sent} /><Kv k="Reminders failed" v={reminders.failed} />
            <Kv k="Broadcasts" v={broadcasts.length} /><Kv k="Broadcast delivered" v={broadcasts.reduce((s, b) => s + (b.successCount ?? 0), 0)} />
          </div>
        </Section>
      </div>
    </div>
  )
}

// ─── Billing tab ────────────────────────────────────────────────────────────────

export function CommBilling() {
  const { data, loading, error } = useLoaded(async () => {
    const [wallet, usage] = await Promise.all([
      getJSON<{ overview: WalletOverview }>('/api/organizer/wallet/overview'),
      getJSON<{ usage: CommUsageRow[] }>('/api/organizer/wallet/usage?limit=500'),
    ])
    return { wallet: wallet.overview, usage: usage.usage ?? [] }
  })
  if (loading) return <Loading />
  if (error || !data) return <p className="text-[13px] text-destructive">{error ?? 'No data.'}</p>

  const { wallet, usage } = data
  const byChannel = new Map<string, number>()
  let lifetime = 0
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
  let monthly = 0
  for (const u of usage) {
    byChannel.set(u.channel, (byChannel.get(u.channel) ?? 0) + u.costPaise)
    lifetime += u.costPaise
    if (u.createdAt && new Date(u.createdAt) >= monthStart) monthly += u.costPaise
  }
  const seg: ChartPoint[] = [...byChannel.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard label="Email cost" value={rupees(byChannel.get('email') ?? 0)} icon={Mail} iconColor="text-primary" iconBg="bg-primary/10" />
        <MetricCard label="WhatsApp cost" value={rupees(byChannel.get('whatsapp') ?? 0)} icon={MessageSquare} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
        <MetricCard label="SMS cost" value={rupees(byChannel.get('sms') ?? 0)} icon={Phone} iconColor="text-sky-700" iconBg="bg-sky-50" />
        <MetricCard label="Monthly spend" value={rupees(monthly)} icon={Wallet} iconColor="text-amber-700" iconBg="bg-amber-50" />
        <MetricCard label="Lifetime spend" value={rupees(lifetime)} icon={Wallet} iconColor="text-slate-700" iconBg="bg-slate-100" />
        <MetricCard label="Wallet balance" value={rupees(wallet.balancePaise)} icon={Wallet} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/wallet" />
      </section>
      <Section title="Spend by channel">{seg.length ? <Donut segments={seg} /> : <p className="text-[13px] text-muted-foreground">No communication charges yet.</p>}</Section>
    </div>
  )
}

// ─── Templates tab (read-only registries) ──────────────────────────────────────

export function TemplateCenter() {
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)

  // Organizer workspace lists ONLY organizer-scoped templates; platform lifecycle
  // templates remain in the registry but are hidden here (future Admin surfaces them).
  const emailTypes = Object.values(NotificationType).filter(t => NOTIFICATION_META[t]?.channel === 'email' && isOrganizerNotification(t))
  const whatsappEntries = Object.entries(WHATSAPP_TEMPLATE_REGISTRY).filter(([type]) => isOrganizerNotification(type as NotificationType))

  return (
    <div className="space-y-4">
      <Section title={`Reminder templates (${REMINDER_KINDS.length})`}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {REMINDER_KINDS.map(kind => (
            <div key={kind} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <p className="text-[13px] font-medium text-foreground">{REMINDER_KIND_LABELS[kind]}</p>
                <p className="text-[11px] text-muted-foreground capitalize">Email · {kind === 'custom' ? 'organizer' : KIND_AUDIENCE[kind]}</p>
              </div>
              <button onClick={() => { const c = buildReminderContent({ kind, eventName: 'Sample Event', recipientName: 'Alex', eventDateLabel: 'Sat, 12 Jul', eventUrl: '#', balanceLabel: '₹0' }); setPreview({ subject: c.subject, body: c.html }) }}
                className="text-[12px] font-semibold text-primary hover:underline">Preview</button>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`WhatsApp templates (${whatsappEntries.length})`} action={<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Meta-approved · view only</span>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12.5px]">
            <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase text-muted-foreground"><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Template</th><th className="py-2 pr-3">Language</th><th className="py-2 pr-3">Category</th><th className="py-2 pr-3">Variables</th></tr></thead>
            <tbody className="divide-y divide-border">
              {whatsappEntries.map(([type, def]) => (
                <tr key={type}>
                  <td className="py-2 pr-3 text-foreground">{type}</td>
                  <td className="py-2 pr-3 font-mono text-[11.5px] text-muted-foreground">{def.templateName}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{def.language}</td>
                  <td className="py-2 pr-3"><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] capitalize text-muted-foreground">{def.category}</span></td>
                  <td className="py-2 pr-3 text-muted-foreground">{def.requiredVariables.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Email templates (${emailTypes.length})`} action={<a href="/dashboard/communications/email-templates" className="text-[12px] font-semibold text-primary hover:underline">Edit transactional templates →</a>}>
        <div className="flex flex-wrap gap-1.5">
          {emailTypes.map(t => <span key={t} className="rounded-full bg-muted px-2.5 py-1 text-[11.5px] font-medium text-foreground">{t}</span>)}
        </div>
      </Section>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="mb-2 text-[13px] font-bold text-foreground">{preview.subject}</p>
            <iframe title="preview" srcDoc={preview.body} className="h-[480px] w-full rounded-lg border border-border bg-white" />
            <button onClick={() => setPreview(null)} className="mt-3 w-full rounded-lg border border-border py-2 text-[13px] font-medium text-foreground hover:bg-muted">Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: number }) {
  return <div className="rounded-lg border border-border bg-muted/20 px-3 py-2"><p className="text-[11px] text-muted-foreground">{k}</p><p className="text-[16px] font-bold text-foreground">{v.toLocaleString('en-IN')}</p></div>
}
