'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import {
  ArrowLeft, Undo2, Redo2, ZoomIn, ZoomOut, Grid3x3, Magnet,
  MousePointer2, Hand, Eye, EyeOff, Lock, Unlock, Save, Loader2, Copy, Trash2,
  ChevronUp, ChevronDown, Type, Image as ImageIcon, QrCode, Square, Minus, PanelRight, Frame, Monitor,
} from 'lucide-react'
import PrintCanvas, { type GuideFlags } from './PrintCanvas'
import { PrintPreview } from './PrintPreview'
import { SmartPreviewBar } from './SmartPreviewBar'
import { VariablePicker } from './VariablePicker'
import { VariableInspector } from './VariableInspector'
import { ImageSourcePicker } from './ImageSourcePicker'
import { AlignToolbar } from './AlignToolbar'
import { QualityPanel } from './QualityPanel'
import { useLocalStorage } from './useLocalStorage'
import { createElement, ELEMENT_LABELS, newId } from './lib'
import { buildVariableMap, type PrintVariableSources } from '@/lib/printAssets/render/variables'
import {
  PREVIEW_PROFILES, customFieldVariables, type AuthoringVar,
} from '@/lib/printAssets/designer/previewData'
import { alignPatches, type AlignOp } from '@/lib/printAssets/designer/align'
import { useEditorHistory } from '@/lib/designer/history'
import { analyzeDesign } from '@/lib/printAssets/designer/quality'
import {
  emptyDesign, PRINT_DESIGN_VERSION, type PrintTemplate, type PrintElement,
  type PrintElementType, type PrintDesignCanvasSettings, type PrintElementProperties,
  type PrintDesign,
} from '@/lib/printAssets/types'

interface Doc { elements: PrintElement[]; settings: PrintDesignCanvasSettings }
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const PALETTE: { type: PrintElementType; icon: React.ElementType }[] = [
  { type: 'text', icon: Type }, { type: 'image', icon: ImageIcon }, { type: 'qr', icon: QrCode },
  { type: 'rect', icon: Square }, { type: 'line', icon: Minus },
]

