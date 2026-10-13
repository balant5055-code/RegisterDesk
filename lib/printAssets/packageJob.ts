// Print Asset packaging on the generic job runner (PA-6). Server-only.
//
// A package is a ZIP of the cards a PA-4 generation job produced, optionally narrowed
// by the same filters. Execution is the ROE generic runner; this module supplies the
// four JobStrategy hooks.
//
// ═══ NO STORED OUTPUT (RD-PRINT-P0) ══════════════════════════════════════════════
// Packaging used to read every stored card PDF back from Storage, build the ZIP and
// upload it to `printPackages/…` with a PERMANENT, unauthenticated token URL saved on
// the job. It now stores NOTHING:
//   • the job only computes WHAT the package contains (stats + per-item reasons,
//     registration ids only — no names, no ticket codes);
//   • the ZIP is built IN MEMORY by the download route (buildPrintPackageZip), from the
//     job's template and the LIVE registrations, and returned in the response.
// A single response must stay small and fast, so the on-demand ZIP is capped
// (PRINT_PACKAGE_MAX_CARDS cards, PRINT_PACKAGE_MAX_BYTES bytes) and REFUSES — never
// truncates — above the cap. Legacy package jobs (with a stored `output`) are served
// the same way: their stored URL is never read or returned.
//
// REUSE — nothing is redesigned or duplicated:
//   • Generic Job Runner / Kernel  → lease / cursor / resume / cancel / progress.
//   • buildStoredZip (lib/zip)      → shared with the XLSX writer.
//   • renderPrintCards (PA-4)       → the SAME renderer and data path as one card.

import crypto            from 'crypto'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult, JobPage } from '@/lib/jobs/runner'
import type { Job, JobStatus, JobCounts } from '@/lib/jobs/types'
import { buildStoredZip, type ZipEntry } from '@/lib/zip/store'
import { notifyPrintJobComplete } from '@/lib/notifications/inbox/notify'
import {
  getPrintGenerationJob, listPrintJobItems, isPrintItemReady, renderPrintCards,
  type PrintGenerationFilters, type PrintJobItem, type LegacyPrintItemOutput,
} from './generationJob'
import type { PrintAssetType } from '@/lib/printAssets/types'

export const PRINT_PACKAGE_JOBS = 'printPackageJobs'

const PACKAGE_BUDGET_MS = 55_000
const PACKAGE_LEASE_MS   = 120_000

/**
 * The on-demand ZIP caps (RD-PRINT-P0). Measured locally on the bundled CR80 badge
 * (QR, no images): ~10 ms/card render, ~5 KB/card, so 500 cards ≈ 2.6 MB in ≈ 6.5 s.
 * The byte cap keeps a response under the hosting platform's function response limit
 * even when cards carry images; either cap REFUSES the download with a clear message —
 * a package is never silently truncated.
 */
export const PRINT_PACKAGE_MAX_CARDS = 500
export const PRINT_PACKAGE_MAX_BYTES = 4 * 1024 * 1024

// ─── Job document ────────────────────────────────────────────────────────────────
export interface PrintPackageStats { filesTotal: number; packaged: number; missing: number; failed: number }
/** A card left out of the package. `filename` is kept for the response shape; always ''. */
export interface PrintPackageFailure { registrationId: string; filename: string; reason: string }

// printPackageJobs/{jobId} — generic control fields (Job) + payload. METADATA ONLY.
export interface PrintPackageJob extends Job {
  sourceJobId: string
  eventId:     string
  eventSlug:   string
  assetType:   PrintAssetType
  filters:     PrintGenerationFilters
  stats?:      PrintPackageStats
  failures?:   PrintPackageFailure[]
  /** LEGACY (pre RD-PRINT-P0) — a stored ZIP's path + token URL. Never written, never served. */
  output?:     LegacyPrintItemOutput & { fileCount?: number }
}

// ─── Filtering (reuses the PA-4 generation filters over the source items) ────────
/** Select which of the source job's items to include. Pure. */
export function selectPackageItems(items: PrintJobItem[], f: PrintGenerationFilters): PrintJobItem[] {
  const idSet = f.registrationIds && f.registrationIds.length ? new Set(f.registrationIds) : null
  return items.filter(it => {
    if (idSet && !idSet.has(it.registrationId)) return false
    if (f.pass && it.passId !== f.pass) return false
    if (f.category && it.category !== f.category && it.passName !== f.category) return false
    return true
  })
}

/** The package's ZIP filename. Derived from the job — never stored. */
export function packageFilename(job: Pick<PrintPackageJob, 'assetType' | 'eventSlug' | 'jobId'>): string {
  const slug = (job.eventSlug || 'event').replace(/[^A-Za-z0-9._-]/g, '_')
  return `${job.assetType.toLowerCase()}-${slug}-${job.jobId}.zip`
}

