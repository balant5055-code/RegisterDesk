// RD-COMMS-P1 — a licence refund touches the (legacy) communication wallet ONLY for a historical
// wallet-funded licence. Proved on REAL Firestore through the real refund (applyLicenseAction):
//
//   • current Razorpay-only licence → gateway refund + unused service units retired, and NO wallet
//     operation: no credit, no ₹0 `license_refund` row, no organizerWallets document created;
//   • a repeat is refused (409) and never refunds twice;
//   • historical licence (a `license_<draftId>` `license_charge` row > 0) → that wallet-paid amount
//     comes back to the legacy balance exactly once, with the deterministic `license_refund` row;
//   • the historical charge row is left exactly as it was;
//   • concurrent refunds of a licence with NO order (no order claim) record and credit at most once.
// Razorpay is an in-memory stub — no request leaves the process.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const ADMIN = `lrw-admin-${P}`

const h = vi.hoisted(() => ({ refunds: [] as Array<{ paymentId: string; amount: number }> }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_lrw', RAZORPAY_KEY_SECRET: 'lrw',
  razorpay: {
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        h.refunds.push({ paymentId, amount: o.amount })
        return { id: `rfnd_lrw_${h.refunds.length}`, amount: o.amount, status: 'processed' }
      },
    },
  },
}))

