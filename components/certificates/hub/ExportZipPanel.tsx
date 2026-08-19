'use client'

// RD-CERT-SCALE P2-2 · the organizer's view of a MULTIPART certificate export.
//
// There is no single-file download to preserve here, and deliberately so: a 50,000-certificate
// archive is not one object. The export is a set of independently valid ZIP parts, and this
// panel's whole job is to make that legible — every part listed, every part downloadable, and
// the completeness of the set stated rather than implied.
//
// ═══ WHY `outcome` AND NOT `status` ══════════════════════════════════════════
// `status: 'completed'` only means the job stopped running. Whether the archive is WHOLE is a
// separate question answered by the server's finalize seal, which refuses to pass a short or
// duplicated archive. So this panel reports `outcome`, and a partial export is rendered as a
// warning that names how many certificates are missing — never as a green success.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, Download, Loader2, AlertTriangle, CheckCircle2, FileJson } from 'lucide-react'
import { ErrorBox, btnGhost } from './ui'
import type { CertApi } from './api'
import type { ZipJobResponse } from './api'

/** Poll cadence while the job runs. Slow enough to be free, fast enough to feel live. */
const POLL_MS = 2500

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function ExportZipPanel({ api }: { api: CertApi }) {
  const [job, setJob]         = useState<ZipJobResponse | null>(null)
  const [starting, setStart]  = useState(false)
  const [err, setErr]         = useState<string | null>(null)
  // Held in a ref so the polling effect does not re-subscribe on every tick.
  const jobIdRef = useRef<string | null>(null)

  const terminal = job?.status === 'completed' || job?.status === 'failed' || job?.status === 'cancelled'

  const start = useCallback(async () => {
    setErr(null); setStart(true); setJob(null)
    try {
      const created = await api.createZipJob('all')
      jobIdRef.current = created.jobId
      setJob(await api.getZipJob(created.jobId))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the export')
    } finally {
      setStart(false)
    }
  }, [api])

  // Drive AND poll. The cron would finish the job on its own; driving it from the open tab
  // just means the organizer does not wait for the next cron tick to see progress.
  useEffect(() => {
    if (!job || terminal) return
    let live = true
    const tick = async () => {
      const id = jobIdRef.current
      if (!id || !live) return
      try {
        await api.processZipJob(id).catch(() => {})   // best-effort; the cron is the guarantee
        const next = await api.getZipJob(id)
        if (live) setJob(next)
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'Lost contact with the export')
      }
    }
    const t = setInterval(tick, POLL_MS)
    return () => { live = false; clearInterval(t) }
  }, [api, job, terminal])

  const pct = job && job.requested > 0
    ? Math.min(100, Math.round((job.included / job.requested) * 100))
    : 0

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-[14px] font-semibold text-foreground">Export all certificates</h3>
        <p className="text-[13px] text-muted-foreground">
          Large events are exported as several ZIP parts. Every part is a complete, valid
          archive on its own — download them all to have the full set.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGhost}
          onClick={() => { void start() }}
          disabled={starting || (!!job && !terminal)}
        >
          {starting || (job && !terminal)
            ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
            : <Archive className="size-3.5" aria-hidden />}
          {job && !terminal ? 'Preparing…' : 'Prepare ZIP export'}
        </button>
      </div>

      {err && <ErrorBox message={err} />}

      {job && (
        <div className="rounded-lg border border-border bg-card p-4">
          {/* Progress is stated in certificates, not in parts: parts are an implementation
              detail of how the archive is delivered, not of what was asked for. */}
          {!terminal && (
            <>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">
                  Archiving {job.included.toLocaleString()} of {job.requested.toLocaleString()}
                </span>
                <span className="tabular-nums text-muted-foreground">{pct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}

          {job.status === 'failed' && (
            <ErrorBox message={job.error ?? 'The export failed and was not published.'} />
          )}

          {job.status === 'completed' && job.outcome === 'complete' && (
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" aria-hidden />
              All {job.included.toLocaleString()} certificates exported across {job.partCount} part{job.partCount === 1 ? '' : 's'}.
            </p>
          )}

          {/* A short archive is announced, with the number missing. This is the case the old
              synchronous download reported as an ordinary success. */}
          {job.status === 'completed' && job.outcome !== 'complete' && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
              <span>
                {job.outcome === 'partial'
                  ? <><strong>Partial export.</strong> {job.included.toLocaleString()} of {job.requested.toLocaleString()} certificates
                      were archived; {job.failedCount.toLocaleString()} could not be read. The parts below are complete and valid —
                      the missing certificates are listed in the manifest.</>
                  : <><strong>Not verified.</strong> This export predates completeness verification, so the parts below
                      may not be the whole set.</>}
              </span>
            </div>
          )}

          {job.parts.length > 0 && (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {job.parts.map(p => (
                <li key={p.part} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-[13px] text-foreground">
                    Part {p.part}
                    <span className="ml-2 text-muted-foreground">
                      {p.count.toLocaleString()} certificates · {fmtBytes(p.bytes)}
                    </span>
                  </span>
                  {/* A plain link: the signed URL is minted by the poll above and is short-lived,
                      so it is followed immediately rather than stored anywhere. */}
                  <a className={btnGhost} href={p.url} download>
                    <Download className="size-3.5" aria-hidden /> Download
                  </a>
                </li>
              ))}
            </ul>
          )}

          {job.manifestUrl && (
            <a className={`${btnGhost} mt-3`} href={job.manifestUrl} target="_blank" rel="noreferrer">
              <FileJson className="size-3.5" aria-hidden /> Manifest (what is and is not included)
            </a>
          )}
        </div>
      )}
    </div>
  )
}
