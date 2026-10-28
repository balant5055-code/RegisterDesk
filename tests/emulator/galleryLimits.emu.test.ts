// RD-GALLERY-01 · gallery limits on the REAL draft-save route (PATCH /api/organizer/drafts/[id]),
// on real Firestore (private emulator). The route is the server's check: a browser cannot save a
// gallery past 6 uploads or 20 URL images through it, and a refused save writes nothing.
//
//   • within limits (6 uploads + 20 links) → saved
//   • a 7th upload / a 21st link → 422 GALLERY_LIMIT, the stored gallery unchanged
//   • a forged "url" marker on a platform-storage image still counts as an upload
//   • an existing gallery saved under the old limit (10 uploads) stays editable: unchanged and
//     trimmed saves succeed, growth is refused
//   • the same save submitted twice is a no-op, never a refusal or a duplicate
//   • a save that does not touch eventDetails is not affected

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `gal-org-${P}`

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['events'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

type Body = Record<string, unknown>
const FB = (n: number) => `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/event-assets%2Fg${n}.webp?alt=media`
const up  = (n: number) => ({ source: 'url', value: FB(n), origin: 'upload', originalFileName: `p${n}.jpg` })
const url = (n: number) => ({ source: 'url', value: `https://images.example.com/p${n}.jpg`, origin: 'url' })
const many = <X>(n: number, f: (i: number) => X) => Array.from({ length: n }, (_, i) => f(i))
const details = (g: unknown[]) => ({ info: { name: 'Gallery Test' }, media: { galleryImages: g } })

describeEmu('RD-GALLERY-01 · draft-save gallery limits (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let PATCH: (r: NextRequest, c: { params: Promise<{ draftId: string }> }) => Promise<Response>
  const drafts: string[] = []
  let n = 0

  async function draft(gallery: unknown[]) {
    const id = `galD${P}x${++n}`
    drafts.push(id)
    await db.doc(`users/${UID}/eventDrafts/${id}`).set({ status: 'draft', publishedAt: null, eventDetails: details(gallery) })
    return id
  }
  const save = async (id: string, body: Body) => {
    const res = await PATCH(new NextRequest(`http://localhost/api/organizer/drafts/${id}`, {
      method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ draftId: id }) })
    return { status: res.status, body: await res.json() as Body }
  }
  const stored = async (id: string) => ((await db.doc(`users/${UID}/eventDrafts/${id}`).get()).data()?.eventDetails as Body | undefined)?.media as { galleryImages: unknown[] } | undefined

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ PATCH } = await import('@/app/api/organizer/drafts/[draftId]/route') as never)
  }, T)
  afterAll(async () => { for (const id of drafts) await db.doc(`users/${UID}/eventDrafts/${id}`).delete().catch(() => null) }, T)

  it('a mixed gallery within both limits (6 uploads + 20 links) is saved', async () => {
    const id = await draft([])
    const r = await save(id, { eventDetails: details([...many(6, up), ...many(20, url)]) })
    expect(r.status).toBe(200)
    expect((await stored(id))?.galleryImages).toHaveLength(26)
  }, T)

  it('a 7th upload is refused (422) and nothing is written', async () => {
    const id = await draft(many(6, up))
    const r = await save(id, { eventDetails: details(many(7, up)) })
    expect(r).toMatchObject({ status: 422, body: { code: 'GALLERY_LIMIT' } })
    expect(String(r.body.error)).toContain('up to 6 uploaded images')
    expect((await stored(id))?.galleryImages).toHaveLength(6)
  }, T)

  it('a 21st link is refused; 10 links with 6 uploads are fine (no shared limit)', async () => {
    const id = await draft([])
    expect((await save(id, { eventDetails: details([...many(6, up), ...many(10, url)]) })).status).toBe(200)
    const r = await save(id, { eventDetails: details(many(21, url)) })
    expect(r).toMatchObject({ status: 422, body: { code: 'GALLERY_LIMIT' } })
    expect((await stored(id))?.galleryImages).toHaveLength(16)
  }, T)

  it('a forged "url" marker on a platform-storage image still counts as an upload', async () => {
    const id = await draft(many(6, up))
    const forged = { source: 'url', value: FB(77), origin: 'url' }
    expect((await save(id, { eventDetails: details([...many(6, up), forged]) })).status).toBe(422)
  }, T)

  it('an existing gallery saved under the old limit stays editable; it cannot grow', async () => {
    const id = await draft(many(10, up))
    expect((await save(id, { eventDetails: details(many(10, up)) })).status).toBe(200)            // unchanged
    expect((await save(id, { eventDetails: details([...many(10, up)].reverse()) })).status).toBe(200) // reordered
    expect((await save(id, { eventDetails: details(many(8, up)) })).status).toBe(200)             // trimmed
    expect((await save(id, { eventDetails: details(many(9, up)) })).status).toBe(422)             // grew back
    expect((await stored(id))?.galleryImages).toHaveLength(8)
  }, T)

  it('the same save submitted twice is a no-op (no refusal, no duplicates)', async () => {
    const id = await draft([])
    const body = { eventDetails: details([...many(6, up), ...many(2, url)]) }
    const [a, b] = await Promise.all([save(id, body), save(id, body)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await stored(id))?.galleryImages).toHaveLength(8)
  }, T)

  it('a save that does not touch eventDetails is unaffected, even on an over-limit legacy draft', async () => {
    const id = await draft(many(12, up))
    expect((await save(id, { currentStep: 2 })).status).toBe(200)
  }, T)
})
