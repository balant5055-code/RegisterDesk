// Operations Center / NOC aggregation service (GA-2 S4). Server-only.
//
// READ aggregation over the EXISTING generic job engine (lib/jobs) and every
// feature job collection. It NEVER reimplements job logic: status/counts/error/
// timestamps are read straight off the shared Job shape. The ONLY mutation the NOC
// performs is CANCEL, done by the endpoint via the kernel's existing cancelJob().
// No new queue, no new job engine, no retry engine (retry is honestly unsupported).
//
// Collection names mirror the source constants (kept as literals to avoid importing
// the heavy job-runner modules into this read service):
//   printGenerationJobs / printPackageJobs        (lib/printAssets/*)
//   certificateJobs                               (lib/certificates/constants COLLECTIONS.JOBS)
//   registrationImportJobs / registrationBulkJobs (lib/registrations/*)
//   reportExportJobs                              (lib/reports/exportJob)
//   emailBroadcastJobs / whatsappBroadcastJobs    (lib/broadcasts/*)

import { adminDb } from '@/lib/firebase/admin'
import type { Job, JobStatus } from '@/lib/jobs/types'
import type {
  EngineKey, EngineStatus, JobStatusRollup, OpsOverview, OpsJobView,
  EngineMonitoring, OpsMonitoring, OpsTimelineEntry, HealthIndicator, HealthLevel,
} from '@/lib/admin/operationsCenterTypes'

interface EngineDef { key: EngineKey; label: string; collections: string[] }

export const ENGINES: EngineDef[] = [
  { key: 'print',       label: 'Print',             collections: ['printGenerationJobs', 'printPackageJobs'] },
  { key: 'certificate', label: 'Certificate',       collections: ['certificateJobs'] },
  { key: 'import',      label: 'Import',            collections: ['registrationImportJobs'] },
  { key: 'export',      label: 'Reports & Exports', collections: ['reportExportJobs'] },
  { key: 'broadcast',   label: 'Broadcast',         collections: ['emailBroadcastJobs', 'whatsappBroadcastJobs'] },
  { key: 'bulk',        label: 'Bulk Operations',   collections: ['registrationBulkJobs'] },
]

export const ALL_COLLECTIONS = new Set(ENGINES.flatMap(e => e.collections))
const COLLECTION_ENGINE = new Map<string, EngineDef>()
for (const e of ENGINES) for (const c of e.collections) COLLECTION_ENGINE.set(c, e)

// ─── helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
function tsMs(ts: unknown): number | null {
  if (ts && typeof (ts as { toMillis?: () => number }).toMillis === 'function') {
    try { return (ts as { toMillis: () => number }).toMillis() } catch { return null }
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const numOf = (v: unknown): number => (typeof v === 'number' ? v : 0)

async function countOf(q: FirebaseFirestore.Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}

const TERMINAL: JobStatus[] = ['completed', 'cancelled']
function isCancellable(status: JobStatus): boolean { return !TERMINAL.includes(status) }

function toJobView(collection: string, doc: FirebaseFirestore.QueryDocumentSnapshot): OpsJobView {
  const engine = COLLECTION_ENGINE.get(collection)
  const j = doc.data() as Job & Record<string, unknown>
  const counts = (j.counts ?? {}) as { total?: number; processed?: number; succeeded?: number; failed?: number }
  const startMs = tsMs(j.startedAt)
  const endMs   = tsMs(j.completedAt)
  const status  = (j.status ?? 'pending') as JobStatus
  return {
    jobId:        doc.id,
    collection,
    engine:       engine?.key ?? 'bulk',
    engineLabel:  engine?.label ?? collection,
    status,
    total:        numOf(counts.total),
    processed:    numOf(counts.processed),
    succeeded:    numOf(counts.succeeded),
    failed:       numOf(counts.failed),
    error:        str(j.error),
    organizerUid: str(j.organizerUid),
    eventId:      str(j.eventId) ?? str(j.eventSlug),
    campaignId:   str(j.campaignId),
    createdAt:    tsToISO(j.createdAt),
    startedAt:    tsToISO(j.startedAt),
    completedAt:  tsToISO(j.completedAt),
    durationMs:   startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : null,
    cancellable:  isCancellable(status),
    retrySupported: false,   // no retry engine exists — surfaced honestly in the UI
  }
}

// ─── Overview (status rollup + health) ──────────────────────────────────────

async function collectionRollup(collection: string): Promise<JobStatusRollup> {
  const c = adminDb.collection(collection)
  const [total, running, waiting, failed, completed, cancelled] = await Promise.all([
    countOf(c),
    countOf(c.where('status', '==', 'processing')),
    countOf(c.where('status', '==', 'pending')),
    countOf(c.where('status', '==', 'failed')),
    countOf(c.where('status', '==', 'completed')),
    countOf(c.where('status', '==', 'cancelled')),
  ])
  return { total, running, waiting, failed, completed, cancelled }
}

function engineHealth(key: EngineKey | 'queue', label: string, r: JobStatusRollup): HealthIndicator {
  let level: HealthLevel = 'neutral'
  if (r.total === 0) level = 'neutral'
  else if (r.failed > 0 && (r.failed >= r.completed || r.failed > 10)) level = 'red'
  else if (r.failed > 0 || r.running > 0) level = r.failed > 0 ? 'yellow' : 'green'
  else level = 'green'
  const detail = r.total === 0 ? 'Idle' : `${r.running} running · ${r.failed} failed / ${r.total}`
  return { key, label, level, detail }
}

export async function getOpsOverview(): Promise<OpsOverview> {
  const perCollection = new Map<string, JobStatusRollup>()
  await Promise.all([...ALL_COLLECTIONS].map(async c => { perCollection.set(c, await collectionRollup(c)) }))

  const engines: EngineStatus[] = ENGINES.map(e => {
    const agg: JobStatusRollup = { total: 0, running: 0, waiting: 0, failed: 0, completed: 0, cancelled: 0 }
    for (const c of e.collections) {
      const r = perCollection.get(c)
      if (!r) continue
      agg.total += r.total; agg.running += r.running; agg.waiting += r.waiting
      agg.failed += r.failed; agg.completed += r.completed; agg.cancelled += r.cancelled
    }
    return { key: e.key, label: e.label, ...agg }
  })

  const overall: JobStatusRollup = engines.reduce((a, e) => ({
    total: a.total + e.total, running: a.running + e.running, waiting: a.waiting + e.waiting,
    failed: a.failed + e.failed, completed: a.completed + e.completed, cancelled: a.cancelled + e.cancelled,
  }), { total: 0, running: 0, waiting: 0, failed: 0, completed: 0, cancelled: 0 })

  const health: HealthIndicator[] = engines.map(e => engineHealth(e.key, `${e.label} Engine`, e))
  health.push(engineHealth('queue', 'Overall Queue', overall))

  return { engines, overall, health }
}

// ─── Jobs list (Operations / Failures) ──────────────────────────────────────

export async function listOpsJobs(opts: { collection?: string; status?: string; search?: string; limit?: number }): Promise<{ jobs: OpsJobView[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200)
  const targets = opts.collection && ALL_COLLECTIONS.has(opts.collection) ? [opts.collection] : [...ALL_COLLECTIONS]
  const perColl = Math.max(Math.ceil(limit / targets.length) + 1, 15)

  const pages = await Promise.all(targets.map(async c => {
    try {
      const snap = await adminDb.collection(c).orderBy('createdAt', 'desc').limit(perColl).get()
      return snap.docs.map(d => toJobView(c, d))
    } catch { return [] as OpsJobView[] }
  }))

  let jobs = pages.flat()
  if (opts.status) jobs = jobs.filter(j => j.status === opts.status)
  const q = (opts.search ?? '').trim().toLowerCase()
  if (q) jobs = jobs.filter(j =>
    j.jobId.toLowerCase().includes(q) ||
    (j.organizerUid ?? '').toLowerCase().includes(q) ||
    (j.eventId ?? '').toLowerCase().includes(q) ||
    (j.campaignId ?? '').toLowerCase().includes(q))

  jobs.sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0))
  const truncated = jobs.length > limit
  return { jobs: jobs.slice(0, limit), truncated }
}

