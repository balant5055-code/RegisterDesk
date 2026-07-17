// Print Asset packaging on the generic job runner (PA-6). Server-only.
//
// Packages the PDFs a PA-4 generation job ALREADY produced into ONE ZIP. It NEVER
// renders, regenerates, or reopens the renderer — it reads the generated files back
// from Storage (SSRF-guarded, owner-scoped) and archives them. Execution is the ROE
// generic runner; this module supplies the four JobStrategy hooks.
//
// REUSE — nothing is redesigned or duplicated:
//   • Generic Job Runner / Kernel  → lease / cursor / resume / cancel / progress.
//   • buildStoredZip (lib/zip)      → shared with the XLSX writer.
//   • safeFetchBytes + validateStorageUrl (certificates/urlGuard) → read PDFs back.
//   • uploadServerFile             → store the ZIP + token URL.
//   • PA-4 items (output/passId/category) + PrintGenerationFilters.

import crypto            from 'crypto'
import { Timestamp }     from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult, JobPage } from '@/lib/jobs/runner'
import type { Job, JobStatus, JobCounts } from '@/lib/jobs/types'
import { buildStoredZip, type ZipEntry } from '@/lib/zip/store'
import { uploadServerFile } from '@/lib/firebase/storage/admin'
import { notifyPrintJobComplete } from '@/lib/notifications/inbox/notify'
import { validateStorageUrl, safeFetchBytes } from '@/lib/certificates/urlGuard'
import {
  getPrintGenerationJob, listPrintJobItems,
  type PrintGenerationFilters, type PrintJobItem,
} from './generationJob'
import type { PrintAssetType } from '@/lib/printAssets/types'

export const PRINT_PACKAGE_JOBS = 'printPackageJobs'

const PACKAGE_BUDGET_MS = 55_000
const PACKAGE_LEASE_MS   = 120_000
const EXPIRY_MS          = 24 * 60 * 60 * 1000     // download links valid for 24h
const MAX_FILE_BYTES     = 30 * 1024 * 1024        // per-PDF read cap
const MAX_FILES          = 20_000                  // ZIP entry / memory guard
const FETCH_CONCURRENCY  = 8

// ─── Job document ────────────────────────────────────────────────────────────────
export interface PrintPackageOutput {
  path:        string
  filename:    string
  contentType: string
  fileCount:   number
  expiresAt:   unknown   // Firestore Timestamp
  url:         string     // token URL — server-side only (download route redirects)
}

export interface PrintPackageStats { filesTotal: number; packaged: number; missing: number; failed: number }
export interface PrintPackageFailure { registrationId: string; filename: string; reason: string }

// printPackageJobs/{jobId} — generic control fields (Job) + payload.
export interface PrintPackageJob extends Job {
  sourceJobId: string
  eventId:     string
  eventSlug:   string
  assetType:   PrintAssetType
  filters:     PrintGenerationFilters
  stats?:      PrintPackageStats
  failures?:   PrintPackageFailure[]
  output?:     PrintPackageOutput
}

// ─── Filtering (reuses the PA-4 generation filters over the source items) ────────
/** Select which of the source job's generated items to include. Pure. */
export function selectPackageItems(items: PrintJobItem[], f: PrintGenerationFilters): PrintJobItem[] {
  const idSet = f.registrationIds && f.registrationIds.length ? new Set(f.registrationIds) : null
  return items.filter(it => {
    if (idSet && !idSet.has(it.registrationId)) return false
    if (f.pass && it.passId !== f.pass) return false
    if (f.category && it.category !== f.category && it.passName !== f.category) return false
    return true
  })
}

