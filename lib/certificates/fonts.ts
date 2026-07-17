// Certificate font registry — server-only.
// Provides pdf-lib fonts for the renderer, with optional Unicode (TTF) embedding
// so non-Latin participant names render correctly. Unicode fonts are provisioned
// out-of-band (a `certificate-fonts/` directory or CERT_FONT_*_URL env), since
// binary fonts can't live in source; when none are available the renderer falls
// back to the built-in WinAnsi standard fonts (with sanitization).

import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import { promises as fs } from 'fs'
import path from 'path'
import { CERT_FONT_REGULAR_URL, CERT_FONT_BOLD_URL } from '@/lib/env'
import type { FontFamily } from './types'

export interface FontStyle { bold?: boolean; italic?: boolean }

const STANDARD: Record<FontFamily, { regular: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
  helvetica: {
    regular:    StandardFonts.Helvetica,
    bold:       StandardFonts.HelveticaBold,
    italic:     StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    regular:    StandardFonts.TimesRoman,
    bold:       StandardFonts.TimesRomanBold,
    italic:     StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    regular:    StandardFonts.Courier,
    bold:       StandardFonts.CourierBold,
    italic:     StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
}

function standardName(family: FontFamily, style: FontStyle): StandardFonts {
  const f = STANDARD[family]
  if (style.bold && style.italic) return f.boldItalic
  if (style.bold)   return f.bold
  if (style.italic) return f.italic
  return f.regular
}

/** True when the string contains characters the WinAnsi standard fonts can't draw. */
export function hasNonWinAnsi(s: string): boolean {
  return /[^\x20-\x7E\xA0-\xFF]/.test(s)
}

/** Strips characters outside the WinAnsi range (fallback when no Unicode font). */
export function sanitizeWinAnsi(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

// ─── Unicode font byte loading (module-cached) ───────────────────────────────
// undefined = unresolved, null = unavailable, Uint8Array = loaded.

let _regularBytes: Uint8Array | null | undefined
let _boldBytes:    Uint8Array | null | undefined

async function loadBytes(envUrl: string, fileNames: string[]): Promise<Uint8Array | null> {
  for (const fn of fileNames) {
    try {
      const buf = await fs.readFile(path.join(process.cwd(), 'certificate-fonts', fn))
      return new Uint8Array(buf)
    } catch { /* not present — try next */ }
  }
  if (envUrl) {
    try {
      const res = await fetch(envUrl, { signal: AbortSignal.timeout(10000) })
      if (res.ok) return new Uint8Array(await res.arrayBuffer())
    } catch { /* unreachable — fall back */ }
  }
  return null
}

async function regularUnicodeBytes(): Promise<Uint8Array | null> {
  if (_regularBytes === undefined) {
    _regularBytes = await loadBytes(CERT_FONT_REGULAR_URL, ['NotoSans-Regular.ttf', 'Unicode-Regular.ttf'])
  }
  return _regularBytes
}

async function boldUnicodeBytes(): Promise<Uint8Array | null> {
  if (_boldBytes === undefined) {
    _boldBytes = await loadBytes(CERT_FONT_BOLD_URL, ['NotoSans-Bold.ttf', 'Unicode-Bold.ttf'])
  }
  return _boldBytes
}

// ─── Per-document font set ────────────────────────────────────────────────────

export interface FontSet {
  /**
   * Picks a font able to render `sample`. When `sample` contains non-WinAnsi
   * characters and a Unicode font is available, returns it (isUnicode: true);
   * otherwise returns the requested standard font (caller should sanitize).
   */
  pick(family: FontFamily, style: FontStyle, sample: string): Promise<{ font: PDFFont; isUnicode: boolean }>
}

export async function buildFontSet(doc: PDFDocument): Promise<FontSet> {
  doc.registerFontkit(fontkit)

  const cache = new Map<string, PDFFont>()
  let uniRegular: PDFFont | null | undefined
  let uniBold:    PDFFont | null | undefined

  async function standard(family: FontFamily, style: FontStyle): Promise<PDFFont> {
    const key = `${family}:${style.bold ? 1 : 0}:${style.italic ? 1 : 0}`
    const cached = cache.get(key)
    if (cached) return cached
    const font = await doc.embedFont(standardName(family, style))
    cache.set(key, font)
    return font
  }

  async function unicode(bold: boolean): Promise<PDFFont | null> {
    if (bold) {
      if (uniBold === undefined) {
        const bytes = await boldUnicodeBytes()
        uniBold = bytes ? await doc.embedFont(bytes, { subset: true }).catch(() => null) : null
      }
      if (uniBold) return uniBold
      // fall through to regular weight when bold isn't provisioned
    }
    if (uniRegular === undefined) {
      const bytes = await regularUnicodeBytes()
      uniRegular = bytes ? await doc.embedFont(bytes, { subset: true }).catch(() => null) : null
    }
    return uniRegular
  }

  return {
    async pick(family, style, sample) {
      if (hasNonWinAnsi(sample)) {
        const uni = await unicode(!!style.bold)
        if (uni) return { font: uni, isUnicode: true }
      }
      return { font: await standard(family, style), isUnicode: false }
    },
  }
}
