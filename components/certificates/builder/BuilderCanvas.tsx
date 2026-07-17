'use client'

import { useEffect, useRef, useState } from 'react'
import { QrCode } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { FONT_CSS, clamp01, snapFraction } from './lib'
import type { EditorMeta } from './lib'
import type { CertificateDimensions, LayoutElement } from '@/lib/certificates/types'

const BASE_WIDTH = 760           // stage width (px) at zoom = 1
const GRID_STEP  = 0.025         // snap step (fraction)
const HANDLE     = 10            // resize handle size (px)

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Props {
  canvas:         CertificateDimensions
  bgUrl:          string | null
  isPdf:          boolean
  elements:       LayoutElement[]
  meta:           Record<string, EditorMeta>
  selectedIds:    string[]
  setSelectedIds: (ids: string[]) => void
  onChangeMany:   (patches: { id: string; patch: Partial<LayoutElement> }[]) => void
  zoom:           number
  pan:            { x: number; y: number }
  setPan:         (p: { x: number; y: number }) => void
  grid:           boolean
  snap:           boolean
  tool:           'select' | 'pan'
  readOnly:       boolean
  onZoom:         (dir: 1 | -1) => void
}

interface Marquee { x0: number; y0: number; x1: number; y1: number }

export default function BuilderCanvas(p: Props) {
  const displayW = BASE_WIDTH * p.zoom
  const displayH = displayW * (p.canvas.height / p.canvas.width)

  const stageRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })

  // Latest props for use inside imperative pointer handlers.
  const ref = useRef(p)
  ref.current = p
  const dimsRef = useRef({ displayW, displayH })
  dimsRef.current = { displayW, displayH }

  function selectOnly(id: string, additive: boolean) {
    const cur = ref.current.selectedIds
    if (additive) ref.current.setSelectedIds(cur.includes(id) ? cur.filter(i => i !== id) : [...cur, id])
    else if (!cur.includes(id)) ref.current.setSelectedIds([id])
  }

  // ── Move (single or multi) ──────────────────────────────────────────────────
  function startMove(e: React.PointerEvent, id: string) {
    if (ref.current.readOnly || ref.current.meta[id]?.locked) { selectOnly(id, e.shiftKey); return }
    e.stopPropagation()
    const additive = e.shiftKey
    selectOnly(id, additive)
    const ids = additive
      ? Array.from(new Set([...ref.current.selectedIds, id]))
      : (ref.current.selectedIds.includes(id) ? ref.current.selectedIds : [id])

    const startX = e.clientX
    const startY = e.clientY
    const snap = ref.current.snap
    const snapshot = new Map(ref.current.elements.map(el => [el.id, { x: el.x, y: el.y }]))

    function move(ev: PointerEvent) {
      const { displayW: dw, displayH: dh } = dimsRef.current
      const dxF = (ev.clientX - startX) / dw
      const dyF = (ev.clientY - startY) / dh
      const patches = ids.map(eid => {
        const s = snapshot.get(eid)!
        return { id: eid, patch: { x: snapFraction(s.x + dxF, GRID_STEP, snap), y: snapFraction(s.y + dyF, GRID_STEP, snap) } }
      })
      if (ids.length === 1) {
        const px = patches[0].patch
        setGuides({ v: px.x === 0.5, h: px.y === 0.5 })
      }
      ref.current.onChangeMany(patches)
    }
    function up() {
      setGuides({ v: false, h: false })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Resize (single, corner) ───────────────────────────────────────────────────
  function startResize(e: React.PointerEvent, el: LayoutElement, corner: Corner) {
    if (ref.current.readOnly || ref.current.meta[el.id]?.locked) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const snap = ref.current.snap
    const init = { x: el.x, y: el.y, w: el.width ?? 0.2, h: el.height ?? 0.1 }

    function move(ev: PointerEvent) {
      const { displayW: dw, displayH: dh } = dimsRef.current
      const dxF = (ev.clientX - startX) / dw
      const dyF = (ev.clientY - startY) / dh
      let { x, y, w, h } = init
      if (corner === 'se') { w = init.w + dxF; h = init.h + dyF }
      if (corner === 'ne') { w = init.w + dxF; h = init.h - dyF; y = init.y + dyF }
      if (corner === 'sw') { w = init.w - dxF; h = init.h + dyF; x = init.x + dxF }
      if (corner === 'nw') { w = init.w - dxF; h = init.h - dyF; x = init.x + dxF; y = init.y + dyF }
      w = Math.max(0.02, w); h = Math.max(0.01, h)
      ref.current.onChangeMany([{ id: el.id, patch: {
        x: snapFraction(x, GRID_STEP, snap), y: snapFraction(y, GRID_STEP, snap),
        width: clamp01(w), height: clamp01(h),
      } }])
    }
    function up() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Rotate (single, on-canvas handle) — rotates about the element CENTER to match
  //    the certificate renderer's rotate-about-center convention (GA-6 S2/S6). ──────
  function startRotate(e: React.PointerEvent, el: LayoutElement) {
    if (ref.current.readOnly || ref.current.meta[el.id]?.locked) return
    e.stopPropagation()
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2   // center is fixed during rotation
    function move(ev: PointerEvent) {
      let deg = Math.round(Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90)   // handle sits above center
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15                                          // 15° snap with Shift
      deg = ((deg % 360) + 360) % 360
      ref.current.onChangeMany([{ id: el.id, patch: { rotation: deg } }])
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Background pointer down: pan, marquee, or clear ───────────────────────────
  function onStagePointerDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.stagebg) return

    if (ref.current.tool === 'pan' || e.button === 1) {
      const startX = e.clientX, startY = e.clientY
      const startPan = { ...ref.current.pan }
      function move(ev: PointerEvent) {
        ref.current.setPan({ x: startPan.x + (ev.clientX - startX), y: startPan.y + (ev.clientY - startY) })
      }
      function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      return
    }

    if (ref.current.readOnly) return
    // Marquee select.
    const rect = stageRef.current!.getBoundingClientRect()
    const x0 = (e.clientX - rect.left) / rect.width
    const y0 = (e.clientY - rect.top) / rect.height
    ref.current.setSelectedIds([])
    function move(ev: PointerEvent) {
      const x1 = clamp01((ev.clientX - rect.left) / rect.width)
      const y1 = clamp01((ev.clientY - rect.top) / rect.height)
      setMarquee({ x0, y0, x1, y1 })
    }
    function up(ev: PointerEvent) {
      const x1 = clamp01((ev.clientX - rect.left) / rect.width)
      const y1 = clamp01((ev.clientY - rect.top) / rect.height)
      const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
      const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
      const hit = ref.current.elements.filter(el => {
        const ew = el.width ?? 0.05, eh = el.height ?? 0.05
        return el.x < hi.x && el.x + ew > lo.x && el.y < hi.y && el.y + eh > lo.y && !ref.current.meta[el.id]?.hidden
      }).map(el => el.id)
      if (hit.length) ref.current.setSelectedIds(hit)
      setMarquee(null)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Spacebar → temporary pan cursor handled by parent tool; wheel zoom by parent.
  useEffect(() => {
    const el = stageRef.current?.parentElement
    if (!el) return
    function wheel(e: WheelEvent) {
      if (!e.ctrlKey) return
      e.preventDefault()
      ref.current.onZoom(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const ordered = [...p.elements].sort((a, b) => a.zIndex - b.zIndex)

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted/40">
      {/* viewport */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ cursor: p.tool === 'pan' ? 'grab' : 'default' }}
      >
        <div style={{ transform: `translate(${p.pan.x}px, ${p.pan.y}px)` }}>
          {/* stage */}
          <div
            ref={stageRef}
            data-stagebg="1"
            onPointerDown={onStagePointerDown}
            className="relative select-none shadow-lg ring-1 ring-border"
            style={{
              width: displayW,
              height: displayH,
              background: p.bgUrl ? `center/cover no-repeat url(${p.bgUrl})` : '#ffffff',
              backgroundImage: p.grid
                ? `${p.bgUrl ? `url(${p.bgUrl}),` : ''} linear-gradient(#0000000d 1px,transparent 1px), linear-gradient(90deg,#0000000d 1px,transparent 1px)`
                : undefined,
              backgroundSize: p.grid ? `cover, ${displayW * GRID_STEP}px ${displayH * GRID_STEP}px, ${displayW * GRID_STEP}px ${displayH * GRID_STEP}px` : undefined,
            }}
          >
            {/* PDF templates can't show their background in-browser */}
            {p.isPdf && (
              <span data-stagebg="1" className="pointer-events-none absolute left-2 top-2 rounded bg-foreground/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                PDF background — see Server Preview
              </span>
            )}

            {/* center guides */}
            {guides.v && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary/70" />}
            {guides.h && <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/70" />}

            {/* elements */}
            {ordered.map(el => {
              if (p.meta[el.id]?.hidden) return null
              const selected = p.selectedIds.includes(el.id)
              const locked = p.meta[el.id]?.locked
              const left = el.x * displayW
              const top  = el.y * displayH
              const w = (el.width ?? (el.type === 'text' ? 0.4 : 0.15)) * displayW
              const h = (el.height ?? (el.type === 'line' ? 0.01 : 0.12)) * displayH
              const rot = el.rotation ? `rotate(${el.rotation}deg)` : undefined

              return (
                <div
                  key={el.id}
                  onPointerDown={e => startMove(e, el.id)}
                  className={cn('absolute', selected ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-primary/40', locked && 'cursor-not-allowed')}
                  style={{ left, top, width: w, height: el.type === 'text' ? undefined : h, transform: rot, opacity: el.opacity ?? 1, transformOrigin: 'center' }}
                >
                  <ElementBody el={el} displayH={displayH} />

                  {/* rotate handle (single selected, unlocked) — above the box centre */}
                  {selected && !locked && !p.readOnly && (
                    <div
                      onPointerDown={e => startRotate(e, el)}
                      title="Rotate" aria-label="Rotate element"
                      className="absolute left-1/2 z-20 size-3 -translate-x-1/2 cursor-grab rounded-full border border-primary bg-white"
                      style={{ top: -22 }}
                    />
                  )}

                  {/* resize handles (single selected, unlocked, sized elements) */}
                  {selected && !locked && !p.readOnly && el.type !== 'text' && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(c => (
                    <div
                      key={c}
                      onPointerDown={e => startResize(e, el, c)}
                      className="absolute z-10 rounded-sm border border-primary bg-white"
                      style={{
                        width: HANDLE, height: HANDLE,
                        left: c.includes('w') ? -HANDLE / 2 : undefined,
                        right: c.includes('e') ? -HANDLE / 2 : undefined,
                        top: c.includes('n') ? -HANDLE / 2 : undefined,
                        bottom: c.includes('s') ? -HANDLE / 2 : undefined,
                        cursor: `${c}-resize`,
                      }}
                    />
                  ))}
                </div>
              )
            })}

            {/* marquee */}
            {marquee && (
              <div
                className="pointer-events-none absolute border border-primary bg-primary/10"
                style={{
                  left: Math.min(marquee.x0, marquee.x1) * displayW,
                  top: Math.min(marquee.y0, marquee.y1) * displayH,
                  width: Math.abs(marquee.x1 - marquee.x0) * displayW,
                  height: Math.abs(marquee.y1 - marquee.y0) * displayH,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ElementBody({ el, displayH }: { el: LayoutElement; displayH: number }) {
  if (el.type === 'text') {
    return (
      <div
        style={{
          fontFamily: FONT_CSS[el.fontFamily],
          fontSize: el.fontSizeFrac * displayH,
          fontWeight: el.weight === 'bold' ? 700 : 400,
          fontStyle: el.italic ? 'italic' : 'normal',
          color: el.color,
          textAlign: el.align,
          lineHeight: 1.25,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {el.content}
      </div>
    )
  }
  if (el.type === 'image') {
    return el.assetUrl
      ? <img src={el.assetUrl} alt="" className="h-full w-full" style={{ objectFit: el.fit }} draggable={false} />
      : (
        <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-muted-foreground/50 bg-muted/40 text-[11px] capitalize text-muted-foreground">
          {el.role ?? 'image'} — upload
        </div>
      )
  }
  if (el.type === 'qr') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white" style={{ color: el.darkColor ?? '#1a1a1a' }}>
        <QrCode className="h-3/4 w-3/4" />
      </div>
    )
  }
  // line
  return <div className="w-full" style={{ height: Math.max(1, el.thickness * displayH), background: el.color }} />
}
