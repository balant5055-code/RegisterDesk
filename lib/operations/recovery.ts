// Recovery & reliability aggregation (Phase G.6). Server-only, READ-ONLY.
//
// Surfaces backup health, dead-letter-queue depths, deployment health and open
// incident count for the admin Operations dashboard. Writes nothing except via the
// incident service; backupStatus is written by an EXTERNAL backup job — this module
// only reads it (monitoring/visibility, not backup infrastructure).

import { adminDb } from '@/lib/firebase/admin'
import { countOpenIncidents } from '@/lib/operations/incidents'

// Captured at module init ≈ serverless instance boot (proxy for deploy freshness;
// per-instance on serverless — see uptimeSeconds note).
const BOOT_AT = Date.now()
const BACKUP_STALE_HOURS = 26   // daily backup + grace

const ms = (v: unknown): number => {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  return 0
}
const iso = (n: number): string | null => (n > 0 ? new Date(n).toISOString() : null)

// ─── Backup health (reads externally-written backupStatus/latest) ──────────────

export interface BackupHealth {
  status:       'ok' | 'stale' | 'failed' | 'unknown'
  lastBackupAt: string | null
  ageHours:     number | null
  sizeBytes:    number | null
  error:        string | null
}

async function getBackupHealth(): Promise<BackupHealth> {
  try {
    const snap = await adminDb.doc('backupStatus/latest').get()
    if (!snap.exists) return { status: 'unknown', lastBackupAt: null, ageHours: null, sizeBytes: null, error: null }
    const d = snap.data() as { lastBackupAt?: unknown; status?: string; sizeBytes?: number; error?: string }
    const lastMs = ms(d.lastBackupAt)
    const ageHours = lastMs > 0 ? (Date.now() - lastMs) / 3_600_000 : null
    let status: BackupHealth['status'] = 'unknown'
    if (d.status === 'failed') status = 'failed'
    else if (lastMs > 0) status = ageHours !== null && ageHours > BACKUP_STALE_HOURS ? 'stale' : 'ok'
    return { status, lastBackupAt: iso(lastMs), ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10, sizeBytes: d.sizeBytes ?? null, error: d.error ?? null }
  } catch {
    return { status: 'unknown', lastBackupAt: null, ageHours: null, sizeBytes: null, error: 'read_failed' }
  }
}

// ─── Dead letter queues ─────────────────────────────────────────────────────────

export interface DeadLetterEntry { key: string; label: string; count: number; oldestAt: string | null; retry: string }

interface DlqSpec { collection: string; field: string; value: string }

async function dlq(label: string, key: string, retry: string, specs: DlqSpec[]): Promise<DeadLetterEntry> {
  let count = 0, oldest = 0
  for (const s of specs) {
    const base = adminDb.collection(s.collection).where(s.field, '==', s.value)
    try {
      const c = await base.count().get()
      count += c.data().count
    } catch { count = -1 }
    // Oldest from a bounded sample (failures should be few; single-equality auto-index, no orderBy).
    try {
      const sample = await base.limit(200).get()
      for (const doc of sample.docs) {
        const data = doc.data() as { createdAt?: unknown; firstSeenAt?: unknown }
        const t = ms(data.createdAt ?? data.firstSeenAt)
        if (t > 0 && (oldest === 0 || t < oldest)) oldest = t
      }
    } catch { /* leave oldest */ }
  }
  return { key, label, count, oldestAt: iso(oldest), retry }
}

export interface DeadLetterHealth { webhooks: DeadLetterEntry; refunds: DeadLetterEntry; reconciliations: DeadLetterEntry; settlements: DeadLetterEntry; broadcasts: DeadLetterEntry }

// ─── Deployment health ──────────────────────────────────────────────────────────

export interface DeploymentHealth {
  version:        string
  environment:    string
  bootAt:         string
  uptimeSeconds:  number
}

function getDeploymentHealth(): DeploymentHealth {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7)
  return {
    version:       sha || 'unknown',
    environment:   process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    bootAt:        new Date(BOOT_AT).toISOString(),
    uptimeSeconds: Math.round((Date.now() - BOOT_AT) / 1000),   // per serverless instance
  }
}

// ─── Aggregate ──────────────────────────────────────────────────────────────────

export interface RecoveryHealth {
  backup:        BackupHealth
  deadLetter:    DeadLetterHealth
  deployment:    DeploymentHealth
  openIncidents: number
  generatedAt:   string
}

export async function getRecoveryHealth(): Promise<RecoveryHealth> {
  const [backup, webhooks, refunds, reconciliations, settlements, broadcasts, openIncidents] = await Promise.all([
    getBackupHealth(),
    dlq('Failed webhook deliveries', 'webhooks', 'Auto-retries via webhooks cron; exhausted are terminal', [{ collection: 'webhookDeliveries', field: 'status', value: 'failed' }]),
    dlq('Failed refunds', 'refunds', 'Manual retry — admin failed-refunds', [{ collection: 'failedRefunds', field: 'status', value: 'open' }]),
    dlq('Failed reconciliations', 'reconciliations', 'Auto-drains via reconciliation crons', [
      { collection: 'registrationFinancialReconciliation', field: 'status', value: 'pending' },
      { collection: 'donationFinancialReconciliation', field: 'status', value: 'pending' },
      { collection: 'walletTopupReconciliation', field: 'status', value: 'pending' },
    ]),
    dlq('Rejected settlements', 'settlements', 'Manual — review + re-request', [{ collection: 'settlementRequests', field: 'status', value: 'rejected' }]),
    dlq('Failed broadcasts', 'broadcasts', 'Manual — organizer re-sends', [{ collection: 'broadcastCampaigns', field: 'status', value: 'failed' }]),
    countOpenIncidents(),
  ])

  return {
    backup,
    deadLetter: { webhooks, refunds, reconciliations, settlements, broadcasts },
    deployment: getDeploymentHealth(),
    openIncidents,
    generatedAt: new Date().toISOString(),
  }
}
