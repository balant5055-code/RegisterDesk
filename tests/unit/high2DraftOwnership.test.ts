// RD-HIGH-2 — a paid entitlement keyed by a (global, client-choosable) draft id is usable ONLY by
// the organizer who owns it. Pure rule + the real readers against an in-memory Firestore double +
// route wiring. Behaviour through the real routes on Firestore: tests/emulator/serviceAllowances.emu
// .test.ts ("HIGH-2 ·").

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// ── a tiny in-memory Firestore (doc get, chained where == / limit, withConverter) ──────────
const store = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('@/lib/firebase/admin', () => {
  const pick = (o: unknown, path: string) => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o)
  const snap = (id: string, data: Record<string, unknown> | undefined) => ({ id, exists: !!data, data: () => data, get: (f: string) => pick(data, f) })
  const query = (name: string, filters: Array<[string, unknown]>): Record<string, unknown> => ({
    where: (f: string, _op: string, v: unknown) => query(name, [...filters, [f, v]]),
    limit: () => query(name, filters),
    get: async () => ({
      docs: [...store.entries()]
        .filter(([k, d]) => k.startsWith(`${name}/`) && k.split('/').length === 2 && filters.every(([f, v]) => pick(d, f) === v))
        .map(([k, d]) => snap(k.split('/')[1], d)),
    }),
  })
  const col = (name: string): Record<string, unknown> => ({
    doc: (id: string) => ({ id, path: `${name}/${id}`, get: async () => snap(id, store.get(`${name}/${id}`)) }),
    withConverter: () => col(name),
    ...query(name, []),
  })
  return { adminDb: { collection: col } }
})

import { judgeDraftCommerceOwnership, ownerVerdict, checkDraftCommerceOwnership } from '@/lib/licensing/draftOwnership'
import { readDraftCoverage } from '@/lib/licensing/draftCoverage'
import { draftIdForEventSlug, txnApplyServiceItems } from '@/lib/licensing/serviceAllowanceLedger'

const A = 'org-A', B = 'org-B', D = 'DraftShared1'
const put = (path: string, data: Record<string, unknown>) => store.set(path, data)
/** Organizer A has paid for draft D: 1,000 capacity + 500 WhatsApp, and published it. */
function seedA() {
  put(`licenseOrders/lic_${D}`, { orderId: `lic_${D}`, eventId: D, organizerUid: A, status: 'paid', commercialModel: 'capacity',
    capacityChange: { capacity: 1_000 } })
  put(`licenseOrders/add_${D}_1`, { orderId: `add_${D}_1`, eventId: D, organizerUid: A, purpose: 'addon', status: 'paid', capacityChange: { capacity: 1_500 } })
  put(`eventServiceAllowances/${D}`, { draftId: D, organizerUid: A, whatsapp: { purchased: 500, consumed: 20 } })
  put('events/a-city-run', { uid: A, draftId: D })
}
beforeEach(() => store.clear())

describe('the ownership rule (pure)', () => {
  it('own ⇒ ok; foreign ⇒ refused; a missing or malformed owner ⇒ refused (fail closed)', () => {
    expect(ownerVerdict(A, A)).toBe('own')
    expect(ownerVerdict(B, A)).toBe('foreign')
    for (const bad of [undefined, null, '', 7, {}]) expect(ownerVerdict(bad, A)).toBe('unknown')
    expect(judgeDraftCommerceOwnership([], A)).toEqual({ ok: true })
    expect(judgeDraftCommerceOwnership([{ record: 'order', owner: A }, { record: 'service allowance', owner: B }], A))
      .toEqual({ ok: false, verdict: 'foreign', record: 'service allowance' })
    expect(judgeDraftCommerceOwnership([{ record: 'event', owner: undefined }], A)).toEqual({ ok: false, verdict: 'unknown', record: 'event' })
  })
})

describe('checkDraftCommerceOwnership — every record under the draft id', () => {
  it('the rightful organizer passes; another organizer is refused on ANY of their records', async () => {
    seedA()
    expect(await checkDraftCommerceOwnership(D, A)).toEqual({ ok: true })
    expect(await checkDraftCommerceOwnership(D, B)).toMatchObject({ ok: false, verdict: 'foreign' })
    for (const only of [`licenseOrders/lic_${D}`, `licenseOrders/add_${D}_1`, `eventServiceAllowances/${D}`, 'events/a-city-run']) {
      store.clear(); seedA()
      for (const k of [...store.keys()]) if (k !== only) store.delete(k)
      expect((await checkDraftCommerceOwnership(D, B)).ok, only).toBe(false)
    }
  })
  it('an unused draft id has nothing to protect; a record with NO owner blocks everyone (never reassigned)', async () => {
    expect(await checkDraftCommerceOwnership('FreshDraft', B)).toEqual({ ok: true })
    put(`eventServiceAllowances/${D}`, { draftId: D, whatsapp: { purchased: 100 } })
    expect(await checkDraftCommerceOwnership(D, A)).toMatchObject({ ok: false, verdict: 'unknown' })
  })
})

