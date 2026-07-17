'use client'

// PA-9 Sprint 1 — Live Output Preview. Renders the designer's CURRENT (unsaved)
// design through the EXISTING preview API (POST /print-templates/[id]/preview with an
// inline `design`), which calls the ONE renderer (renderToSvg). No second renderer,
// no renderPreview()/designerRenderer()/previewRenderer().
//
// Contract: 200ms debounce after the last change, abort the in-flight request so only
// the latest render wins, and never fetch during a drag (the timer keeps resetting).

import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, RefreshCw, ZoomIn, ZoomOut, Maximize, AlertTriangle } from 'lucide-react'
import type { PrintDesign } from '@/lib/printAssets/types'
import type { PrintVariableSources } from '@/lib/printAssets/render/variables'

type Status = 'idle' | 'loading' | 'error'

const SIMULATIONS: { key: string; label: string }[] = [
  { key: 'pdf', label: 'Actual PDF' }, { key: 'pvc', label: 'PVC Badge' }, { key: 'lanyard', label: 'Lanyard Badge' },
  { key: 'bib', label: 'Race Bib' }, { key: 'vip', label: 'VIP Pass' }, { key: 'tent', label: 'Table Tent' },
  { key: 'parking', label: 'Parking Pass' },
]

export function PrintPreview({ templateId, design, variables }: { templateId: string; design: PrintDesign; variables?: PrintVariableSources }) {
  const [svgUrl, setSvgUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [scale, setScale] = useState(1)
  const [sim, setSim] = useState('pdf')

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const urlRef   = useRef<string | null>(null)          // current object URL, for revocation

  // Serialize the design + variables so the debounce effect re-runs on any change
  // (edit, sample profile, or real registration).
  const key = JSON.stringify({ design, variables })

  const fetchPreview = useCallback(async () => {
    abortRef.current?.abort()                            // only the latest render wins
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStatus('loading')
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch(`/api/organizer/print-templates/${templateId}/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design, format: 'svg', ...(variables ? { variables } : {}) }),
        signal: ctrl.signal,
      })
      if (!res.ok) { setStatus('error'); return }
      const svg = await res.text()
      const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)   // free the previous frame
      urlRef.current = blobUrl
      setSvgUrl(blobUrl)
      setStatus('idle')
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return   // superseded — ignore
      setStatus('error')
    }
  }, [templateId, design, variables])

  // Debounced auto-refresh: wait 200ms after the last change, then render.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void fetchPreview() }, 200)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Cleanup on unmount.
  useEffect(() => () => {
    abortRef.current?.abort()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Preview toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
          Live Preview
          {status === 'loading' && <Loader2 className="size-3 animate-spin text-primary" />}
        </span>
        <select value={sim} onChange={e => setSim(e.target.value)} title="Print simulation"
          className="mr-auto ml-2 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {SIMULATIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <PBtn title="Zoom out" onClick={() => setScale(s => Math.max(0.25, +(s - 0.15).toFixed(2)))}><ZoomOut className="size-3.5" /></PBtn>
        <button onClick={() => setScale(1)} className="min-w-[42px] rounded px-1 text-[11px] tabular-nums text-muted-foreground hover:bg-muted">{Math.round(scale * 100)}%</button>
        <PBtn title="Zoom in" onClick={() => setScale(s => Math.min(4, +(s + 0.15).toFixed(2)))}><ZoomIn className="size-3.5" /></PBtn>
        <PBtn title="Fit" onClick={() => setScale(1)}><Maximize className="size-3.5" /></PBtn>
        <PBtn title="Refresh preview" onClick={() => void fetchPreview()}><RefreshCw className="size-3.5" /></PBtn>
      </div>

      {/* Preview surface */}
      <div className="relative flex flex-1 items-center justify-center overflow-auto bg-muted/40 p-3">
        {svgUrl && (
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }} className="max-h-full max-w-full">
            <SimFrame sim={sim}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={svgUrl} alt="Live output preview" className="block max-h-full max-w-full object-contain" />
            </SimFrame>
          </div>
        )}

        {/* First-load spinner (no image yet) */}
        {!svgUrl && status === 'loading' && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-[12px]">Rendering preview…</span>
          </div>
        )}

        {/* Error — designer keeps working; retry re-renders */}
        {status === 'error' && (
          <div className={cn('flex flex-col items-center gap-2 rounded-lg bg-card/90 p-4 text-center', svgUrl && 'absolute inset-x-3 bottom-3')}>
            <AlertTriangle className="size-5 text-amber-500" />
            <span className="text-[12px] font-medium text-foreground">Preview unavailable</span>
            <button onClick={() => void fetchPreview()} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[12px] font-semibold text-foreground hover:bg-muted">
              <RefreshCw className="size-3.5" /> Retry
            </button>
          </div>
        )}

        {/* In-place refresh overlay (keeps the last frame — no flicker) */}
        {svgUrl && status === 'loading' && (
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
            <Loader2 className="size-3 animate-spin text-primary" /> Rendering…
          </div>
        )}
      </div>
    </div>
  )
}

function PBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      {children}
    </button>
  )
}

// Presentation-only mockups around the real SVG. NEVER affects the exported PDF.
function SimFrame({ sim, children }: { sim: string; children: React.ReactNode }) {
  if (sim === 'pdf') return <div className="shadow-md ring-1 ring-border">{children}</div>

  if (sim === 'pvc') return (
    <div className="relative overflow-hidden rounded-xl shadow-xl ring-1 ring-black/10">
      {children}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-white/0 via-white/25 to-white/0" />
    </div>
  )
  if (sim === 'lanyard') return (
    <div className="relative pt-8">
      <div className="absolute left-1/2 top-0 h-8 w-10 -translate-x-1/2 rounded-b bg-slate-400" />
      <div className="absolute left-1/2 top-6 size-2.5 -translate-x-1/2 rounded-full border-2 border-slate-500 bg-white" />
      <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black/10">{children}</div>
    </div>
  )
  if (sim === 'bib') return (
    <div className="relative bg-white p-1 shadow-md ring-1 ring-border">
      {children}
      {[['left-1 top-1'], ['right-1 top-1'], ['left-1 bottom-1'], ['right-1 bottom-1']].map(([pos], i) => (
        <div key={i} className={`pointer-events-none absolute ${pos} size-2 rounded-full bg-slate-300 ring-1 ring-slate-400`} />
      ))}
    </div>
  )
  if (sim === 'vip') return (
    <div className="relative rounded-lg p-1.5 shadow-xl" style={{ background: 'linear-gradient(135deg,#b8860b,#f5d67a,#b8860b)' }}>
      <div className="overflow-hidden rounded ring-1 ring-black/10">{children}</div>
      <div className="pointer-events-none absolute -right-1 top-2 rounded-l bg-rose-600 px-2 py-0.5 text-[9px] font-bold text-white shadow">VIP</div>
    </div>
  )
  if (sim === 'tent') return (
    <div className="relative shadow-md ring-1 ring-border">
      {children}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-slate-400/70" />
    </div>
  )
  if (sim === 'parking') return (
    <div className="relative pt-6">
      <div className="absolute left-1/2 top-1 size-3 -translate-x-1/2 rounded-full border-2 border-slate-400 bg-white" />
      <div className="shadow-md ring-1 ring-border">{children}</div>
    </div>
  )
  return <div className="shadow-md ring-1 ring-border">{children}</div>
}
