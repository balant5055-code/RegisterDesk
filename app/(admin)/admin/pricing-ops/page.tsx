'use client'

// RD-OPS-01 — Pricing Engine operational readiness dashboard. Admin-only, read-only.
// Renders /api/admin/pricing-ops (live metrics + durable ledger aggregates + health).

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  StatusPill, ErrorBanner, TableFrame, THead, Th, TBody, Tr, Td, type PillTone,
} from '@/components/admin'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils/cn'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

type Health = 'green' | 'yellow' | 'red'
type Dist = Record<string, number>

interface OpsData {
  status: { pricingEngineEnabled: boolean; configurationVersion: number; lastUpdated: string }
  liveMetrics: Record<string, number>
  rates: {
    snapshotUsedPct: number; ledgerFallbackPct: number; shadowMatchPct: number; shadowMismatchPct: number
    walletSnapshotPct: number; financeSnapshotPct: number; reportSnapshotPct: number
  }
  checksumFailuresTotal: number
  diagnostics: {
    totalOrders: number; ordersWithSnapshot: number; ordersUsingFallback: number; ordersWithShadowMismatch: number
    snapshotVersionDistribution: Dist; pricingVersionDistribution: Dist; configurationVersionDistribution: Dist
    topFailureReasons: { reason: string; count: number }[]; scanCap: number; truncated: boolean
  }
  health: Health
  healthReasons: string[]
}

const HEALTH_TONE: Record<Health, PillTone> = { green: 'success', yellow: 'warning', red: 'danger' }
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Distribution({ title, dist }: { title: string; dist: Dist }) {
  const rows = Object.entries(dist).sort((a, b) => a[0].localeCompare(b[0]))
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-foreground">{title}</div>
      <TableFrame>
        <THead><Th>Version</Th><Th align="right">Orders</Th></THead>
        <TBody>
          {rows.length === 0
            ? <Tr><Td colSpan={2}><span className="text-muted-foreground">No data</span></Td></Tr>
            : rows.map(([v, c]) => <Tr key={v}><Td>v{v}</Td><Td align="right">{c.toLocaleString('en-IN')}</Td></Tr>)}
        </TBody>
      </TableFrame>
    </div>
  )
}

