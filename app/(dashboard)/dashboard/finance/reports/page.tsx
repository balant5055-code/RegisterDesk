'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type User } from 'firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { FileText, Loader2, Download, AlertCircle, History } from 'lucide-react'
import { cellToDisplay, fmtDate } from '@/lib/reports/format'
import type { ReportTable, PayoutStatement, ReportDefinition } from '@/lib/reports/types'
// From the PURE catalogue, never '@/lib/reports/registry' — that module value-imports the
// builders, which import firebase-admin, and this is a client component.
import { REPORT_CATALOG, REPORT_DEFINITIONS } from '@/lib/reports/catalog'
import type { ReportExportJobView } from '@/lib/reports/exportJob'
import type { CreateReportExportResponse } from '@/app/api/organizer/reports/exports/route'
import type { ProcessReportExportResponse } from '@/app/api/organizer/reports/exports/[jobId]/process/route'
// Type-only, so the route module (and its firebase-admin dependencies) is erased at compile
// time — the same pattern the two imports above already use.
import type { ReportHistoryResponse, ReportHistoryEntry } from '@/app/api/organizer/reports/history/route'

/**
 * RD-ANALYTICS-12-08 · the report list comes from the REGISTRY now.
 *
 * This file used to carry its own `REPORTS` array — the same eight kinds, with their labels
 * restated — beside `ORGANIZER_REPORTS` on the server. Two definitions of one thing, and
 * adding a report meant remembering both. `REPORT_DEFINITIONS` is that list, in the same
 * order, and `output === 'statement'` carries what the local `statement?: boolean` flag did.
 *
 * This is presentation only. The server still authorizes every request on its own; nothing
 * here is a permission check.
 */
type ReportDef = ReportDefinition

const REPORTS: ReportDef[] = REPORT_DEFINITIONS

/**
 * RD-ANALYTICS-12-10 · which reports this caller may actually use.
 *
 * ═══ THIS GRANTS NOTHING ═════════════════════════════════════════════════════
 * `useWorkspacePermissions` is a PROJECTION of the server's own `ROLE_PERMISSIONS`
 * array — not a second matrix — and the permission it is checked against is the one
 * already in the catalogue. Every route behind these controls still authorizes on its
 * own: the sync route, the export create route, poll/process/cancel, and the download.
 * A client that ignores this filter gains nothing but a 403.
 *
 * Its purpose is narrower and worth stating: the page used to render all eight reports
 * to everyone and surface "You do not have permission to view this report" only after a
 * click. A manager saw seven doors, all of which slammed.
 */
function visibleReports(has: (p: ReportDef['permission']) => boolean): ReportDef[] {
  return REPORTS.filter(r => has(r.permission))
}

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }

const isStatement = (def: ReportDef) => def.output === 'statement'

function urlFor(def: ReportDef): string {
  return isStatement(def) ? '/api/organizer/reports/payout-statement' : `/api/organizer/reports/${def.kind}`
}

