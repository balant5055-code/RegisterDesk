// RD-COMMS-CAPACITY-UX — organizer capacity UX (M1, M2) and refunded audiences (L3): pure rules + wiring.
//
//   • M1: the count preview carries the server's capacity quote; the composer shows eligible /
//     available / required / shortfall, offers License & Services, and disables Send when short;
//   • M2: the create route refuses an unfundable WhatsApp broadcast BEFORE any campaign exists —
//     send-now and scheduled alike — and a campaign that still fails later says why;
//   • L3: 'confirmed' audiences never include a completed refund; 'all' keeps its meaning.
// Behaviour on real Firestore: tests/emulator/communicationCapacityUx.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
const { campaignFailureLabel, isCapacityFailure } = await import('@/lib/broadcasts/campaignFailure')
const { toRecipientCountState } = await import('@/lib/broadcasts/recipientCount')
const { applyAudienceRefundRule, audienceExcludesRefunded, isRefundedRegistration } = await import('@/lib/broadcasts/audienceRefunds')

const CLIENT = 'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'

describe('M1 · the count preview carries the server capacity quote', () => {
  it('passes a well-formed quote through and never invents one', () => {
    const capacity = { required: 100, available: 50, shortfall: 50, sufficient: false, fundedBy: null }
    expect(toRecipientCountState(true, { success: true, count: 100, capacity })).toEqual({ status: 'ready', count: 100, meta: null, capacity })
    expect(toRecipientCountState(true, { success: true, count: 3 })).toEqual({ status: 'ready', count: 3, meta: null })      // email: unchanged shape
    expect(toRecipientCountState(true, { success: true, count: 3, capacity: { required: 'x' } })).toEqual({ status: 'ready', count: 3, meta: null })
  })
  it('the composer shows the four figures, gates Send on the quote, and offers License & Services', () => {
    const src = read(CLIENT)
    expect(src).toContain("const capacityShort = channel === 'whatsapp' && capacity !== null && !capacity.sufficient")
    // RD-BCAST-ESTIMATE-01 — Send now needs a positive quote (broadcastEstimate 'ready'), which is
    // stricter than "not short": a missing WhatsApp quote no longer counts as enough.
    expect(src).toContain('const canSend = !!eventSlug && contentReady && estimateAllowsSend(estimate)')
    for (const label of ['Eligible recipients', 'Available messages', 'Required', 'Additional capacity needed']) expect(src, label).toContain(`<dt>${label}</dt>`)
    expect(src).toContain("can’t be sent or scheduled.{' '}")
    expect(src).toContain('{capacityPurchaseHref && <a href={capacityPurchaseHref}')
  })
})

describe('M2 · refused before anything exists; a later failure says why', () => {
  it('the create route quotes capacity BEFORE the campaign document is written, for send-now and scheduled', () => {
    const route = read('app/api/organizer/broadcasts/route.ts')
    const quote = route.indexOf('const capacity = await quoteWhatsAppBroadcastCapacity({ organizerUid: uid, eventSlug, recipientCount })')
    expect(quote).toBeGreaterThan(-1)
    expect(quote).toBeLessThan(route.indexOf('await campaignRef.set({'))
    expect(quote).toBeLessThan(route.indexOf('if (isScheduled) {'))
    expect(route).toMatch(/error: 'WHATSAPP_CAPACITY_REQUIRED', message: WHATSAPP_BROADCAST_CAPACITY_REQUIRED, capacity \},\s*\{ status: 402 \}/)
    // The authoritative funding check at start is still there (capacity can change before a scheduled send).
    expect(route).toContain("result.reason === 'allowance_exhausted' || result.reason === 'allowance_required'")
  })
  it('capacity failures read clearly; other reasons are worded; unknown codes are never echoed', () => {
    for (const r of ['allowance_required', 'allowance_exhausted', 'insufficient_balance']) {
      expect(campaignFailureLabel(r)).toBe('Failed — Insufficient WhatsApp capacity')
      expect(isCapacityFailure(r)).toBe(true)
    }
    expect(campaignFailureLabel('event_cancelled')).toBe('Failed — Event cancelled')
    expect(isCapacityFailure('event_cancelled')).toBe(false)
    expect(campaignFailureLabel('some_internal_code_x')).toBe('Failed — The broadcast could not be sent')
    expect(campaignFailureLabel(null)).toBeNull()
  })
  it('history shows the reason under "Failed" and the License & Services link for capacity failures', () => {
    const src = read(CLIENT)
    expect(src).toContain("{c.status === 'failed' && campaignFailureLabel(c.failReason) && (")
    expect(src).toContain("{isCapacityFailure(c.failReason) && c.eventDraftId && (")
    expect(read('app/api/organizer/broadcasts/route.ts')).toContain("eventDraftId:   typeof d.eventDraftId    === 'string' ? d.eventDraftId    : null,")
  })
})

describe('L3 · refunded attendees and broadcast audiences', () => {
  const regs = [
    { id: 'ok',      data: { status: 'confirmed', paymentStatus: 'paid' } },
    { id: 'free',    data: { status: 'confirmed', paymentStatus: 'not_required' } },
    { id: 'pending', data: { status: 'confirmed', paymentStatus: 'refund_pending' } },
    { id: 'refund',  data: { status: 'confirmed', paymentStatus: 'refunded' } },
  ]
  it("'confirmed' excludes a COMPLETED refund only (a pending refund is still an attendee)", () => {
    expect(applyAudienceRefundRule('confirmed', regs).map(r => r.id)).toEqual(['ok', 'free', 'pending'])
    expect(isRefundedRegistration({ paymentStatus: 'refunded' })).toBe(true)
    expect(isRefundedRegistration({ paymentStatus: 'refund_pending' })).toBe(false)
  })
  it("'all' (and every other audience) keeps its documented meaning — unchanged", () => {
    for (const a of ['all', 'pending', 'rejected', 'cancelled']) {
      expect(audienceExcludesRefunded(a), a).toBe(false)
      expect(applyAudienceRefundRule(a, regs), a).toHaveLength(4)
    }
  })
  it('applied at EVERY audience builder: create route, both job builds, all three count branches', () => {
    expect(read('app/api/organizer/broadcasts/route.ts')).toContain('const allRecipients = applyAudienceRefundRule(String(audience), regsSnap.docs.map(d => ({')
    const send = read('lib/broadcasts/send.ts')
    expect(send.match(/applyAudienceRefundRule\(c\.audience, regsSnap\.docs/g)).toHaveLength(2)        // email + WhatsApp
    const count = read('app/api/organizer/broadcasts/count/route.ts')
    expect(count).toContain("query.select('attendee', 'whatsappBroadcastConsent', 'paymentStatus')")
    expect(count).toContain("const emails = applyAudienceRefundRule(audience as BroadcastAudience,")
    expect(count).toContain("(await query.where('paymentStatus', '==', 'refunded').count().get()).data().count")
  })
  it('the index the date-filtered refunded count needs is defined', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as { indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[] }
    expect(idx.indexes.some(i => i.collectionGroup === 'registrations' && i.fields.map(f => f.fieldPath).join() === 'organizerUid,eventSlug,status,paymentStatus,registeredAt')).toBe(true)
  })
  it('transactional WhatsApp and reminders do not read the broadcast audience rule', () => {
    for (const f of ['lib/registrations/sendWhatsAppConfirmation.ts', 'lib/reminders/dispatch.ts']) expect(read(f), f).not.toMatch(/audienceRefunds|applyAudienceRefundRule/)
  })
})