/** Whether the package can be downloaded as ONE on-demand ZIP. */
export function packageDownloadable(stats: PrintPackageStats | undefined): boolean {
  return !!stats && stats.packaged > 0 && stats.packaged <= PRINT_PACKAGE_MAX_CARDS
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

    // Single unit. Cursor guards re-entry so a resumed chunk asks once.
    async fetchPage(_job, _ctx, cursor): Promise<JobPage<PackageUnit>> {
      if (cursor) return { items: [], nextCursor: cursor, hasMore: false }
      return { items: [{ go: true }], nextCursor: 'done', hasMore: false }
    },

    // Compute the package's contents — metadata only. Nothing is read from Storage,
    // rendered, zipped or uploaded here; the download route renders on demand.
    async processItem(_unit, job) {
      try {
        const selected = selectPackageItems(await listPrintJobItems(job.sourceJobId), job.filters)
        const failures: PrintPackageFailure[] = []
        let packaged = 0
        for (const it of selected) {
          if (isPrintItemReady(it)) packaged++
          else failures.push({ registrationId: it.registrationId, filename: '', reason: it.error ? 'generation failed' : 'not generated' })
        }
        const stats: PrintPackageStats = { filesTotal: selected.length, packaged, missing: failures.length, failed: 0 }
        await adminDb.collection(PRINT_PACKAGE_JOBS).doc(job.jobId).update({ stats, failures: failures.slice(0, 200) })
        if (packaged === 0) return { ok: false, error: 'No generated cards match this package.' }
        if (packaged > PRINT_PACKAGE_MAX_CARDS) {
          return { ok: false, error: tooManyCardsMessage(packaged) }
        }
        return { ok: true }
      } catch (err) {
        console.error('[print] packaging failed', { jobId: job.jobId, type: err instanceof Error ? err.name : typeof err })
        return { ok: false, error: PACKAGE_FAILED_MESSAGE }
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

/**
 * RD-PRINT-AUDIT · what a failed packaging step stores and shows. Fixed text only: an
 * exception's message (which could quote attendee data or internals) is never persisted to
 * the job's `error`, returned by the job view, or logged — only its type is logged.
 */
export const PACKAGE_FAILED_MESSAGE = 'The package could not be prepared. Please try again.'

function tooManyCardsMessage(n: number): string {
  return `This package has ${n.toLocaleString('en-IN')} cards — one download holds at most ${PRINT_PACKAGE_MAX_CARDS.toLocaleString('en-IN')}. Package by pass, category or a selection instead.`
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

// ─── On-demand ZIP (RD-PRINT-P0) ───────────────────────────────────────────────────

export type PackageZipResult =
  | { ok: true;  zip: Uint8Array; filename: string; fileCount: number; skipped: number }
  | { ok: false; status: number; error: string }

/**
 * Build the package's ZIP IN MEMORY from the source job's template and the LIVE
 * registrations. Nothing is stored. Refuses (413) above either cap; never truncates.
 * The caller has already authorized the request and checked ownership of `pkg`.
 */
export async function buildPrintPackageZip(
  pkg: PrintPackageJob,
  /** Tests only — a tighter byte budget to exercise the refusal. The route never passes this. */
  limits?: { maxBytes?: number },
): Promise<PackageZipResult> {
  const source = await getPrintGenerationJob(pkg.sourceJobId)
  if (!source || source.organizerUid !== pkg.organizerUid) {
    return { ok: false, status: 404, error: 'Source generation job not found' }
  }
  const ready = selectPackageItems(await listPrintJobItems(pkg.sourceJobId), pkg.filters).filter(isPrintItemReady)
  if (ready.length === 0) return { ok: false, status: 409, error: 'No generated cards match this package.' }
  if (ready.length > PRINT_PACKAGE_MAX_CARDS) return { ok: false, status: 413, error: tooManyCardsMessage(ready.length) }

  const rendered = await renderPrintCards(source, ready.map(i => i.registrationId), limits?.maxBytes ?? PRINT_PACKAGE_MAX_BYTES)
  if (!rendered.ok) {
    return rendered.status === 413
      ? { ok: false, status: 413, error: `This package is larger than one download allows (${Math.round(PRINT_PACKAGE_MAX_BYTES / 1048576)} MB). Package by pass, category or a selection instead.` }
      : rendered
  }
  if (rendered.cards.length === 0) return { ok: false, status: 410, error: 'None of these registrations can receive a card any more.' }

  // De-duplicate in-archive names (two cards can share a ticket-less fallback name).
  const seen = new Set<string>()
  const entries: ZipEntry[] = rendered.cards.map(c => {
    let name = c.filename
    if (seen.has(name)) name = name.replace(/(\.pdf)?$/i, `-${c.registrationId}.pdf`)
    seen.add(name)
    return { name, data: Buffer.from(c.bytes) }
  })
  return {
    ok: true, zip: buildStoredZip(entries), filename: packageFilename(pkg),
    fileCount: entries.length, skipped: rendered.skipped.length,
  }
}

// ─── Client-safe view (no storage path, no URL — legacy or otherwise) ──────────────
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
  const ready = job.status === 'completed' && packageDownloadable(job.stats)
  return {
    jobId:       job.jobId,
    status:      job.status,
    counts:      job.counts,
    error:       typeof job.error === 'string' ? job.error : null,
    sourceJobId: job.sourceJobId,
    eventId:     job.eventId,
    assetType:   job.assetType,
    createdAt:   toIso(job.createdAt),
    ready,
    stats:       job.stats,
    failures:    job.failures?.map(f => ({ registrationId: f.registrationId, filename: '', reason: f.reason })),
    // `expiresAt` is always null now: the ZIP is rendered at download time, so it never expires.
    output:      ready && job.stats
      ? { filename: packageFilename(job), fileCount: job.stats.packaged, expiresAt: null }
      : undefined,
  }
}
