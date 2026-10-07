// RD-PHOTO-01 · Event photo capacity on REAL Firestore (private emulator), through the REAL routes:
// /api/organizer/media-studio/uploads/prepare + /complete + /limits, and the REAL refund services.
//
// Photos are a PAID event service: an event's capacity is exactly the photo units paid for on it
// (no free base, no Media Credits), every upload takes one unit inside a transaction, and refunds
// only ever return UNUSED paid units. Identity is stubbed at the token boundary; object storage is
// stubbed (no bytes move); Razorpay throws if touched.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `phc${process.pid}`

const h = vi.hoisted(() => ({ who: '', superUid: '', seq: 0 }))
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
vi.mock('@/lib/team/workspace', async orig => {
  const ctx = () => ({ callerUid: h.who, workspaceUid: h.who, role: 'owner', permissions: [], isOwner: true, eventIds: [], isStaffCredential: false })
  return {
    ...(await orig<typeof import('@/lib/team/workspace')>()),
    resolveWorkspaceUid: async () => ctx(),
    authorizeWorkspace:  async () => (h.who ? { ...ctx(), ok: true, status: 200, error: '' } : { ok: false, status: 401, error: 'Unauthorized' }),
  }
})
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.who && h.who === h.superUid ? h.who : null),
  resolveSuperAdminUid: async () => (h.who && h.who === h.superUid ? h.superUid : null),
  legacyAdminClaimOnly: async () => false,
}))
// Storage is not configured in the emulator: authorize keys without minting real URLs.
vi.mock('@/features/media-studio/services/uploadService', async orig => ({
  ...(await orig<typeof import('@/features/media-studio/services/uploadService')>()),
  isStorageReady: () => true,
  prepareUploads: async (p: { eventSlug: string; renditions: { rendition: string; mimeType: string }[] }) => ({
    ok: true,
    renditions: p.renditions.map(r => ({ rendition: r.rendition, path: `events/${p.eventSlug}/photos/${r.rendition}/o${++h.seq}`, uploadUrl: 'https://upload.invalid/', mimeType: r.mimeType })),
  }),
  resolveRenditionUrl: async () => null,
}))
vi.mock('@/features/platform-storage', async orig => ({
  ...(await orig<typeof import('@/features/platform-storage')>()),
  storage: { getMetadata: async () => ({ size: 1_000, mimeType: 'image/jpeg' }), isConfigured: () => true },
}))
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))
vi.mock('@/lib/notifications', async orig => ({
  ...(await orig<typeof import('@/lib/notifications')>()),
  notificationEngine: { isAvailable: () => false, send: async () => ({ success: true }) },
}))

const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const post = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body),
})
const get = (qs: string) => new NextRequest(`http://localhost/api/test?${qs}`, { headers: { Authorization: 'Bearer t' } })

