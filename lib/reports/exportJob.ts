// Report export execution on the generic job runner (OE-3). Server-only.
//
// Moves report/export GENERATION off the request thread onto the generic runner
// (lib/jobs/runner): the create route returns a jobId immediately, the report is
// built + serialized + persisted in the background (first chunk inline + the
// report-exports cron), and the organizer polls progress and downloads the file.
//
// REUSE — nothing is redesigned or duplicated:
//   • Report Registry  (ORGANIZER_REPORTS) → resolves the builder + permission.
//   • Report Builders   (meta.build)        → unchanged; the same tables as sync.
//   • Serializers       (serializeTables → tableToCsv / tablesToXlsx / reportPdf).
//   • Storage           (uploadServerFile)  → persisted file + token download URL.
//
// The existing builders are capped (REPORT_ROW_CAP) and not cursor-paged; per the
// OE-3 constraint they are untouched here, so this phase changes EXECUTION only
// (background + progress + persistence + expiring download). Lifting the cap for
// 100k-row exports requires cursor-aware builders — a follow-up, not this phase.

import { Timestamp }     from 'firebase-admin/firestore'
import crypto            from 'crypto'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult, JobPage } from '@/lib/jobs/runner'
import type { Job, JobStatus, JobCounts } from '@/lib/jobs/types'
import { ORGANIZER_REPORTS } from '@/lib/reports/registry'
import { serializeTables }   from '@/lib/reports/export'
import { uploadServerFile }  from '@/lib/firebase/storage/admin'
import { notifyExportReady } from '@/lib/notifications/inbox/notify'
import type { ReportFilters, ExportFormat } from '@/lib/reports/types'

export const REPORT_EXPORT_JOBS = 'reportExportJobs'

// File-format formats only (json is a live preview, never a background file).
export type ReportFileFormat = Exclude<ExportFormat, 'json'>

const EXPORT_BUDGET_MS = 55_000
const EXPORT_LEASE_MS  = 120_000
const EXPIRY_MS        = 24 * 60 * 60 * 1000   // download link valid for 24h

export interface ReportExportOutput {
  url:         string
  path:        string
  filename:    string
  contentType: string
  rowCount:    number
  truncated:   boolean
  expiresAt:   unknown   // Firestore Timestamp
}

// reportExportJobs/{jobId} — generic control fields (Job) + report request + output.
export interface ReportExportJob extends Job {
  kind:         string
  format:       ReportFileFormat
  filenameBase: string
  heading:      string
  filters:      ReportFilters
  output?:      ReportExportOutput
}

export function isReportFileFormat(v: unknown): v is ReportFileFormat {
  return v === 'csv' || v === 'xlsx' || v === 'pdf'
}

// ─── Job creation ──────────────────────────────────────────────────────────────
export async function createReportExportJob(meta: {
  kind: string; format: ReportFileFormat; filenameBase: string; heading: string
  filters: ReportFilters; organizerUid: string; createdBy: string
}): Promise<ReportExportJob> {
  const jobId = `rex_${crypto.randomUUID()}`
  return kernelCreateJob<ReportExportJob>(
    REPORT_EXPORT_JOBS,
    jobId,
    {
      organizerUid: meta.organizerUid,
      createdBy:    meta.createdBy,
      kind:         meta.kind,
      format:       meta.format,
      filenameBase: meta.filenameBase,
      heading:      meta.heading,
      filters:      meta.filters,
    },
    1,   // one report to generate
  )
}

// ─── Strategy ──────────────────────────────────────────────────────────────────

type ExportCtx = Record<string, never>
type ExportItem = { kind: string }

export function reportExportStrategy(): JobStrategy<ReportExportJob, ExportCtx, ExportItem> {
  return {
    // Validate the report kind up front (systemic failure fails the whole job).
    async loadContext(job) {
      if (!ORGANIZER_REPORTS[job.kind]) return { ok: false, error: `Unknown report: ${job.kind}` }
      return { ok: true, ctx: {} }
    },

    // Single unit of work — the report build. Cursor guards re-entry so a resumed
    // chunk asks for it once (then the page is empty).
    async fetchPage(job, _ctx, cursor): Promise<JobPage<ExportItem>> {
      if (cursor) return { items: [], nextCursor: cursor, hasMore: false }
      return { items: [{ kind: job.kind }], nextCursor: 'done', hasMore: false }
    },

    // Build (existing engine) → serialize (existing serializers) → persist (Storage).
    // Idempotent: a resumed re-run rebuilds and overwrites the same deterministic path.
    async processItem(_item, job) {
      const meta = ORGANIZER_REPORTS[job.kind]
      if (!meta) return { ok: false, error: 'Unknown report' }
      try {
        const table = await meta.build(job.organizerUid, job.filters)
        const out   = await serializeTables([table], job.format, job.filenameBase, { heading: job.heading, sub: 'RegisterDesk finance report' })
        const bytes = typeof out.body === 'string' ? new Uint8Array(Buffer.from(out.body, 'utf8')) : new Uint8Array(out.body)
        const path  = `reportExports/${job.organizerUid}/${job.jobId}/${out.filename}`
        const { url } = await uploadServerFile(path, bytes, out.contentType)

        const output: ReportExportOutput = {
          url, path, filename: out.filename, contentType: out.contentType,
          rowCount: table.rows.length, truncated: !!table.truncated,
          expiresAt: Timestamp.fromMillis(Date.now() + EXPIRY_MS),
        }
        await adminDb.collection(REPORT_EXPORT_JOBS).doc(job.jobId).update({ output })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'report generation failed' }
      }
    },

    // EA-4 S3: notify the organizer their export is ready (grouped — one per job).
    async onComplete(job) {
      const out = (job as unknown as { output?: { rowCount?: number } }).output
      void notifyExportReady({ workspaceUid: job.organizerUid, jobId: job.jobId, rowCount: out?.rowCount ?? job.counts.succeeded })
    },
  }
}

/** Advances the export job by one chunk (builds/serializes/persists on the first). */
export function processReportExportChunk(jobId: string): Promise<ProcessResult> {
  return runJobChunk(jobId, reportExportStrategy(), {
    collection: REPORT_EXPORT_JOBS,
    pageSize:   1,
    budgetMs:   EXPORT_BUDGET_MS,
    leaseMs:    EXPORT_LEASE_MS,
  })
}

/** Read a job (for the progress/download routes). */
export function getReportExportJob(jobId: string): Promise<ReportExportJob | null> {
  return getJob<ReportExportJob>(REPORT_EXPORT_JOBS, jobId)
}

// ─── Client-safe view (the storage token URL stays server-side) ────────────────

export interface ReportExportJobView {
  jobId:     string
  status:    JobStatus
  counts:    JobCounts
  error?:    string | null
  kind:      string
  format:    ReportFileFormat
  createdAt: string | null
  ready:     boolean
  output?:   { filename: string; rowCount: number; truncated: boolean; expiresAt: string | null }
}

function toIso(v: unknown): string | null {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function toExportJobView(job: ReportExportJob): ReportExportJobView {
  return {
    jobId:     job.jobId,
    status:    job.status,
    counts:    job.counts,
    error:     typeof job.error === 'string' ? job.error : null,
    kind:      job.kind,
    format:    job.format,
    createdAt: toIso(job.createdAt),
    ready:     !!job.output,
    output:    job.output
      ? { filename: job.output.filename, rowCount: job.output.rowCount, truncated: job.output.truncated, expiresAt: toIso(job.output.expiresAt) }
      : undefined,
  }
}
