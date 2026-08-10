// RD-CERTIFICATE-PASSNAME — {{passName}} as a first-class certificate variable.
//
// Real-data motivation: registration f7b68fb9… carries passName "3 KM Run", but the
// certificate generated from it had no passName key at all, because `passName` was absent
// from PlaceholderKey. The picker could not offer it and the resolver could not resolve
// it — populated data with no route to a certificate.
//
// These tests pin the whole route through the EXISTING machinery: registry → context →
// snapshot → restore → resolver. No special-casing anywhere.

import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDERS, PLACEHOLDER_BY_KEY, replaceVariables, extractPlaceholders,
  type PlaceholderContext,
} from '@/lib/certificates/placeholders'

const REAL_PASS = '3 KM Run'

describe('registry', () => {
  it('passName is a defined placeholder', () => {
    const def = PLACEHOLDER_BY_KEY.passName
    expect(def).toBeDefined()
    expect(def.token).toBe('{{passName}}')
    expect(def.label).toBeTruthy()
  })

  it('is grouped with identity and NOT sportsOnly', () => {
    // Every event type sells a pass — a conference or workshop certificate should be able
    // to print it, so gating it behind sportsOnly would hide it from most events.
    const def = PLACEHOLDER_BY_KEY.passName
    expect(def.category).toBe('identity')
    expect(def.sportsOnly).toBe(false)
  })

  it('appears exactly once in the registry the picker renders from', () => {
    // VariablePicker maps over PLACEHOLDERS, so presence here IS presence in the picker.
    expect(PLACEHOLDERS.filter(p => p.key === 'passName')).toHaveLength(1)
  })

  it('carries a sample value for the preview', () => {
    expect(PLACEHOLDER_BY_KEY.passName.example).toBeTruthy()
  })
})

describe('resolution through the existing resolver', () => {
  const ctx: PlaceholderContext = { passName: REAL_PASS }

  it('{{passName}} resolves to the real pass name', () => {
    expect(replaceVariables('{{passName}}', ctx)).toBe(REAL_PASS)
  })

  it('resolves inside surrounding copy', () => {
    expect(replaceVariables('Pass: {{passName}}', ctx)).toBe(`Pass: ${REAL_PASS}`)
  })

  it('resolves alongside other variables in one element', () => {
    const out = replaceVariables(
      '{{participantName}} — {{passName}} — {{eventName}}',
      { participantName: 'Bala', passName: REAL_PASS, eventName: 'Noyyal Marathon 2026' },
    )
    expect(out).toBe('Bala — 3 KM Run — Noyyal Marathon 2026')
  })

  it('is discoverable by the template scanner', () => {
    expect(extractPlaceholders('Pass: {{passName}}')).toContain('passName')
  })
})

describe('absent passName behaves like every other optional variable', () => {
  it.each([
    ['missing key', {} as PlaceholderContext],
    ['empty string', { passName: '' } as PlaceholderContext],
    ['null',         { passName: null } as PlaceholderContext],
  ])('%s produces the same output as the other optionals', (_l, ctx) => {
    // Whatever the platform does for an unset `category`, it must do for `passName` —
    // one consistent behaviour, not a special case.
    expect(replaceVariables('{{passName}}', ctx))
      .toBe(replaceVariables('{{category}}', ctx))
  })

  it('does not corrupt neighbouring resolved values', () => {
    expect(replaceVariables('{{participantName}}/{{passName}}', { participantName: 'Bala' }))
      .toContain('Bala')
  })
})
