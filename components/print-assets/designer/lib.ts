// Print designer — shared client helpers. Mirrors the certificate builder's
// interaction model (fractional [0,1] coords, top-left origin, snap-to-grid/center).

import type { PrintElement, PrintElementType } from '@/lib/printAssets/types'

export const ELEMENT_LABELS: Record<PrintElementType, string> = {
  text:    'Text',
  image:   'Image Placeholder',
  qr:      'QR Placeholder',
  barcode: 'Barcode',
  rect:    'Rectangle',
  line:    'Line',
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Snap a fraction to a grid step, or to canvas center (0.5) when close. */
export function snapFrac(frac: number, step: number, enabled: boolean): number {
  if (!enabled) return clamp01(frac)
  if (Math.abs(frac - 0.5) < step / 2) return 0.5
  return clamp01(Math.round(frac / step) * step)
}

export function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `el-${Math.random().toString(36).slice(2, 10)}`
}

/** Creates a new element with sensible defaults near the canvas center. */
export function createElement(type: PrintElementType, zIndex: number): PrintElement {
  const base = { id: newId(), x: 0.32, y: 0.4, width: 0.3, height: 0.15, rotation: 0, visible: true, locked: false, zIndex }
  switch (type) {
    case 'text':
      return { ...base, type, height: 0.1, properties: { text: 'Text', fontSize: 0.06, fontWeight: 'normal', align: 'center', color: '#111827', opacity: 1, letterSpacing: 0, lineHeight: 1.2 } }
    case 'image':
      return { ...base, type, width: 0.22, height: 0.22, properties: { fit: 'contain', opacity: 1 } }
    case 'qr':
      return { ...base, type, x: 0.7, y: 0.68, width: 0.16, height: 0.16, properties: {} }
    case 'rect':
      return { ...base, type, properties: { fill: '#e5e7eb', borderColor: '#9ca3af', borderWidth: 0, radius: 0, opacity: 1 } }
    case 'line':
    default:
      return { ...base, type: 'line', x: 0.3, y: 0.6, width: 0.4, height: 0.004, properties: { orientation: 'horizontal', thickness: 0.004, color: '#9ca3af', opacity: 1 } }
  }
}
