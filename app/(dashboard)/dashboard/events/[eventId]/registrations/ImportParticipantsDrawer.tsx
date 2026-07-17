'use client'

// RM-2.1 template · RM-2.2A upload+parse · RM-2.2B validation engine ·
// RM-2.2C validation PREVIEW (this file's new part).
// After a successful parse the file is validated via /import-validate (RM-2.2B)
// and the results are displayed. NOTHING is imported/written here — the Import
// button is gated on readyCount but performs no write (that is a later phase).

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  X, Download, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Search, ChevronDown, Ban, Loader2,
  FileDown, Clock, History,
} from 'lucide-react'
import {
  IMPORT_TEMPLATE_VERSION, IMPORT_SHEET_PARTICIPANTS, IMPORT_SHEET_META,
  IMPORT_META_KEYS, IMPORT_REQUIRED_HEADERS, IMPORT_MAX_ROWS, IMPORT_MAX_FILE_BYTES,
  type ImportTemplateMetadata,
} from '@/lib/registrations/importTemplate'
import type {
  ValidatedImportRow, ImportValidationStatistics, ImportRowStatus,
} from '@/lib/registrations/importValidation'
import { csvCell as csvEscape } from '@/lib/utils/csv'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

// Standard header labels (match the RM-2.1 template + RM-2.2B engine).
const H_NAME = 'Full Name *'
const H_EMAIL = 'Email *'
const H_PASS = 'Pass *'

interface ParsedImport {
  fileName:        string
  headers:         string[]
  rows:            Record<string, string>[]
  metadata:        ImportTemplateMetadata
  rowsDetected:    number
  columnsDetected: number
}
type ParseResult = { ok: true; data: ParsedImport } | { ok: false; error: string }

interface ValidationResponse {
  eventStopped?: { reason: string; message: string }
  validatedRows: ValidatedImportRow[]
  statistics:    ImportValidationStatistics
}

const STATUS_META: Record<ImportRowStatus, { label: string; cls: string; dot: string }> = {
  READY:     { label: 'Ready',     cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  WARNING:   { label: 'Warning',   cls: 'bg-amber-100 text-amber-700',     dot: 'bg-amber-500' },
  DUPLICATE: { label: 'Duplicate', cls: 'bg-orange-100 text-orange-700',   dot: 'bg-orange-500' },
  ERROR:     { label: 'Error',     cls: 'bg-red-100 text-red-600',         dot: 'bg-red-500' },
}

type TabKey = 'ALL' | ImportRowStatus

// RM-2.3A/B — the serialized import job shape the drawer polls + summarizes.
type ImportJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
interface ImportJobView {
  jobId:   string
  status:  ImportJobStatus
  counts:  { total: number; processed: number; succeeded: number; failed: number }
  error?:  string | null
  summary?:  { imported: number; failed: number; total: number }
  fileName?:   string
  fileTotal?:  number
  stats?:      { ready: number; warning: number; duplicate: number; error: number }
  createdAt?:   string | null
  startedAt?:   string | null
  completedAt?: string | null
}
const isTerminalJob = (s: ImportJobStatus) => s === 'completed' || s === 'failed' || s === 'cancelled'
const failedRowCount = (j: ImportJobView) => j.counts.failed + (j.stats?.duplicate ?? 0) + (j.stats?.error ?? 0)
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}
function fmtDuration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return '—'
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
const JOB_STATUS_LABEL: Record<ImportJobStatus, string> = {
  pending: 'Queued', processing: 'Importing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
}
const JOB_STATUS_CLS: Record<ImportJobStatus, string> = {
  pending:    'bg-muted text-muted-foreground',
  processing: 'bg-blue-100 text-blue-700',
  completed:  'bg-emerald-100 text-emerald-700',
  failed:     'bg-red-100 text-red-600',
  cancelled:  'bg-amber-100 text-amber-700',
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Diagnostics (RM-2.2E) ──────────────────────────────────────────────────────
// Never swallow a parsing exception. The REAL error is always logged to the
// console (with full type/message/stack in development); users only ever see a
// friendly, contextual message — never an internal stack trace.
function logParserException(stage: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error))
  if (process.env.NODE_ENV === 'production') {
    console.error(`[import-parser:${stage}] ${e.name}: ${e.message}`)
  } else {
    console.error(`[import-parser:${stage}]`, { type: e.name, message: e.message, stack: e.stack })
  }
}

