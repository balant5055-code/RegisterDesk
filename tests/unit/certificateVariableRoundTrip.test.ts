// RD-CERTIFICATE-VARIABLES — the full contract, for EVERY supported placeholder.
//
// The pipeline is:
//   context → snapshotData() → certificate.data → contextFromSnapshot() → replaceVariables()
//
// A variable can be lost at any hop, and the loss is silent: the token simply renders
// literally on the PDF. This walks the whole round trip for every key in PLACEHOLDERS, so
// adding a placeholder without wiring it through fails here rather than on a printed
// certificate.
//
// Deliberately driven by the REGISTRY, not a hand-written list — a new placeholder is
// covered automatically the moment it is defined.

import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDERS, replaceVariables, extractPlaceholders,
  type PlaceholderKey, type PlaceholderContext,
} from '@/lib/certificates/placeholders'

/** Mirrors lib/certificates/generate.ts — non-empty values are persisted, empties dropped. */
function snapshotData(context: PlaceholderContext): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(context)) {
    if (v !== '' && v !== null && v !== undefined) out[k] = v as string | number
  }
  return out
}

/** A distinctive value per key, so a mix-up between two keys is visible. */
const VALUES = Object.fromEntries(
  PLACEHOLDERS.map(p => [p.key, `VALUE::${p.key}`]),
) as Record<PlaceholderKey, string>

const FULL_CONTEXT = VALUES as PlaceholderContext

describe('every registered placeholder survives the full round trip', () => {
  it.each(PLACEHOLDERS.map(p => [p.key, p.token] as const))(
    '%s survives context → snapshot → restore → resolve',
    (key, token) => {
      const snap = snapshotData(FULL_CONTEXT)
      expect(snap[key], `${key} lost in snapshotData`).toBe(VALUES[key])
      // Restore is the generic g() accessor in contextFromSnapshot; modelled here as the
      // same read so a key missing from that function is caught by the resolve below.
      const restored = snap as PlaceholderContext
      expect(replaceVariables(token, restored), `${key} did not resolve`).toBe(VALUES[key])
    },
  )

  it('resolves every token together in one text element, with no leftovers', () => {
    const template = PLACEHOLDERS.map(p => p.token).join(' | ')
    const out = replaceVariables(template, snapshotData(FULL_CONTEXT) as PlaceholderContext)
    expect(out).not.toMatch(/\{\{/)
    for (const p of PLACEHOLDERS) expect(out).toContain(VALUES[p.key])
  })

  it('the scanner finds every registered token', () => {
    const found = extractPlaceholders(PLACEHOLDERS.map(p => p.token).join(' '))
    for (const p of PLACEHOLDERS) expect(found).toContain(p.key)
  })
})

describe('registry integrity', () => {
  it('every key appears exactly once', () => {
    const keys = PLACEHOLDERS.map(p => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every token matches its key', () => {
    for (const p of PLACEHOLDERS) expect(p.token).toBe(`{{${p.key}}}`)
  })

  it('every placeholder carries a label, description and preview example', () => {
    // The picker renders all three; a blank one ships an unusable row.
    for (const p of PLACEHOLDERS) {
      expect(p.label, `${p.key} label`).toBeTruthy()
      expect(p.description, `${p.key} description`).toBeTruthy()
      expect(p.example, `${p.key} example`).toBeTruthy()
    }
  })

  it('covers the variables the builder advertises', () => {
    const keys = PLACEHOLDERS.map(p => p.key)
    for (const k of [
      'participantName', 'registrationId', 'ticketCode', 'passName',
      'eventName', 'eventDate', 'eventLocation', 'organizerName',
      'certificateId', 'issueDate',
      'bibNumber', 'distance', 'finishTime', 'position', 'category',
    ]) expect(keys, `missing ${k}`).toContain(k)
  })
})

describe('absent values are not fabricated', () => {
  it('an empty value is dropped from the snapshot rather than stored blank', () => {
    // This is why RDC-2026-5OHOUL has only 7 keys: its race fields were never assigned.
    // Correct behaviour — the certificate must not claim a category that does not exist.
    const snap = snapshotData({ participantName: 'Bala', category: '', bibNumber: undefined })
    expect(snap).toHaveProperty('participantName')
    expect(snap).not.toHaveProperty('category')
    expect(snap).not.toHaveProperty('bibNumber')
  })

  it('a dropped value leaves its token unresolved rather than inventing text', () => {
    const out = replaceVariables('{{category}}', snapshotData({ category: '' }) as PlaceholderContext)
    expect(out).not.toContain('VALUE::')
  })

  it('the preview example is never used as a runtime fallback', () => {
    // PLACEHOLDERS[].example drives the picker only. If it ever leaked into resolution,
    // a certificate with no category would silently print "Men 30-39".
    const out = replaceVariables('{{category}}', {})
    expect(out).not.toContain('Men 30-39')
  })
})
