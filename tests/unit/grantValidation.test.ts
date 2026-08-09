// MC-09 · Grant admission rules. Pure — no Firestore, no auth.
//
// A grant creates credits with no counterparty. Once the authorization gate is passed, these
// rules are the only thing standing between a typo and a fabricated liability.

import { describe, it, expect } from 'vitest'
import {
  MAX_GRANT_CREDITS, MAX_NOTE_LENGTH, MAX_REFERENCE_LENGTH, MIN_NOTE_LENGTH,
  grantEntryId, validateGrant,
} from '@/features/media-credits/utils/grantValidation'

const ok = { organizerUid: 'org_1', credits: 500, reason: 'goodwill', note: 'Compensating a failed import batch.' }

const reject = (patch: Record<string, unknown>) => {
  const r = validateGrant({ ...ok, ...patch })
  expect(r.ok).toBe(false)
  return r as { ok: false; field: string; message: string }
}

describe('validateGrant — the amount', () => {
  it('accepts a sane grant', () => {
    const r = validateGrant(ok)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.credits).toBe(500)
  })

  it('rejects zero and negatives — a negative grant is a debit', () => {
    // Allowing one would be a second, unaudited way to remove credits beside the refund
    // engine that owns that.
    expect(reject({ credits: 0 }).field).toBe('credits')
    expect(reject({ credits: -100 }).field).toBe('credits')
  })

  it('rejects fractional credits rather than rounding', () => {
    // Rounding would grant an amount that differs from the one typed.
    expect(reject({ credits: 10.5 }).field).toBe('credits')
  })

  it('rejects NaN and Infinity', () => {
    expect(reject({ credits: NaN }).field).toBe('credits')
    expect(reject({ credits: Infinity }).field).toBe('credits')
    expect(reject({ credits: '500' }).field).toBe('credits')
  })

  it('caps a single grant — this is the typo guard', () => {
    expect(validateGrant({ ...ok, credits: MAX_GRANT_CREDITS }).ok).toBe(true)
    expect(reject({ credits: MAX_GRANT_CREDITS + 1 }).field).toBe('credits')
  })
})

describe('validateGrant — the justification', () => {
  it('requires a known reason', () => {
    expect(reject({ reason: 'because' }).field).toBe('reason')
    expect(reject({ reason: '' }).field).toBe('reason')
  })

  it('accepts every published reason', () => {
    for (const reason of ['goodwill', 'compensation', 'promotional', 'migration', 'correction', 'support']) {
      expect(validateGrant({ ...ok, reason }).ok).toBe(true)
    }
  })

  it('requires a note long enough to mean something', () => {
    expect(reject({ note: 'ok' }).field).toBe('note')
    expect(reject({ note: '   ' }).field).toBe('note')
    expect(reject({ note: 'x'.repeat(MIN_NOTE_LENGTH - 1) }).field).toBe('note')
    expect(validateGrant({ ...ok, note: 'x'.repeat(MIN_NOTE_LENGTH) }).ok).toBe(true)
  })

  it('rejects an unbounded note', () => {
    expect(reject({ note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).field).toBe('note')
  })

  it('trims the note it returns, so what is stored is what was validated', () => {
    const r = validateGrant({ ...ok, note: '  a real explanation  ' })
    if (r.ok) expect(r.value.note).toBe('a real explanation')
  })
})

describe('validateGrant — the reference', () => {
  it('is optional and normalises empty to null', () => {
    for (const reference of [undefined, null, '', '   ']) {
      const r = validateGrant({ ...ok, reference })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.reference).toBeNull()
    }
  })

  it('is truncated rather than rejected', () => {
    // A too-long ticket id is not worth failing a grant over.
    const r = validateGrant({ ...ok, reference: 'T'.repeat(MAX_REFERENCE_LENGTH + 50) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.reference).toHaveLength(MAX_REFERENCE_LENGTH)
  })
})

describe('validateGrant — the recipient', () => {
  it('requires an organizer', () => {
    expect(reject({ organizerUid: '' }).field).toBe('organizerUid')
    expect(reject({ organizerUid: '   ' }).field).toBe('organizerUid')
  })

  it('trims the uid it returns', () => {
    const r = validateGrant({ ...ok, organizerUid: '  org_1  ' })
    if (r.ok) expect(r.value.organizerUid).toBe('org_1')
  })
})

describe('grantEntryId', () => {
  it('is derived from the grant id — ONE definition', () => {
    // The writer and the replay check must agree. Two sites deriving this separately is how
    // an idempotency key drifts and a replay becomes a second grant.
    expect(grantEntryId('g_abc')).toBe('grant:g_abc')
  })

  it('is stable across calls', () => {
    expect(grantEntryId('g_abc')).toBe(grantEntryId('g_abc'))
  })
})
