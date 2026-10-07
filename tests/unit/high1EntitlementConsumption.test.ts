// RD-HIGH-1 — a paid capacity entitlement publishes its OWN event, exactly once. Source contracts
// for app/api/events/publish/route.ts; the behaviour on real Firestore (retry, changed slug,
// consumed / foreign / mismatched entitlement, concurrent publishes, edit + capacity purchase
// still working, historical drafts) is in tests/emulator/serviceAllowances.emu.test.ts ("HIGH-1 ·").

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const SRC  = read('app/api/events/publish/route.ts')
const TXN  = SRC.slice(SRC.indexOf('await adminDb.runTransaction(async (txn) => {'), SRC.indexOf('  } catch (err) {'))
const at   = (s: string, from = SRC) => from.indexOf(s)

describe('fast refusal: a draft that already produced its event never comes back through publish', () => {
  it('keys on the SERVER-written publishedAt (not the client slug, status or a consumed flag in the body)', () => {
    expect(SRC).toContain('if (draft.publishedAt != null) {')
    expect(SRC).not.toMatch(/body[^\n]*\.(consumed|entitlement|publishedAt)/)
  })
  it('runs before the slug is resolved or anything is priced / written', () => {
    expect(at('if (draft.publishedAt != null) {')).toBeLessThan(at('const slug = buildEventSlug('))
    expect(at('if (draft.publishedAt != null) {')).toBeLessThan(at('adminDb.runTransaction'))
  })
  it('a retry of a live / pending event answers EVENT_ALREADY_PUBLISHED; anything else ENTITLEMENT_ALREADY_USED', () => {
    expect(SRC).toContain("const live = draft.status === 'published' || draft.status === 'pending_review'")
    expect(SRC).toContain("reason: 'ENTITLEMENT_ALREADY_USED', error: ENTITLEMENT_ALREADY_USED_MESSAGE")
  })
})

describe('the authoritative check is INSIDE the publish transaction', () => {
  it('re-reads the draft and the paid activation order in the transaction (reads before writes)', () => {
    expect(TXN).toContain('const draftNowSnap = await txn.get(draftRef)')
    // RD-CE-FIX H4 — the activation order is ALWAYS re-read in the transaction (a pending checkout is
    // superseded; one that became paid aborts); the entitlement is that same snapshot when paid.
    expect(TXN).toContain('const orderNowSnap = await txn.get(orderRef)')
    expect(TXN).toContain("const entitlementSnap = order?.status === 'paid' ? orderNowSnap : null")
    expect(at('const entitlementSnap', TXN)).toBeLessThan(at('txn.set(slugRef', TXN))
  })
  it('refuses a submitted draft, a foreign / mismatched / unpaid order (fail closed) and a consumed one', () => {
    expect(TXN).toContain("if (!draftNow || draftNow.publishedAt != null || draftNow.status !== 'draft') {")
    expect(TXN).toContain("if (!ent || ent.status !== 'paid' || ent.eventId !== draftId")
    expect(TXN).toContain("|| typeof ent.organizerUid !== 'string' || ent.organizerUid !== uid) {")
    expect(TXN).toContain('if (ent.consumed === true) {')
    // all refusals happen before the first write
    for (const s of ["err.name  = 'ENTITLEMENT_ALREADY_USED'", "err.name  = 'ENTITLEMENT_INVALID'"]) {
      expect(at(s, TXN)).toBeGreaterThan(-1)
      expect(at(s, TXN)).toBeLessThan(at('txn.set(slugRef', TXN))
    }
  })
  it('CONSUMES the order in the same transaction that creates the event (bound to this draft + slug)', () => {
    expect(TXN).toContain('consumed: true, boundEventId: draftId, eventSlug: slug,')
    expect(at('consumed: true, boundEventId: draftId', TXN)).toBeGreaterThan(at('txn.set(slugRef', TXN))
    // the old best-effort, after-commit consumption is gone
    const after = SRC.slice(at('// ── 8b. EA-4 S1'))
    expect(after).not.toMatch(/orderRef\.set\(\s*\{ consumed: true/)
  })
  it('both refusals are returned with a reason, never a 500', () => {
    expect(SRC).toContain("if (err instanceof Error && (err.name === 'ENTITLEMENT_ALREADY_USED' || err.name === 'ENTITLEMENT_INVALID')) {")
    expect(SRC).toContain("{ status: err.name === 'ENTITLEMENT_INVALID' ? 403 : 409 }")
  })
})

describe('nothing else moved', () => {
  it('pricing, the free allowance and the coverage gate are unchanged', () => {
    expect(SRC).toContain('const quoted = calculateActivationQuote({ capacity: requestedCapacity, terms })')
    expect(SRC).toContain("canPublish: false, reason: 'CAPACITY_PAYMENT_REQUIRED',")
    // RD-HIGH-2 — coverage is now read for the authenticated organizer only.
    expect(SRC).toContain('const paidAddonCapacity = (await readDraftCoverage(draftId, uid)).paidCapacity')
  })
  it('the one-licence-per-slug guard and SLUG_CONFLICT remain', () => {
    expect(TXN).toContain("err.name  = 'LICENSE_ALREADY_EXISTS'")
    expect(TXN).toContain("err.name  = 'SLUG_CONFLICT'")
  })
  it('the legacy paid-tier order shape (tests) carries eventId + organizerUid, so it passes the fail-closed check', () => {
    const legacy = read('tests/emulator/publishCapacityHardening.emu.test.ts')
    expect(legacy).toMatch(/orderId: `lic_\$\{id\}`, eventId: id, organizerUid: UID, tier: 'professional'/)
  })
})
