// PA-9 S3 — Design quality analysis (Parts 3 + 7). PURE, client-safe. Produces
// NON-BLOCKING warnings/errors for the validation + quality panel. Reuses the
// engine token set (via the resolved varMap) — no new resolver.

import type { PrintCanvas, PrintDesign, PrintElement } from '@/lib/printAssets/types'

export type IssueLevel = 'error' | 'warn'
export interface DesignIssue {
  level:      IssueLevel
  code:       string
  message:    string
  elementId?: string
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

function pageDims(canvas: PrintCanvas): { wMm: number; hMm: number } {
  const portrait = canvas.orientation !== 'landscape'
  const w = portrait ? canvas.width : canvas.height
  const h = portrait ? canvas.height : canvas.width
  const f = canvas.unit === 'in' ? 25.4 : canvas.unit === 'px' ? 25.4 / 96 : 1
  return { wMm: w * f, hMm: h * f }
}

const SAFE = 0.06   // inner safe-area inset (fraction)

/**
 * Analyzes a design. `map` is the resolved variable map (buildVariableMap output)
 * for the current preview data; a token missing from it flags an unknown/unbound
 * variable or a missing image source. Never blocks; callers only surface issues.
 */
export function analyzeDesign(
  design: PrintDesign, canvas: PrintCanvas, map: Map<string, string>,
): DesignIssue[] {
  const issues: DesignIssue[] = []
  const { wMm, hMm } = pageDims(canvas)

  for (const el of design.elements) {
    if (el.visible === false) continue
    const pr = el.properties
    const right = el.x + el.width, bottom = el.y + el.height

    // Outside the page (trim) — likely clipped on print.
    if (el.x < -0.001 || el.y < -0.001 || right > 1.001 || bottom > 1.001) {
      issues.push({ level: 'warn', code: 'outside-page', message: `${label(el)} extends past the page edge`, elementId: el.id })
    } else if (el.x < SAFE || el.y < SAFE || right > 1 - SAFE || bottom > 1 - SAFE) {
      // Fully inside the page but crossing the safe area (bleed/margin zone only).
      issues.push({ level: 'warn', code: 'bleed-only', message: `${label(el)} is inside the bleed/margin zone`, elementId: el.id })
    }

    if (el.type === 'qr') {
      // Physical QR side in mm; scannable QRs want ~15mm+.
      const sideMm = Math.min(el.width * wMm, el.height * hMm)
      if (sideMm < 12) issues.push({ level: 'warn', code: 'qr-small', message: `QR is small (${sideMm.toFixed(0)}mm) — may not scan`, elementId: el.id })
    }

    if (el.type === 'image') {
      const src = (pr.text ?? '').trim()
      if (!src) {
        issues.push({ level: 'warn', code: 'image-missing', message: `${label(el)} has no source selected`, elementId: el.id })
      } else {
        // Known image bindings ({{logo}}, {{sponsorLogo}}, {{custom.*}}) resolve at
        // render time (branding/event assets injected server-side), so only a truly
        // unknown token is a problem.
        const tokens = [...src.matchAll(TOKEN_RE)].map(m => m[1])
        const unknown = tokens.filter(t => t !== 'logo' && t !== 'sponsorLogo' && !t.startsWith('custom.') && !map.has(t))
        if (unknown.length) issues.push({ level: 'warn', code: 'image-unknown', message: `${label(el)} uses unknown source {{${unknown[0]}}}`, elementId: el.id })
      }
      // Aspect distortion risk — extreme box aspect will heavily letterbox/crop.
      const ar = (el.width * wMm) / Math.max(0.0001, el.height * hMm)
      if (ar > 4 || ar < 0.25) issues.push({ level: 'warn', code: 'image-aspect', message: `${label(el)} box is very ${ar > 1 ? 'wide' : 'tall'} — image may crop`, elementId: el.id })
    }

    if (el.type === 'text') {
      const raw = pr.text ?? ''
      // Unknown variables — tokens the engine map doesn't know.
      for (const m of raw.matchAll(TOKEN_RE)) {
        const t = m[1]
        if (!map.has(t) && !t.startsWith('custom.')) {
          issues.push({ level: 'warn', code: 'unknown-var', message: `Unknown variable {{${t}}}`, elementId: el.id })
        }
      }
      // Clipping heuristic — font too tall for the box, or a long single line.
      const fs = pr.fontSize ?? 0.06
      const lineH = fs * (pr.lineHeight ?? 1.2)
      if (lineH > el.height + 0.005) {
        issues.push({ level: 'warn', code: 'text-clip', message: `${label(el)} font may be clipped by its box height`, elementId: el.id })
      }
    }
  }

  return issues
}

function label(el: PrintElement): string {
  if (el.type === 'text') return `Text "${(el.properties.text ?? '').slice(0, 16) || 'Text'}"`
  return el.type.charAt(0).toUpperCase() + el.type.slice(1)
}

export interface QualitySummary {
  errors:    number
  warnings:  number
  printReady: boolean
}
export function summarize(issues: DesignIssue[]): QualitySummary {
  const errors = issues.filter(i => i.level === 'error').length
  return { errors, warnings: issues.length - errors, printReady: errors === 0 }
}