// ─── Monitoring (rates / durations / throughput from a bounded sample) ──────

const SAMPLE = 40

export async function getOpsMonitoring(): Promise<OpsMonitoring> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000

  const engines: EngineMonitoring[] = await Promise.all(ENGINES.map(async e => {
    const docs: OpsJobView[] = []
    for (const c of e.collections) {
      try {
        const snap = await adminDb.collection(c).orderBy('createdAt', 'desc').limit(SAMPLE).get()
        for (const d of snap.docs) docs.push(toJobView(c, d))
      } catch { /* skip collection */ }
    }
    const completed = docs.filter(d => d.status === 'completed')
    const failed    = docs.filter(d => d.status === 'failed')
    const running   = docs.filter(d => d.status === 'processing' || d.status === 'pending')
    const terminal  = completed.length + failed.length
    const durations = completed.map(d => d.durationMs).filter((n): n is number => typeof n === 'number')
    const avgDurationMs = durations.length ? Math.round(durations.reduce((a, n) => a + n, 0) / durations.length) : null
    const throughputPerDay = docs.filter(d => d.createdAt && Date.parse(d.createdAt) >= dayAgo).length
    return {
      key: e.key, label: e.label, sampled: docs.length,
      completed: completed.length, failed: failed.length, running: running.length,
      successRatePct: terminal ? Math.round((completed.length / terminal) * 100) : null,
      failureRatePct: terminal ? Math.round((failed.length / terminal) * 100) : null,
      avgDurationMs, throughputPerDay,
    }
  }))

  return { engines, sampleSize: SAMPLE }
}

// ─── Timeline (merged job lifecycle events) ─────────────────────────────────

export async function getOpsTimeline(): Promise<OpsTimelineEntry[]> {
  const entries: OpsTimelineEntry[] = []

  await Promise.all([...ALL_COLLECTIONS].map(async c => {
    try {
      const snap = await adminDb.collection(c).orderBy('createdAt', 'desc').limit(30).get()
      for (const d of snap.docs) {
        const v = toJobView(c, d)
        const owner = v.eventId ?? v.campaignId ?? v.organizerUid
        entries.push({ id: `${c}:${d.id}:created`, engine: v.engine, kind: 'created', detail: `${v.engineLabel} job started`, entity: owner, jobId: d.id, at: v.createdAt })
        if (v.status === 'completed' || v.status === 'failed' || v.status === 'cancelled') {
          entries.push({
            id: `${c}:${d.id}:${v.status}`, engine: v.engine,
            kind: v.status === 'completed' ? 'completed' : v.status === 'failed' ? 'failed' : 'cancelled',
            detail: v.status === 'failed' ? (v.error ?? 'Job failed') : `${v.engineLabel} job ${v.status}`,
            entity: owner, jobId: d.id, at: v.completedAt ?? v.createdAt,
          })
        }
      }
    } catch { /* skip collection */ }
  }))

  entries.sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity))
  return entries.slice(0, 300)
}