// Turns a workbook-reader exception into a specific, human explanation.
function describeWorkbookError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/zip|central directory|eocd|signature|compress|inflate|end of central|deflate/.test(msg)) {
    return 'This file appears to be corrupted (its workbook structure could not be read). Re-download the template and upload it again.'
  }
  if (/xml|parse|token|tag|entity|malformed|dom|unexpected/.test(msg)) {
    return 'This workbook contains invalid XML and could not be read. Re-download the template and upload it again.'
  }
  if (/not a|invalid file|unsupported|format|magic|zip file/.test(msg)) {
    return 'This file is not a valid .xlsx workbook. Upload the .xlsx template — not .xls, .csv, or a renamed file.'
  }
  return 'The workbook could not be read (unknown parsing error). Re-download the template and upload it again.'
}

// ─── Client-side structural parser (RM-2.2A logic unchanged — diagnostics only) ──
async function parseTemplateFile(file: File, eventId: string, eventSlug: string): Promise<ParseResult> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return { ok: false, error: 'Please upload the .xlsx template — other file types are not supported.' }
  }
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    return { ok: false, error: `File is too large. Maximum size is ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB.` }
  }

  let sheets: { sheet: string; data: (string | number | boolean | null)[][] }[]
  try {
    const readXlsxFile = (await import('read-excel-file/browser')).default
    sheets = (await readXlsxFile(file)) as typeof sheets
  } catch (error) {
    logParserException('read-workbook', error)
    return { ok: false, error: describeWorkbookError(error) }
  }
  if (!Array.isArray(sheets) || sheets.length === 0) {
    logParserException('read-workbook', new Error(`reader returned ${Array.isArray(sheets) ? 'no sheets' : typeof sheets}`))
    return { ok: false, error: 'This workbook format is invalid — no sheets were found. Re-download the template and try again.' }
  }

  const cell = (v: unknown) => String(v ?? '').trim()

  const metaSheet = sheets.find(s => s.sheet === IMPORT_SHEET_META)
  if (!metaSheet) return { ok: false, error: 'This file is missing its template metadata. Download a fresh template and try again.' }
  const metaMap: Record<string, string> = {}
  for (const row of metaSheet.data.slice(1)) {
    const k = cell(row[0])
    if (k) metaMap[k] = cell(row[1])
  }
  const metadata: ImportTemplateMetadata = {
    version:     metaMap[IMPORT_META_KEYS.version]     ?? '',
    eventId:     metaMap[IMPORT_META_KEYS.eventId]     ?? '',
    eventSlug:   metaMap[IMPORT_META_KEYS.eventSlug]   ?? '',
    generatedAt: metaMap[IMPORT_META_KEYS.generatedAt] ?? '',
  }
  if (!metadata.version || !metadata.eventId || !metadata.eventSlug || !metadata.generatedAt) {
    return { ok: false, error: 'The template metadata is incomplete. Download a fresh template and try again.' }
  }
  if (metadata.version !== IMPORT_TEMPLATE_VERSION) {
    return { ok: false, error: 'This template is from an older version. Download the latest template and try again.' }
  }
  if (Number.isNaN(Date.parse(metadata.generatedAt))) {
    return { ok: false, error: 'The template metadata is invalid (bad generated date). Download a fresh template.' }
  }
  if (metadata.eventId !== eventId || metadata.eventSlug !== eventSlug) {
    return { ok: false, error: 'This template was generated for a different event. Download the template for this event.' }
  }

  const partSheet = sheets.find(s => s.sheet === IMPORT_SHEET_PARTICIPANTS)
  if (!partSheet) return { ok: false, error: 'The "Participants" sheet is missing. Download a fresh template.' }
  if (partSheet.data.length === 0) return { ok: false, error: 'The "Participants" sheet has no header row.' }

  const headers = partSheet.data[0].map(cell)
  if (!headers.some(Boolean)) return { ok: false, error: 'The "Participants" sheet header row is empty.' }

  const missing = IMPORT_REQUIRED_HEADERS.filter(h => !headers.includes(h))
  if (missing.length) {
    return { ok: false, error: `The template is missing required columns: ${missing.join(', ')}. Do not rename or delete columns.` }
  }

  const dataRows = partSheet.data.slice(1)
    .map(r => headers.map((_, i) => cell(r[i])))
    .filter(cells => cells.some(c => c !== ''))

  if (dataRows.length > IMPORT_MAX_ROWS) {
    return { ok: false, error: `Too many rows (${dataRows.length}). Maximum is ${IMPORT_MAX_ROWS} per import — split the file.` }
  }

  const rows = dataRows.map(cells => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
  return {
    ok: true,
    data: { fileName: file.name, headers, rows, metadata, rowsDetected: rows.length, columnsDetected: headers.length },
  }
}

