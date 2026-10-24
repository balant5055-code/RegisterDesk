// RD-MEDIA-SIZE-01 · /uploads/complete verifies the REAL stored size before recording a photo,
// on REAL Firestore (private emulator), through the REAL prepare + complete routes.
//
// The signed upload URL binds the key and content-type but not the length, so a client could
// declare 1 KB at /prepare and PUT gigabytes. /complete now reads each object's size from the
// bucket and refuses — before recording anything — when it differs from the size declared on
// the reservation, or exceeds the platform / event limit. It deletes the rejected objects ONLY
// when they are provably this upload's own still-pending keys. Object storage is stubbed: the
// stored size is set per test and deletes are recorded, no bytes move.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `pus${process.pid}`

const h = vi.hoisted(() => ({ who: '', seq: 0, storedSize: 1_000, deleted: [] as string[] }))
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
  storage: {
    getMetadata: async () => ({ size: h.storedSize, mimeType: 'image/jpeg' }),
    delete:      async (k: string) => { h.deleted.push(k) },
    isConfigured: () => true,
  },
}))
vi.mock('@/lib/razorpay/client', () => new Proxy({}, {
  get(_t, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(`payment provider touched: ${String(key)}`)
  },
}))

const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const post = (body: unknown) => new NextRequest('http://localhost/api/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body),
})