export default function PricingOpsPage() {
  const [data, setData]       = useState<OpsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [saving, setSaving]   = useState(false)
  const { showToast }         = useToast()

  const load = useCallback(() => {
    setLoading(true); setError(null)
    ;(async () => {
      const token = await getToken()
      const res = await fetch('/api/admin/pricing-ops', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      return await res.json() as OpsData
    })()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  // RD-PAYMENT-06: flip the ALREADY-BUILT pricingEngineEnabled runtime flag via the
  // EXISTING PATCH endpoint. No new API, no new setting — just exposing the switch.
  // On success we re-load the ops data so the status reflects the persisted source of truth.
  const toggleEngine = useCallback(async (next: boolean) => {
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch('/api/admin/platform-settings', {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ features: { pricingEngineEnabled: next } }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(j?.error ?? `Request failed (${res.status})`)
      }
      showToast(next ? 'Attendee Pays Fees enabled' : 'Attendee Pays Fees disabled', 'success')
      load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update setting', 'error')
    } finally {
      setSaving(false)
    }
  }, [load, showToast])

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Pricing Engine Operations</h1>
          <p className="text-[13px] text-muted-foreground">Snapshot pipeline health · diagnostics only · read-only.</p>
        </div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-foreground hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && !data ? (
        <div className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : data ? (
        <>
          {/* Health */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <StatusPill tone={HEALTH_TONE[data.health]}>{data.health.toUpperCase()}</StatusPill>
              <span className="text-[13px] font-medium text-foreground">Overall Pricing Health</span>
            </div>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-muted-foreground">
              {data.healthReasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>

          {/* Platform features — expose the existing pricingEngineEnabled runtime flag */}
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-foreground">Platform Features</h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-foreground">Attendee Pays Fees</span>
                    <StatusPill tone={data.status.pricingEngineEnabled ? 'success' : 'neutral'}>
                      {data.status.pricingEngineEnabled ? 'ON' : 'OFF'}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">
                    Enable organizers to select &ldquo;Attendee Pays Fees&rdquo; when creating events. While off, the
                    builder shows &ldquo;Coming Soon&rdquo; and every event uses Organizer Absorbs Fees.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={data.status.pricingEngineEnabled}
                  aria-label="Attendee Pays Fees"
                  disabled={saving}
                  onClick={() => void toggleEngine(!data.status.pricingEngineEnabled)}
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50',
                    data.status.pricingEngineEnabled ? 'bg-emerald-500' : 'bg-muted',
                  )}
                >
                  {saving ? (
                    <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin text-foreground" />
                  ) : (
                    <span className={cn(
                      'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                      data.status.pricingEngineEnabled ? 'translate-x-5' : 'translate-x-0.5',
                    )} />
                  )}
                </button>
              </div>
            </div>
          </section>

          {/* Engine status */}
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-foreground">Pricing Engine Status</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Engine Enabled" value={data.status.pricingEngineEnabled ? 'ON' : 'OFF'}
                    hint={data.status.pricingEngineEnabled ? 'engine authoritative' : 'lib/fees authoritative'} />
              <Stat label="Config Version" value={`v${data.status.configurationVersion}`} />
              <Stat label="Snapshot Used" value={`${data.rates.snapshotUsedPct}%`} hint="ledger financials" />
              <Stat label="Ledger Fallback" value={`${data.rates.ledgerFallbackPct}%`} />
              <Stat label="Shadow Match" value={`${data.rates.shadowMatchPct}%`} />
              <Stat label="Shadow Mismatch" value={`${data.rates.shadowMismatchPct}%`} />
              <Stat label="Checksum Failures" value={data.checksumFailuresTotal} hint="all namespaces (live)" />
              <Stat label="Last Updated" value={fmt(data.status.lastUpdated)} />
            </div>
          </section>

          {/* Per-layer snapshot usage */}
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-foreground">Snapshot Usage by Layer (live)</h2>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Wallet Snapshot" value={`${data.rates.walletSnapshotPct}%`} />
              <Stat label="Finance Snapshot" value={`${data.rates.financeSnapshotPct}%`} />
              <Stat label="Report Snapshot" value={`${data.rates.reportSnapshotPct}%`} />
            </div>
          </section>

          {/* Diagnostics */}
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-foreground">
              Order Diagnostics <span className="font-normal text-muted-foreground">
                (last {data.diagnostics.scanCap.toLocaleString('en-IN')}{data.diagnostics.truncated ? '+' : ''})
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Total Orders" value={data.diagnostics.totalOrders.toLocaleString('en-IN')} />
              <Stat label="With Snapshot" value={data.diagnostics.ordersWithSnapshot.toLocaleString('en-IN')} />
              <Stat label="Using Fallback" value={data.diagnostics.ordersUsingFallback.toLocaleString('en-IN')} />
              <Stat label="Shadow Mismatch" value={data.diagnostics.ordersWithShadowMismatch.toLocaleString('en-IN')} />
            </div>
            {data.diagnostics.topFailureReasons.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[12px] font-medium text-foreground">Top Failure Reasons</div>
                <TableFrame>
                  <THead><Th>Reason</Th><Th align="right">Orders</Th></THead>
                  <TBody>
                    {data.diagnostics.topFailureReasons.map(f => (
                      <Tr key={f.reason}><Td>{f.reason}</Td><Td align="right">{f.count.toLocaleString('en-IN')}</Td></Tr>
                    ))}
                  </TBody>
                </TableFrame>
              </div>
            )}
          </section>

          {/* Version distributions */}
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-foreground">Version Distribution</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Distribution title="Snapshot Version" dist={data.diagnostics.snapshotVersionDistribution} />
              <Distribution title="Pricing Version" dist={data.diagnostics.pricingVersionDistribution} />
              <Distribution title="Configuration Version" dist={data.diagnostics.configurationVersionDistribution} />
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
