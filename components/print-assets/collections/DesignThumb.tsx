'use client'

// PA-8 — Lightweight client preview of a design. Positions elements by their
// fractional coords (the SAME [0,1] model the renderer uses) with plain divs — it
// does NOT import the server-only renderer. Good enough to preview a collection
// template before import; the real PDF/SVG still comes from the render engine.

import { cn } from '@/lib/utils/cn'
import type { PrintCanvas, PrintDesign, PrintElement } from '@/lib/printAssets/types'

const TIER: Record<PrintElement['type'], number> = { rect: 0, line: 1, image: 2, qr: 3, barcode: 4, text: 5 }

export function DesignThumb({ canvas, design, height = 150, className }: {
  canvas: PrintCanvas; design: PrintDesign; height?: number; className?: string
}) {
  const portrait = canvas.orientation !== 'landscape'
  const cw = portrait ? canvas.width : canvas.height
  const ch = portrait ? canvas.height : canvas.width
  const width = height * (cw / ch)

  const ordered = [...design.elements]
    .filter(e => e.visible !== false)
    .sort((a, b) => (TIER[a.type] - TIER[b.type]) || (a.zIndex - b.zIndex))

  return (
    <div className={cn('relative overflow-hidden rounded ring-1 ring-border', className)}
      style={{ width, height, background: design.canvas.background, border: design.canvas.borderWidth > 0 ? `1px solid ${design.canvas.borderColor}` : undefined }}>
      {ordered.map(el => {
        const style: React.CSSProperties = {
          position: 'absolute',
          left: `${el.x * 100}%`, top: `${el.y * 100}%`,
          width: `${el.width * 100}%`, height: `${el.height * 100}%`,
          transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
          transformOrigin: 'center', opacity: el.properties.opacity ?? 1,
        }
        const p = el.properties
        if (el.type === 'rect') return <div key={el.id} style={{ ...style, background: p.fill ?? '#e5e7eb', borderRadius: (p.radius ?? 0) * width, border: (p.borderWidth ?? 0) > 0 ? `1px solid ${p.borderColor ?? '#9ca3af'}` : undefined }} />
        if (el.type === 'line') return <div key={el.id} style={{ ...style, height: Math.max(1, (p.thickness ?? 0.004) * height), background: p.color ?? '#9ca3af', top: `${(el.y + el.height / 2) * 100}%` }} />
        if (el.type === 'image') return <div key={el.id} style={style} className="flex items-center justify-center bg-slate-100 text-[7px] text-slate-400"><span>IMG</span></div>
        if (el.type === 'qr') return (
          <div key={el.id} style={style} className="grid grid-cols-3 grid-rows-3 gap-px bg-white p-px">
            {Array.from({ length: 9 }).map((_, i) => <div key={i} style={{ background: [0, 2, 4, 6, 8].includes(i) ? (p.color ?? '#111') : 'transparent' }} />)}
          </div>
        )
        if (el.type === 'barcode') return (
          <div key={el.id} style={{ ...style, background: '#fff', backgroundImage: `repeating-linear-gradient(90deg, ${p.color ?? '#111'} 0, ${p.color ?? '#111'} 1px, transparent 1px, transparent 3px)` }} />
        )
        // text
        return (
          <div key={el.id} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: p.align === 'left' ? 'flex-start' : p.align === 'right' ? 'flex-end' : 'center' }}>
            <span style={{ fontSize: Math.max(4, (p.fontSize ?? 0.05) * height), fontWeight: p.fontWeight === 'bold' ? 700 : 400, color: p.color ?? '#111827', lineHeight: 1, textAlign: p.align ?? 'center', width: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              {p.text || ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}