export function ImportParticipantsDrawer({
  open,
  onClose,
  eventId,
  eventSlug,
  token,
  eventName,
}: {
  open:      boolean
  onClose:   () => void
  eventId:   string
  eventSlug: string
  token:     string
  eventName: string
}) {
  // GA-7D S1: this slide-over had no dialog semantics. Reuse the shared focus trap
  // (trap + restore + initial focus) + Escape-to-close; role/aria-modal added below.
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const [downloading, setDownloading]   = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const [parsing, setParsing]   = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsed, setParsed]     = useState<ParsedImport | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [validating, setValidating]           = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [validation, setValidation]           = useState<ValidationResponse | null>(null)

  const [tab, setTab]       = useState<TabKey>('ALL')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  // RM-2.3A — import job execution (create → drive → progress → complete).
  const [job, setJob]             = useState<ImportJobView | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [recentJobs, setRecentJobs] = useState<ImportJobView[]>([])
  const running = useRef(false)

  const apiBase = `/api/organizer/events/${eventId}/registrations`

  async function handleDownloadTemplate() {
    if (downloading || !token) return
    setDownloading(true); setDownloadError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/registrations/import-template`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not generate the template. Please try again.')
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `registration-template-${eventSlug || eventId}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed')
    } finally { setDownloading(false) }
  }

  async function runValidation(data: ParsedImport) {
    setValidating(true); setValidationError(null); setValidation(null)
    setTab('ALL'); setSearch(''); setExpanded(null); setJob(null); setImportErr(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/registrations/import-validate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ rows: data.rows, headers: data.headers, metadata: data.metadata }),
      })
      const json = await res.json().catch(() => ({})) as ValidationResponse & { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Validation failed. Please try again.')
      setValidation({ eventStopped: json.eventStopped, validatedRows: json.validatedRows ?? [], statistics: json.statistics })
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : 'Validation failed')
    } finally { setValidating(false) }
  }

  async function handleFile(file: File | undefined) {
    if (!file || parsing) return
    setParsing(true); setParseError(null); setParsed(null); setValidation(null); setValidationError(null)
    const result = await parseTemplateFile(file, eventId, eventSlug)
    setParsing(false)
    if (result.ok) { setParsed(result.data); void runValidation(result.data) }
    else setParseError(result.error)
  }

  function resetFile() {
    setParsed(null); setParseError(null); setValidation(null); setValidationError(null)
    setJob(null); setImportErr(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Client-side driver: repeatedly call /process until the job is done (mirrors the
  // certificate bulk-job poller). The scheduled cron also advances it independently.
  async function drive(jobId: string) {
    if (running.current) return
    running.current = true
    try {
      for (let i = 0; i < 100_000; i++) {
        const res  = await fetch(`${apiBase}/import/${jobId}/process`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        const json = await res.json().catch(() => ({})) as { result?: { done?: boolean; reason?: string }; job?: ImportJobView; error?: string }
        if (!res.ok) { setImportErr(json.error ?? 'Import processing failed.'); break }
        if (json.job) setJob(json.job)
        if (json.result?.done) break
        if (json.result?.reason === 'busy') { await sleep(1500); continue }
        await sleep(300)
      }
    } catch (error) { logParserException('drive-job', error) /* status is reflected on the next poll / GET */ }
    finally { running.current = false }
  }

  async function createImportJob() {
    if (!parsed || importing) return
    setImporting(true); setImportErr(null)
    try {
      const res  = await fetch(`${apiBase}/import`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ rows: parsed.rows, headers: parsed.headers, fileName: parsed.fileName }),
      })
      const json = await res.json().catch(() => ({})) as { jobId?: string; job?: ImportJobView; error?: string }
      if (!res.ok || !json.jobId || !json.job) throw new Error(json.error ?? 'Could not start the import.')
      setJob(json.job)
      void drive(json.jobId)
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : 'Import failed')
    } finally { setImporting(false) }
  }

  async function cancelImport() {
    if (!job) return
    try {
      const res  = await fetch(`${apiBase}/import/${job.jobId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => ({})) as { status?: ImportJobStatus }
      if (json.status) setJob(prev => (prev ? { ...prev, status: json.status! } : prev))
    } catch (error) { logParserException('cancel-job', error) /* next poll reflects state */ }
  }

  // RM-2.3B — Recent imports + failed-rows download.
  const fetchRecent = useCallback(async () => {
    try {
      const res  = await fetch(`${apiBase}/import`, { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => ({})) as { jobs?: ImportJobView[] }
      if (res.ok && Array.isArray(json.jobs)) setRecentJobs(json.jobs)
    } catch (error) { logParserException('recent-imports', error) }
  }, [apiBase, token])

  // Async fetch-on-open / on-terminal — the accepted "subscribe to an external
  // system, setState in the async callback" effect pattern (setState is not synchronous).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (open) void fetchRecent() }, [open, fetchRecent])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (job && isTerminalJob(job.status)) void fetchRecent() }, [job, fetchRecent])

  async function downloadFailedRows(jobId: string) {
    try {
      const res = await fetch(`${apiBase}/import/${jobId}/failed-rows`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { setImportErr('Could not generate the failed-rows file.'); return }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `import-failed-rows-${eventSlug || eventId}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (error) { logParserException('download-failed-rows', error) }
  }

  function startNewImport() {
    setJob(null); setImportErr(null); resetFile()
  }

  // Summary card for a terminal job (fresh import result OR a recent-imports click).
  function renderJobSummary(j: ImportJobView) {
    const total  = j.fileTotal ?? j.counts.total
    // Failed = execution failures + validation errors (duplicates have their own tile).
    const failed = j.counts.failed + (j.stats?.error ?? 0)
    const tiles: [string, number, string][] = [
      ['Total rows', total,              'text-foreground'],
      ['Imported',   j.counts.succeeded, 'text-emerald-600'],
      ['Failed',     failed,             'text-red-600'],
      ['Duplicates', j.stats?.duplicate ?? 0, 'text-orange-600'],
      ['Warnings',   j.stats?.warning ?? 0,   'text-amber-600'],
    ]
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${JOB_STATUS_CLS[j.status]}`}>
              {JOB_STATUS_LABEL[j.status]}
            </span>
            {j.fileName && <span className="truncate text-[12px] text-muted-foreground">{j.fileName}</span>}
          </div>
          <button type="button" onClick={startNewImport} className="text-[12px] font-semibold text-primary hover:underline">New import</button>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {tiles.map(([label, count, cls]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/20 px-2.5 py-2 text-center">
              <p className={`text-[18px] font-bold ${cls}`}>{count}</p>
              <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock className="size-3" aria-hidden /> Started {fmtTime(j.startedAt ?? j.createdAt)}</span>
          <span>Completed {fmtTime(j.completedAt)}</span>
          <span>Duration {fmtDuration(j.startedAt ?? j.createdAt, j.completedAt)}</span>
        </div>

        {j.error && <p className="mt-2 text-[12px] text-red-600">{j.error}</p>}
        {importErr && <p className="mt-2 text-[12px] text-red-600">{importErr}</p>}

        {failedRowCount(j) > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-[12px] text-muted-foreground">Download the {failedRowCount(j)} unimported row(s), fix them, and re-import — created rows are skipped.</p>
            <button
              type="button" onClick={() => downloadFailedRows(j.jobId)}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground shadow-sm hover:bg-muted/50"
            >
              <FileDown className="size-3.5" aria-hidden /> Failed rows
            </button>
          </div>
        )}
      </div>
    )
  }

  // Merge validated rows with the parsed participant fields for display.
  const rowsView = (validation?.validatedRows ?? []).map(vr => {
    const src = parsed?.rows[vr.rowNumber - 2] ?? {}
    return { ...vr, name: src[H_NAME] ?? '', email: src[H_EMAIL] ?? '', pass: src[H_PASS] ?? '' }
  })

  const q = search.trim().toLowerCase()
  const filtered = rowsView.filter(r =>
    (tab === 'ALL' || r.status === tab) &&
    (!q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.pass.toLowerCase().includes(q)),
  )

  function downloadErrorReport() {
    const bad = rowsView.filter(r => r.status === 'ERROR' || r.status === 'DUPLICATE' || r.status === 'WARNING')
    const lines = [['Row', 'Full Name', 'Email', 'Pass', 'Status', 'Reasons'].join(',')]
    for (const r of bad) {
      lines.push([r.rowNumber, r.name, r.email, r.pass, r.status, r.reasons.join(' | ')].map(v => csvEscape(String(v))).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `import-issues-${eventSlug || eventId}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  if (!open) return null

  const stats = validation?.statistics
  const tabs: { key: TabKey; label: string; count: number }[] = stats ? [
    { key: 'ALL',       label: 'All',        count: stats.total },
    { key: 'READY',     label: 'Ready',      count: stats.readyCount },
    { key: 'WARNING',   label: 'Warnings',   count: stats.warningCount },
    { key: 'DUPLICATE', label: 'Duplicates', count: stats.duplicateCount },
    { key: 'ERROR',     label: 'Errors',     count: stats.errorCount },
  ] : []

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-foreground/30" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-drawer-title"
        className="flex h-full w-full max-w-3xl flex-col overflow-y-auto bg-card shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="import-drawer-title" className="text-[16px] font-bold text-foreground">Import Participants</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Viewing a finished job (fresh result or a Recent Imports click) */}
          {job && !parsed && isTerminalJob(job.status) && renderJobSummary(job)}

          {!parsed && !job && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Bulk-add participants to <span className="font-semibold text-foreground">{eventName}</span> from a spreadsheet.
              Download the template built from this event’s registration form, fill it in, then upload it here.
            </p>
          )}

          {/* Recent imports */}
          {!parsed && !job && recentJobs.length > 0 && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                <History className="size-3.5" aria-hidden /> Recent imports
              </p>
              <div className="divide-y divide-border rounded-xl border border-border">
                {recentJobs.map(rj => (
                  <button
                    key={rj.jobId} type="button" onClick={() => { setImportErr(null); setJob(rj) }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${JOB_STATUS_CLS[rj.status]}`}>
                        {JOB_STATUS_LABEL[rj.status]}
                      </span>
                      <span className="truncate text-[13px] text-foreground">{rj.fileName || rj.jobId}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      <span className="text-emerald-600">✓ {rj.counts.succeeded}</span>
                      {rj.counts.failed > 0 && <span className="ml-2 text-red-600">✗ {rj.counts.failed}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 1 — template (hidden once a file is loaded) */}
          {!parsed && !job && (
            <div className="space-y-2">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">1 · Get the template</p>
              <button
                type="button"
                onClick={handleDownloadTemplate}
                disabled={downloading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
              >
                <Download className="size-4" aria-hidden />
                {downloading ? 'Preparing…' : 'Download Template'}
              </button>
              {downloadError && <p className="text-[12px] text-red-600">{downloadError}</p>}
            </div>
          )}

          {/* Step 2 — upload */}
          {!parsed && !job && (
            <div className="space-y-2">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">2 · Upload the filled file</p>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]) }}
                className={`rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'}`}
              >
                <Upload className="mx-auto size-6 text-muted-foreground" aria-hidden />
                <p className="mt-2 text-[13px] font-semibold text-foreground">{parsing ? 'Reading file…' : 'Drag & drop your .xlsx here'}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">Only the .xlsx template is accepted.</p>
                <button
                  type="button" disabled={parsing} onClick={() => fileInputRef.current?.click()}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-1.5 text-[13px] font-semibold text-foreground shadow-sm hover:bg-muted/50 disabled:opacity-50"
                >
                  Browse File
                </button>
                <input
                  ref={fileInputRef} type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden" onChange={e => { void handleFile(e.target.files?.[0]) }}
                />
              </div>
              {parseError && (
                <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12px] text-red-700">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{parseError}</span>
                </div>
              )}
            </div>
          )}

          {/* Loaded-file bar */}
          {parsed && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-sm">
              <div className="flex min-w-0 items-center gap-2">
                <FileSpreadsheet className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate text-[13px] font-semibold text-foreground">{parsed.fileName}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">· {parsed.rowsDetected} rows</span>
              </div>
              <button type="button" onClick={resetFile} className="shrink-0 text-[12px] font-semibold text-primary hover:underline">
                Choose a different file
              </button>
            </div>
          )}

          {/* Validation */}
          {parsed && validating && (
            <p className="text-[13px] text-muted-foreground">Validating {parsed.rowsDetected} rows…</p>
          )}
          {parsed && validationError && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12px] text-red-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{validationError}</span>
            </div>
          )}
          {parsed && validation?.eventStopped && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span><span className="font-semibold">Import unavailable — </span>{validation.eventStopped.message}</span>
            </div>
          )}

          {parsed && validation && !validation.eventStopped && stats && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([
                  ['Ready to import', stats.readyCount, 'text-emerald-700', 'bg-emerald-50'],
                  ['Warnings',        stats.warningCount, 'text-amber-700',  'bg-amber-50'],
                  ['Duplicates',      stats.duplicateCount, 'text-orange-700', 'bg-orange-50'],
                  ['Errors',          stats.errorCount, 'text-red-600',    'bg-red-50'],
                ] as const).map(([label, count, txt, bg]) => (
                  <div key={label} className={`rounded-xl ${bg} px-3 py-2.5`}>
                    <p className={`text-[20px] font-bold ${txt}`}>{count}</p>
                    <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>

              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[180px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input
                    value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search name, email, pass…"
                    className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-[13px] text-foreground shadow-sm placeholder:text-muted-foreground"
                  />
                </div>
                <button
                  type="button" onClick={downloadErrorReport}
                  disabled={stats.errorCount + stats.warningCount + stats.duplicateCount === 0}
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground shadow-sm hover:bg-muted/50 disabled:opacity-40"
                >
                  <Download className="size-3.5" aria-hidden /> Error Report
                </button>
              </div>

              {/* Tabs (status filter) */}
              <div className="flex flex-wrap gap-1.5 border-b border-border">
                {tabs.map(t => (
                  <button
                    key={t.key} type="button" onClick={() => setTab(t.key)}
                    className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                      tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t.label} <span className="text-[12px] font-medium">({t.count})</span>
                  </button>
                ))}
              </div>

              {/* Table */}
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[560px] text-left text-[13px]">
                  <thead className="bg-muted/40 text-[12px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Row</th>
                      <th className="px-3 py-2 font-semibold">Name</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Pass</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-[13px] text-muted-foreground">No rows match this view.</td></tr>
                    )}
                    {filtered.map(r => {
                      const meta = STATUS_META[r.status]
                      const isOpen = expanded === r.rowNumber
                      return (
                        <Fragment key={r.rowNumber}>
                          <tr
                            onClick={() => setExpanded(isOpen ? null : r.rowNumber)}
                            className="cursor-pointer border-t border-border hover:bg-muted/30"
                          >
                            <td className="px-3 py-2 text-muted-foreground">{r.rowNumber}</td>
                            <td className="px-3 py-2 font-medium text-foreground">{r.name || '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.email || '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.pass || '—'}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold ${meta.cls}`}>
                                <span className={`size-1.5 rounded-full ${meta.dot}`} />{meta.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <span className="line-clamp-1">{r.reasons[0] ?? (r.status === 'READY' ? 'Ready to import' : '—')}</span>
                                {r.reasons.length > 1 && <span className="shrink-0 text-[12px] text-primary">+{r.reasons.length - 1}</span>}
                                {r.reasons.length > 0 && <ChevronDown className={`size-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden />}
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-t border-border bg-muted/20">
                              <td colSpan={6} className="px-3 py-3">
                                <p className="mb-1 text-[12px] font-semibold text-foreground">
                                  Row {r.rowNumber} · {meta.label}
                                  {r.resultStatus && <span className="ml-2 font-normal text-muted-foreground">→ will be {r.resultStatus}</span>}
                                </p>
                                {r.reasons.length > 0 ? (
                                  <ul className="list-inside list-disc space-y-0.5 text-[12px] text-muted-foreground">
                                    {r.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                                  </ul>
                                ) : (
                                  <p className="text-[12px] text-emerald-700">No issues — ready to import.</p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Import — create job, then live progress (RM-2.3A) */}
              <div className="border-t border-border pt-4">
                {!job ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12px] text-muted-foreground">{stats.readyCount} of {stats.total} rows are ready to import.</p>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        disabled={stats.readyCount === 0 || importing}
                        onClick={createImportJob}
                        className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
                      >
                        {importing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
                        {importing ? 'Starting…' : `Import ${stats.readyCount > 0 ? stats.readyCount : ''} Ready`}
                      </button>
                      {importErr && <p className="text-[12px] text-red-600">{importErr}</p>}
                    </div>
                  </div>
                ) : isTerminalJob(job.status) ? renderJobSummary(job) : (() => {
                  const pct = job.counts.total ? Math.round((job.counts.processed / job.counts.total) * 100) : 0
                  return (
                    <div className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${JOB_STATUS_CLS[job.status]}`}>
                          {JOB_STATUS_LABEL[job.status]}
                        </span>
                        <button type="button" onClick={cancelImport}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-semibold text-red-600 hover:bg-red-50">
                          <Ban className="size-3.5" aria-hidden /> Cancel
                        </button>
                      </div>
                      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-4 text-[12px] text-muted-foreground">
                        <span>Processed {job.counts.processed}/{job.counts.total}</span>
                        <span className="text-emerald-600">✓ {job.counts.succeeded} created</span>
                        <span className="text-red-600">✗ {job.counts.failed} failed</span>
                      </div>
                      {job.error && <p className="mt-1 text-[12px] text-red-600">{job.error}</p>}
                      {importErr && <p className="mt-1 text-[12px] text-red-600">{importErr}</p>}
                    </div>
                  )
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
