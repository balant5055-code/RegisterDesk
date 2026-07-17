'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, Activity, AlertTriangle, RefreshCw, ShieldCheck, BookOpen, ChevronDown } from 'lucide-react'
import type { OperationsHealth, OperationalAlert, CronHealthEntry } from '@/lib/operations/healthMetrics'
import type { RecoveryHealth, DeadLetterEntry } from '@/lib/operations/recovery'
import { RUNBOOKS } from '@/lib/operations/runbooks'

const fmtAgo = (iso: string | null): string => {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function OperationsPage() {
  const [health, setHealth] = useState<OperationsHealth | null>(null)
  const [alerts, setAlerts] = useState<OperationalAlert[]>([])
  const [recovery, setRecovery] = useState<RecoveryHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const u = auth.currentUser
    if (!u) { setError('Not authenticated'); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const h = { authorization: `Bearer ${token}` }
      const [res, recRes] = await Promise.all([
        fetch('/api/admin/operations', { headers: h, cache: 'no-store' }),
        fetch('/api/admin/operations/recovery', { headers: h, cache: 'no-store' }),
      ])
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const d = await res.json() as { health: OperationsHealth; alerts: OperationalAlert[] }
      setHealth(d.health); setAlerts(d.alerts)
      if (recRes.ok) setRecovery(((await recRes.json()) as { recovery: RecoveryHealth }).recovery)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }

  useEffect(() => {
    // Defer so load()'s initial setState isn't synchronous in the effect body.
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [])

  if (loading && !health) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !health) return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error ?? 'Failed'}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground"><Activity className="size-5 text-primary" aria-hidden /> Operations</h1>
          <p className="text-[13.5px] text-muted-foreground">Platform financial, webhook, subscription, broadcast and cron health.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/operations-center" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted">
            <Activity className="size-3.5" /> Operations Center
          </Link>
          <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {/* ── System Alerts ── */}
      <section>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">System Alerts</h2>
        {alerts.length === 0 ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">All clear — no active alerts.</div>
        ) : (
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]',
                a.severity === 'critical' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span><span className="font-semibold uppercase">{a.severity}</span> — {a.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <HealthGrid title="Financial Health" items={[
        { label: 'Pending settlements', value: health.financial.pendingSettlements },
        { label: 'Failed refunds', value: health.financial.failedRefunds, danger: health.financial.failedRefunds > 0 },
        { label: 'Pending wallet topups', value: health.financial.pendingWalletTopups },
        { label: 'Pending registration recon', value: health.financial.pendingRegistrationReconciliation },
        { label: 'Pending donation recon', value: health.financial.pendingDonationReconciliation },
        { label: 'Outstanding clawbacks', value: health.financial.outstandingClawbacks, danger: health.financial.outstandingClawbacks > 0 },
      ]} />

      <HealthGrid title="Webhook Health" items={[
        { label: 'Pending deliveries', value: health.webhook.pendingDeliveries },
        { label: 'Failed deliveries', value: health.webhook.failedDeliveries, danger: health.webhook.failedDeliveries > 10 },
        { label: 'Exhausted retries', value: health.webhook.exhaustedRetries },
        { label: 'Oldest pending', value: fmtAgo(health.webhook.oldestPendingAt), text: true },
      ]} />

      <HealthGrid title="Broadcast Health" items={[
        { label: 'Scheduled', value: health.broadcast.scheduled },
        { label: 'Sending', value: health.broadcast.sending },
        { label: 'Failed', value: health.broadcast.failed },
        { label: 'Stuck > 30m', value: health.broadcast.stuckSending, danger: health.broadcast.stuckSending > 0 },
      ]} />

      <HealthGrid title="Data Integrity (mismatches, last 48h)" items={[
        { label: 'Event', value: health.dataIntegrity.eventMismatches, danger: health.dataIntegrity.eventMismatches > 0 },
        { label: 'Pass', value: health.dataIntegrity.passMismatches, danger: health.dataIntegrity.passMismatches > 0 },
        { label: 'Campaign', value: health.dataIntegrity.campaignMismatches, danger: health.dataIntegrity.campaignMismatches > 0 },
        { label: 'Session', value: health.dataIntegrity.sessionMismatches, danger: health.dataIntegrity.sessionMismatches > 0 },
        { label: 'Wallet (report-only)', value: health.dataIntegrity.walletMismatches, danger: health.dataIntegrity.walletMismatches > 0 },
      ]} />

      {/* ── Cron Health ── */}
      <section>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Cron Health</h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
              <th className="px-4 py-2.5">Cron</th><th className="px-4 py-2.5">Last success</th><th className="px-4 py-2.5">Last failure</th>
              <th className="px-4 py-2.5 text-right">Runs</th><th className="px-4 py-2.5 text-right">Failures</th><th className="px-4 py-2.5">Status</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {health.crons.map((c: CronHealthEntry) => (
                <tr key={c.cronName} className={cn(c.failedWithin24h && 'bg-rose-50/50')}>
                  <td className="px-4 py-2.5 font-medium text-foreground">{c.cronName}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtAgo(c.lastSuccessAt)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtAgo(c.lastFailureAt)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.runCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.failureCount}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1',
                      c.failedWithin24h ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                        : c.lastOk === null ? 'bg-slate-100 text-slate-600 ring-slate-500/20'
                        : c.lastOk ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-amber-50 text-amber-700 ring-amber-600/20')}>
                      {c.failedWithin24h ? 'failing' : c.lastOk === null ? 'no data' : c.lastOk ? 'ok' : 'last run failed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Recovery & Reliability ── */}
      {recovery && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"><ShieldCheck className="size-4" /> Recovery &amp; Reliability</h2>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className={cn('rounded-2xl border bg-card p-4', recovery.backup.status === 'ok' ? 'border-border' : 'border-rose-200')}>
              <p className="text-[12px] text-muted-foreground">Backup</p>
              <p className={cn('mt-1 text-[16px] font-bold capitalize', recovery.backup.status === 'ok' ? 'text-emerald-600' : recovery.backup.status === 'unknown' ? 'text-slate-500' : 'text-rose-600')}>{recovery.backup.status}</p>
              <p className="text-[11px] text-muted-foreground">{recovery.backup.ageHours !== null ? `${recovery.backup.ageHours}h old` : 'no report'}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[12px] text-muted-foreground">Deployment</p>
              <p className="mt-1 text-[16px] font-bold text-foreground">{recovery.deployment.version}</p>
              <p className="text-[11px] text-muted-foreground">{recovery.deployment.environment} · up {Math.floor(recovery.deployment.uptimeSeconds / 60)}m</p>
            </div>
            <Link href="/admin/incidents" className={cn('rounded-2xl border bg-card p-4 hover:bg-muted/30', recovery.openIncidents > 0 ? 'border-amber-200' : 'border-border')}>
              <p className="text-[12px] text-muted-foreground">Open incidents</p>
              <p className={cn('mt-1 text-[20px] font-bold', recovery.openIncidents > 0 ? 'text-amber-600' : 'text-foreground')}>{recovery.openIncidents < 0 ? '—' : recovery.openIncidents}</p>
              <p className="text-[11px] text-primary">Manage →</p>
            </Link>
          </div>

          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Dead Letter Queues</p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                  <th className="px-4 py-2.5">Queue</th><th className="px-4 py-2.5 text-right">Count</th><th className="px-4 py-2.5">Oldest</th><th className="px-4 py-2.5">Retry</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {([recovery.deadLetter.webhooks, recovery.deadLetter.refunds, recovery.deadLetter.reconciliations, recovery.deadLetter.settlements, recovery.deadLetter.broadcasts] as DeadLetterEntry[]).map(q => (
                    <tr key={q.key} className={cn(q.count > 0 && 'bg-amber-50/40')}>
                      <td className="px-4 py-2.5 font-medium text-foreground">{q.label}</td>
                      <td className={cn('px-4 py-2.5 text-right tabular-nums font-bold', q.count > 0 ? 'text-amber-600' : 'text-foreground')}>{q.count < 0 ? '—' : q.count}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{q.count > 0 ? fmtAgo(q.oldestAt) : '—'}</td>
                      <td className="px-4 py-2.5 text-[12px] text-muted-foreground">{q.retry}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Runbooks ── */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"><BookOpen className="size-4" /> Runbooks</h2>
        <div className="space-y-2">
          {RUNBOOKS.map(rb => (
            <details key={rb.id} className="rounded-xl border border-border bg-card">
              <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-[14px] font-medium text-foreground">
                <span>{rb.title}</span>
                <span className="flex items-center gap-2"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', rb.severity === 'critical' ? 'bg-rose-50 text-rose-700' : rb.severity === 'high' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600')}>{rb.severity}</span><ChevronDown className="size-4 text-muted-foreground" /></span>
              </summary>
              <div className="border-t border-border px-4 py-3 text-[13px]">
                <p className="mb-2 text-muted-foreground"><span className="font-semibold text-foreground">Trigger:</span> {rb.trigger}</p>
                <ol className="ml-4 list-decimal space-y-1.5">
                  {rb.steps.map((s, i) => <li key={i}><span className="font-medium text-foreground">{s.title}</span> — <span className="text-muted-foreground">{s.detail}</span></li>)}
                </ol>
                {rb.references.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {rb.references.map(r => <Link key={r.href} href={r.href} className="text-[12px] font-semibold text-primary hover:underline">{r.label}</Link>)}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <p className="text-[11px] text-muted-foreground">Snapshot generated {fmtAgo(health.generatedAt)}.</p>
    </div>
  )
}

interface HealthItem { label: string; value: number | string; danger?: boolean; text?: boolean }
function HealthGrid({ title, items }: { title: string; items: HealthItem[] }) {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map(i => (
          <div key={i.label} className={cn('rounded-2xl border bg-card p-4', i.danger ? 'border-rose-200' : 'border-border')}>
            <p className="text-[12px] text-muted-foreground">{i.label}</p>
            <p className={cn('mt-1 font-bold', i.text ? 'text-[15px]' : 'text-[20px]', i.danger ? 'text-rose-600' : 'text-foreground')}>
              {typeof i.value === 'number' && i.value < 0 ? '—' : i.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