// ─── Job creation ────────────────────────────────────────────────────────────────
export async function createPrintPackageJob(meta: {
  sourceJobId: string; eventId: string; eventSlug: string; assetType: PrintAssetType
  filters: PrintGenerationFilters; organizerUid: string; createdBy: string
}): Promise<PrintPackageJob> {
  const jobId = `pkg_${crypto.randomUUID()}`
  return kernelCreateJob<PrintPackageJob>(
    PRINT_PACKAGE_JOBS,
    jobId,
    {
      organizerUid: meta.organizerUid,
      createdBy:    meta.createdBy,
      sourceJobId:  meta.sourceJobId,
      eventId:      meta.eventId,
      eventSlug:    meta.eventSlug,
      assetType:    meta.assetType,
      filters:      meta.filters,
    },
    1,   // one packaging unit (per-file counts live in `stats`)
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────
function tsMillis(v: unknown): number {
  return v instanceof Timestamp ? v.toMillis()
    : (v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis(): number }).toMillis() : 0)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ─── Strategy ────────────────────────────────────────────────────────────────────

interface PackageCtx { organizerUid: string }
type PackageUnit = { go: true }

export function printPackageStrategy(): JobStrategy<PrintPackageJob, PackageCtx, PackageUnit> {
  return {
    // Verify the source generation job exists and is owned by this workspace.
    async loadContext(job) {
      const source = await getPrintGenerationJob(job.sourceJobId)
      if (!source || source.organizerUid !== job.organizerUid) {
        return { ok: false, error: 'Source generation job not found' }
      }
      return { ok: true, ctx: { organizerUid: job.organizerUid } }
    },

    // Single unit — the packaging build. Cursor guards re-entry so a resumed chunk
    // asks once (then the page is empty). Idempotent: a re-run rebuilds + overwrites.
    async fetchPage(_job, _ctx, cursor): Promise<JobPage<PackageUnit>> {
      if (cursor) return { items: [], nextCursor: cursor, hasMore: false }
      return { items: [{ go: true }], nextCursor: 'done', hasMore: false }
    },

    // Read every already-generated PDF back → ZIP → upload. Per-file failures are
    // recorded and packaging continues; the renderer is never touched.
    async processItem(_unit, job, ctx) {
      try {
        const all      = await listPrintJobItems(job.sourceJobId)
        const selected = selectPackageItems(all, job.filters).slice(0, MAX_FILES)
        const now      = Date.now()

        type Result = { entry?: ZipEntry; failure?: PrintPackageFailure; kind: 'ok' | 'missing' | 'failed' }
        const results = await mapLimit(selected, FETCH_CONCURRENCY, async (it): Promise<Result> => {
          if (!it.output) {
            return { kind: 'missing', failure: { registrationId: it.registrationId, filename: '', reason: 'not generated' } }
          }
          const filename = it.output.filename || `${it.registrationId}.pdf`
          if (tsMillis(it.output.expiresAt) && tsMillis(it.output.expiresAt) < now) {
            return { kind: 'failed', failure: { registrationId: it.registrationId, filename, reason: 'source PDF expired' } }
          }
          const check = validateStorageUrl(it.output.url)
          if (!check.ok || !check.objectPath || !check.objectPath.startsWith(`printAssets/${ctx.organizerUid}/`)) {
            return { kind: 'failed', failure: { registrationId: it.registrationId, filename, reason: 'invalid storage path' } }
          }
          const bytes = await safeFetchBytes(it.output.url, check, { timeoutMs: 15000, maxBytes: MAX_FILE_BYTES }).catch(() => null)
          if (!bytes) {
            return { kind: 'failed', failure: { registrationId: it.registrationId, filename, reason: 'storage read failed' } }
          }
          return { kind: 'ok', entry: { name: filename, data: Buffer.from(bytes) } }
        })

        // Assemble, de-duplicating in-archive names.
        const seen = new Set<string>()
        const entries: ZipEntry[] = []
        const failures: PrintPackageFailure[] = []
        let missing = 0, failed = 0
        for (let k = 0; k < results.length; k++) {
          const r = results[k]
          if (r.kind === 'ok' && r.entry) {
            let name = r.entry.name
            if (seen.has(name)) name = name.replace(/(\.pdf)?$/i, `-${selected[k].registrationId}.pdf`)
            seen.add(name)
            entries.push({ name, data: r.entry.data })
          } else if (r.failure) {
            if (r.kind === 'missing') missing++; else failed++
            failures.push(r.failure)
          }
        }

        const zip      = buildStoredZip(entries)
        const filename = `${job.assetType.toLowerCase()}-${job.eventSlug || 'event'}-${job.jobId}.zip`
        const path     = `printPackages/${job.organizerUid}/${job.jobId}/${filename}`
        const { url }  = await uploadServerFile(path, zip, 'application/zip')

        const stats: PrintPackageStats = { filesTotal: selected.length, packaged: entries.length, missing, failed }
        const output: PrintPackageOutput = {
          path, filename, contentType: 'application/zip', url, fileCount: entries.length,
          expiresAt: Timestamp.fromMillis(now + EXPIRY_MS),
        }
        await adminDb.collection(PRINT_PACKAGE_JOBS).doc(job.jobId).update({
          output, stats, failures: failures.slice(0, 200),
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'packaging failed' }
      }
    },
    // EA-4 S3: one grouped Notification-Center entry when packaging finishes.
    async onComplete(job) {
      const j = job as unknown as { organizerUid?: string; eventSlug?: string | null; stats?: { packaged?: number; failed?: number } }
      if (j.organizerUid) void notifyPrintJobComplete({
        workspaceUid: j.organizerUid, jobId: job.jobId, kind: 'package', eventId: j.eventSlug ?? null,
        succeeded: j.stats?.packaged ?? job.counts.succeeded, failed: j.stats?.failed ?? job.counts.failed,
      })
    },
  }
}

/** Advances one chunk of a package job. Safe to call repeatedly (resumes). */
export function processPrintPackageChunk(jobId: string): Promise<ProcessResult> {
  return runJobChunk(jobId, printPackageStrategy(), {
    collection: PRINT_PACKAGE_JOBS,
    pageSize:   1,
    budgetMs:   PACKAGE_BUDGET_MS,
    leaseMs:    PACKAGE_LEASE_MS,
  })
}

export function getPrintPackageJob(jobId: string): Promise<PrintPackageJob | null> {
  return getJob<PrintPackageJob>(PRINT_PACKAGE_JOBS, jobId)
}

// ─── Client-safe view (storage token URL + path stay server-side) ───────────────
export interface PrintPackageJobView {
  jobId:       string
  status:      JobStatus
  counts:      JobCounts
  error?:      string | null
  sourceJobId: string
  eventId:     string
  assetType:   PrintAssetType
  createdAt:   string | null
  ready:       boolean
  stats?:      PrintPackageStats
  failures?:   PrintPackageFailure[]
  output?:     { filename: string; fileCount: number; expiresAt: string | null }
}

function toIso(v: unknown): string | null {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function toPackageJobView(job: PrintPackageJob): PrintPackageJobView {
  return {
    jobId:       job.jobId,
    status:      job.status,
    counts:      job.counts,
    error:       typeof job.error === 'string' ? job.error : null,
    sourceJobId: job.sourceJobId,
    eventId:     job.eventId,
    assetType:   job.assetType,
    createdAt:   toIso(job.createdAt),
    ready:       !!job.output,
    stats:       job.stats,
    failures:    job.failures,
    output:      job.output
      ? { filename: job.output.filename, fileCount: job.output.fileCount, expiresAt: toIso(job.output.expiresAt) }
      : undefined,
  }
}
