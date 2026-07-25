// RD-GA-HARDEN-01 — immutable order pricing snapshot (orderSnapshot.ts):
// creation, checksum integrity, tamper detection, (de)serialization, Infinity round-trip.

import { describe, it, expect } from 'vitest'
import {
  createOrderPricingSnapshot, validateOrderPricingSnapshot,
  serializeOrderPricingSnapshot, deserializeOrderPricingSnapshot,
  computePricingChecksum, ORDER_SNAPSHOT_VERSION,
} from '@/lib/platform/pricing/orderSnapshot'
import { buildPricingSummary, buildUnlimitedSummary } from '../fixtures/pricingSummary'

describe('createOrderPricingSnapshot', () => {
  it('produces a valid, checksummed, versioned snapshot', () => {
    const snap = createOrderPricingSnapshot(buildPricingSummary())
    expect(snap.snapshotVersion).toBe(ORDER_SNAPSHOT_VERSION)
    expect(snap.pricingChecksum).toMatch(/^[a-f0-9]{64}$/)   // SHA-256 hex
    expect(validateOrderPricingSnapshot(snap)).toEqual({ ok: true })
  })

  it('is deep-frozen (immutable — Phase 8)', () => {
    const snap = createOrderPricingSnapshot(buildPricingSummary())
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.ticketPrice)).toBe(true)
    expect(() => { (snap as { pricingChecksum: string }).pricingChecksum = 'x' }).toThrow()
  })

  it('checksum is deterministic for identical content (idempotency)', () => {
    const summary = buildPricingSummary({ resolvedAt: '2026-07-21T00:00:00.000Z' })
    expect(createOrderPricingSnapshot(summary).pricingChecksum)
      .toBe(createOrderPricingSnapshot(summary).pricingChecksum)
  })
})

describe('validateOrderPricingSnapshot — integrity', () => {
  it('detects a tampered financial field (checksum mismatch)', () => {
    const snap = createOrderPricingSnapshot(buildPricingSummary())
    const tampered = { ...snap, platformRevenue: { paise: 999999, rupees: 9999.99 } }
    const res = validateOrderPricingSnapshot(tampered)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/checksum/i)
  })

  it('rejects a broken money invariant', () => {
    const snap = createOrderPricingSnapshot(buildPricingSummary())
    // organizerReceives > ticketPrice violates an invariant; recompute a matching checksum
    const content = { ...snap, organizerReceives: { paise: snap.ticketPrice.paise + 1, rupees: 0 } }
    const { pricingChecksum: _omit, ...rest } = content
    void _omit
    const withChecksum = { ...content, pricingChecksum: computePricingChecksum(rest) }
    expect(validateOrderPricingSnapshot(withChecksum).ok).toBe(false)
  })
})

describe('serialize / deserialize', () => {
  it('round-trips and re-validates', () => {
    const snap = createOrderPricingSnapshot(buildPricingSummary())
    const json = serializeOrderPricingSnapshot(snap)
    const back = deserializeOrderPricingSnapshot(json)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.snapshot.pricingChecksum).toBe(snap.pricingChecksum)
  })

  it('unlimited registration limit survives the Infinity↔null wire boundary', () => {
    const snap = createOrderPricingSnapshot(buildUnlimitedSummary())
    const json = serializeOrderPricingSnapshot(snap)
    expect(json).toMatch(/"value":null/)                       // Firestore-safe on the wire
    const back = deserializeOrderPricingSnapshot(json)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.snapshot.registrationLimit.value).toBe(Infinity)   // revived
  })

  it('rejects corrupt JSON and tampered payloads', () => {
    expect(deserializeOrderPricingSnapshot('{not json').ok).toBe(false)
    const json = serializeOrderPricingSnapshot(createOrderPricingSnapshot(buildPricingSummary()))
    const tampered = json.replace(/"platformRevenue":\{[^}]*\}/, '"platformRevenue":{"paise":123456,"rupees":1234.56}')
    expect(deserializeOrderPricingSnapshot(tampered).ok).toBe(false)
  })
})