describeEmu('RD-PHOTO-01 · event photo capacity (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let prepare: (r: NextRequest) => Promise<Response>
  let complete: (r: NextRequest) => Promise<Response>
  let limits: (r: NextRequest) => Promise<Response>
  let gate: typeof import('@/features/media-studio/services/photoCapacityGate')
  let requests: typeof import('@/lib/wallet/serviceRequests')
  const U = `${P}_org`, OTHER = `${P}_other`, SUPER = `${P}_super`
  const docs: string[] = []
  const events: string[] = []

  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); docs.push(path) }
  /** A live (published, or closed) event of organizer `uid` with one gallery; returns its ids. */
  async function event(name: string, opts: { uid?: string; photos?: number; lifecycle?: string; paidOrder?: boolean } = {}) {
    const uid = opts.uid ?? U
    const draftId = `${P}_${name}`, slug = `${P}-${name}`, galleryId = `${P}_g_${name}`
    events.push(draftId)
    const closed = opts.lifecycle && opts.lifecycle !== 'published'
    const life = { lifecycleStatus: opts.lifecycle ?? 'published', ...(closed ? { completedAt: FS.Timestamp.fromMillis(Date.now() - 3 * 3_600_000) } : {}) }
    await put(`users/${uid}/eventDrafts/${draftId}`, { status: 'published', ...life, eventDetails: { info: { name }, seo: { urlSlug: slug } }, updatedAt: FS.Timestamp.now() })
    await put(`events/${slug}`, { uid, draftId, slug, ...life })
    await put(`mediaGalleries/${galleryId}`, { galleryId, organizerUid: uid, eventId: draftId, eventSlug: slug, name: 'Finish', schemaVersion: 1, assetCount: 0, bytesStored: 0, bytesOriginalSource: 0 })
    if (opts.photos !== undefined) {
      await adminDb.doc(`eventServiceAllowances/${draftId}`).set({ draftId, organizerUid: uid, media: { purchased: opts.photos, consumed: 0, onExhausted: 'block' } })
      if (opts.paidOrder !== false && opts.photos > 0) {
        const q = opts.photos
        await put(`licenseOrders/add_${draftId}`, {
          orderId: `add_${draftId}`, eventId: draftId, organizerUid: uid, purpose: 'addon', status: 'paid', amountPaise: q * 224,
          serviceItems: [{ service: 'media', quantity: q, unitPricePaise: 190, basePaise: q * 190, gstRatePercent: 18, gstPaise: q * 34, totalPaise: q * 224, onExhausted: 'block', baseCapAtPurchase: 0 }],
          createdAt: FS.Timestamp.now(), paidAt: FS.Timestamp.now(),
        })
      }
    }
    return { draftId, slug, galleryId }
  }
  const prep = (galleryId: string) => prepare(post({ galleryId, renditions: [{ rendition: 'original', mimeType: 'image/jpeg', size: 1_000 }] })).then(json)
  async function upload(galleryId: string) {
    const p = await prep(galleryId)
    if (p.status !== 200) return p
    const r = (p.body.renditions as { rendition: string; path: string }[])[0]
    return json(await complete(post({ assetId: p.body.assetId, galleryId, checksum: 'a'.repeat(64), renditions: [{ rendition: r.rendition, path: r.path, width: 10, height: 10 }] })))
  }
  const count = async (draftId: string, status: string, uid = U) =>
    (await adminDb.collection('mediaAssets').where('organizerUid', '==', uid).where('eventId', '==', draftId).where('status', '==', status).count().get()).data().count

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ POST: prepare } = await import('@/app/api/organizer/media-studio/uploads/prepare/route'))
    ;({ POST: complete } = await import('@/app/api/organizer/media-studio/uploads/complete/route'))
    ;({ GET: limits } = await import('@/app/api/organizer/media-studio/limits/route'))
    gate = await import('@/features/media-studio/services/photoCapacityGate')
    requests = await import('@/lib/wallet/serviceRequests')
    for (const u of [U, OTHER]) await put(`users/${u}`, { uid: u, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
  }, T)
  beforeEach(() => { h.who = U })
  afterAll(async () => {
    for (const d of events) {
      for (const s of (await adminDb.collection('mediaAssets').where('eventId', '==', d).get()).docs) await s.ref.delete()
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
      await adminDb.doc(`eventPhotoUsage/${d}`).delete().catch(() => null)
    }
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const c of ['walletServiceRequests', 'walletServiceRequestsLocks', 'adminAuditLogs']) {
      const qs = await adminDb.collection(c).where('organizerUid', '==', U).get().catch(() => null)
      for (const d of qs?.docs ?? []) await d.ref.delete()
    }
  }, T)

  it('#1/#17 · a new event has ZERO photo capacity — the legacy 500 default grants nothing', async () => {
    const { draftId } = await event('new')
    const r = await json(await limits(get(`eventId=${draftId}`)))
    expect(r.status).toBe(200)
    expect(r.body.photoCapacity).toMatchObject({ capacity: 0, used: 0, remaining: 0, max: 3000, maxAdditional: 3000 })
    expect((r.body.limits as { maxPhotosPerEvent: number }).maxPhotosPerEvent).toBe(0)
  }, T)

  it('#2/#16 · upload with zero capacity is refused before any URL — and points to License & Services', async () => {
    const { draftId, galleryId } = await event('zero')
    const p = await prep(galleryId)
    expect(p.status).toBe(402)
    expect(p.body.code).toBe('PHOTO_CAPACITY_REQUIRED')
    expect(p.body.renditions).toBeUndefined()
    expect(await count(draftId, 'pending')).toBe(0)
    const l = await json(await limits(get(`eventId=${draftId}`)))
    expect((l.body.photoCapacity as { purchaseHref: string }).purchaseHref)
      .toBe(`/dashboard/events/new/visibility?draftId=${draftId}&step=license&service=media&returnTo=${encodeURIComponent(`/dashboard/wallet?eventId=${draftId}`)}`)
  }, T)

  it('#11 · two tabs × 10 simultaneous uploads against 10 paid photos ⇒ exactly 10 accepted', async () => {
    const { draftId, galleryId } = await event('race', { photos: 10 })
    const results = await Promise.all(Array.from({ length: 20 }, () => prep(galleryId)))
    expect(results.filter(r => r.status === 200)).toHaveLength(10)
    expect(results.filter(r => r.status === 409 && r.body.code === 'PHOTO_CAPACITY_FULL')).toHaveLength(10)
    expect(await count(draftId, 'pending')).toBe(10)
  }, T)

  it('#12 · used photos reduce remaining; remaining 50 ⇒ 25 fit, the 51st does not', async () => {
    const { draftId, galleryId } = await event('used', { photos: 53 })
    for (let i = 0; i < 3; i++) expect((await upload(galleryId)).status).toBe(201)
    let l = (await json(await limits(get(`eventId=${draftId}`)))).body.photoCapacity as Record<string, number>
    expect(l).toMatchObject({ capacity: 53, used: 3, stored: 3, remaining: 50 })
    const ok = await Promise.all(Array.from({ length: 25 }, () => prep(galleryId)))
    expect(ok.every(r => r.status === 200)).toBe(true)
    l = (await json(await limits(get(`eventId=${draftId}`)))).body.photoCapacity as Record<string, number>
    expect(l.remaining).toBe(25)
    const more = await Promise.all(Array.from({ length: 26 }, () => prep(galleryId)))
    expect(more.filter(r => r.status === 200)).toHaveLength(25)
    expect(more.filter(r => r.status === 409)).toHaveLength(1)
  }, T)

  it('#13/#14/#18 · only UNUSED paid photos are refundable — the organizer Wallet and Super Admin agree', async () => {
    const { draftId, galleryId } = await event('refund', { photos: 20, lifecycle: 'published' })
    for (let i = 0; i < 7; i++) expect((await upload(galleryId)).status).toBe(201)
    await adminDb.doc(`events/${P}-refund`).set({ lifecycleStatus: 'completed', completedAt: FS.Timestamp.fromMillis(Date.now() - 3 * 3_600_000) }, { merge: true })
    const view = await requests.getEventRequests(U, draftId)
    const media = view!.services.find(s => s.state.service === 'media')!
    expect(media.state).toMatchObject({ purchased: 20, used: 7, remaining: 13, ownUnused: 13 })
    expect(media.refund).toMatchObject({ eligible: true, quantity: 13 })          // NOT 20
    expect(media.refund.eligible && media.refund.upperBoundPaise).toBe(13 * 224)  // valued at what was paid per unit
    const admin = await requests.getAdminServiceFigures(U, draftId)
    expect(admin!.media).toMatchObject({ purchased: 20, used: 7, remaining: 13, refundableUnits: 13, paidPaise: 20 * 224, problem: null })
  }, T)

  it('#22 · refund approval and uploads race: never a negative or over-used capacity', async () => {
    const { draftId, galleryId, slug } = await event('rrace', { photos: 10 })
    for (let i = 0; i < 5; i++) expect((await upload(galleryId)).status).toBe(201)
    await adminDb.doc(`events/${slug}`).set({ lifecycleStatus: 'completed', completedAt: FS.Timestamp.fromMillis(Date.now() - 3 * 3_600_000) }, { merge: true })
    const req = await requests.submitServiceRequest({ uid: U, callerUid: U, kind: 'refund', draftId, service: 'media', note: 'unused' })
    expect(req.quantity).toBe(5)
    // The approval and five more uploads at the same moment.
    const [decision, ...ups] = await Promise.allSettled([
      requests.decideServiceRequest({ adminUid: SUPER, id: req.id, action: 'approve', reason: 'Approved after review.', approvedAmountPaise: 5 * 224 }),
      ...Array.from({ length: 5 }, () => prep(galleryId)),
    ])
    const accepted = ups.filter(u => u.status === 'fulfilled' && (u.value as { status: number }).status === 200).length
    const approved = decision.status === 'fulfilled'
    const ledger = (await adminDb.doc(`eventServiceAllowances/${draftId}`).get()).data()!.media as { purchased: number; refunded?: number }
    const capacity = ledger.purchased - (ledger.refunded ?? 0)
    const used = await count(draftId, 'ready') + await count(draftId, 'pending')
    expect(capacity).toBeGreaterThanOrEqual(0)
    expect(used).toBeLessThanOrEqual(capacity)                       // the invariant, whichever won
    expect(approved ? accepted === 0 && ledger.refunded === 5 : accepted === 5 && (ledger.refunded ?? 0) === 0).toBe(true)
  }, T)

  it('#19 · event A cannot consume event B’s capacity, nor another organizer’s ledger', async () => {
    const b = await event('evB', { photos: 50 })
    const a = await event('evA')
    expect((await prep(a.galleryId)).status).toBe(402)
    expect(await count(b.draftId, 'pending')).toBe(0)
    // A ledger owned by ANOTHER organizer under this draft id grants nothing.
    const c = await event('evC')
    await adminDb.doc(`eventServiceAllowances/${c.draftId}`).set({ draftId: c.draftId, organizerUid: OTHER, media: { purchased: 100, consumed: 0, onExhausted: 'block' } })
    expect((await prep(c.galleryId)).status).toBe(402)
    // Another organizer cannot upload into this organizer's gallery at all.
    h.who = OTHER
    expect((await prep(b.galleryId)).status).toBe(404)
  }, T)

  it('a completion without a reservation is refused (no capacity bypass by fabricated asset ids)', async () => {
    const { draftId, galleryId, slug } = await event('forge', { photos: 2 })
    expect((await upload(galleryId)).status).toBe(201)
    const used = (await adminDb.collection('mediaAssets').where('eventId', '==', draftId).where('status', '==', 'ready').get()).docs[0].data()
    const path = (used.renditions as { original: { path: string } }).original.path
    // Re-register the same stored object under a made-up id.
    const forged = await json(await complete(post({ assetId: 'med_forged_000000000000000000', galleryId, checksum: 'b'.repeat(64), renditions: [{ rendition: 'original', path, width: 1, height: 1 }] })))
    expect(forged.status).toBe(409)
    expect(forged.body.code).toBe('UPLOAD_NOT_RESERVED')
    expect(path.startsWith(`events/${slug}/`)).toBe(true)
    expect(await count(draftId, 'ready')).toBe(1)
  }, T)

  it('#24 · historical Media Credits stay readable but are never a bypass (policy is off even if stored on)', async () => {
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    const { getCreditPolicy } = await import('@/features/media-credits/services')
    businessConfig.setRuntimeOverride('mediaStudio', { creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100 } as never)
    try {
      await put(`mediaCreditWallets/${U}`, { organizerUid: U, balance: 5_000, held: 0, updatedAt: FS.Timestamp.now() })
      expect((await getCreditPolicy()).creditsEnabled).toBe(false)
      const { galleryId } = await event('credits')
      const p = await prep(galleryId)
      expect(p.status).toBe(402)                                       // a credit balance grants no photo
      expect((await adminDb.doc(`mediaCreditWallets/${U}`).get()).get('balance')).toBe(5_000)   // history intact
    } finally {
      businessConfig.clearRuntimeOverrides()
    }
  }, T)

  it('deleting a photo or reclaiming an abandoned upload frees its unit (the counter stays exact)', async () => {
    const { draftId, galleryId } = await event('free', { photos: 2 })
    expect((await upload(galleryId)).status).toBe(201)
    const pending = await prep(galleryId)
    expect(pending.status).toBe(200)
    expect((await prep(galleryId)).status).toBe(409)                        // full: 1 ready + 1 pending
    const { markAssetDeleted, purgeReclaimedAsset } = await import('@/features/media-studio/repositories/assetRepo')
    const ready = (await adminDb.collection('mediaAssets').where('eventId', '==', draftId).where('status', '==', 'ready').get()).docs[0].id
    expect((await markAssetDeleted(ready)).ok).toBe(true)
    expect((await adminDb.doc(`eventPhotoUsage/${draftId}`).get()).get('held')).toBe(1)
    expect(await purgeReclaimedAsset(pending.body.assetId as string)).toBe(true)
    expect((await adminDb.doc(`eventPhotoUsage/${draftId}`).get()).get('held')).toBe(0)
    const again = await Promise.all([prep(galleryId), prep(galleryId), prep(galleryId)])
    expect(again.filter(r => r.status === 200)).toHaveLength(2)
  }, T)

  it('a failed upload gives its unit back at once (DELETE of the pending reservation) and gallery counts stay true', async () => {
    const { draftId, galleryId } = await event('release', { photos: 1 })
    const p = await prep(galleryId)
    expect(p.status).toBe(200)
    expect((await prep(galleryId)).status).toBe(409)
    const { DELETE: del } = await import('@/app/api/organizer/media-studio/assets/[assetId]/route')
    const r = await del(new NextRequest('http://localhost/api/test', { method: 'DELETE', headers: { Authorization: 'Bearer t' } }), { params: Promise.resolve({ assetId: p.body.assetId as string }) } as never)
    expect(r.status).toBe(200)
    expect((await adminDb.doc(`eventPhotoUsage/${draftId}`).get()).get('held')).toBe(0)
    expect((await adminDb.doc(`mediaGalleries/${galleryId}`).get()).get('assetCount')).toBe(0)   // never −1
    expect((await prep(galleryId)).status).toBe(200)
  }, T)

  it('stress · three tabs, each with the real client’s 4 uploads in flight, 60 photos against 40 paid ⇒ exactly 40, no errors', async () => {
    const { draftId, galleryId } = await event('stress', { photos: 40 })
    const { MAX_CONCURRENT_UPLOADS } = await import('@/features/media-studio/utils/queueMachine')
    // One tab = a sliding window of MAX_CONCURRENT_UPLOADS over its 20 photos (useUploadQueue).
    const tab = async () => {
      const out: { status: number }[] = []
      let next = 0
      await Promise.all(Array.from({ length: MAX_CONCURRENT_UPLOADS }, async () => {
        while (next < 20) { next++; out.push(await prep(galleryId)) }
      }))
      return out
    }
    const r = (await Promise.all([tab(), tab(), tab()])).flat()
    expect(r.filter(x => x.status === 200)).toHaveLength(40)
    expect(r.filter(x => x.status === 409)).toHaveLength(20)
    expect(r.filter(x => x.status >= 500)).toHaveLength(0)
    expect(await count(draftId, 'pending')).toBe(40)
  }, T)

  it('the gate helper reports stored vs in-flight separately and never counts deleted photos', async () => {
    const { draftId, galleryId } = await event('figs', { photos: 4 })
    expect((await upload(galleryId)).status).toBe(201)
    expect((await prep(galleryId)).status).toBe(200)
    const f = await gate.readEventPhotoCapacity(U, draftId)
    expect(f).toMatchObject({ capacity: 4, used: 2, stored: 1, inFlight: 1, remaining: 2 })
  }, T)
})
