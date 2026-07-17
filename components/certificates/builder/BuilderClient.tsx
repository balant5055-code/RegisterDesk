'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { onIdTokenChanged } from 'firebase/auth'
import {
  ArrowLeft, ZoomIn, ZoomOut, Maximize, Grid3x3, Magnet,
  MousePointer2, Hand, Eye, Loader2, Check, AlertCircle, Monitor,
  Undo2, Redo2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import ElementPalette from './ElementPalette'
import BuilderCanvas  from './BuilderCanvas'
import PropertiesPanel from './PropertiesPanel'
import LayersPanel    from './LayersPanel'
import PreviewModal   from './PreviewModal'
import { QualityPanel } from './QualityPanel'
import { analyzeCertificateLayout } from '@/lib/certificates/qualityCheck'
import { createElement, toSavedLayout, newId, FALLBACK_CANVAS } from './lib'
import type { EditorMeta, PaletteKind } from './lib'
// Shared Designer Core (GA-6 S2) — undo/redo + alignment + fit, reused from the Print Designer.
import { useEditorHistory } from '@/lib/designer/history'
import { alignPatches, type AlignOp, type AlignBox } from '@/lib/designer/align'
import { computeFitZoom } from '@/lib/designer/geometry'
import type { TemplateResponse } from '@/app/api/organizer/events/[eventId]/certificates/templates/[templateId]/route'
import type {
  CertificateDimensions, LayoutElement, CertificateLayout,
} from '@/lib/certificates/types'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export default function BuilderClient({ eventId, templateId }: { eventId: string; templateId: string }) {
  const [token, setToken] = useState('')
  const [uid, setUid]     = useState('')

  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [canvas, setCanvas]   = useState<CertificateDimensions>(FALLBACK_CANVAS)
  const [bgUrl, setBgUrl]     = useState<string | null>(null)
  const [isPdf, setIsPdf]     = useState(false)

  // Elements are undoable via the SHARED Designer Core (GA-6 S2). Rendering + data
  // model + save API are unchanged — the core owns only editor state transitions.
  const { state: elements, mutate: mutateEls, reset: resetEls, undo, redo, canUndo, canRedo } =
    useEditorHistory<LayoutElement[]>([])
  const [meta, setMeta]               = useState<Record<string, EditorMeta>>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const viewportRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan]   = useState({ x: 0, y: 0 })
  const [grid, setGrid] = useState(true)
  const [snap, setSnap] = useState(true)
  const [tool, setTool] = useState<'select' | 'pan'>('select')

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  // ── Auth token ───────────────────────────────────────────────────────────────
  useEffect(() => onIdTokenChanged(auth, async u => {
    if (u) { setUid(u.uid); setToken(await u.getIdToken()) }
  }), [])

  // ── Responsive (view-only on mobile) ──────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check(); window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // ── Load template + layout ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/organizer/events/${eventId}/certificates/templates/${templateId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string })?.error ?? 'Failed to load template')
        const { template } = await res.json() as TemplateResponse
        if (cancelled) return
        setTemplateName(template.name)
        setCanvas(template.dimensions ?? FALLBACK_CANVAS)
        setIsPdf(template.templateType === 'pdf')
        setBgUrl(template.templateType === 'pdf' ? null : template.fileUrl)
        resetEls(template.layout?.elements ?? [])
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setLoadErr(e instanceof Error ? e.message : 'Failed to load'); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [token, eventId, templateId, resetEls])

  // GA-7D S3: load the event's certificate settings so the quality validator can flag a
  // missing verification QR when public verification is enabled (the check already exists
  // in analyzeCertificateLayout; it just needs the flag passed below).
  const [verificationEnabled, setVerificationEnabled] = useState(false)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch(`/api/organizer/events/${eventId}/certificates/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.settings) setVerificationEnabled(d.settings.verification?.enabled === true) })
      .catch(() => { /* non-fatal — validator just skips the QR check */ })
    return () => { cancelled = true }
  }, [token, eventId])

  // ── Autosave (debounced) ────────────────────────────────────────────────────────
  const firstSave = useRef(true)
  useEffect(() => {
    if (loading || !token || isMobile) return
    if (firstSave.current) { firstSave.current = false; return }   // skip initial load
    setSaveStatus('saving')
    const layout = toSavedLayout(canvas, elements)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/organizer/events/${eventId}/certificates/templates/${templateId}/layout`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(layout),
        })
        setSaveStatus(res.ok ? 'saved' : 'error')
      } catch {
        setSaveStatus('error')
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [elements, canvas, loading, token, isMobile, eventId, templateId])

  // ── Element mutations ────────────────────────────────────────────────────────
  const nextZ = useCallback(() => elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1, [elements])

  const addElement = useCallback((kind: PaletteKind) => {
    const el = createElement(kind, nextZ())
    mutateEls(prev => [...prev, el])
    setSelectedIds([el.id])
  }, [nextZ, mutateEls])

  // `coalesce` defaults to true so a continuous drag/resize/slider collapses into ONE
  // undo step (the canvas calls onChangeMany with a single arg during a drag).
  const patchMany = useCallback((patches: { id: string; patch: Partial<LayoutElement> }[], coalesce = true) => {
    const map = new Map(patches.map(p => [p.id, p.patch]))
    mutateEls(prev => prev.map(e => map.has(e.id) ? ({ ...e, ...map.get(e.id) } as LayoutElement) : e), coalesce)
  }, [mutateEls])

  const patchOne = useCallback((patch: Partial<LayoutElement>) => {
    if (selectedIds.length !== 1) return
    patchMany([{ id: selectedIds[0], patch }])
  }, [selectedIds, patchMany])

  const select = useCallback((id: string, additive: boolean) => {
    setSelectedIds(cur => additive ? (cur.includes(id) ? cur.filter(i => i !== id) : [...cur, id]) : [id])
  }, [])

  const reorder = useCallback((id: string, dir: 1 | -1) => {
    mutateEls(prev => {
      const sorted = [...prev].sort((a, b) => a.zIndex - b.zIndex)
      const i = sorted.findIndex(e => e.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= sorted.length) return prev
      const zi = sorted[i].zIndex, zj = sorted[j].zIndex
      return prev.map(e => e.id === sorted[i].id ? { ...e, zIndex: zj } : e.id === sorted[j].id ? { ...e, zIndex: zi } : e)
    }, false)
  }, [mutateEls])

  const duplicate = useCallback((id: string) => {
    let copyId = ''
    mutateEls(prev => {
      const src = prev.find(e => e.id === id)
      if (!src) return prev
      const z = prev.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1
      copyId = newId()
      const copy = { ...src, id: copyId, zIndex: z, x: Math.min(0.95, src.x + 0.02), y: Math.min(0.95, src.y + 0.02) } as LayoutElement
      return [...prev, copy]
    }, false)
    if (copyId) setSelectedIds([copyId])
  }, [mutateEls])

  const remove = useCallback((id: string) => {
    mutateEls(prev => prev.filter(e => e.id !== id), false)
    setSelectedIds(cur => cur.filter(i => i !== id))
  }, [mutateEls])

  // Alignment / distribution over the selection via the shared core (page for one, bbox for many).
  const applyAlign = useCallback((op: AlignOp) => {
    const boxes: AlignBox[] = []
    for (const id of selectedIds) {
      const el = elements.find(e => e.id === id)
      if (el) boxes.push({ id, x: el.x, y: el.y, width: el.width ?? 0.1, height: el.height ?? 0.1, locked: meta[id]?.locked })
    }
    const patches = alignPatches(op, boxes)
    if (patches.length) patchMany(patches.map(p => ({ id: p.id, patch: p.patch })), false)
  }, [selectedIds, elements, meta, patchMany])

  // Fit-to-page zoom (shared helper). 760 mirrors BuilderCanvas BASE_WIDTH.
  const fitToPage = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    setZoom(computeFitZoom(vp.clientWidth, vp.clientHeight, 760, canvas.width, canvas.height, 'page'))
    setPan({ x: 0, y: 0 })
  }, [canvas.width, canvas.height])

  const toggleMeta = useCallback((id: string, key: keyof EditorMeta) => {
    setMeta(prev => {
      const cur = prev[id] ?? { locked: false, hidden: false }
      return { ...prev, [id]: { ...cur, [key]: !cur[key] } }
    })
  }, [])

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isMobile) return
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault()
        const ids = new Set(selectedIds)
        mutateEls(prev => prev.filter(el => !ids.has(el.id)), false)   // one undo step for the whole selection
        setSelectedIds([])
        return
      }
      if (e.key === 'Escape') { setSelectedIds([]); return }
      const step = e.shiftKey ? 0.02 : 0.005
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (move && selectedIds.length) {
        e.preventDefault()
        patchMany(selectedIds.map(id => {
          const el = elements.find(x => x.id === id)!
          return { id, patch: { x: Math.max(0, Math.min(1, el.x + move[0])), y: Math.max(0, Math.min(1, el.y + move[1])) } }
        }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, elements, patchMany, undo, redo, mutateEls, isMobile])

  const currentLayout: CertificateLayout = useMemo(() => toSavedLayout(canvas, elements), [canvas, elements])
  const qualityIssues = useMemo(() => analyzeCertificateLayout(currentLayout, { verificationEnabled }), [currentLayout, verificationEnabled])
  const single = selectedIds.length === 1 ? elements.find(e => e.id === selectedIds[0]) ?? null : null

  // ── Render states ───────────────────────────────────────────────────────────
  if (loading) {
    return <div className="flex h-screen items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (loadErr) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
        <AlertCircle className="size-7 text-red-500" />
        <p className="text-[14px] text-foreground">{loadErr}</p>
        <Link href={`/dashboard/events/${eventId}`} className="text-[13px] font-semibold text-primary hover:underline">Back to event</Link>
      </div>
    )
  }

  if (isMobile) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <Monitor className="size-8 text-muted-foreground" />
        <div>
          <p className="text-[15px] font-semibold text-foreground">Builder is desktop-only</p>
          <p className="mt-1 text-[13px] text-muted-foreground">Open the certificate builder on a larger screen to edit. You can still preview the design.</p>
        </div>
        <button type="button" onClick={() => setPreviewOpen(true)} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white">
          <Eye className="size-4" /> Preview
        </button>
        <Link href={`/dashboard/events/${eventId}`} className="text-[13px] text-muted-foreground hover:underline">Back to event</Link>
        {previewOpen && <PreviewModal eventId={eventId} templateId={templateId} token={token} layout={currentLayout} onClose={() => setPreviewOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Toolbar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
        <Link href={`/dashboard/events/${eventId}`} className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back
        </Link>
        <span className="truncate text-[14px] font-semibold text-foreground">{templateName || 'Certificate Builder'}</span>

        <div className="mx-2 h-5 w-px bg-border" />
        <ToolBtn title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo()}><Undo2 className="size-4" /></ToolBtn>
        <ToolBtn title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo()}><Redo2 className="size-4" /></ToolBtn>

        <div className="mx-2 h-5 w-px bg-border" />
        <ToolBtn active={tool === 'select'} title="Select" onClick={() => setTool('select')}><MousePointer2 className="size-4" /></ToolBtn>
        <ToolBtn active={tool === 'pan'} title="Pan" onClick={() => setTool('pan')}><Hand className="size-4" /></ToolBtn>
        <ToolBtn active={grid} title="Grid" onClick={() => setGrid(v => !v)}><Grid3x3 className="size-4" /></ToolBtn>
        <ToolBtn active={snap} title="Snap" onClick={() => setSnap(v => !v)}><Magnet className="size-4" /></ToolBtn>

        {selectedIds.length > 0 && (
          <>
            <div className="mx-2 h-5 w-px bg-border" />
            <ToolBtn title="Align left" onClick={() => applyAlign('left')}><AlignStartVertical className="size-4" /></ToolBtn>
            <ToolBtn title="Align center" onClick={() => applyAlign('center-h')}><AlignCenterVertical className="size-4" /></ToolBtn>
            <ToolBtn title="Align right" onClick={() => applyAlign('right')}><AlignEndVertical className="size-4" /></ToolBtn>
            <ToolBtn title="Align top" onClick={() => applyAlign('top')}><AlignStartHorizontal className="size-4" /></ToolBtn>
            <ToolBtn title="Align middle" onClick={() => applyAlign('center-v')}><AlignCenterHorizontal className="size-4" /></ToolBtn>
            <ToolBtn title="Align bottom" onClick={() => applyAlign('bottom')}><AlignEndHorizontal className="size-4" /></ToolBtn>
          </>
        )}

        <div className="mx-2 h-5 w-px bg-border" />
        <ToolBtn title="Zoom out" onClick={() => setZoom(z => Math.max(0.25, z - 0.1))}><ZoomOut className="size-4" /></ToolBtn>
        <span className="w-10 text-center text-[12px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <ToolBtn title="Zoom in" onClick={() => setZoom(z => Math.min(3, z + 0.1))}><ZoomIn className="size-4" /></ToolBtn>
        <ToolBtn title="Fit to page" onClick={fitToPage}><Maximize className="size-4" /></ToolBtn>

        <div className="ml-auto flex items-center gap-3">
          <SaveIndicator status={saveStatus} />
          <QualityPanel issues={qualityIssues} onSelect={id => setSelectedIds([id])} />
          <button type="button" onClick={() => setPreviewOpen(true)} aria-label="Preview certificate" className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90">
            <Eye className="size-3.5" /> Preview
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 border-r border-border bg-card"><ElementPalette onAdd={addElement} /></aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={viewportRef} className="min-h-0 flex-1">
            <BuilderCanvas
              canvas={canvas} bgUrl={bgUrl} isPdf={isPdf}
              elements={elements} meta={meta}
              selectedIds={selectedIds} setSelectedIds={setSelectedIds}
              onChangeMany={patchMany}
              zoom={zoom} pan={pan} setPan={setPan}
              grid={grid} snap={snap} tool={tool} readOnly={false}
              onZoom={dir => setZoom(z => Math.max(0.25, Math.min(3, z + dir * 0.1)))}
            />
          </div>
          <div className="h-44 shrink-0 border-t border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Layers</span>
            </div>
            <div className="h-[calc(11rem-30px)]">
              <LayersPanel
                elements={elements} meta={meta} selectedIds={selectedIds} select={select}
                bringForward={id => reorder(id, 1)} sendBackward={id => reorder(id, -1)}
                duplicate={duplicate} toggleLock={id => toggleMeta(id, 'locked')}
                toggleHide={id => toggleMeta(id, 'hidden')} remove={remove}
              />
            </div>
          </div>
        </div>

        <aside className="w-64 shrink-0 border-l border-border bg-card">
          <PropertiesPanel element={single} multiCount={selectedIds.length} canvas={canvas} eventId={eventId} uid={uid} onChange={patchOne} />
        </aside>
      </div>

      {previewOpen && <PreviewModal eventId={eventId} templateId={templateId} token={token} layout={currentLayout} onClose={() => setPreviewOpen(false)} />}
    </div>
  )
}

function ToolBtn({ active, title, onClick, disabled, children }: { active?: boolean; title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}
      className={cn('flex size-8 items-center justify-center rounded-lg',
        disabled ? 'cursor-not-allowed text-muted-foreground/40'
        : active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
      {children}
    </button>
  )
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'saving') return <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Saving…</span>
  if (status === 'saved')  return <span className="flex items-center gap-1.5 text-[12px] text-emerald-600"><Check className="size-3.5" /> Saved</span>
  if (status === 'error')  return <span className="flex items-center gap-1.5 text-[12px] text-red-600"><AlertCircle className="size-3.5" /> Save failed</span>
  return null
}
