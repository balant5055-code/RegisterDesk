// RD-COMMS-M3 — shared WhatsApp capacity: a WARNING only. Pure rule + composer wiring.
// Behaviour on real Firestore: tests/emulator/whatsappSharedCapacityM3.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { broadcastCapacityWarning, broadcastCapacityWarningText, LARGE_BROADCAST_SHARE } from '@/lib/broadcasts/capacityWarning'

const read = (f: string) => readFileSync(f, 'utf8')
const CLIENT = 'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'
const quote = (required: number, available: number, over: Record<string, unknown> = {}) => ({
  required, available, shortfall: Math.max(0, required - available), sufficient: required <= available, fundedBy: required <= available ? 'event_capacity' as const : null, ...over,
})

describe('the warning rule (from the server quote — no second calculation)', () => {
  it('1 · a large but allowed broadcast warns: required, available, remaining after', () => {
    expect(broadcastCapacityWarning(quote(900, 1_000))).toEqual({ required: 900, available: 1_000, remainingAfter: 100 })
  })
  it('2 · a small broadcast does not', () => {
    expect(broadcastCapacityWarning(quote(100, 1_000))).toBeNull()
  })
  it('the threshold is half of what is available (the first step of the 50/70/85/95/100% ladder)', () => {
    expect(LARGE_BROADCAST_SHARE).toBe(0.5)
    expect(broadcastCapacityWarning(quote(500, 1_000))).toEqual({ required: 500, available: 1_000, remainingAfter: 500 })
    expect(broadcastCapacityWarning(quote(499, 1_000))).toBeNull()
  })
  it('3 · insufficient capacity: no warning (it is BLOCKED by the existing rule instead)', () => {
    expect(broadcastCapacityWarning(quote(1_001, 1_000))).toBeNull()
    expect(broadcastCapacityWarning(quote(100, 0))).toBeNull()
  })
  it('4 · exact capacity: still allowed — the warning says nothing will remain', () => {
    const w = broadcastCapacityWarning(quote(1_000, 1_000))!
    expect(w).toEqual({ required: 1_000, available: 1_000, remainingAfter: 0 })
    expect(broadcastCapacityWarningText(w)).toContain('No messages will remain available.')
  })
  it('paid from the legacy balance, or no quote: the event capacity is not used — no warning', () => {
    expect(broadcastCapacityWarning(quote(900, 100, { sufficient: true, fundedBy: 'legacy_balance' }))).toBeNull()
    expect(broadcastCapacityWarning(null)).toBeNull()
    expect(broadcastCapacityWarning(quote(0, 1_000))).toBeNull()
  })
  it('5 · the text states required, available and remaining after, and NEVER implies a reservation', () => {
    const t = broadcastCapacityWarningText(broadcastCapacityWarning(quote(900, 1_000))!)
    expect(t).toBe('This broadcast will use 900 of your 1,000 WhatsApp messages available. 100 messages will remain available. '
      + 'Registration confirmations and other WhatsApp notifications use the same capacity, so future notifications may require additional capacity.')
    expect(t).not.toMatch(/reserv|set aside|held for|guarantee/i)
    expect(broadcastCapacityWarningText({ required: 1, available: 1, remainingAfter: 0 })).toContain('use 1 of your 1 WhatsApp message available')
  })
})

describe('composer wiring — the warning never changes what can be sent', () => {
  const src = read(CLIENT)
  it('Send is still gated ONLY by the existing capacity rule (the warning is not part of canSend)', () => {
    // RD-BCAST-ESTIMATE-01 — the capacity rule is now the single estimate decision (stricter: a
    // missing quote is not "enough"); the warning is still not part of it.
    expect(src).toContain('const canSend = !!eventSlug && contentReady && estimateAllowsSend(estimate)')
    expect(src).not.toMatch(/broadcastEstimate\(\{[^}]*capacityWarning/)
    expect(src).toContain("const capacityWarning = channel === 'whatsapp' ? broadcastCapacityWarning(capacity) : null")
    expect(src).not.toMatch(/canSend[^\n]*capacityWarning/)
  })
  it('it is shown in the capacity panel, as a status (not an error), with the License & Services link', () => {
    expect(src).toContain('data-testid="broadcast-capacity-warning"')
    expect(src).toContain('{broadcastCapacityWarningText(capacityWarning)}')
  })
  it('6 · the rule is pure: no Firestore, no writes, no fetch — it cannot reserve anything', () => {
    const rule = read('lib/broadcasts/capacityWarning.ts')
    expect(rule).not.toMatch(/firebase|adminDb|fetch\(|\.set\(|\.update\(|increment/)
  })
  it('7 · transactional WhatsApp and the funding/billing code do not read it', () => {
    for (const f of ['lib/registrations/sendWhatsAppConfirmation.ts', 'lib/communications/billing.ts', 'lib/communications/capacityQuote.ts', 'app/api/organizer/broadcasts/route.ts', 'lib/broadcasts/whatsappJob.ts'])
      expect(read(f), f).not.toMatch(/capacityWarning/)
  })
})
