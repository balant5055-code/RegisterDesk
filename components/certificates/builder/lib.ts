// Certificate builder — shared client helpers & editor types.
// Coordinates follow the layout schema: fractions [0,1], top-left origin.

import { CURRENT_LAYOUT_VERSION } from '@/lib/certificates/constants'
import type {
  CertificateLayout,
  CertificateDimensions,
  LayoutElement,
  FontFamily,
} from '@/lib/certificates/types'

// Palette entries the user can add. Token-text entries are text elements with
// preset placeholder content; image entries carry a semantic role.
export type PaletteKind =
  | 'text' | 'participantName' | 'eventName' | 'eventDate' | 'certificateId' | 'issueDate'
  | 'qr' | 'logo' | 'signature' | 'seal' | 'image' | 'line'

/** Editor-only state, NOT persisted (the layout schema has no lock/hide). */
export interface EditorMeta { locked: boolean; hidden: boolean }

export const FONT_CSS: Record<FontFamily, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times:     'Georgia, "Times New Roman", serif',
  courier:   '"Courier New", monospace',
}

export const FALLBACK_CANVAS: CertificateDimensions = { width: 842, height: 595, unit: 'pt' }

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Snap a fraction to a grid step, or to the canvas center (0.5) when close. */
export function snapFraction(frac: number, step: number, enabled: boolean): number {
  if (!enabled) return clamp01(frac)
  if (Math.abs(frac - 0.5) < step / 2) return 0.5
  return clamp01(Math.round(frac / step) * step)
}

export function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `el-${Math.random().toString(36).slice(2)}`
}

const TOKEN_TEXT: Partial<Record<PaletteKind, string>> = {
  text:            'Text',
  participantName: '{{participantName}}',
  eventName:       '{{eventName}}',
  eventDate:       '{{eventDate}}',
  certificateId:   'Certificate ID: {{certificateId}}',
  issueDate:       'Issued: {{issueDate}}',
}

const IMAGE_ROLE: Partial<Record<PaletteKind, 'logo' | 'signature' | 'seal' | 'image'>> = {
  logo: 'logo', signature: 'signature', seal: 'seal', image: 'image',
}

export const PALETTE_LABELS: Record<PaletteKind, string> = {
  text: 'Text', participantName: 'Participant Name', eventName: 'Event Name',
  eventDate: 'Event Date', certificateId: 'Certificate ID', issueDate: 'Issue Date',
  qr: 'QR Code', logo: 'Logo', signature: 'Signature', seal: 'Seal', image: 'Image', line: 'Line',
}

/** Creates a new element with sensible defaults, centered-ish on the canvas. */
export function createElement(kind: PaletteKind, zIndex: number): LayoutElement {
  const base = { id: newId(), zIndex, x: 0.3, y: 0.42, opacity: 1 }

  if (kind in TOKEN_TEXT) {
    const isName = kind === 'participantName'
    return {
      ...base,
      type: 'text',
      content: TOKEN_TEXT[kind]!,
      fontFamily: 'helvetica',
      fontSizeFrac: isName ? 0.06 : 0.03,
      weight: isName ? 'bold' : 'normal',
      color: '#1a1a1a',
      align: 'center',
      width: 0.4,
    } satisfies LayoutElement
  }

  if (kind in IMAGE_ROLE) {
    return {
      ...base,
      type: 'image',
      assetUrl: '',
      fit: 'contain',
      role: IMAGE_ROLE[kind]!,
      width: 0.18,
      height: 0.12,
    } satisfies LayoutElement
  }

  if (kind === 'qr') {
    return { ...base, type: 'qr', source: 'verify', width: 0.12, height: 0.12, x: 0.8, y: 0.8 } satisfies LayoutElement
  }

  // line
  return { ...base, type: 'line', color: '#999999', thickness: 0.004, width: 0.3, x: 0.35, y: 0.6 } satisfies LayoutElement
}

/** Builds the persisted layout, dropping incomplete image elements (no asset). */
export function toSavedLayout(canvas: CertificateDimensions, elements: LayoutElement[]): CertificateLayout {
  const usable = elements.filter(el => !(el.type === 'image' && !el.assetUrl))
  return { version: CURRENT_LAYOUT_VERSION, canvas, elements: usable }
}

export function isIncompleteImage(el: LayoutElement): boolean {
  return el.type === 'image' && !el.assetUrl
}
