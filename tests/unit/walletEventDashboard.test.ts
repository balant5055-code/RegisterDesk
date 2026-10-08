// RD-WALLET-EVT-01 — the organizer's event-wise Wallet: the pure rules (phases, attribution, what
// happens when a service runs out), the display states, and the structural safety contracts.
// Behaviour on real Firestore (scoping, equality with the License Center / activation-status,
// read-only) is tests/emulator/walletEventDashboard.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  walletEventPhase, todayIn, parseWalletEventPhase, txnEventRef, txnBelongsToEvent, orderPurposeLabel,
} from '@/lib/wallet/eventWalletView'
import { measuredText, rupees, SMS_NOTE } from '@/app/(dashboard)/dashboard/wallet/walletDisplay'

const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('phases (Live / Upcoming / Completed / Cancelled)', () => {
  const T = '2026-10-01'
  it.each([
    ['cancelled', null, null, 'cancelled'],
    ['completed', '2026-12-01', null, 'completed'],
    ['archived', null, null, 'completed'],
    ['published', '2026-09-01', '2026-09-03', 'completed'],     // ended
    ['published', '2026-10-01', null, 'live'],                  // today
    ['published', '2026-09-28', '2026-10-05', 'live'],          // running
    ['published', '2026-11-01', null, 'upcoming'],              // not started
    ['published', null, null, 'live'],                          // no dates: on sale
    ['registration_closed', '2026-10-10', null, 'upcoming'],
    ['unpublished', '2026-01-01', null, 'completed'],
    ['draft', '2020-01-01', null, 'upcoming'],                  // never live yet
    ['pending_review', null, null, 'upcoming'],
    ['changes_requested', null, null, 'upcoming'],
  ] as const)('%s %s→%s ⇒ %s', (lifecycle, start, end, phase) => {
    expect(walletEventPhase(lifecycle, start, end, T)).toBe(phase)
  })
  it('today is the calendar day in the event time zone; an invalid zone falls back to India time', () => {
    const now = new Date('2026-09-30T20:00:00Z')             // 01:30 IST on 1 Oct, still 30 Sep in New York
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-10-01')
    expect(todayIn('America/New_York', now)).toBe('2026-09-30')
    expect(todayIn('Not/AZone', now)).toBe('2026-10-01')
    expect(todayIn(null, now)).toBe('2026-10-01')
  })
  it('only the four phases are accepted as a filter', () => {
    expect(parseWalletEventPhase('live')).toBe('live')
    for (const bad of ['', 'all', 'LIVE', 'drafts', null]) expect(parseWalletEventPhase(bad)).toBeNull()
  })
})

describe('transaction ↔ event attribution uses only references the writers store', () => {
  it('WhatsApp charges by slug; certificate charges by draft id; broadcasts, top-ups and adjustments are not linked', () => {
    expect(txnEventRef({ type: 'whatsapp_charge', metadata: { eventId: 'run-2026', eventSlug: 'run-2026' } })).toEqual({ slug: 'run-2026', draftId: null })
    expect(txnEventRef({ type: 'certificate_charge', metadata: { eventId: 'draftABC', certificateId: 'c1' } })).toEqual({ slug: null, draftId: 'draftABC' })
    expect(txnEventRef({ type: 'broadcast_whatsapp', metadata: { campaignId: 'cmp1', units: 20 } })).toBeNull()
    expect(txnEventRef({ type: 'fund_added', metadata: {} })).toBeNull()
    // a bare eventId on anything but a certificate charge is NOT trusted (writers disagree on what it holds)
    expect(txnEventRef({ type: 'whatsapp_charge', metadata: { eventId: 'run-2026' } })).toBeNull()
    expect(txnEventRef({ type: 'adjustment' })).toBeNull()
  })
  it('belongs-to matches the slug OR the draft id, never another event', () => {
    const ev = { slug: 'run-2026', draftId: 'draftABC' }
    expect(txnBelongsToEvent({ type: 'whatsapp_charge', metadata: { eventSlug: 'run-2026' } }, ev)).toBe(true)
    expect(txnBelongsToEvent({ type: 'certificate_charge', metadata: { eventId: 'draftABC' } }, ev)).toBe(true)
    expect(txnBelongsToEvent({ type: 'whatsapp_charge', metadata: { eventSlug: 'other' } }, ev)).toBe(false)
    expect(txnBelongsToEvent({ type: 'certificate_charge', metadata: { eventId: 'run-2026' } }, ev)).toBe(false)
    expect(txnBelongsToEvent({ type: 'whatsapp_charge', metadata: { eventSlug: 'x' } }, { slug: null, draftId: 'draftABC' })).toBe(false)
  })
})

