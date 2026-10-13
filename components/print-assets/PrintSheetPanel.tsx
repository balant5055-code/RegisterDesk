'use client'

// RD-PRINT-P2/P3 — "Print sheets": lay a generation job's cards out on A4/A3 paper and
// download ONE PDF. RD-PRINT-P3: any number of cards (up to a run's limit) — the server
// plans a combined run and renders it in sheet-aligned batches; the browser merges them
// and downloads only when every batch arrived and the server confirmed the run. Nothing is
// stored; the session token travels in the Authorization header only. Uses the selected
// cards when there is a selection, otherwise every ready card in the job. The card size
// is the job's PINNED template version.

import { useEffect, useState } from 'react'
import { downloadCombinedPrintRun, PrintRunError } from '@/lib/printAssets/runs/client'
import { Loader2, Printer } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import {
  DEFAULT_SHEET_SPEC, PAPER_SIZES, SHEET_GAP_MAX_MM, SHEET_MARGIN_MAX_MM, CROP_MARK_REACH_MM,
  validateSheetSpec, type SheetSpec,
} from '@/lib/printAssets/sheet/layout'

interface Props {
  jobId:       string
  selectedIds: string[]
  getToken:    () => Promise<string>
  notify:      (message: string, kind: 'success' | 'error') => void
}

const input = 'w-20 rounded-lg border border-border bg-background px-2 py-1 text-[13px]'

interface HistoryRow {
  runId: string; status: string; statusLabel: string; message: string | null
  cardCount: number; sheets: number; sheet: { paper: string }; createdAt: string | null
}

async function loadHistory(jobId: string, getToken: () => Promise<string>): Promise<HistoryRow[]> {
  try {
    const res = await fetch(`/api/organizer/print-jobs/${encodeURIComponent(jobId)}/runs`, {
      headers: { Authorization: `Bearer ${await getToken()}` }, cache: 'no-store',
    })
    if (!res.ok) return []
    return ((await res.json()) as { runs?: HistoryRow[] }).runs ?? []
  } catch { return [] }
}

export default function PrintSheetPanel({ jobId, selectedIds, getToken, notify }: Props) {
  const [spec, setSpec] = useState<SheetSpec>(DEFAULT_SHEET_SPEC)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  // RD-PRINT-P4 — this job's recent combined downloads, with a clear status and message.
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      const rows = await loadHistory(jobId, getToken)
      if (alive) setHistory(rows)
    })()
    return () => { alive = false }
  }, [jobId, getToken, historyVersion])
  const check = validateSheetSpec(spec)
  const cropTooTight = spec.cropMarks && spec.marginMm < CROP_MARK_REACH_MM

  async function download() {
    if (!check.ok || busy) return
    setBusy(true); setProgress('Planning…')
    try {
      const { plan } = await downloadCombinedPrintRun({
        jobId, spec: check.value, registrationIds: selectedIds, getToken,
        requestId: crypto.randomUUID(),                     // once per click — a double submit reuses the run
        onPlan: p => setProgress(`Rendering ${p.cardCount} cards in ${p.batchCount} part${p.batchCount === 1 ? '' : 's'}…`),
        onProgress: (d, t) => setProgress(`Rendering part ${d} of ${t}…`),
      })
      const notes = [
        plan.skippedCount ? `${plan.skippedCount} could not be printed (cancelled, refunded or not ready)` : '',
        plan.overflowCount ? `${plan.overflowCount} card${plan.overflowCount === 1 ? ' has' : 's have'} text that does not fit its box — check the design` : '',
      ].filter(Boolean)
      notify(`${plan.cardCount} cards on ${plan.sheets} sheet${plan.sheets === 1 ? '' : 's'} (${plan.perSheet} per sheet).${notes.length ? ` ${notes.join('; ')}.` : ''}`, 'success')
    } catch (err) {
      const e = err instanceof PrintRunError ? err : null
      notify(e ? `${e.message}${e.registrationIds?.length ? ` (${e.registrationIds.length} affected)` : ''} Nothing was downloaded.` : 'Network error — nothing was downloaded.', 'error')
    } finally {
      setBusy(false); setProgress(''); setHistoryVersion(v => v + 1)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-3" data-testid="print-sheet-panel">
      <span className="flex items-center gap-1.5 self-center text-[12px] font-semibold text-muted-foreground"><Printer className="size-4" aria-hidden /> Print sheets</span>
      <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">Paper
        <select value={spec.paper} onChange={e => setSpec(s => ({ ...s, paper: e.target.value as SheetSpec['paper'] }))} className={input}>
          {PAPER_SIZES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">Orientation
        <select value={spec.orientation} onChange={e => setSpec(s => ({ ...s, orientation: e.target.value as SheetSpec['orientation'] }))} className="rounded-lg border border-border bg-background px-2 py-1 text-[13px]">
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">Margins (mm)
        <input type="number" min={0} max={SHEET_MARGIN_MAX_MM} step={0.5} value={spec.marginMm} onChange={e => setSpec(s => ({ ...s, marginMm: Number(e.target.value) }))} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">Gap (mm)
        <input type="number" min={0} max={SHEET_GAP_MAX_MM} step={0.5} value={spec.gapMm} onChange={e => setSpec(s => ({ ...s, gapMm: Number(e.target.value) }))} className={input} />
      </label>
      <label className="flex items-center gap-1.5 self-center text-[13px] text-foreground">
        <input type="checkbox" checked={spec.cropMarks} onChange={e => setSpec(s => ({ ...s, cropMarks: e.target.checked }))} /> Crop marks
      </label>
      <button type="button" onClick={() => void download()} disabled={busy || !check.ok || cropTooTight}
        className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'ml-auto')}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
        {selectedIds.length ? `Sheets for ${selectedIds.length} selected` : 'Sheets for all ready cards'}
      </button>
      {progress && <p role="status" className="w-full text-[12px] text-muted-foreground">{progress}</p>}
      {history.length > 0 && (
        <ul className="w-full divide-y divide-border border-t border-border pt-1 text-[12px]" data-testid="print-run-history">
          {history.slice(0, 5).map(h => (
            <li key={h.runId} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
              <span className="text-muted-foreground">{h.createdAt ? new Date(h.createdAt).toLocaleString() : '—'}</span>
              <span className="text-foreground">{h.cardCount} cards · {h.sheets} sheets · {h.sheet.paper}</span>
              <span className={h.status === 'completed' ? 'font-semibold text-emerald-700' : h.status === 'planned' ? 'text-muted-foreground' : 'font-semibold text-destructive'}>{h.statusLabel}</span>
              {h.message && h.status !== 'completed' && <span className="w-full text-muted-foreground">{h.message}</span>}
            </li>
          ))}
        </ul>
      )}
      {(!check.ok || cropTooTight) && (
        <p role="alert" className="w-full text-[12px] text-destructive">
          {!check.ok ? check.error : `Crop marks need margins of at least ${CROP_MARK_REACH_MM} mm.`}
        </p>
      )}
    </div>
  )
}