export function PrintDesigner({ templateId }: { templateId: string }) {
  const { showToast } = useToast()
  const tokenRef = useRef('')

  const [loading, setLoading] = useState(true)
  const [template, setTemplate] = useState<PrintTemplate | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  // GA-7D S1: the drag-based canvas is desktop-only (fixed 480px side panels). Mirror
  // the Certificate Builder's graceful mobile guard instead of a silently-broken canvas.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check(); window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Editor document + undo/redo — the SHARED Designer Core owns history (GA-6 S2).
  const markUnsaved = useCallback(() => setSaveStatus('idle'), [])
  const { state: doc, ref: docRef, mutate, undo, redo, reset: resetDoc, canUndo, canRedo } =
    useEditorHistory<Doc>({ elements: [], settings: emptyDesign().canvas }, markUnsaved)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null

  const [zoom, setZoom] = useLocalStorage('pa-zoom', 1)
  const [pan, setPan]   = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  const [preview, setPreview] = useLocalStorage('pa-preview', false)

  // Live Output Preview pane (PA-9): visible + resizable — all persisted (Part 8).
  const [showPreview, setShowPreview] = useLocalStorage('pa-showpreview', true)
  const [previewW, setPreviewW]       = useLocalStorage('pa-previewW', 360)
  const [guides, setGuides] = useLocalStorage<GuideFlags>('pa-guides', { safe: false, trim: false, bleed: false, margins: false, center: false })
  const [guideMenu, setGuideMenu] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)

  // The current (unsaved) design fed to the Live Preview — same JSON the save sends.
  const design = useMemo<PrintDesign>(
    () => ({ version: PRINT_DESIGN_VERSION, canvas: doc.settings, elements: doc.elements }),
    [doc],
  )

  // Smart-preview data (sample profile or real registration) + the resolved map for
  // the Variable Inspector. Reuses the engine's buildVariableMap — no new resolver.
  const [previewVars, setPreviewVars] = useState<PrintVariableSources>(PREVIEW_PROFILES[0].sources)
  const [fieldLabels, setFieldLabels] = useState<Record<string, string>>({})
  const varMap = useMemo(() => buildVariableMap(previewVars), [previewVars])
  const customVars = useMemo<AuthoringVar[]>(() => customFieldVariables(fieldLabels), [fieldLabels])

  function startResize(e: React.PointerEvent) {
    e.preventDefault()
    const startX = e.clientX, startW = previewW
    function move(ev: PointerEvent) { setPreviewW(Math.max(260, Math.min(720, startW + (startX - ev.clientX)))) }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const authed = useCallback(async () => {
    const t = await auth.currentUser?.getIdToken() ?? tokenRef.current
    if (t) tokenRef.current = t
    return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  }, [])

  // ── Load ──────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/organizer/print-templates/${templateId}`, { headers: await authed() })
      const data = await res.json() as { success: boolean; template?: PrintTemplate; error?: string }
      if (!res.ok || !data.success || !data.template) { showToast(data.error ?? 'Could not load template', 'error'); return }
      setTemplate(data.template)
      const d = data.template.design ?? emptyDesign()
      resetDoc({ elements: d.elements ?? [], settings: d.canvas ?? emptyDesign().canvas })
    } catch { showToast('Network error', 'error') }
    finally { setLoading(false) }
  }, [templateId, authed, showToast, resetDoc])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────────
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) { e.preventDefault(); deleteSelected() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // ── Mutations ──────────────────────────────────────────────────────────────────
  const nextZ = () => docRef.current.elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1

  function addElement(type: PrintElementType) {
    const el = createElement(type, nextZ())
    mutate(d => ({ ...d, elements: [...d.elements, el] }))
    setSelectedIds([el.id])
  }
  function patchElements(patches: { id: string; patch: Partial<PrintElement> }[], coalesce = false) {
    const map = new Map(patches.map(p => [p.id, p.patch]))
    mutate(d => ({ ...d, elements: d.elements.map(e => map.has(e.id) ? { ...e, ...map.get(e.id) } : e) }), coalesce)
  }
  function patchSelected(patch: Partial<PrintElement>) { if (selectedId) patchElements([{ id: selectedId, patch }]) }
  function patchSelectedProps(pp: Partial<PrintElementProperties>) {
    if (!selectedId) return
    mutate(d => ({ ...d, elements: d.elements.map(e => e.id === selectedId ? { ...e, properties: { ...e.properties, ...pp } } : e) }))
  }
  function deleteSelected() {
    if (!selectedIds.length) return
    const ids = new Set(selectedIds)
    mutate(d => ({ ...d, elements: d.elements.filter(e => !ids.has(e.id)) }))
    setSelectedIds([])
  }
  function duplicateSelected() {
    const srcs = doc.elements.filter(e => selectedIds.includes(e.id))
    if (!srcs.length) return
    let z = nextZ()
    const copies = srcs.map(src => ({ ...src, id: newId(), x: Math.min(0.98, src.x + 0.03), y: Math.min(0.98, src.y + 0.03), zIndex: z++ }))
    mutate(d => ({ ...d, elements: [...d.elements, ...copies] }))
    setSelectedIds(copies.map(c => c.id))
  }
  // Alignment / distribute / equal-size over the current selection (Part 4).
  function applyAlign(op: AlignOp) {
    const sel = doc.elements.filter(e => selectedIds.includes(e.id))
    const patches = alignPatches(op, sel)
    if (patches.length) patchElements(patches)
  }
  function zOrder(dir: 1 | -1) {
    if (selectedIds.length > 1) {
      const all = doc.elements
      const bound = dir > 0 ? Math.max(...all.map(e => e.zIndex)) + 1 : Math.min(...all.map(e => e.zIndex)) - 1
      const sel = all.filter(e => selectedIds.includes(e.id)).sort((a, b) => a.zIndex - b.zIndex)
      patchElements(sel.map((e, i) => ({ id: e.id, patch: { zIndex: dir > 0 ? bound + i : bound - (sel.length - 1 - i) } })))
      return
    }
    const sorted = [...doc.elements].sort((a, b) => a.zIndex - b.zIndex)
    const i = sorted.findIndex(e => e.id === selectedId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= sorted.length) return
    const a = sorted[i], b = sorted[j]
    patchElements([{ id: a.id, patch: { zIndex: b.zIndex } }, { id: b.id, patch: { zIndex: a.zIndex } }])
  }
  function patchSettings(patch: Partial<PrintDesignCanvasSettings>) { mutate(d => ({ ...d, settings: { ...d.settings, ...patch } })) }

  // Zoom presets + fit (Part 8). 620 mirrors PrintCanvas BASE_WIDTH.
  function fitZoom(mode: 'width' | 'page') {
    const vp = viewportRef.current
    if (!vp || !template) return
    const availW = vp.clientWidth - 48, availH = vp.clientHeight - 48
    const portrait = template.canvas.orientation !== 'landscape'
    const cwv = portrait ? template.canvas.width : template.canvas.height
    const chv = portrait ? template.canvas.height : template.canvas.width
    const zw = availW / 620
    const z = Math.max(0.1, Math.min(3, +(mode === 'width' ? zw : Math.min(zw, availH / (620 * chv / cwv))).toFixed(2)))
    setZoom(z); setPan({ x: 0, y: 0 })
  }
  function onZoomPreset(v: string) {
    if (v === 'fitw') fitZoom('width')
    else if (v === 'fitp') fitZoom('page')
    else if (v) { setZoom((Number(v) || 100) / 100); setPan({ x: 0, y: 0 }) }
  }

  // ── Save (one JSON, atomic overwrite) ──────────────────────────────────────────
  async function save() {
    setSaveStatus('saving')
    try {
      const design = { version: PRINT_DESIGN_VERSION, canvas: doc.settings, elements: doc.elements }
      const res = await fetch(`/api/organizer/print-templates/${templateId}/design`, { method: 'PUT', headers: await authed(), body: JSON.stringify({ design }) })
      setSaveStatus(res.ok ? 'saved' : 'error')
      if (!res.ok) showToast('Save failed', 'error')
    } catch { setSaveStatus('error'); showToast('Network error', 'error') }
  }

  const selected = doc.elements.find(e => e.id === selectedId) ?? null
  const layers = [...doc.elements].sort((a, b) => b.zIndex - a.zIndex)
  const issues = useMemo(() => (template ? analyzeDesign(design, template.canvas, varMap) : []), [template, design, varMap])

  if (loading) return <div className="flex h-[70vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  if (isMobile) {
    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 px-6 text-center">
        <Monitor className="size-8 text-muted-foreground" />
        <div>
          <p className="text-[15px] font-semibold text-foreground">Print Designer is desktop-only</p>
          <p className="mt-1 text-[13px] text-muted-foreground">Open the designer on a larger screen to edit this print asset.</p>
        </div>
        <Link href="/dashboard/print-assets" className="text-[13px] text-muted-foreground hover:underline">Back to Print Assets</Link>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Link href="/dashboard/print-assets" className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft className="size-4" /> Print Assets</Link>
        <span className="truncate text-[14px] font-semibold text-foreground">{template?.name}</span>
        <div className="mx-1 h-5 w-px bg-border" />
        <TBtn title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo()}><Undo2 className="size-4" /></TBtn>
        <TBtn title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo()}><Redo2 className="size-4" /></TBtn>
        <div className="mx-1 h-5 w-px bg-border" />
        <TBtn title="Zoom out" onClick={() => setZoom(z => Math.max(0.1, +(z - 0.1).toFixed(2)))}><ZoomOut className="size-4" /></TBtn>
        <select value="" onChange={e => onZoomPreset(e.target.value)} title="Zoom" className="rounded border border-border bg-background px-1 py-1 text-[12px] tabular-nums text-muted-foreground">
          <option value="">{Math.round(zoom * 100)}%</option>
          <option value="fitw">Fit width</option>
          <option value="fitp">Fit page</option>
          {[25, 50, 75, 100, 150, 200, 300].map(pc => <option key={pc} value={pc}>{pc}%</option>)}
        </select>
        <TBtn title="Zoom in" onClick={() => setZoom(z => Math.min(3, +(z + 0.1).toFixed(2)))}><ZoomIn className="size-4" /></TBtn>
        <div className="mx-1 h-5 w-px bg-border" />
        <TBtn title="Grid" active={doc.settings.showGrid} onClick={() => patchSettings({ showGrid: !doc.settings.showGrid })}><Grid3x3 className="size-4" /></TBtn>
        <TBtn title="Snap" active={doc.settings.snap} onClick={() => patchSettings({ snap: !doc.settings.snap })}><Magnet className="size-4" /></TBtn>
        <div className="relative">
          <TBtn title="Print guides" active={Object.values(guides).some(Boolean)} onClick={() => setGuideMenu(v => !v)}><Frame className="size-4" /></TBtn>
          {guideMenu && (
            <div className="absolute left-0 top-full z-30 mt-1 w-40 rounded-lg border border-border bg-card p-2 text-[12px] shadow-lg">
              {([['safe', 'Safe area'], ['margins', 'Margins'], ['trim', 'Trim line'], ['bleed', 'Bleed'], ['center', 'Center guides']] as [keyof GuideFlags, string][]).map(([k, lbl]) => (
                <label key={k} className="flex items-center gap-2 py-0.5 text-foreground"><input type="checkbox" checked={guides[k]} onChange={e => setGuides(g => ({ ...g, [k]: e.target.checked }))} /> {lbl}</label>
              ))}
            </div>
          )}
        </div>
        <TBtn title="Select tool" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 className="size-4" /></TBtn>
        <TBtn title="Pan tool" active={tool === 'pan'} onClick={() => setTool('pan')}><Hand className="size-4" /></TBtn>
        <TBtn title="Preview mode (hide designer chrome)" active={preview} onClick={() => setPreview(v => !v)}><Eye className="size-4" /></TBtn>
        <TBtn title="Toggle live preview" active={showPreview} onClick={() => setShowPreview(v => !v)}><PanelRight className="size-4" /></TBtn>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed' : 'Unsaved'}</span>
          <button onClick={() => void save()} disabled={saveStatus === 'saving'} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {saveStatus === 'saving' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: elements + layers ── */}
        <div className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <div className="p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Add Element</p>
            <div className="grid grid-cols-2 gap-1.5">
              {PALETTE.map(({ type, icon: Icon }) => (
                <button key={type} onClick={() => addElement(type)} disabled={preview}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-50">
                  <Icon className="size-3.5 text-muted-foreground" /> <span className="truncate">{ELEMENT_LABELS[type]}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Layers — hidden in preview mode (designer chrome only) */}
          {!preview && (
          <div className="flex-1 overflow-y-auto border-t border-border p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Layers</p>
            {layers.length === 0 ? <p className="text-[12px] text-muted-foreground">No elements yet.</p> : (
              <ul className="space-y-0.5">
                {layers.map(el => (
                  <li key={el.id}>
                    <div onClick={e => setSelectedIds(e.shiftKey || e.ctrlKey || e.metaKey ? (selectedIds.includes(el.id) ? selectedIds.filter(x => x !== el.id) : [...selectedIds, el.id]) : [el.id])}
                      className={cn('flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px]', selectedIds.includes(el.id) ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted')}>
                      <span className="flex-1 truncate capitalize">{el.type === 'text' ? (el.properties.text || 'Text') : ELEMENT_LABELS[el.type]}</span>
                      <button onClick={e => { e.stopPropagation(); patchElements([{ id: el.id, patch: { visible: !el.visible } }]) }} title={el.visible ? 'Hide' : 'Show'} className="text-muted-foreground hover:text-foreground">
                        {el.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                      </button>
                      <button onClick={e => { e.stopPropagation(); patchElements([{ id: el.id, patch: { locked: !el.locked } }]) }} title={el.locked ? 'Unlock' : 'Lock'} className="text-muted-foreground hover:text-foreground">
                        {el.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}
        </div>

        {/* ── Center: Designer Canvas | Live Output Preview ── */}
        <div className="flex flex-1 overflow-hidden">
          <div ref={viewportRef} className="flex-1 overflow-hidden">
            {template && (
              <PrintCanvas
                canvasSize={template.canvas} settings={doc.settings} elements={doc.elements}
                selectedIds={selectedIds} setSelectedIds={setSelectedIds} guides={guides}
                onChange={(patches) => patchElements(patches, true)}
                zoom={zoom} pan={pan} setPan={setPan} tool={tool} preview={preview}
                onZoom={dir => setZoom(z => Math.max(0.1, Math.min(3, +(z + dir * 0.1).toFixed(2))))}
              />
            )}
          </div>
          {showPreview && template && (
            <>
              <div onPointerDown={startResize} title="Drag to resize preview"
                className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50" />
              <div className="hidden shrink-0 flex-col md:flex" style={{ width: previewW }}>
                {template.eventId && <SmartPreviewBar eventId={template.eventId} onChange={setPreviewVars} onFields={setFieldLabels} />}
                <div className="min-h-0 flex-1">
                  <PrintPreview templateId={templateId} design={design} variables={previewVars} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Right: properties + alignment + quality ── */}
        <div className="w-64 shrink-0 space-y-3 overflow-y-auto border-l border-border bg-card p-3">
          {selectedIds.length > 1 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-bold text-foreground">{selectedIds.length} items selected</p>
                <div className="flex items-center gap-0.5">
                  <IB title="Duplicate" onClick={duplicateSelected}><Copy className="size-3.5" /></IB>
                  <IB title="Delete" onClick={deleteSelected} danger><Trash2 className="size-3.5" /></IB>
                </div>
              </div>
              <Section title="Arrange"><AlignToolbar count={selectedIds.length} onAlign={applyAlign} onForward={() => zOrder(1)} onBackward={() => zOrder(-1)} /></Section>
            </div>
          ) : selected ? (
            <>
              <ElementProps el={selected} varMap={varMap} customVars={customVars}
                onEl={patchSelected} onProp={patchSelectedProps}
                onDuplicate={duplicateSelected} onDelete={deleteSelected}
                onForward={() => zOrder(1)} onBackward={() => zOrder(-1)}
                onToggleLock={() => patchSelected({ locked: !selected.locked })}
                onToggleVisible={() => patchSelected({ visible: !selected.visible })} />
              <Section title="Align to page"><AlignToolbar count={1} onAlign={applyAlign} onForward={() => zOrder(1)} onBackward={() => zOrder(-1)} /></Section>
            </>
          ) : (
            <CanvasProps settings={doc.settings} onChange={patchSettings} canvas={template?.canvas} />
          )}

          <QualityPanel issues={issues} onSelect={id => setSelectedIds([id])} />
        </div>
      </div>
    </div>
  )
}

// ─── Toolbar button ─────────────────────────────────────────────────────────────
function TBtn({ children, title, onClick, active, disabled }: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      className={cn('rounded-lg p-1.5 transition-colors disabled:opacity-40', active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
      {children}
    </button>
  )
}

// ─── Property panels ──────────────────────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex items-center justify-between gap-2 py-1"><span className="text-[12px] text-muted-foreground">{label}</span><div className="flex items-center gap-1">{children}</div></label>
}
const numCls = 'w-16 rounded border border-border bg-background px-2 py-1 text-[12px]'
const pct = (v: number) => Math.round(v * 1000) / 10
const fromPct = (v: string) => (Number(v) || 0) / 100

function ElementProps({ el, varMap, customVars, onEl, onProp, onDuplicate, onDelete, onForward, onBackward, onToggleLock, onToggleVisible }: {
  el: PrintElement
  varMap: Map<string, string>
  customVars: AuthoringVar[]
  onEl: (p: Partial<PrintElement>) => void
  onProp: (p: Partial<PrintElementProperties>) => void
  onDuplicate: () => void; onDelete: () => void; onForward: () => void; onBackward: () => void
  onToggleLock: () => void; onToggleVisible: () => void
}) {
  const pr = el.properties
  const textRef = useRef<HTMLTextAreaElement>(null)

  // Insert a {{token}} at the caret (cursor position preserved) — no manual typing.
  function insertToken(token: string) {
    const ta = textRef.current
    const cur = pr.text ?? ''
    if (!ta) { onProp({ text: cur + token }); return }
    const start = ta.selectionStart ?? cur.length
    const end   = ta.selectionEnd ?? cur.length
    const next  = cur.slice(0, start) + token + cur.slice(end)
    onProp({ text: next })
    requestAnimationFrame(() => { ta.focus(); const pos = start + token.length; ta.setSelectionRange(pos, pos) })
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold capitalize text-foreground">{ELEMENT_LABELS[el.type]}</p>
        <div className="flex items-center gap-0.5">
          <IB title="Bring forward" onClick={onForward}><ChevronUp className="size-3.5" /></IB>
          <IB title="Send backward" onClick={onBackward}><ChevronDown className="size-3.5" /></IB>
          <IB title={el.visible ? 'Hide' : 'Show'} onClick={onToggleVisible}>{el.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</IB>
          <IB title={el.locked ? 'Unlock' : 'Lock'} onClick={onToggleLock}>{el.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}</IB>
          <IB title="Duplicate" onClick={onDuplicate}><Copy className="size-3.5" /></IB>
          <IB title="Delete" onClick={onDelete} danger><Trash2 className="size-3.5" /></IB>
        </div>
      </div>

      <Section title="Position & Size">
        <Row label="X %"><input type="number" className={numCls} value={pct(el.x)} onChange={e => onEl({ x: fromPct(e.target.value) })} /></Row>
        <Row label="Y %"><input type="number" className={numCls} value={pct(el.y)} onChange={e => onEl({ y: fromPct(e.target.value) })} /></Row>
        <Row label="Width %"><input type="number" className={numCls} value={pct(el.width)} onChange={e => onEl({ width: fromPct(e.target.value) })} /></Row>
        <Row label="Height %"><input type="number" className={numCls} value={pct(el.height)} onChange={e => onEl({ height: fromPct(e.target.value) })} /></Row>
        <Row label="Rotation °"><input type="number" className={numCls} value={Math.round(el.rotation)} onChange={e => onEl({ rotation: ((Number(e.target.value) % 360) + 360) % 360 })} /></Row>
      </Section>

      {el.type === 'text' && (
        <Section title="Text">
          <div className="py-1">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] text-muted-foreground">Content</span>
              <VariablePicker onInsert={insertToken} customVars={customVars} />
            </div>
            <textarea ref={textRef} className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[12px]" rows={2} value={pr.text ?? ''} onChange={e => onProp({ text: e.target.value })} />
            <div className="mt-1.5"><VariableInspector text={pr.text ?? ''} map={varMap} /></div>
          </div>
          <Row label="Font size %"><input type="number" className={numCls} value={pct(pr.fontSize ?? 0.06)} onChange={e => onProp({ fontSize: fromPct(e.target.value) })} /></Row>
          <Row label="Weight"><select className={numCls} value={pr.fontWeight ?? 'normal'} onChange={e => onProp({ fontWeight: e.target.value as 'normal' | 'bold' })}><option value="normal">Normal</option><option value="bold">Bold</option></select></Row>
          <Row label="Align"><select className={numCls} value={pr.align ?? 'center'} onChange={e => onProp({ align: e.target.value as 'left' | 'center' | 'right' })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></Row>
          <Row label="Color"><input type="color" value={pr.color ?? '#111827'} onChange={e => onProp({ color: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
          <Row label="Letter spacing"><input type="number" step={0.01} className={numCls} value={pr.letterSpacing ?? 0} onChange={e => onProp({ letterSpacing: Number(e.target.value) || 0 })} /></Row>
          <Row label="Line height"><input type="number" step={0.1} className={numCls} value={pr.lineHeight ?? 1.2} onChange={e => onProp({ lineHeight: Number(e.target.value) || 1.2 })} /></Row>
          <Row label="Opacity"><input type="number" step={0.1} min={0} max={1} className={numCls} value={pr.opacity ?? 1} onChange={e => onProp({ opacity: Math.max(0, Math.min(1, Number(e.target.value))) })} /></Row>
        </Section>
      )}
      {el.type === 'image' && (
        <Section title="Image">
          <ImageSourcePicker value={pr.text ?? ''} onChange={text => onProp({ text })} />
          <Row label="Fit"><select className={numCls} value={pr.fit ?? 'contain'} onChange={e => onProp({ fit: e.target.value as 'contain' | 'cover' })}><option value="contain">Contain</option><option value="cover">Cover</option></select></Row>
          <Row label="Opacity"><input type="number" step={0.1} min={0} max={1} className={numCls} value={pr.opacity ?? 1} onChange={e => onProp({ opacity: Math.max(0, Math.min(1, Number(e.target.value))) })} /></Row>
        </Section>
      )}
      {el.type === 'qr' && <Section title="QR"><p className="text-[11px] text-muted-foreground">Encodes the participant QR ({`{{qr}}`}). Move &amp; resize as needed.</p></Section>}
      {el.type === 'rect' && (
        <Section title="Rectangle">
          <Row label="Fill"><input type="color" value={pr.fill ?? '#e5e7eb'} onChange={e => onProp({ fill: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
          <Row label="Border color"><input type="color" value={pr.borderColor ?? '#9ca3af'} onChange={e => onProp({ borderColor: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
          <Row label="Border %"><input type="number" step={0.1} className={numCls} value={pct(pr.borderWidth ?? 0)} onChange={e => onProp({ borderWidth: fromPct(e.target.value) })} /></Row>
          <Row label="Radius %"><input type="number" step={0.1} className={numCls} value={pct(pr.radius ?? 0)} onChange={e => onProp({ radius: fromPct(e.target.value) })} /></Row>
          <Row label="Opacity"><input type="number" step={0.1} min={0} max={1} className={numCls} value={pr.opacity ?? 1} onChange={e => onProp({ opacity: Math.max(0, Math.min(1, Number(e.target.value))) })} /></Row>
        </Section>
      )}
      {el.type === 'line' && (
        <Section title="Line">
          <Row label="Orientation"><select className={numCls} value={pr.orientation ?? 'horizontal'} onChange={e => onProp({ orientation: e.target.value as 'horizontal' | 'vertical' })}><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select></Row>
          <Row label="Thickness %"><input type="number" step={0.1} className={numCls} value={pct(pr.thickness ?? 0.004)} onChange={e => onProp({ thickness: fromPct(e.target.value) })} /></Row>
          <Row label="Color"><input type="color" value={pr.color ?? '#9ca3af'} onChange={e => onProp({ color: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
        </Section>
      )}
    </div>
  )
}

function CanvasProps({ settings, onChange, canvas }: { settings: PrintDesignCanvasSettings; onChange: (p: Partial<PrintDesignCanvasSettings>) => void; canvas?: PrintTemplate['canvas'] }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] font-bold text-foreground">Canvas</p>
      {canvas && <p className="text-[12px] text-muted-foreground">{canvas.preset === 'CUSTOM' ? 'Custom' : canvas.preset} · {canvas.width}×{canvas.height} {canvas.unit} · {canvas.orientation}</p>}
      <Section title="Appearance">
        <Row label="Background"><input type="color" value={settings.background} onChange={e => onChange({ background: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
        <Row label="Border color"><input type="color" value={settings.borderColor} onChange={e => onChange({ borderColor: e.target.value })} className="h-6 w-8 rounded border border-border" /></Row>
        <Row label="Border %"><input type="number" step={0.1} className={numCls} value={pct(settings.borderWidth)} onChange={e => onChange({ borderWidth: fromPct(e.target.value) })} /></Row>
      </Section>
      <Section title="Grid">
        <Row label="Show grid"><input type="checkbox" checked={settings.showGrid} onChange={e => onChange({ showGrid: e.target.checked })} /></Row>
        <Row label="Snap"><input type="checkbox" checked={settings.snap} onChange={e => onChange({ snap: e.target.checked })} /></Row>
      </Section>
      <p className="text-[11px] text-muted-foreground">Select an element to edit its properties.</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-lg border border-border p-2"><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>{children}</div>
}
function IB({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" title={title} onClick={onClick} className={cn('rounded p-1 text-muted-foreground hover:bg-muted', danger ? 'hover:text-rose-600' : 'hover:text-foreground')}>{children}</button>
}