describe('display states', () => {
  it('a measured figure that failed reads "Unavailable", never 0', () => {
    expect(measuredText({ ok: false, reason: 'unavailable' }, rupees)).toBe('Unavailable')
    expect(measuredText({ ok: true, value: 7000 }, rupees)).toBe('₹70.00')
    expect(measuredText(null, rupees, 'None')).toBe('None')
  })
  it('order purposes are labelled generically', () => {
    expect([orderPurposeLabel('purchase'), orderPurposeLabel('capacity_increase'), orderPurposeLabel('addon'), orderPurposeLabel('weird')])
      .toEqual(['Activation', 'Capacity increase', 'Add-on', 'Order'])
  })
})

describe('structural safety', () => {
  const svc = code('lib/wallet/eventWalletService.ts')
  const list = code('app/api/organizer/wallet/events/route.ts')
  const detail = code('app/api/organizer/wallet/events/[draftId]/route.ts')
  const txns = code('app/api/organizer/wallet/transactions/route.ts')
  // 2026-10-02 — the Wallet is ONE event at a time (the header's event selector).
  const page = code('app/(dashboard)/dashboard/wallet/EventWalletClient.tsx')
  const balance = code('components/wallet/CommunicationBalanceCard.tsx')

  it('both endpoints use the wallet workspace permission before any read', () => {
    for (const [f, src] of [['list', list], ['detail', detail]] as const) {
      const gate = src.indexOf("await authorizeWorkspace(req, 'wallet')")
      expect(gate, f).toBeGreaterThan(-1)
      expect(src.indexOf('WalletEvent', gate), f).toBeGreaterThan(gate)
    }
    expect(txns).toContain("authorizeWorkspace(req, 'wallet')")
  })
  it('the read model reuses the owning derivations — License Center, activation-status, upload gate — and writes nothing', () => {
    for (const fn of ['deriveStoredEventCapacity(', 'resolveEffectiveEventLicense(', 'pickVersionedDefinition(', 'readDraftCoverage(', 'viewOf(', 'photoCapacityUsageQuery(']) {
      expect(svc, fn).toContain(fn)
    }
    // Firestore-shaped writes (in-memory Map.set is fine; the emulator suite traps every real write API).
    expect(svc).not.toMatch(/\.doc\([^)]*\)\.(set|update|delete|create)\(/)
    expect(svc).not.toMatch(/\.collection\([^)]*\)\.add\(/)
    expect(svc).not.toMatch(/\b(tx|txn|transaction|batch)\.(set|update|delete|create)\(|runTransaction|\.batch\(|bulkWriter|recursiveDelete|FieldValue/)
    expect(svc).not.toMatch(/paymentEvents|razorpay/i)
    expect(svc).toContain("where('organizerUid', '=='")
  })
  it('the event filter on transactions is resolved from the workspace’s own draft (never a client slug)', () => {
    expect(txns).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventParam}`)')
    expect(txns).toContain('txnBelongsToEvent(')
  })
  it('the Wallet follows the header event selector and shows only that event (stale responses ignored)', () => {
    expect(page).toContain('useEventContext()')
    expect(page).toContain('const current = data && data.eventId === selectedEventId ? data : null')
    expect(page).toContain('/api/organizer/wallet/events/${encodeURIComponent(eventId)}')
    expect(page).toContain('/api/organizer/wallet/service-requests?event=${encodeURIComponent(eventId)}')
  })
  // RD-COMMS-P1 — no Add Funds anywhere: capacity is bought per event (Increase Limit → License &
  // Services); the old balance card is a read-only legacy notice, and Communications shows Usage.
  it('no Add Funds on the Wallet or the legacy balance card: Increase Limit uses the existing purchase flow', () => {
    expect(page).not.toMatch(/\/api\/organizer\/wallet\/topup|AddFundsModal|Add Funds/)
    expect(page).toContain('increaseLimitHref(')
    expect(balance).not.toMatch(/\/api\/organizer\/wallet\/topup|AddFundsModal|Add funds|Add Funds|razorpay/i)
    expect(balance).toContain('if (balancePaise === null || balancePaise <= 0) return null')
    const comms = code('app/(dashboard)/dashboard/communications/page.tsx')
    expect(comms).not.toContain('<CommunicationBalanceCard />')
    expect(comms).toContain("{tab === 'usage'      && <CommUsage />}")
  })
  it('no SMS allowance; the other balances are separate links, never summed into the event', () => {
    expect(page).toContain('{SMS_NOTE}')
    expect(SMS_NOTE).toBe('SMS is not currently available.')
    expect(page).not.toMatch(/SMS allowance|SMS Sent|sms\b.*purchased/i)
    expect(page).toContain('COMMUNICATION_BALANCE_HREF')
    // RD-PHOTO-01 — no organizer-wide "Photo credits" link: photos are this event's paid capacity.
    expect(page).not.toContain('MEDIA_STUDIO_CREDITS')
    expect(page).not.toContain('Photo credits')
    expect(page).not.toMatch(/balancePaise|media-credits\/balance/)
  })
})