describeEmu('RD-COMMS-P1 · licence refunds and the communication wallet (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/lib/admin/licenseAdminService')
  const paths = new Set<string>()
  const slugs = new Set<string>()
  let n = 0

  const put = async (path: string, data: Record<string, unknown>) => { paths.add(path); await adminDb.doc(path).set(data) }
  const get = async (path: string) => (await adminDb.doc(path).get()).data()
  const refund = (slug: string, reason = 'customer cancelled') => svc.applyLicenseAction(slug, { action: 'refund', reason }, ADMIN, { actorRole: 'super_admin' })
  const historyOf = async (slug: string) => (await adminDb.collection('licenseHistory').where('eventId', '==', slug).get()).docs.map(d => d.data())
  const walletRows = async (uid: string) => (await adminDb.collection('walletTransactions').where('organizerUid', '==', uid).get()).docs

  /** A licence, optionally with an activation order (lic_<draftId>) and its applied service units. */
  async function licence(opts: { order?: { paymentId: string | null; amountPaise: number; whatsapp?: { bought: number; consumed: number } } } = {}) {
    const k = ++n
    const uid = `lrw-org-${k}-${P}`, d = `lrw-d${k}-${P}`, slug = `lrw-ev${k}-${P}`
    slugs.add(slug)
    paths.add(`organizerWallets/${uid}`); paths.add(`walletTransactions/license_refund_${slug}`)
    await put(`events/${slug}`, { uid, slug, draftId: d, lifecycleStatus: 'published' })
    const orderId = opts.order ? `lic_${d}` : null
    await put(`eventLicenses/${slug}`, { eventId: slug, organizerUid: uid, orderId, commercialModel: 'capacity', capacity: 100, tier: 'free', version: 2, status: 'active' })
    if (opts.order) {
      const w = opts.order.whatsapp
      const items = w ? [{ service: 'whatsapp', quantity: w.bought, unitPricePaise: 45, basePaise: w.bought * 45, gstRatePercent: 18, gstPaise: 0, totalPaise: opts.order.amountPaise, onExhausted: 'block' }] : []
      await put(`licenseOrders/${orderId}`, {
        orderId, eventId: d, organizerUid: uid, status: 'paid', amountPaise: opts.order.amountPaise, purpose: 'activation', serviceItems: items,
        ...(opts.order.paymentId ? { razorpayPaymentId: opts.order.paymentId } : {}),
      })
      if (w) await put(`eventServiceAllowances/${d}`, { draftId: d, organizerUid: uid, appliedOrders: { [orderId as string]: true }, whatsapp: { purchased: w.bought, consumed: w.consumed, onExhausted: 'block' } })
    }
    return { uid, d, slug, orderId }
  }

  async function wipe() {
    for (const p of paths) await adminDb.doc(p).delete().catch(() => null)
    for (const slug of slugs) {
      for (const col of ['licenseHistory', 'adminAuditLogs']) {
        const field = col === 'licenseHistory' ? 'eventId' : 'entityId'
        for (const x of (await adminDb.collection(col).where(field, '==', slug).get()).docs) await x.ref.delete()
      }
    }
    paths.clear(); slugs.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/admin/licenseAdminService')
  }, T)
  beforeEach(async () => { h.refunds.length = 0; await wipe() }, T)
  afterAll(wipe, T)

  // ── 1 · 2 · 6 — current Razorpay-only licence ──────────────────────────────────────────────────
  it('current Razorpay-only licence: gateway refund + unused units retired, and NO communication-wallet operation at all', async () => {
    const { uid, d, slug, orderId } = await licence({ order: { paymentId: `pay_lrw_cur_${P}`, amountPaise: 5_310, whatsapp: { bought: 100, consumed: 30 } } })

    const res = await refund(slug)
    expect(res.refund).toMatchObject({ gatewayRefunded: true, walletCreditedPaise: 0, servicesRetired: { whatsapp: 70 } })
    expect(h.refunds).toEqual([{ paymentId: `pay_lrw_cur_${P}`, amount: 5_310 }])          // the external amount is unchanged
    // No wallet money, no ₹0 ledger row, no wallet document.
    expect((await adminDb.doc(`organizerWallets/${uid}`).get()).exists).toBe(false)
    expect((await adminDb.doc(`walletTransactions/license_refund_${slug}`).get()).exists).toBe(false)
    expect(await walletRows(uid)).toHaveLength(0)
    // Service allowance reconciliation is unchanged: unused units retired, consumed ones stay.
    expect((await get(`eventServiceAllowances/${d}`))!.whatsapp).toMatchObject({ purchased: 30, consumed: 30 })
    expect(await get(`licenseOrders/${orderId}`)).toMatchObject({ status: 'refunded', servicesRetiredOnRefund: { whatsapp: 70 } })
    // The licence is cancelled and carries the (non-wallet) refund marker; one history entry.
    const lic = (await get(`eventLicenses/${slug}`))!
    expect((lic.admin as { lifecycle: string }).lifecycle).toBe('cancelled')
    expect(lic.refundedAt).toBeTruthy()
    expect((await historyOf(slug)).filter(x => x.action === 'refunded')).toHaveLength(1)

    // 2 · a repeat is refused and never refunds twice.
    await expect(refund(slug, 'again please')).rejects.toMatchObject({ status: 409 })
    expect(h.refunds).toHaveLength(1)
    expect((await get(`eventServiceAllowances/${d}`))!.whatsapp).toMatchObject({ purchased: 30 })
    expect((await adminDb.doc(`organizerWallets/${uid}`).get()).exists).toBe(false)
  }, T)

  it('current licence: CONCURRENT refunds → one gateway refund, one record, still no wallet operation', async () => {
    const { uid, slug } = await licence({ order: { paymentId: `pay_lrw_conc_${P}`, amountPaise: 9_000 } })
    const rs = await Promise.allSettled(Array.from({ length: 4 }, () => refund(slug)))
    expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as { status?: number }).status).toBe(409)
    expect(h.refunds).toHaveLength(1)
    expect((await historyOf(slug)).filter(x => x.action === 'refunded')).toHaveLength(1)
    expect((await adminDb.doc(`organizerWallets/${uid}`).get()).exists).toBe(false)
    expect(await walletRows(uid)).toHaveLength(0)
  }, T)

  it('a licence with NO order and no historical charge: CONCURRENT refunds record once (the licence marker), no wallet operation', async () => {
    const { uid, slug } = await licence()
    const rs = await Promise.allSettled(Array.from({ length: 4 }, () => refund(slug)))
    expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as { status?: number }).status).toBe(409)
    expect((await historyOf(slug)).filter(x => x.action === 'refunded')).toHaveLength(1)
    expect((await adminDb.doc(`organizerWallets/${uid}`).get()).exists).toBe(false)
    expect(h.refunds).toHaveLength(0)
  }, T)

  // ── 3 · 4 · 7 — historical wallet-funded licence ──────────────────────────────────────────────
  it('historical wallet-funded licence: the wallet-paid amount returns to the legacy balance exactly once; the charge row is untouched', async () => {
    const { uid, d, slug } = await licence({ order: { paymentId: null, amountPaise: 2_000 } })
    const charge = { organizerUid: uid, type: 'license_charge', amountPaise: 2_000, balancePaise: 500, status: 'completed', referenceType: 'license', referenceId: d, description: 'License purchased', metadata: {} }
    await put(`walletTransactions/license_${d}`, charge)
    await put(`organizerWallets/${uid}`, { balancePaise: 500, currency: 'INR' })

    const res = await refund(slug)
    expect(res.refund).toMatchObject({ gatewayRefunded: false, walletCreditedPaise: 2_000 })
    expect(h.refunds).toHaveLength(0)                                                     // wallet-only: no gateway leg
    expect((await get(`organizerWallets/${uid}`))!.balancePaise).toBe(2_500)
    expect(await get(`walletTransactions/license_refund_${slug}`)).toMatchObject({
      organizerUid: uid, type: 'license_refund', amountPaise: 2_000, balancePaise: 2_500, referenceType: 'license', referenceId: slug,
    })
    expect(await get(`walletTransactions/license_${d}`)).toEqual(charge)                 // 7 · historical row unchanged

    // 4 · never credited twice.
    await expect(refund(slug, 'again please')).rejects.toMatchObject({ status: 409 })
    expect((await get(`organizerWallets/${uid}`))!.balancePaise).toBe(2_500)
    expect((await walletRows(uid)).map(x => x.id).sort()).toEqual([`license_${d}`, `license_refund_${slug}`].sort())
  }, T)

  it('historical charge on a licence with NO order: CONCURRENT refunds credit the legacy balance exactly once', async () => {
    const { uid, slug } = await licence()
    // No order ⇒ the refund keys the historical charge by the event id (license_<eventId>).
    await put(`walletTransactions/license_${slug}`, { organizerUid: uid, type: 'license_charge', amountPaise: 1_500, balancePaise: 0, status: 'completed', metadata: {} })
    const rs = await Promise.allSettled(Array.from({ length: 4 }, () => refund(slug)))
    expect(rs.some(r => r.status === 'fulfilled')).toBe(true)
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as { status?: number }).status).toBe(409)
    expect((await get(`organizerWallets/${uid}`))!.balancePaise).toBe(1_500)
    expect((await get(`walletTransactions/license_refund_${slug}`))!.amountPaise).toBe(1_500)
    expect((await historyOf(slug)).filter(x => x.action === 'refunded')).toHaveLength(1)
  }, T)

  it('a licence refunded BEFORE this change (₹0 license_refund row, no marker) is still refused', async () => {
    const { uid, slug } = await licence({ order: { paymentId: `pay_lrw_old_${P}`, amountPaise: 3_000 } })
    await put(`walletTransactions/license_refund_${slug}`, { organizerUid: uid, type: 'license_refund', amountPaise: 0, balancePaise: 0, status: 'completed' })
    await expect(refund(slug)).rejects.toMatchObject({ status: 409 })
    expect(h.refunds).toHaveLength(0)
  }, T)
})