export default function FinanceReportsPage() {
  const { showToast } = useToast()
  const { user } = useAuth()   // RD-AUTH-01 Phase 1 (M-A): shared auth state
  const userRef = useRef<User | null>(null)
  const [kind,    setKind]    = useState<string>('transactions')
  /**
   * RD-ANALYTICS-12-11 · Reports and History are two modes of ONE workspace.
   *
   * Not a route: `/dashboard/finance/reports` stays the only Reports URL, so nothing in the
   * sidebar, the breadcrumbs or the command palette has to learn about History. Local state
   * rather than a query parameter, because `searchParams` in a page makes it dynamic and
   * this phase changes no rendering semantics.
   */
  const [mode,    setMode]    = useState<'reports' | 'history'>('reports')
  const [from,    setFrom]    = useState(daysAgo(30))
  const [to,      setTo]      = useState(today())
  const [event,   setEvent]   = useState('')
  const [campaign,setCampaign]= useState('')
  const [status,  setStatus]  = useState('')

  const [table,     setTable]     = useState<ReportTable | null>(null)
  const [statement, setStatement] = useState<PayoutStatement | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  // OE-3 — background report export (large datasets).
  const [exportJob,  setExportJob]  = useState<ReportExportJobView | null>(null)
  const [exporting,  setExporting]  = useState(false)
  const exportRunning = useRef(false)

  const perms = useWorkspacePermissions()
  const available = useMemo(() => visibleReports(perms.has), [perms.has])

  /**
   * The effective selection, DERIVED rather than corrected.
   *
   * `kind` defaults to 'transactions', which a manager cannot use. The obvious fix is an
   * effect that calls `setKind` once permissions resolve — but React Compiler is on and
   * rejects a synchronous setState in an effect body, and it is right to: this is a
   * derivation, not a synchronisation. So the selected report is simply "the chosen one
   * if it is visible, otherwise the first that is", and no state has to be repaired.
   *
   * `kind` therefore holds the user's INTENT and `def` holds what is actually shown; the
   * two differ only while a permission-less report is nominally selected.
   */
  const def =
    available.find(r => r.kind === kind)
    ?? available[0]
    ?? REPORTS.find(r => r.kind === kind)
    ?? REPORTS[0]

  /**
   * True once permissions have resolved and none of the eight reports is usable.
   *
   * Gated on `!perms.loading` because the hook answers optimistically until the workspace
   * response lands; showing "no reports" during that beat would flash an untruth.
   */
  const noneAvailable = !perms.loading && available.length === 0

  const queryString = useCallback(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (!isStatement(def)) {
      if (event) p.set('event', event)
      if (campaign) p.set('campaign', campaign)
      if (status) p.set('status', status)
    }
    return p.toString()
  }, [from, to, event, campaign, status, def])

  const loadPreview = useCallback(async () => {
    const u = userRef.current
    // No usable report ⇒ no request. Without this the page fetched a report the caller
    // cannot open and rendered its 403 as a page-level error beneath the empty state.
    if (!u || noneAvailable) return
    setLoading(true); setError(null); setTable(null); setStatement(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`${urlFor(def)}?${queryString()}&format=json`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.status === 403) throw new Error('You do not have permission to view this report.')
      if (!res.ok) { const e = await res.json().catch(() => null) as { error?: string } | null; throw new Error(e?.error ?? 'Failed to load report.') }
      const data = await res.json()
      if (isStatement(def)) setStatement(data.statement as PayoutStatement)
      else setTable(data.table as ReportTable)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }, [def, queryString, noneAvailable])

  useEffect(() => {
    if (user === undefined) return
    userRef.current = user
    const run = async () => { if (user) void loadPreview() }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Reload when the EFFECTIVE report changes — def.kind, not the raw selection intent,
  // so a selection corrected by permissions still refreshes the preview.
  useEffect(() => {
    if (userRef.current) void loadPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.kind])

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    const u = userRef.current
    if (!u) return
    setDownloading(format)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`${urlFor(def)}?${queryString()}&format=${format}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { const e = await res.json().catch(() => null) as { error?: string } | null; throw new Error(e?.error ?? 'Export failed.') }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const fn = /filename="(.+?)"/.exec(cd)?.[1] ?? `${def.kind}.${format}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = fn
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(a.href)
    } catch (e) { showToast(e instanceof Error ? e.message : 'Export failed', 'error') } finally { setDownloading(null) }
  }

  // ── OE-3: background export (build off the request; poll → download) ──────────
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  async function generateBackground(format: 'csv' | 'xlsx' | 'pdf') {
    const u = userRef.current
    if (!u) return
    setExporting(true); setExportJob(null)
    try {
      const token = await u.getIdToken()
      const filters = { from, to, ...(event ? { event } : {}), ...(campaign ? { campaign } : {}), ...(status ? { status } : {}) }
      const res = await fetch('/api/organizer/reports/exports', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // `def.kind`, not the raw `kind` intent — a selection corrected by permissions
        // must export the report actually on screen, not the one nominally selected.
        body: JSON.stringify({ kind: def.kind, format, filters }),
      })
      const data = await res.json() as CreateReportExportResponse
      if (!res.ok || !data.success) { showToast((!data.success && data.error) || 'Could not start export', 'error'); return }
      setExportJob(data.job)
      void driveExport(data.jobId)
    } catch { showToast('Network error', 'error') } finally { setExporting(false) }
  }

  async function driveExport(jobId: string) {
    if (exportRunning.current) return
    exportRunning.current = true
    try {
      for (let i = 0; i < 100_000; i++) {
        const token = await userRef.current?.getIdToken()
        const res  = await fetch(`/api/organizer/reports/exports/${jobId}/process`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        const json = await res.json() as ProcessReportExportResponse
        if (!res.ok || !json.success) break
        if (json.job) setExportJob(json.job)
        if (json.result.done) break
        if (json.result.reason === 'busy') { await sleep(1500); continue }
        await sleep(400)
      }
    } catch { /* the cron finishes it; user can re-open */ }
    finally { exportRunning.current = false }
  }

  async function cancelExport(jobId: string) {
    const token = await userRef.current?.getIdToken()
    if (!token) return
    try {
      await fetch(`/api/organizer/reports/exports/${jobId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      setExportJob(prev => prev ? { ...prev, status: 'cancelled' } : prev)
    } catch { /* next poll reflects it */ }
  }

  /**
   * RD-ANALYTICS-12-04 · the ID token no longer travels in the URL.
   *
   * This used to `window.open('…/download?token=' + idToken)`, putting the caller's whole
   * session credential into a URL — and so into browser history, server and CDN logs, and any
   * copied link. It is now an ordinary authenticated request, the same shape `download(format)`
   * above has always used for the synchronous report.
   *
   * `redirect: 'follow'` is the default: fetch follows the route's 302 to the short-lived
   * signed URL, reads the bytes, and the blob is handed to the browser as a download. The
   * signed URL is never shown, never copied, and expires within minutes either way.
   */
  /**
   * `fallback` was added in RD-ANALYTICS-12-11 so History can reuse this unchanged.
   *
   * It only names the file when the response carries no `Content-Disposition`; the active
   * export panel passes nothing and behaves exactly as before. History passes the row's own
   * kind and format, because `def` describes whatever report is selected on the OTHER tab
   * and has nothing to do with a job created last week.
   */
  async function downloadExport(jobId: string, fallback?: { kind: string; format: string }) {
    // `user` rather than `userRef.current`: this function is now also handed to HistoryPanel
    // as a prop, and React Compiler correctly refuses a ref read inside a value that escapes
    // the component. The auth state is the same one the ref mirrors.
    const token = await user?.getIdToken()
    if (!token) return
    try {
      const res = await fetch(`/api/organizer/reports/exports/${jobId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const e = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(e?.error ?? 'Download failed.')
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const fn = /filename="(.+?)"/.exec(cd)?.[1]
        ?? `${fallback?.kind ?? def.kind}.${fallback?.format ?? exportJob?.format ?? 'csv'}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = fn
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Download failed', 'error')
    }
  }

  /**
   * Formats come from the CATALOGUE, not from a local rule.
   *
   * This was `isStatement(def) ? ['pdf'] : ['csv','xlsx','pdf']` — the payout statement's
   * PDF-only restriction restated in the client, a third place (after its route and the
   * catalogue) that had to agree. `ReportDefinition.formats` already records exactly what
   * each report's exporter supports.
   */
  const formats = def.formats

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><FileText className="size-5" aria-hidden /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Finance &amp; Compliance Reports</h1>
          <p className="text-[13.5px] text-muted-foreground">Filter, preview, and export financial records as CSV, Excel, or PDF.</p>
        </div>
      </div>

      {/* ── Report discovery ────────────────────────────────────────────────
             Was a wrap of eight identical pills carrying nothing but a label, so
             choosing a report meant already knowing what it contained. Each row now
             carries the catalogue's own description and formats — the reader can scan
             rather than recall. Two columns from `sm`, because eight one-line rows in a
             single column push the filters below the fold on a laptop.

             No category filter: every catalogue entry is `financial`, so "All Reports"
             and "Financial" would be the same eight rows behind two tabs. No search
             either — eight rows are faster to read than to filter. Both become worth
             adding when a second category or a longer list exists, and the catalogue
             already carries `category` for that day. ── */}
      {/* ── Nothing to report on ──────────────────────────────────────────────
             Browser QA caught this: hiding the report LIST alone left a manager looking
             at "No reports available" directly above a filter bar, three download
             buttons, a background-export panel and "You do not have permission to view
             this report." Controls for a report they cannot open, and an error for a
             request the page made on their behalf. When nothing is available the page
             ends here. ── */}
      {noneAvailable && (
        <div className="rounded-2xl border border-border bg-card px-5 py-8 text-center">
          <p className="text-[13.5px] font-medium text-foreground">No reports available</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
            Your workspace permissions don&apos;t include any of the finance reports. An
            owner can change this from Team settings.
          </p>
        </div>
      )}

      {/* ── Reports · History ────────────────────────────────────────────────
             RD-ANALYTICS-12-11. Two modes of one workspace, not two pages: History is
             a different VIEW of the exports this page already creates.

             Hidden entirely when no report is available. A caller with no finance
             permission has no finance export history either — the server would return
             an empty feed — so offering the tab would only invite a click that proves
             a negative. ── */}
      {!noneAvailable && (
        <div role="tablist" aria-label="Reports workspace" className="flex gap-1 border-b border-border">
          {([['reports', 'Reports', FileText], ['history', 'History', History]] as const).map(([id, label, Icon]) => {
            const active = mode === id
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(id)}
                className={cn(
                  '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
                  // Border + weight + colour: the selected tab is never signalled by hue alone.
                  active
                    ? 'border-primary font-semibold text-primary'
                    : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            )
          })}
        </div>
      )}

      {!noneAvailable && mode === 'history' && (
        <HistoryPanel onDownload={downloadExport} />
      )}

      {!noneAvailable && mode === 'reports' && (
        <div role="group" aria-label="Choose a report"
             className="grid gap-2 sm:grid-cols-2">
          {available.map(r => {
            const selected = r.kind === def.kind
            return (
              <button
                key={r.kind}
                type="button"
                onClick={() => setKind(r.kind)}
                aria-pressed={selected}
                className={cn(
                  'rounded-xl border px-3.5 py-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
                  selected
                    ? 'border-primary bg-primary/[0.06]'
                    : 'border-border bg-card hover:bg-muted/50',
                )}
              >
                <span className="flex items-baseline justify-between gap-2">
                  {/* Selection is carried by the border, the tint AND the weight — never
                      by colour alone. */}
                  <span className={cn('text-[13.5px]', selected ? 'font-semibold text-primary' : 'font-medium text-foreground')}>
                    {r.label}
                  </span>
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {r.formats.join(' · ')}
                  </span>
                </span>
                <span className="mt-1 block text-[12.5px] leading-snug text-muted-foreground">
                  {r.description}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Everything below operates on a selected report, so it exists only when there is
          one. See the empty-state note above. */}
      {!noneAvailable && mode === 'reports' && <>
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
        <Field label="From"><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        <Field label="To"><input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        {!isStatement(def) && <>
          <Field label="Event (slug)"><input value={event} onChange={e => setEvent(e.target.value)} placeholder="any" className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
          <Field label="Campaign (slug)"><input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="any" className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
          <Field label="Status"><input value={status} onChange={e => setStatus(e.target.value)} placeholder="any" className="w-28 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        </>}
        <button onClick={() => void loadPreview()} disabled={loading}
          className="rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : 'Apply'}
        </button>
        <div className="ml-auto flex gap-2">
          {formats.map(fmt => (
            <button key={fmt} onClick={() => void download(fmt)} disabled={downloading !== null || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
              {downloading === fmt ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* OE-3 — background export for large datasets */}
      {!isStatement(def) && (
        <div className="rounded-2xl border border-border bg-card p-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">Large dataset?</span>
            <span className="text-muted-foreground">Generate in the background —</span>
            {formats.map(fmt => (
              <button key={fmt} onClick={() => void generateBackground(fmt)} disabled={exporting || loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-muted disabled:opacity-60">
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />} {fmt.toUpperCase()}
              </button>
            ))}
          </div>

          {exportJob && (() => {
            const j = exportJob
            const active = j.status === 'pending' || j.status === 'processing'
            const failed = j.status === 'failed' || (j.status === 'completed' && !j.ready)
            const label: Record<string, string> = { pending: 'Queued', processing: 'Generating…', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
            return (
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                <span className="font-semibold text-foreground">{j.format.toUpperCase()} export — {label[j.status] ?? j.status}</span>
                {active && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                {j.ready && j.output && (
                  <>
                    <button onClick={() => void downloadExport(j.jobId)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold text-primary-foreground shadow-sm hover:opacity-90" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                      <Download className="size-3.5" /> Download
                    </button>
                    <span className="text-muted-foreground">{j.output.rowCount.toLocaleString()} rows{j.output.truncated ? ' (capped)' : ''}</span>
                  </>
                )}
                {failed && <span className="text-destructive">{j.error || 'Generation failed.'}</span>}
                {active && <button onClick={() => void cancelExport(j.jobId)} className="text-muted-foreground hover:text-foreground underline">Cancel</button>}
              </div>
            )
          })()}
        </div>
      )}

      {error && <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive"><AlertCircle className="size-4" /> {error}</div>}

      {loading && <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}

      {/* Payout statement preview */}
      {!loading && statement && <StatementPreview s={statement} />}

      {/* Table preview */}
      {!loading && table && <TablePreview table={table} />}
      </>}
    </div>
  )
}

/**
 * ─── RD-ANALYTICS-12-11 · Reports History ───────────────────────────────────
 *
 * A reader over the export jobs this page already creates. It solves one concrete failure:
 * a background export used to exist only in the React state of the tab that started it, so
 * a refresh made a finished report unreachable while the artifact sat in storage for another
 * seven days. History is therefore SERVER-backed by definition — local state is exactly what
 * was broken.
 *
 * It owns its own fetch state and unmounts with the tab, so switching back re-reads rather
 * than showing a stale list. The active-export panel on the Reports tab is untouched: live
 * job → panel, every job → History, both from `reportExportJobs`.
 */
function HistoryPanel({ onDownload }: {
  onDownload: (jobId: string, fallback?: { kind: string; format: string }) => Promise<void>
}) {
  const { user } = useAuth()
  const [rows,    setRows]    = useState<ReportHistoryEntry[] | null>(null)
  const [cursor,  setCursor]  = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [busy,    setBusy]    = useState<string | null>(null)

  const load = useCallback(async (cur: string | null) => {
    if (!user) return
    setLoading(true); setError(null)
    try {
      const token = await user.getIdToken()
      // Cursor only — there is no page number to send, because the endpoint offers none.
      const qs  = cur ? `?cursor=${encodeURIComponent(cur)}` : ''
      const res = await fetch(`/api/organizer/reports/history${qs}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      const data = await res.json().catch(() => null) as ReportHistoryResponse | null
      if (!res.ok || !data?.success) throw new Error('load failed')
      setRows(prev => (cur && prev ? [...prev, ...data.jobs] : data.jobs))
      setCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch {
      // The server's own message is deliberately generic; there is nothing here worth
      // showing the user beyond "it did not load, try again".
      setError('Could not load report history.')
    } finally { setLoading(false) }
  }, [user])

  useEffect(() => {
    // Wrapped, not called directly: React Compiler is on and a synchronous setState in an
    // effect body is an error — the same idiom the preview effect above uses.
    const run = async () => { await load(null) }
    void run()
  }, [load])

  if (loading && rows === null) {
    return (
      <div className="flex justify-center rounded-2xl border border-border bg-card py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error && rows === null) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-8 text-center">
        <p className="flex items-center justify-center gap-2 text-[13.5px] font-medium text-destructive">
          <AlertCircle className="size-4" aria-hidden /> {error}
        </p>
        <button type="button" onClick={() => void load(null)}
          className="mt-3 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted">
          Try again
        </button>
      </div>
    )
  }

  if (rows && rows.length === 0 && !hasMore) {
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-10 text-center">
        <p className="text-[13.5px] font-medium text-foreground">No report exports yet</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
          Reports generated in the background appear here. Files stay available for 24 hours
          after generation.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Background exports from this workspace, newest first.
        </p>
        <button type="button" onClick={() => void load(null)} disabled={loading}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : 'Refresh'}
        </button>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {(rows ?? []).map(row => {
          // The label comes from the catalogue; an export of a RETIRED kind falls back to the
          // stored string rather than blanking the row or failing the list.
          const label = REPORT_CATALOG[row.kind]?.label ?? row.kind ?? 'Unknown report'
          const range = row.range.from || row.range.to
            ? `${row.range.from ?? '—'} → ${row.range.to ?? '—'}`
            : 'All dates'
          return (
            <li key={row.jobId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              {/* `w-full` below `sm`, and only then a flex child.

                  Browser QA at 390px: as a plain `flex-1` this shrank to make room for the
                  status pill and the Download button beside it — enough room for them, not
                  enough for the row's own name, which `truncate` then clipped to
                  "Transacti…". Rows with no download button were unaffected, so the list
                  disagreed with itself about how wide a report name may be. Taking the whole
                  line first makes the pill and the action wrap underneath, which is what
                  `flex-wrap` was there for. */}
              <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                <p className="truncate text-[13.5px] font-medium text-foreground">
                  {label}
                  <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {row.format}
                  </span>
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {range} · {fmtDate(row.createdAt)}
                  {row.createdByYou && ' · by you'}
                  {row.rowCount !== null && ` · ${row.rowCount.toLocaleString()} rows${row.truncated ? ' (capped)' : ''}`}
                </p>
                {row.failure && <p className="mt-0.5 text-[12px] text-destructive">{row.failure}</p>}
              </div>

              <StatusPill status={row.status} download={row.download} />

              {/* One download path for the whole product: the existing authenticated route,
                  which re-checks permission and lifecycle and mints a fresh short-lived
                  signature. History stores no URL and asks for none while listing. */}
              {row.download === 'available' ? (
                <button
                  type="button"
                  disabled={busy === row.jobId}
                  onClick={async () => {
                    setBusy(row.jobId)
                    try { await onDownload(row.jobId, { kind: row.kind, format: row.format }) }
                    finally { setBusy(null) }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
                  {busy === row.jobId ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Download
                </button>
              ) : (
                <span className="text-[12.5px] text-muted-foreground">
                  {row.download === 'expired' ? 'Download expired' : 'No file'}
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {hasMore && (
        <div className="flex justify-center">
          <button type="button" onClick={() => void load(cursor)} disabled={loading || !cursor}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
            {loading ? <Loader2 className="size-4 animate-spin" /> : 'Load more'}
          </button>
        </div>
      )}
      {!hasMore && rows && rows.length > 0 && (
        <p className="text-center text-[12px] text-muted-foreground">End of history</p>
      )}
      {error && rows !== null && (
        <p className="text-center text-[12px] text-destructive">{error}</p>
      )}
    </div>
  )
}

/**
 * Job status and download availability are DIFFERENT facts, so they are two labels.
 *
 * There is no `expired` job status and this does not invent one: a completed export whose
 * artifact is past its 24-hour link expiry is still `completed`. Collapsing the two would
 * either lose the outcome of the run or claim a state the storage model does not have.
 */
function StatusPill({ status, download }: { status: ReportHistoryEntry['status']; download: ReportHistoryEntry['download'] }) {
  const label: Record<string, string> = {
    pending: 'Queued', processing: 'Generating', completed: 'Completed',
    failed: 'Failed', cancelled: 'Cancelled',
  }
  // Text carries the state; the tint only reinforces it.
  const tone =
    status === 'failed'    ? 'border-destructive/30 bg-destructive/5 text-destructive' :
    status === 'completed' ? 'border-border bg-muted/60 text-foreground' :
    status === 'cancelled' ? 'border-border bg-muted/40 text-muted-foreground' :
                             'border-border bg-muted/40 text-muted-foreground'
  return (
    <span className="flex items-center gap-2">
      <span className={cn('rounded-md border px-2 py-0.5 text-[11.5px] font-medium', tone)}>
        {label[status] ?? status}
      </span>
      {status === 'completed' && download === 'expired' && (
        <span className="text-[11.5px] text-muted-foreground">file expired</span>
      )}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[11px] font-medium text-muted-foreground">{label}</span>{children}</label>
}

function StatementPreview({ s }: { s: PayoutStatement }) {
  const line = (label: string, paise: number, neg = false, total = false) => (
    <div className={cn('flex justify-between py-2', total && 'border-t border-border font-bold text-foreground', !total && 'text-muted-foreground')}>
      <span>{label}</span><span>{neg ? `(${cellToDisplay(paise, 'money')})` : cellToDisplay(paise, 'money')}</span>
    </div>
  )
  return (
    <div className="max-w-md rounded-2xl border border-border bg-card p-5 text-[13.5px]">
      <p className="mb-1 text-[15px] font-bold text-foreground">{s.organizerName}</p>
      <p className="mb-3 text-[12px] text-muted-foreground">
        {cellToDisplay(s.period.from, 'date')} — {cellToDisplay(s.period.to, 'date')} · {s.transactionCount} transactions
      </p>
      {s.truncated && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700">
          Partial statement — this period exceeds the record cap; the totals below cover only the most recent {s.transactionCount} transactions. Narrow the date range for a complete statement.
        </p>
      )}
      {line('Gross Revenue', s.grossRevenuePaise)}
      {line('Platform Fee', s.platformFeeBasePaise)}
      {line('Platform GST', s.platformFeeGstPaise)}
      {line(`Razorpay Fee (${s.gatewayFeeBasis === 'actual' ? 'Actual' : s.gatewayFeeBasis === 'mixed' ? 'Part Actual' : 'Estimated'})`, s.gatewayFeePaise)}
      {line('Total Fees', s.totalFeesPaise)}
      {line('Refunds', s.refundsPaise)}
      {line('Net Settlement (payable)', s.netSettlementPaise, false, true)}
      {/* The fees above are LISTED, not subtracted into the payable — under an attendee-pays
          model the attendee bore them, and the ledger already records what is owed. */}
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Net Settlement is the recorded payable, not gross minus the fees above.
        {s.gatewayTaxPaise !== null && (
          <> Razorpay tax of {cellToDisplay(s.gatewayTaxPaise, 'money')} is a component
            <em> inside</em> the Razorpay fee, not an additional charge.</>
        )}
      </p>
      <div className="mt-3 text-[12px] text-muted-foreground">
        <p>Settlement Ref: <span className="text-foreground">{s.settlementReference ?? '—'}</span></p>
        <p>Settlement Date: <span className="text-foreground">{cellToDisplay(s.settlementDate, 'date')}</span></p>
      </div>
    </div>
  )
}

function TablePreview({ table }: { table: ReportTable }) {
  return (
    <div className="space-y-3">
      {table.summary && table.summary.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {table.summary.map(s => (
            <div key={s.label} className="rounded-xl border border-border bg-card px-4 py-2.5">
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
              <p className="text-[16px] font-bold text-foreground">{cellToDisplay(s.value, s.type)}</p>
            </div>
          ))}
        </div>
      )}
      {table.truncated && <p className="text-[12px] text-amber-600">Showing the most recent {table.rows.length} records. Narrow the date range for a complete export.</p>}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
            {table.columns.map(c => <th key={c.key} className={cn('px-3 py-2.5', (c.align === 'right' || c.type === 'money' || c.type === 'number') && 'text-right')}>{c.label}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {table.rows.length === 0 ? (
              <tr><td colSpan={table.columns.length} className="px-4 py-12 text-center text-muted-foreground">No records for the selected filters.</td></tr>
            ) : table.rows.slice(0, 200).map((row, i) => (
              <tr key={i} className="hover:bg-muted/20">
                {table.columns.map(c => {
                  const right = c.align === 'right' || c.type === 'money' || c.type === 'number'
                  return <td key={c.key} className={cn('px-3 py-2.5', right ? 'text-right tabular-nums' : '', c.type === 'text' && 'text-foreground')}>{cellToDisplay(row[c.key] ?? null, c.type)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > 200 && <p className="text-[12px] text-muted-foreground">Preview limited to 200 rows — export for the full {table.rows.length} rows.</p>}
    </div>
  )
}