describeEmu('RD-MEDIA-SIZE-01 · real stored size enforced at /uploads/complete', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let prepare: (r: NextRequest) => Promise<Response>
  let complete: (r: NextRequest) => Promise<Response>
  const U = `${P}_org`
  const docs: string[] = []
  const events: string[] = []
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); docs.push(path) }

  async function event(name: string, photos = 5) {
    const draftId = `${P}_${name}`, slug = `${P}-${name}`, galleryId = `${P}_g_${name}`
    events.push(draftId)
    await put(`users/${U}/eventDrafts/${draftId}`, { status: 'published', lifecycleStatus: 'published', eventDetails: { info: { name }, seo: { urlSlug: slug } }, updatedAt: FS.Timestamp.now() })
    await put(`events/${slug}`, { uid: U, draftId, slug, lifecycleStatus: 'published' })
    await put(`mediaGalleries/${galleryId}`, { galleryId, organizerUid: U, eventId: draftId, eventSlug: slug, name: 'Finish', schemaVersion: 1, assetCount: 0, bytesStored: 0, bytesOriginalSource: 0 })
    await adminDb.doc(`eventServiceAllowances/${draftId}`).set({ draftId, organizerUid: U, media: { purchased: photos, consumed: 0, onExhausted: 'block' } })
    await put(`licenseOrders/add_${draftId}`, {
      orderId: `add_${draftId}`, eventId: draftId, organizerUid: U, purpose: 'addon', status: 'paid', amountPaise: photos * 224,
      serviceItems: [{ service: 'media', quantity: photos, unitPricePaise: 190, basePaise: photos * 190, gstRatePercent: 18, gstPaise: photos * 34, totalPaise: photos * 224, onExhausted: 'block', baseCapAtPurchase: 0 }],
      createdAt: FS.Timestamp.now(), paidAt: FS.Timestamp.now(),
    })
    return { draftId, galleryId }
  }
  /** prepare (declaring `declared` bytes) → the reserved path + assetId. */
  async function prep(galleryId: string, declared = 1_000) {
    const p = await json(await prepare(post({ galleryId, renditions: [{ rendition: 'original', mimeType: 'image/jpeg', size: declared }] })))
    expect(p.status).toBe(200)
    const r = (p.body.renditions as { rendition: string; path: string }[])[0]
    return { assetId: p.body.assetId as string, path: r.path }
  }
  const finish = async (galleryId: string, assetId: string, path: string) =>
    json(await complete(post({ assetId, galleryId, checksum: 'a'.repeat(64), renditions: [{ rendition: 'original', path, width: 10, height: 10 }] })))
  const status = async (assetId: string) => (await adminDb.doc(`mediaAssets/${assetId}`).get()).get('status') as string | undefined

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ POST: prepare } = await import('@/app/api/organizer/media-studio/uploads/prepare/route'))
    ;({ POST: complete } = await import('@/app/api/organizer/media-studio/uploads/complete/route'))
    await put(`users/${U}`, { uid: U, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })
  }, T)
  beforeEach(() => { h.who = U; h.storedSize = 1_000; h.deleted.length = 0 })
  afterAll(async () => {
    for (const d of events) {
      for (const s of (await adminDb.collection('mediaAssets').where('eventId', '==', d).get()).docs) await s.ref.delete()
      await adminDb.recursiveDelete(adminDb.doc(`eventServiceAllowances/${d}`)).catch(() => null)
      await adminDb.doc(`eventPhotoUsage/${d}`).delete().catch(() => null)
    }
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
  }, T)

  it('the declared size is recorded on the reservation at /prepare', async () => {
    const { galleryId } = await event('declared')
    const { assetId } = await prep(galleryId, 1_234)
    const doc = (await adminDb.doc(`mediaAssets/${assetId}`).get()).data()!
    expect(doc.status).toBe('pending')
    expect((doc.renditions as Record<string, { size: number }>).original.size).toBe(1_234)
  })

  it('an object of exactly the declared size completes (the legitimate path)', async () => {
    const { galleryId } = await event('exact')
    const { assetId, path } = await prep(galleryId, 1_000)
    const r = await finish(galleryId, assetId, path)
    expect(r.status).toBe(201)
    expect(await status(assetId)).toBe('ready')
    expect(h.deleted).toEqual([])
  })

  it('an object LARGER than declared is refused before recording, and its pending object is deleted', async () => {
    const { galleryId } = await event('bigger')
    const { assetId, path } = await prep(galleryId, 1_000)
    h.storedSize = 5_000_000
    const r = await finish(galleryId, assetId, path)
    expect(r.status).toBe(413)
    expect(r.body.code).toBe('UPLOAD_SIZE_REJECTED')
    expect(await status(assetId)).toBe('pending')          // nothing recorded as ready
    expect(h.deleted).toEqual([path])                      // exactly the reserved key, nothing else
  })

  it('repeated completions of an oversized upload are refused every time', async () => {
    const { galleryId } = await event('repeat')
    const { assetId, path } = await prep(galleryId, 1_000)
    h.storedSize = 2_000
    for (let k = 0; k < 3; k++) expect((await finish(galleryId, assetId, path)).status).toBe(413)
    expect(await status(assetId)).toBe('pending')
  })

  it('an object above the platform ceiling is refused even when the declared size was 0 (pre-change reservation)', async () => {
    const { galleryId } = await event('ceiling')
    const { assetId, path } = await prep(galleryId, 1_000)
    // A reservation created before this change carries size 0: only the declared-size comparison is skipped.
    await adminDb.doc(`mediaAssets/${assetId}`).update({ 'renditions.original.size': 0 })
    h.storedSize = 10 * 1024 * 1024 * 1024
    const r = await finish(galleryId, assetId, path)
    expect(r.status).toBe(413)
    expect(await status(assetId)).toBe('pending')
  })

  it('a READY asset replayed with an oversized object is refused but NEVER deleted', async () => {
    const { galleryId } = await event('ready')
    const { assetId, path } = await prep(galleryId, 1_000)
    expect((await finish(galleryId, assetId, path)).status).toBe(201)
    h.storedSize = 9_000_000                              // overwritten after completion
    const r = await finish(galleryId, assetId, path)
    expect(r.status).toBe(413)
    expect(await status(assetId)).toBe('ready')            // the recorded photo is untouched
    expect(h.deleted).toEqual([])                         // a completed photo is never deleted here
  })

  it('a path that is not the reservation’s key is refused without deleting anything', async () => {
    const { galleryId } = await event('foreignpath')
    const { assetId } = await prep(galleryId, 1_000)
    h.storedSize = 5_000
    const other = `events/${P}-foreignpath/photos/original/not-reserved`
    const r = await finish(galleryId, assetId, other)
    expect(r.status).toBe(413)
    expect(h.deleted).toEqual([])
  })
})
