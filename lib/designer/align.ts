// Shared Designer Core — alignment / distribution / equal-size (GA-6 S2). PURE.
//
// Generalized from lib/printAssets/designer/align.ts so BOTH designers share ONE
// implementation. Operates on a minimal geometric box (fractional [0,1] coords) and
// returns geometry-only patches the caller applies through its EXISTING mutate path —
// no renderer, schema, or business-logic knowledge. For a single element, alignment
// is relative to the PAGE; for many, relative to the selection bbox.

export type AlignOp =
  | 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v'
  | 'distribute-h' | 'distribute-v' | 'equal-w' | 'equal-h'

/** The only fields alignment needs. Both LayoutElement and PrintElement satisfy this
 *  (callers supply width/height defaults for models where they are optional). */
export interface AlignBox { id: string; x: number; y: number; width: number; height: number; locked?: boolean }
export interface AlignPatch { id: string; patch: { x?: number; y?: number; width?: number; height?: number } }

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
function bounds(els: AlignBox[]): Bounds {
  return {
    minX: Math.min(...els.map(e => e.x)),
    minY: Math.min(...els.map(e => e.y)),
    maxX: Math.max(...els.map(e => e.x + e.width)),
    maxY: Math.max(...els.map(e => e.y + e.height)),
  }
}

export function alignPatches(op: AlignOp, selected: AlignBox[]): AlignPatch[] {
  if (selected.length === 0) return []
  const els = selected.filter(e => !e.locked)
  if (els.length === 0) return []

  // Single element aligns to the page [0,1]; multiple align to their group bbox.
  const b: Bounds = els.length === 1 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : bounds(els)
  const patch = (id: string, p: AlignPatch['patch']): AlignPatch => ({ id, patch: p })

  switch (op) {
    case 'left':     return els.map(e => patch(e.id, { x: b.minX }))
    case 'right':    return els.map(e => patch(e.id, { x: b.maxX - e.width }))
    case 'top':      return els.map(e => patch(e.id, { y: b.minY }))
    case 'bottom':   return els.map(e => patch(e.id, { y: b.maxY - e.height }))
    case 'center-h': return els.map(e => patch(e.id, { x: (b.minX + b.maxX) / 2 - e.width / 2 }))
    case 'center-v': return els.map(e => patch(e.id, { y: (b.minY + b.maxY) / 2 - e.height / 2 }))

    case 'distribute-h': {
      if (els.length < 3) return []
      const sorted = [...els].sort((a, c) => a.x - c.x)
      const totalW = sorted.reduce((s, e) => s + e.width, 0)
      const gap = (b.maxX - b.minX - totalW) / (sorted.length - 1)
      let cur = b.minX
      return sorted.map(e => { const p = patch(e.id, { x: cur }); cur += e.width + gap; return p })
    }
    case 'distribute-v': {
      if (els.length < 3) return []
      const sorted = [...els].sort((a, c) => a.y - c.y)
      const totalH = sorted.reduce((s, e) => s + e.height, 0)
      const gap = (b.maxY - b.minY - totalH) / (sorted.length - 1)
      let cur = b.minY
      return sorted.map(e => { const p = patch(e.id, { y: cur }); cur += e.height + gap; return p })
    }

    case 'equal-w': {
      const w = els[0].width
      return els.slice(1).map(e => patch(e.id, { width: w }))
    }
    case 'equal-h': {
      const h = els[0].height
      return els.slice(1).map(e => patch(e.id, { height: h }))
    }
  }
}
