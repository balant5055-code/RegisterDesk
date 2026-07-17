// Enterprise pre-publish Quality Validator (GA-6 S6). Pure — client + server safe.
//
// Analyses a certificate LAYOUT and reports actionable issues BEFORE publish. It
// REUSES the single placeholder registry (lib/certificates/placeholders) and the font
// registry — no new validation engine, no rendering. Every issue explains the Problem,
// the Reason it matters, and the Fix. Deterministic; never throws.

import { PLACEHOLDERS, PLACEHOLDER_BY_KEY, type PlaceholderKey } from './placeholders'
import { FONT_FAMILIES } from './constants'
import type { CertificateLayout, LayoutElement, TextLayoutElement } from './types'

export type QualitySeverity = 'error' | 'warning'

export interface QualityIssue {
  id:        string
  severity:  QualitySeverity     // error = blocks confident publish; warning = review
  problem:   string              // WHAT is wrong
  reason:    string              // WHY it matters
  fix:       string              // HOW to fix it
  elementId?: string             // the offending element, when applicable
}

const KNOWN_KEYS = new Set<string>(PLACEHOLDERS.map(p => p.key))
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9]+)\s*\}\}/g

/** Every `{{token}}` referenced by a text element's content. */
function tokensIn(content: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(content)) !== null) out.push(m[1])
  return out
}

const outsidePage = (el: LayoutElement): boolean => {
  const w = el.width ?? 0, h = el.height ?? 0
  const EPS = 0.002
  return el.x < -EPS || el.y < -EPS || el.x + w > 1 + EPS || el.y + h > 1 + EPS
}

/**
 * Returns the layout's quality issues, most-severe first. `opts.verificationEnabled`
 * (from the event's certificate settings) drives the "missing QR" check.
 */
export function analyzeCertificateLayout(
  layout: CertificateLayout | null | undefined,
  opts?: { verificationEnabled?: boolean },
): QualityIssue[] {
  const issues: QualityIssue[] = []
  const push = (i: QualityIssue) => issues.push(i)
  const els = layout?.elements ?? []

  if (els.length === 0) {
    push({ id: 'empty-layout', severity: 'warning',
      problem: 'The design has no elements.',
      reason: 'A blank layout renders the uploaded template with no dynamic text or QR.',
      fix: 'Add at least the participant name and a QR code from the element palette.' })
    return issues
  }

  const texts = els.filter((e): e is TextLayoutElement => e.type === 'text')
  const qrCount = els.filter(e => e.type === 'qr').length
  let nameTokenCount = 0

  for (const el of els) {
    // Objects outside the page.
    if (outsidePage(el)) push({ id: `outside-${el.id}`, severity: 'warning', elementId: el.id,
      problem: 'An element extends beyond the certificate edge.',
      reason: 'Content outside the page area is clipped and will be missing on the printed certificate.',
      fix: 'Move or resize the element so it sits fully inside the canvas.' })

    // Zero-size (effectively invisible) element.
    if ((el.type !== 'text') && ((el.width ?? 0) <= 0 || (el.height ?? 0) <= 0)) {
      push({ id: `zero-${el.id}`, severity: 'warning', elementId: el.id,
        problem: 'An element has zero width or height.',
        reason: 'A zero-size element never appears on the certificate.',
        fix: 'Give the element a visible width and height, or delete it.' })
    }

    if (el.type === 'image' && !el.assetUrl) push({ id: `broken-img-${el.id}`, severity: 'error', elementId: el.id,
      problem: `The ${el.role ?? 'image'} element has no image uploaded.`,
      reason: 'A certificate with a missing logo/signature/seal looks broken and unofficial.',
      fix: 'Upload an image for this element, or remove it.' })

    if (el.type === 'text') {
      const content = (el.content ?? '').trim()
      if (!content) {
        push({ id: `empty-text-${el.id}`, severity: 'warning', elementId: el.id,
          problem: 'A text element is empty.',
          reason: 'Empty text boxes add nothing and can hide layout mistakes.',
          fix: 'Enter text or a {{variable}}, or delete the element.' })
      }
      // Unknown / unsupported variables.
      for (const tok of tokensIn(content)) {
        if (tok === 'participantName') nameTokenCount++
        if (!KNOWN_KEYS.has(tok)) push({ id: `unknown-var-${el.id}-${tok}`, severity: 'error', elementId: el.id,
          problem: `Unknown variable “{{${tok}}}”.`,
          reason: 'Unrecognised tokens are printed literally (e.g. the text “{{' + tok + '}}”) instead of a value.',
          fix: `Use a variable from the picker. Available: ${PLACEHOLDERS.slice(0, 4).map(p => p.token).join(', ')}…` })
      }
      // Text that runs off the right edge (heuristic — box width beyond the page).
      if (el.width && el.x + el.width > 1.002) push({ id: `overflow-${el.id}`, severity: 'warning', elementId: el.id,
        problem: 'A text box extends past the right edge.',
        reason: 'Long values may be clipped where the box leaves the page.',
        fix: 'Reduce the text box width or move it left.' })
      // Unsupported font (defensive — the type is constrained, but data may be legacy).
      if (!(FONT_FAMILIES as readonly string[]).includes(el.fontFamily)) push({ id: `font-${el.id}`, severity: 'error', elementId: el.id,
        problem: `Unsupported font “${el.fontFamily}”.`,
        reason: 'A font outside the embedded set cannot be rendered and falls back unexpectedly.',
        fix: `Choose one of: ${FONT_FAMILIES.join(', ')}.` })
    }
  }

  // Missing participant name.
  if (nameTokenCount === 0) push({ id: 'missing-name', severity: 'warning',
    problem: 'No participant name variable.',
    reason: 'Most certificates name the recipient; without it every certificate looks identical.',
    fix: `Add a text element containing ${PLACEHOLDER_BY_KEY.participantName.token}.` })

  // Duplicate mandatory element.
  if (nameTokenCount > 1) push({ id: 'dup-name', severity: 'warning',
    problem: 'The participant name appears more than once.',
    reason: 'A duplicated name is usually an accidental copy and looks wrong.',
    fix: 'Keep a single {{participantName}} element.' })
  if (qrCount > 1) push({ id: 'dup-qr', severity: 'warning',
    problem: 'More than one QR code.',
    reason: 'Multiple verification QRs are redundant and confusing.',
    fix: 'Keep a single QR element.' })

  // Missing QR when verification is on.
  if (opts?.verificationEnabled && qrCount === 0) push({ id: 'missing-qr', severity: 'warning',
    problem: 'Verification is enabled but there is no QR code.',
    reason: 'Recipients cannot verify a certificate that has no QR/verification link on it.',
    fix: 'Add a QR element (it encodes the verification URL automatically).' })

  const order: Record<QualitySeverity, number> = { error: 0, warning: 1 }
  return issues.sort((a, b) => order[a.severity] - order[b.severity])
}

/** A one-line summary for a compact status badge. */
export function qualitySummary(issues: QualityIssue[]): { errors: number; warnings: number; ok: boolean } {
  const errors = issues.filter(i => i.severity === 'error').length
  return { errors, warnings: issues.length - errors, ok: issues.length === 0 }
}

// Re-export for callers that need the key type without a second import.
export type { PlaceholderKey }
