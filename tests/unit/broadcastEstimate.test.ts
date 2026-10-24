// RD-BCAST-ESTIMATE-01 — the composer's "Estimated cost" line used to be a ternary on the recipient
// count alone, so no event, incomplete filters, loading, a failed count, a confirmed zero and a
// missing capacity quote all rendered the same bare "—". Each is now its own state, and the Send
// button reads the SAME decision. Server behaviour: tests/emulator/broadcastEstimateStates.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { broadcastEstimate, estimateAllowsSend, toRecipientCountState, type RecipientCapacity } from '@/lib/broadcasts/recipientCount'

const base = {
  channel: 'whatsapp' as const, eventSelected: true, filtersReady: true, loading: false, failed: false,
  recipientCount: 3 as number | null, capacity: null as RecipientCapacity | null, excluded: null,
}
const cap = (o: Partial<RecipientCapacity>): RecipientCapacity =>
  ({ required: 3, available: 10, shortfall: 0, sufficient: true, fundedBy: 'event_capacity', ...o })

describe('RD-BCAST-ESTIMATE-01 · broadcastEstimate', () => {
  it('no event selected', () => {
    expect(broadcastEstimate({ ...base, eventSelected: false })).toEqual({ kind: 'no_event' })
  })
  it('incomplete date filter', () => {
    expect(broadcastEstimate({ ...base, filtersReady: false })).toEqual({ kind: 'filters_incomplete' })
  })
  it('loading', () => {
    expect(broadcastEstimate({ ...base, loading: true, capacity: cap({}) })).toEqual({ kind: 'loading' })
  })
  it('failed count — and an absent count — are an error, never zero', () => {
    expect(broadcastEstimate({ ...base, failed: true })).toEqual({ kind: 'error' })
    expect(broadcastEstimate({ ...base, recipientCount: null })).toEqual({ kind: 'error' })
  })
  it('confirmed zero carries the server reason (WhatsApp) and never offers Send', () => {
    const e = broadcastEstimate({ ...base, recipientCount: 0, excluded: { noConsent: 7, optedOut: 2 } })
    expect(e).toEqual({ kind: 'no_recipients', excluded: { noConsent: 7, optedOut: 2 } })
    expect(estimateAllowsSend(e)).toBe(false)
    expect(broadcastEstimate({ ...base, channel: 'email', recipientCount: 0 })).toEqual({ kind: 'no_recipients', excluded: null })
  })
  it('WhatsApp without a capacity quote is UNKNOWN, not available', () => {
    const e = broadcastEstimate({ ...base, capacity: null })
    expect(e).toEqual({ kind: 'capacity_unknown', count: 3 })
    expect(estimateAllowsSend(e)).toBe(false)
  })
  it('zero prepaid capacity', () => {
    const e = broadcastEstimate({ ...base, capacity: cap({ available: 0, shortfall: 3, sufficient: false, fundedBy: null }) })
    expect(e).toEqual({ kind: 'no_capacity', count: 3 })
    expect(estimateAllowsSend(e)).toBe(false)
  })
  it('insufficient prepaid capacity reports the shortfall', () => {
    const e = broadcastEstimate({ ...base, recipientCount: 5, capacity: cap({ required: 5, available: 2, shortfall: 3, sufficient: false, fundedBy: null }) })
    expect(e).toEqual({ kind: 'insufficient', count: 5, available: 2, shortfall: 3 })
    expect(estimateAllowsSend(e)).toBe(false)
  })
  it('a successful quote from event capacity is the only WhatsApp state that allows Send', () => {
    const e = broadcastEstimate({ ...base, capacity: cap({}) })
    expect(e).toEqual({ kind: 'ready', count: 3, available: 10 })
    expect(estimateAllowsSend(e)).toBe(true)
  })
  it('no legacy-wallet fallback: a quote funded by the legacy balance is NOT ready', () => {
    const e = broadcastEstimate({ ...base, capacity: cap({ available: 0, fundedBy: 'legacy_balance' }) })
    expect(e.kind).toBe('no_capacity')
    expect(estimateAllowsSend(e)).toBe(false)
  })
  it('email with recipients is free and may be sent', () => {
    const e = broadcastEstimate({ ...base, channel: 'email' })
    expect(e).toEqual({ kind: 'email_free', count: 3 })
    expect(estimateAllowsSend(e)).toBe(true)
  })
})

describe('RD-BCAST-ESTIMATE-01 · count response mapping', () => {
  it('maps whatsappExcluded when well-formed, drops it otherwise', () => {
    const ok = toRecipientCountState(true, { success: true, count: 0, whatsappExcluded: { noConsent: 4, optedOut: 1 } })
    expect(ok).toMatchObject({ status: 'ready', count: 0, excluded: { noConsent: 4, optedOut: 1 } })
    const bad = toRecipientCountState(true, { success: true, count: 0, whatsappExcluded: { noConsent: 'x' } })
    expect(bad).not.toHaveProperty('excluded')
  })
})

describe('RD-BCAST-ESTIMATE-01 · the composer uses the one decision', () => {
  const src = readFileSync(join(process.cwd(), 'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'), 'utf8')
  it('Send is gated by estimateAllowsSend, and the line no longer falls back to a bare dash', () => {
    expect(src).toContain('const canSend = !!eventSlug && contentReady && estimateAllowsSend(estimate)')
    expect(src).not.toMatch(/: '—'\}\s*<\/strong>/)
    expect(src).toContain('data-testid="broadcast-estimate"')
  })
  it('every non-ready state has its own sentence', () => {
    for (const kind of ['no_event', 'filters_incomplete', 'loading', 'error', 'no_recipients', 'capacity_unknown', 'no_capacity', 'insufficient']) {
      expect(src).toContain(`estimate.kind === '${kind}' &&`)
    }
  })
})