describe('readDraftCoverage counts ONLY the caller’s own records', () => {
  it('A sees A’s paid capacity and allowance', async () => {
    seedA()
    const c = await readDraftCoverage(D, A)
    expect(c.activationPaid).toBe(true)
    expect(c.paidCapacity).toBe(1_500)
    expect(c.purchased.whatsapp).toBe(500)
  })
  it('B, using A’s draft id, sees NOTHING paid — no capacity, no allowance, no activation', async () => {
    seedA()
    const c = await readDraftCoverage(D, B)
    expect(c.activation).toBeNull()
    expect(c.activationPaid).toBe(false)
    expect(c.paidCapacity).toBeNull()
    expect(c.purchased).toEqual({ whatsapp: 0, certificates: 0, media: 0 })
  })
})

describe('runtime consumption and grants never cross organizers', () => {
  it('a live event whose ledger belongs to another organizer draws on NO allowance', async () => {
    seedA()
    expect(await draftIdForEventSlug('a-city-run')).toBe(D)             // A's event → A's ledger
    put('events/b-clone', { uid: B, draftId: D })                        // B's event under the same draft id
    expect(await draftIdForEventSlug('b-clone')).toBeNull()              // → its own PAYG path
    put('events/no-owner', { draftId: D })
    expect(await draftIdForEventSlug('no-owner')).toBeNull()
  })
  it('a grant for B into A’s ledger aborts the transaction and writes nothing; A’s own grant still applies', () => {
    const txn = { set: vi.fn() }
    const ledgerSnap = { exists: true, data: () => ({ draftId: D, organizerUid: A, appliedOrders: {} }) }
    const items = [{ service: 'whatsapp', quantity: 100, onExhausted: 'block' }] as never
    expect(() => txnApplyServiceItems(txn as never, ledgerSnap as never, { draftId: D, organizerUid: B, orderId: 'o1', items }))
      .toThrow('LEDGER_OWNER_MISMATCH')
    expect(txn.set).not.toHaveBeenCalled()
    txnApplyServiceItems(txn as never, ledgerSnap as never, { draftId: D, organizerUid: A, orderId: 'o2', items })
    expect(txn.set).toHaveBeenCalledTimes(1)
    // an owner-less ledger is never adopted either
    const orphan = { exists: true, data: () => ({ draftId: D, appliedOrders: {} }) }
    expect(() => txnApplyServiceItems(txn as never, orphan as never, { draftId: D, organizerUid: A, orderId: 'o3', items })).toThrow('LEDGER_OWNER_MISMATCH')
  })
})

describe('route wiring: the organizer is server-derived, and the gate runs before anything is created', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  const PUB = read('app/api/events/publish/route.ts')
  const BUY = read('app/api/licensing/purchase/route.ts')
  const CONF = read('app/api/licensing/checkout/confirm/route.ts')
  const PP  = read('app/api/licensing/published/purchase/route.ts')
  it('publish: ownership gate before pricing/transaction; the ledger owner is re-checked INSIDE the transaction', () => {
    expect(PUB).toContain('const ownership = await checkDraftCommerceOwnership(draftId, uid)')
    expect(PUB.indexOf('checkDraftCommerceOwnership(draftId, uid)')).toBeLessThan(PUB.indexOf('adminDb.runTransaction'))
    const txn = PUB.slice(PUB.indexOf('adminDb.runTransaction'))
    expect(txn).toContain('const ledgerNowSnap = await txn.get(ledgerRef(draftId))')
    expect(txn).toContain("if (ledgerNowSnap.exists && ledgerNowSnap.get('organizerUid') !== uid) {")
    expect(PUB).toContain('readDraftCoverage(draftId, uid)')
    expect(PUB).toContain('const uid = authz.workspaceUid')                    // never from the body
  })
  it('draft purchase: refused (403) before any order is reused, superseded, self-healed or created', () => {
    const gate = BUY.indexOf('const ownership = await checkDraftCommerceOwnership(eventId, ctx.workspaceUid)')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(BUY.indexOf('// ── The authoritative amount'))
    expect(BUY).not.toMatch(/body\.(organizerUid|uid|ownerUid)/)
  })
  it('confirm (activation): someone else’s or an owner-less order is refused before the payment is examined', () => {
    const gate = CONF.indexOf("if (preExisting && (typeof preExisting.organizerUid !== 'string' || preExisting.organizerUid !== uid)) {")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(CONF.indexOf('deriveLicenseCharge(persisted, pricePaise)'))
  })
  it('published purchase: the ledger / orders under the draft id must be the caller’s too', () => {
    expect(PP).toContain('const ownership = await checkDraftCommerceOwnership(draftId, uid)')
    expect(PP.indexOf('checkDraftCommerceOwnership(draftId, uid)')).toBeLessThan(PP.indexOf('purchaseAddon('))
  })
})
