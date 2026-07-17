'use client'

import { useEffect, useRef, useState } from 'react'
import { QrCode, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { clamp01, snapFrac } from './lib'
import type { PrintCanvas as CanvasSize, PrintDesignCanvasSettings, PrintElement } from '@/lib/printAssets/types'

const BASE_WIDTH = 620
const HANDLE      = 9
const RULER       = 18   // px

type Corner = 'nw' | 'ne' | 'sw' | 'se'

export interface GuideFlags { safe: boolean; trim: boolean; bleed: boolean; margins: boolean; center: boolean }

interface Props {
  canvasSize:  CanvasSize
  settings:    PrintDesignCanvasSettings
  elements:    PrintElement[]
  selectedIds: string[]
  setSelectedIds: (ids: string[]) => void
  onChange:    (patches: { id: string; patch: Partial<PrintElement> }[]) => void
  zoom:        number
  pan:         { x: number; y: number }
  setPan:      (p: { x: number; y: number }) => void
  tool:        'select' | 'pan'
  preview:     boolean
  guides:      GuideFlags
  onZoom:      (dir: 1 | -1) => void
}

export default function PrintCanvas(p: Props) {
  const portrait = p.canvasSize.orientation !== 'landscape'
  const cw = portrait ? p.canvasSize.width  : p.canvasSize.height
  const ch = portrait ? p.canvasSize.height : p.canvasSize.width
  const displayW = BASE_WIDTH * p.zoom
  const displayH = displayW * (ch / cw)

  const stageRef = useRef<HTMLDivElement>(null)
  const [guideLine, setGuideLine] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const ref = useRef(p)
  const dims = useRef({ displayW, displayH })
  /* eslint-disable react-hooks/refs */
  ref.current = p
  dims.current = { displayW, displayH }
  /* eslint-enable react-hooks/refs */

  const selSet = new Set(p.selectedIds)
  const selectedEls = p.elements.filter(e => selSet.has(e.id))

  function toggleSelect(id: string) {
    const cur = ref.current.selectedIds
    ref.current.setSelectedIds(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])
  }

  // ── Move (group-aware) ─────────────────────────────────────────────────────────
  function startMove(e: React.PointerEvent, el: PrintElement) {
    if (ref.current.preview) return
    if (e.shiftKey || e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSelect(el.id); return }
    if (!new Set(ref.current.selectedIds).has(el.id)) ref.current.setSelectedIds([el.id])
    if (el.locked) return
    e.stopPropagation()

    const sx = e.clientX, sy = e.clientY
    const ids = new Set(ref.current.selectedIds).has(el.id) ? ref.current.selectedIds : [el.id]
    const movers = ref.current.elements.filter(x => ids.includes(x.id) && !x.locked)
    const inits = new Map(movers.map(x => [x.id, { x: x.x, y: x.y }]))
    const primary = inits.get(el.id)!
    const snap = ref.current.settings.snap, step = ref.current.settings.gridStep

    function move(ev: PointerEvent) {
      const { displayW: dw, displayH: dh } = dims.current
      const nx = snapFrac(primary.x + (ev.clientX - sx) / dw, step, snap)
      const ny = snapFrac(primary.y + (ev.clientY - sy) / dh, step, snap)
      const ddx = nx - primary.x, ddy = ny - primary.y
      setGuideLine({ v: nx === 0.5, h: ny === 0.5 })
      ref.current.onChange(movers.map(m => {
        const it = inits.get(m.id)!
        return { id: m.id, patch: { x: clamp01(it.x + ddx), y: clamp01(it.y + ddy) } }
      }))
    }
    function up() { setGuideLine({ v: false, h: false }); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // ── Resize (single element) ─────────────────────────────────────────────────────
  function startResize(e: React.PointerEvent, el: PrintElement, corner: Corner) {
    if (ref.current.preview || el.locked) return
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const init = { x: el.x, y: el.y, w: el.width, h: el.height }
    const snap = ref.current.settings.snap, step = ref.current.settings.gridStep
    function move(ev: PointerEvent) {
      const { displayW: dw, displayH: dh } = dims.current
      const dxF = (ev.clientX - sx) / dw, dyF = (ev.clientY - sy) / dh
      let { x, y, w, h } = init
      if (corner === 'se') { w = init.w + dxF; h = init.h + dyF }
      if (corner === 'ne') { w = init.w + dxF; h = init.h - dyF; y = init.y + dyF }
      if (corner === 'sw') { w = init.w - dxF; h = init.h + dyF; x = init.x + dxF }
      if (corner === 'nw') { w = init.w - dxF; h = init.h - dyF; x = init.x + dxF; y = init.y + dyF }
      ref.current.onChange([{ id: el.id, patch: {
        x: snapFrac(x, step, snap), y: snapFrac(y, step, snap),
        width: clamp01(Math.max(0.02, w)), height: clamp01(Math.max(0.006, h)),
      } }])
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // ── Group resize (scale the selection about the opposite corner) ────────────────
  function startGroupResize(e: React.PointerEvent, corner: Corner) {
    if (ref.current.preview) return
    e.stopPropagation()
    const els = ref.current.elements.filter(x => new Set(ref.current.selectedIds).has(x.id) && !x.locked)
    if (els.length < 2) return
    const bb = groupBounds(els)
    const ax = corner.includes('w') ? bb.maxX : bb.minX     // anchor = opposite corner
    const ay = corner.includes('n') ? bb.maxY : bb.minY
    const cx0 = corner.includes('w') ? bb.minX : bb.maxX
    const cy0 = corner.includes('n') ? bb.minY : bb.maxY
    const inits = new Map(els.map(x => [x.id, { x: x.x, y: x.y, w: x.width, h: x.height }]))
    const sx = e.clientX, sy = e.clientY

    function move(ev: PointerEvent) {
      const { displayW: dw, displayH: dh } = dims.current
      const ncx = cx0 + (ev.clientX - sx) / dw
      const ncy = cy0 + (ev.clientY - sy) / dh
      let scx = (ncx - ax) / (cx0 - ax || 1e-6)
      let scy = (ncy - ay) / (cy0 - ay || 1e-6)
      scx = Math.max(0.1, scx); scy = Math.max(0.1, scy)
      ref.current.onChange(els.map(m => {
        const it = inits.get(m.id)!
        return { id: m.id, patch: {
          x: clamp01(ax + (it.x - ax) * scx), y: clamp01(ay + (it.y - ay) * scy),
          width: clamp01(Math.max(0.02, it.w * scx)), height: clamp01(Math.max(0.006, it.h * scy)),
        } }
      }))
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // ── Rotate (single element) ─────────────────────────────────────────────────────
  function startRotate(e: React.PointerEvent, el: PrintElement) {
    if (ref.current.preview || el.locked) return
    e.stopPropagation()
    const rect = stageRef.current!.getBoundingClientRect()
    const cxp = (el.x + el.width / 2) * rect.width + rect.left
    const cyp = (el.y + el.height / 2) * rect.height + rect.top
    const startAngle = Math.atan2(e.clientY - cyp, e.clientX - cxp) * 180 / Math.PI
    const init = el.rotation
    function move(ev: PointerEvent) {
      const a = Math.atan2(ev.clientY - cyp, ev.clientX - cxp) * 180 / Math.PI
      let rot = Math.round(init + (a - startAngle))
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15
      ref.current.onChange([{ id: el.id, patch: { rotation: ((rot % 360) + 360) % 360 } }])
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // ── Stage background: pan, marquee select, or clear ─────────────────────────────
  function onStageDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.stagebg) return
    if (ref.current.tool === 'pan' || e.button === 1) {
      const sx = e.clientX, sy = e.clientY, startPan = { ...ref.current.pan }
      function move(ev: PointerEvent) { ref.current.setPan({ x: startPan.x + (ev.clientX - sx), y: startPan.y + (ev.clientY - sy) }) }
      function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      return
    }
    // Marquee selection.
    const rect = stageRef.current!.getBoundingClientRect()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (!additive) ref.current.setSelectedIds([])
    const ox = (e.clientX - rect.left) / rect.width, oy = (e.clientY - rect.top) / rect.height
    function move(ev: PointerEvent) {
      const cx = (ev.clientX - rect.left) / rect.width, cy = (ev.clientY - rect.top) / rect.height
      setMarquee({ x: Math.min(ox, cx), y: Math.min(oy, cy), w: Math.abs(cx - ox), h: Math.abs(cy - oy) })
    }
    function up(ev: PointerEvent) {
      const cx = (ev.clientX - rect.left) / rect.width, cy = (ev.clientY - rect.top) / rect.height
      const r = { x: Math.min(ox, cx), y: Math.min(oy, cy), w: Math.abs(cx - ox), h: Math.abs(cy - oy) }
      if (r.w > 0.01 || r.h > 0.01) {
        const hits = ref.current.elements.filter(el => el.visible !== false && el.x < r.x + r.w && el.x + el.width > r.x && el.y < r.y + r.h && el.y + el.height > r.y).map(el => el.id)
        const base = additive ? ref.current.selectedIds : []
        ref.current.setSelectedIds([...new Set([...base, ...hits])])
      }
      setMarquee(null)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    const el = stageRef.current?.closest('[data-viewport]') as HTMLElement | null
    if (!el) return
    function wheel(e: WheelEvent) { if (!e.ctrlKey) return; e.preventDefault(); ref.current.onZoom(e.deltaY < 0 ? 1 : -1) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const ordered = [...p.elements].sort((a, b) => a.zIndex - b.zIndex)
  const border = p.settings.borderWidth > 0 ? `${p.settings.borderWidth * displayW}px solid ${p.settings.borderColor}` : undefined
  const ticks = Array.from({ length: Math.round(1 / p.settings.gridStep) + 1 }, (_, i) => i * p.settings.gridStep)
  const single = selectedEls.length === 1 ? selectedEls[0] : null
  const gb = selectedEls.length > 1 ? groupBounds(selectedEls) : null
  const g = p.guides

  return (
    <div data-viewport className="relative h-full w-full overflow-hidden bg-muted/40">
      <div className="absolute inset-0 flex items-center justify-center" style={{ cursor: p.tool === 'pan' ? 'grab' : 'default' }}>
        <div style={{ transform: `translate(${p.pan.x}px, ${p.pan.y}px)` }}>
          <div className="relative" style={{ paddingLeft: RULER, paddingTop: RULER }}>
            {!p.preview && (
              <>
                <div className="absolute left-0 top-0 border-b border-r border-border bg-card" style={{ width: RULER, height: RULER }} />
                <div className="absolute top-0 flex border-b border-border bg-card" style={{ left: RULER, width: displayW, height: RULER }}>
                  {ticks.map((t, i) => <div key={i} className="absolute top-0 h-full border-l border-border/50" style={{ left: t * displayW }} />)}
                </div>
                <div className="absolute left-0 flex flex-col border-r border-border bg-card" style={{ top: RULER, width: RULER, height: displayH }}>
                  {ticks.map((t, i) => <div key={i} className="absolute left-0 w-full border-t border-border/50" style={{ top: t * displayH }} />)}
                </div>
              </>
            )}

            <div
              ref={stageRef}
              data-stagebg="1"
              onPointerDown={onStageDown}
              className="relative select-none shadow-lg ring-1 ring-border"
              style={{
                width: displayW, height: displayH, background: p.settings.background, border,
                backgroundImage: p.settings.showGrid && !p.preview
                  ? 'linear-gradient(#0000000d 1px,transparent 1px), linear-gradient(90deg,#0000000d 1px,transparent 1px)'
                  : undefined,
                backgroundSize: p.settings.showGrid && !p.preview ? `${displayW * p.settings.gridStep}px ${displayH * p.settings.gridStep}px, ${displayW * p.settings.gridStep}px ${displayH * p.settings.gridStep}px` : undefined,
              }}
            >
              {/* Print guides (designer-only overlays; never exported) */}
              {!p.preview && (
                <>
                  {g.bleed   && <div className="pointer-events-none absolute rounded-sm border border-dashed border-rose-400/70" style={{ inset: '-6%' }} />}
                  {g.trim    && <div className="pointer-events-none absolute inset-0 border border-sky-500/70" />}
                  {g.margins && <div className="pointer-events-none absolute border border-dashed border-amber-400/70" style={{ inset: '5%' }} />}
                  {g.safe    && <div className="pointer-events-none absolute border border-dashed border-emerald-500/70" style={{ inset: '8%' }} />}
                  {g.center  && <>
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/30" />
                  </>}
                </>
              )}

              {guideLine.v && <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px -translate-x-1/2 bg-primary/70" />}
              {guideLine.h && <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-px -translate-y-1/2 bg-primary/70" />}

              {ordered.map(el => {
                if (!el.visible) return null
                const isSel = !p.preview && selSet.has(el.id)
                const left = el.x * displayW, top = el.y * displayH
                const w = el.width * displayW, h = el.height * displayH
                return (
                  <div
                    key={el.id}
                    onPointerDown={e => startMove(e, el)}
                    className={cn('absolute', isSel ? 'ring-2 ring-primary' : (!p.preview && 'hover:ring-1 hover:ring-primary/40'), el.locked && 'cursor-not-allowed')}
                    style={{ left, top, width: w, height: h, transform: `rotate(${el.rotation}deg)`, transformOrigin: 'center', opacity: (el.properties.opacity ?? 1) }}
                  >
                    <ElementBody el={el} displayH={displayH} />

                    {single === el && !el.locked && (
                      <>
                        {(['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                          <div key={c} onPointerDown={e => startResize(e, el, c)}
                            className="absolute z-10 rounded-sm border border-primary bg-white"
                            style={{ width: HANDLE, height: HANDLE, cursor: `${c}-resize`,
                              left: c.includes('w') ? -HANDLE / 2 : undefined, right: c.includes('e') ? -HANDLE / 2 : undefined,
                              top: c.includes('n') ? -HANDLE / 2 : undefined, bottom: c.includes('s') ? -HANDLE / 2 : undefined }} />
                        ))}
                        <div onPointerDown={e => startRotate(e, el)} title="Rotate"
                          className="absolute left-1/2 z-10 size-3 -translate-x-1/2 cursor-grab rounded-full border border-primary bg-white" style={{ top: -22 }} />
                        <div className="absolute left-1/2 top-0 h-[14px] w-px -translate-x-1/2 -translate-y-full bg-primary/60" />
                      </>
                    )}
                  </div>
                )
              })}

              {/* Group bounding box + resize handles (multi-select) */}
              {!p.preview && gb && (
                <div className="pointer-events-none absolute z-20 border border-dashed border-primary"
                  style={{ left: gb.minX * displayW, top: gb.minY * displayH, width: (gb.maxX - gb.minX) * displayW, height: (gb.maxY - gb.minY) * displayH }}>
                  {(['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                    <div key={c} onPointerDown={e => startGroupResize(e, c)}
                      className="pointer-events-auto absolute rounded-sm border border-primary bg-white"
                      style={{ width: HANDLE, height: HANDLE, cursor: `${c}-resize`,
                        left: c.includes('w') ? -HANDLE / 2 : undefined, right: c.includes('e') ? -HANDLE / 2 : undefined,
                        top: c.includes('n') ? -HANDLE / 2 : undefined, bottom: c.includes('s') ? -HANDLE / 2 : undefined }} />
                  ))}
                </div>
              )}

              {/* Marquee */}
              {marquee && (
                <div className="pointer-events-none absolute z-30 border border-primary bg-primary/10"
                  style={{ left: marquee.x * displayW, top: marquee.y * displayH, width: marquee.w * displayW, height: marquee.h * displayH }} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function groupBounds(els: PrintElement[]) {
  return {
    minX: Math.min(...els.map(e => e.x)),
    minY: Math.min(...els.map(e => e.y)),
    maxX: Math.max(...els.map(e => e.x + e.width)),
    maxY: Math.max(...els.map(e => e.y + e.height)),
  }
}

function ElementBody({ el, displayH }: { el: PrintElement; displayH: number }) {
  const pr = el.properties
  if (el.type === 'text') {
    return (
      <div className="flex h-full w-full overflow-hidden" style={{ alignItems: 'center', justifyContent: pr.align === 'left' ? 'flex-start' : pr.align === 'right' ? 'flex-end' : 'center' }}>
        <div style={{
          width: '100%',
          fontSize: (pr.fontSize ?? 0.06) * displayH, fontWeight: pr.fontWeight === 'bold' ? 700 : 400,
          textAlign: pr.align ?? 'center', color: pr.color ?? '#111827',
          letterSpacing: `${pr.letterSpacing ?? 0}em`, lineHeight: pr.lineHeight ?? 1.2,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{pr.text || 'Text'}</div>
      </div>
    )
  }
  if (el.type === 'image') {
    return (
      <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-muted-foreground/50 bg-muted/40 text-[10px] text-muted-foreground">
        <div className="text-center"><ImageIcon className="mx-auto size-4" aria-hidden /><span>Image · {pr.fit ?? 'contain'}</span></div>
      </div>
    )
  }
  if (el.type === 'qr') {
    return <div className="flex h-full w-full items-center justify-center rounded bg-white text-foreground/80"><QrCode className="h-4/5 w-4/5" /></div>
  }
  if (el.type === 'rect') {
    return <div className="h-full w-full" style={{ background: pr.fill ?? '#e5e7eb', border: (pr.borderWidth ?? 0) > 0 ? `${(pr.borderWidth ?? 0) * 400}px solid ${pr.borderColor ?? '#9ca3af'}` : undefined, borderRadius: `${(pr.radius ?? 0) * 400}px` }} />
  }
  return <div className="w-full self-center" style={{ height: Math.max(1, (pr.thickness ?? 0.004) * displayH), background: pr.color ?? '#9ca3af' }} />
}
