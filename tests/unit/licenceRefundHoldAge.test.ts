// RD-SA-COMMERCE-P1 (P1-1 / P1-2 / PD-2) — the pure refund-hold rules, and the route-lifetime pin that
// makes the 15-minute release age meaningful.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFUND_HOLD_MIN_RELEASE_AGE_MS, refundHoldOldEnough, classifyGatewayRefunds, isDefinitiveGatewayRejection, gatewayErrorMessage } from '@/lib/licensing/licenceRefundHold'

describe('refund hold age (PD-2)', () => {
  it('is 15 minutes; younger holds are never old enough; a hold with no readable time is legacy (old)', () => {
    expect(REFUND_HOLD_MIN_RELEASE_AGE_MS).toBe(15 * 60 * 1000)
    const now = 1_000_000_000
    expect(refundHoldOldEnough(now - 14 * 60_000, now)).toBe(false)
    expect(refundHoldOldEnough(now - 15 * 60_000, now)).toBe(true)
    expect(refundHoldOldEnough(now, now)).toBe(false)
    expect(refundHoldOldEnough(null, now)).toBe(true)
  })

  it('the admin licence route can never outlive the release age (maxDuration pinned well below 15 min)', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/admin/licenses/[eventId]/route.ts'), 'utf8')
    const m = src.match(/export const maxDuration = (\d+)/)
    expect(m).not.toBeNull()
    const seconds = Number(m![1])
    expect(seconds).toBeGreaterThan(0)
    expect(seconds * 1000 * 2).toBeLessThanOrEqual(REFUND_HOLD_MIN_RELEASE_AGE_MS)   // at least 2× margin
  })
})

describe('classifyGatewayRefunds (P1-1)', () => {
  it('unknown whenever the list cannot be read or a refund cannot be sized — never "none"', () => {
    expect(classifyGatewayRefunds(undefined, 100)).toEqual({ kind: 'unknown' })
    expect(classifyGatewayRefunds({}, 100)).toEqual({ kind: 'unknown' })
    expect(classifyGatewayRefunds({ items: 'x' }, 100)).toEqual({ kind: 'unknown' })
    expect(classifyGatewayRefunds({ items: [null] }, 100)).toEqual({ kind: 'unknown' })
    expect(classifyGatewayRefunds({ items: [{ id: 'r', status: 'processed' }] }, 100)).toEqual({ kind: 'unknown' })
    expect(classifyGatewayRefunds({ items: [{ id: 'r', status: 'pending', amount: -1 }] }, 100)).toEqual({ kind: 'unknown' })
  })
  it('none: an empty list, or only FAILED refunds', () => {
    expect(classifyGatewayRefunds({ items: [] }, 100)).toEqual({ kind: 'none' })
    expect(classifyGatewayRefunds({ items: [{ id: 'r', status: 'failed', amount: 100 }] }, 100)).toEqual({ kind: 'none' })
  })
  it('full when non-failed refunds (pending counts — money is moving) cover the amount; partial otherwise', () => {
    expect(classifyGatewayRefunds({ items: [{ id: 'a', status: 'pending', amount: 100 }] }, 100)).toEqual({ kind: 'full', refundedPaise: 100, refundIds: ['a'] })
    expect(classifyGatewayRefunds({ items: [{ id: 'a', status: 'processed', amount: 60 }, { id: 'b', status: 'processed', amount: 40 }] }, 100))
      .toEqual({ kind: 'full', refundedPaise: 100, refundIds: ['a', 'b'] })
    expect(classifyGatewayRefunds({ items: [{ id: 'a', status: 'processed', amount: 60 }, { id: 'f', status: 'failed', amount: 40 }] }, 100))
      .toEqual({ kind: 'partial', refundedPaise: 60, refundIds: ['a'] })
    expect(classifyGatewayRefunds({ items: [{ id: 'z', status: 'processed', amount: 0 }] }, 100)).toEqual({ kind: 'partial', refundedPaise: 0, refundIds: ['z'] })
  })
})

describe('isDefinitiveGatewayRejection (H1)', () => {
  const api = (statusCode: number, code: unknown = 'BAD_REQUEST_ERROR') => ({ statusCode, error: { code, description: 'x' } })
  it('only a structured 4xx API rejection with an error code proves no refund was created', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isDefinitiveGatewayRejection(api(s))).toBe(true)
  })
  it('timeouts, network errors, 5xx, 408/409/429 and anything unstructured are AMBIGUOUS', () => {
    expect(isDefinitiveGatewayRejection(new Error('timeout of 0ms exceeded'))).toBe(false)
    // the SDK's own normalizeError crashes on a missing response: a TypeError, never a rejection
    expect(isDefinitiveGatewayRejection(new TypeError("Cannot read properties of undefined (reading 'status')"))).toBe(false)
    for (const s of [500, 502, 503, 504, 408, 409, 429]) expect(isDefinitiveGatewayRejection(api(s))).toBe(false)
    expect(isDefinitiveGatewayRejection(api(400, ''))).toBe(false)
    expect(isDefinitiveGatewayRejection({ statusCode: 400, error: { description: 'no code' } })).toBe(false)
    expect(isDefinitiveGatewayRejection({ statusCode: 400 })).toBe(false)
    expect(isDefinitiveGatewayRejection({ statusCode: '400', error: { code: 'X' } })).toBe(false)
    expect(isDefinitiveGatewayRejection(null)).toBe(false)
    expect(isDefinitiveGatewayRejection('BAD_REQUEST_ERROR')).toBe(false)
    // an Error instance that happens to carry a statusCode is still not the SDK's response shape
    expect(isDefinitiveGatewayRejection(Object.assign(new Error('x'), { statusCode: 400, error: { code: 'X' } }))).toBe(false)
  })
  it('gatewayErrorMessage reads Error messages and SDK descriptions', () => {
    expect(gatewayErrorMessage(new Error('boom'))).toBe('boom')
    expect(gatewayErrorMessage({ statusCode: 400, error: { description: 'The payment has been fully refunded' } })).toBe('The payment has been fully refunded')
    expect(gatewayErrorMessage({})).toBe('unknown error')
  })
})
