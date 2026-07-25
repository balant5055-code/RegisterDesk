// GET /api/admin/pricing-ops — RD-OPS-01 operational readiness diagnostics.
//
// Admin-only, READ-ONLY. Combines two sources:
//   • Live in-memory pricing metrics (getPricingMetrics) — process-level counters of
//     snapshot-vs-fallback decisions across payments/wallet/finance/reports since the
//     current process started. Per-instance (serverless), so treat as a live signal.
//   • Durable ledger aggregates — a capped scan of platformTransactions reading the
//     additive pricingSnapshot / pricingSnapshotMeta / pricingSource fields (02B–02F).
//
// Modifies nothing. No pricing calculation, no writes.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getPricingMetrics, resolvePlatformPricing } from '@/lib/platform/pricing'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

const LEDGER_SCAN_CAP = 5000

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0)

type Health = 'green' | 'yellow' | 'red'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Engine status ────────────────────────────────────────────────────────────
  const settings = await resolvePlatformPricing()

  // ── Live metrics ─────────────────────────────────────────────────────────────
  const m = getPricingMetrics()
  const decisionTotal = m.snapshotUsed + m.fallbackUsed
  const shadowTotal   = m.shadowMatches + m.shadowMismatches
  const checksumFailuresTotal =
    m.checksumFailures + m.walletChecksumFailures + m.financeChecksumFailures + m.reportChecksumFailures

  const rates = {
    snapshotUsedPct:   pct(m.snapshotUsed, decisionTotal),
    ledgerFallbackPct: pct(m.fallbackUsed, decisionTotal),
    shadowMatchPct:    pct(m.shadowMatches, shadowTotal),
    shadowMismatchPct: pct(m.shadowMismatches, shadowTotal),
    walletSnapshotPct: pct(m.walletSnapshotUsed, m.walletSnapshotUsed + m.walletFallbackUsed),
    financeSnapshotPct: pct(m.financeSnapshotUsed, m.financeSnapshotUsed + m.financeFallbackUsed),
    reportSnapshotPct: pct(m.reportSnapshotUsed, m.reportSnapshotUsed + m.reportFallbackUsed),
  }

  // ── Durable ledger aggregates ────────────────────────────────────────────────
  const snap = await adminDb.collection('platformTransactions').orderBy('paidAt', 'desc').limit(LEDGER_SCAN_CAP + 1).get()
  const truncated = snap.docs.length > LEDGER_SCAN_CAP
  const docs = truncated ? snap.docs.slice(0, LEDGER_SCAN_CAP) : snap.docs

  let totalOrders = 0, ordersWithSnapshot = 0, ordersUsingFallback = 0, ordersWithShadowMismatch = 0
  const snapshotVersionDistribution:      Record<string, number> = {}
  const pricingVersionDistribution:       Record<string, number> = {}
  const configurationVersionDistribution: Record<string, number> = {}
  const failureReasons: Record<string, number> = {}

  for (const doc of docs) {
    const d = doc.data() as PlatformTransactionDocument
    totalOrders++
    const meta = d.pricingSnapshotMeta

    if (d.pricingSnapshot) ordersWithSnapshot++
    else failureReasons['no_snapshot'] = (failureReasons['no_snapshot'] ?? 0) + 1

    if (d.pricingSource === 'fallback' || !d.pricingSource) ordersUsingFallback++

    if (meta) {
      const sv = String(meta.snapshotVersion), pv = String(meta.pricingVersion), cv = String(meta.configurationVersion)
      snapshotVersionDistribution[sv]      = (snapshotVersionDistribution[sv]      ?? 0) + 1
      pricingVersionDistribution[pv]       = (pricingVersionDistribution[pv]       ?? 0) + 1
      configurationVersionDistribution[cv] = (configurationVersionDistribution[cv] ?? 0) + 1
      if (meta.shadowMatch === false) {
        ordersWithShadowMismatch++
        failureReasons['shadow_mismatch'] = (failureReasons['shadow_mismatch'] ?? 0) + 1
      }
    }
  }

  const topFailureReasons = Object.entries(failureReasons)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([reason, count]) => ({ reason, count }))

  // ── Health ───────────────────────────────────────────────────────────────────
  let health: Health
  const healthReasons: string[] = []
  if (checksumFailuresTotal > 0) {
    health = 'red'
    healthReasons.push(`${checksumFailuresTotal} checksum failure(s) — snapshot integrity compromised`)
  } else if (m.shadowMismatches > 0 || ordersWithShadowMismatch > 0) {
    health = 'yellow'
    healthReasons.push('shadow mismatches detected — engine diverges from production; verify before cutover')
  } else if (totalOrders > 0 && ordersWithSnapshot === 0) {
    health = 'yellow'
    healthReasons.push('no scanned orders carry a snapshot yet — pre-02B history or capture disabled')
  } else {
    health = 'green'
    healthReasons.push('snapshots valid and matching production; lib/fees fallback healthy')
  }

  return NextResponse.json({
    status: {
      pricingEngineEnabled: settings.features.pricingEngineEnabled,
      configurationVersion: settings.metadata.version,
      lastUpdated:          new Date().toISOString(),
    },
    liveMetrics: m,
    rates,
    checksumFailuresTotal,
    diagnostics: {
      totalOrders,
      ordersWithSnapshot,
      ordersUsingFallback,
      ordersWithShadowMismatch,
      snapshotVersionDistribution,
      pricingVersionDistribution,
      configurationVersionDistribution,
      topFailureReasons,
      scanCap: LEDGER_SCAN_CAP,
      truncated,
    },
    health,
    healthReasons,
  })
}
