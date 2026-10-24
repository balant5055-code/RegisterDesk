// RD-CERT-CAPACITY-UX-01 · the Certificates workspace's capacity state, on REAL Firestore (emulator).
//
// The stats route reports `certificateCapacity` from the event's service ledger using the SAME
// decision generateCertificate makes (decideReserve(…, 'certificates', 1)), and the client gate
// (certificateIssueGate) turns it into "may generate" / "may not, and why". Proven here:
//
//   • nothing bought ⇒ none → generation blocked, purchase link offered
//   • bought and partly used ⇒ available, with the exact remainder → not blocked
//   • fully used ⇒ exhausted → blocked
//   • units held by an in-flight licence refund are not counted as available
//   • carried-in units (an admin-approved carry-forward) count, like generateCertificate counts them
//   • EXISTING certificates stay reported whatever the capacity — nothing is hidden

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { certificateIssueGate } from '@/lib/certificates/capacityGate'
import type { CertificateStatsResponse } from '@/app/api/organizer/events/[eventId]/certificates/stats/route'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `ccs-org-${P}`

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['certificates'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-CERT-CAPACITY-UX-01 · certificate capacity state (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  const paths = new Set<string>()
  let n = 0

  async function draft(ledger: Record<string, unknown> | null, existingCertificates = 0) {
    const k = ++n, d = `ccs-d${k}-${P}`, slug = `ccs-ev${k}-${P}`
    paths.add(`users/${UID}/eventDrafts/${d}`); paths.add(`eventServiceAllowances/${d}`)
    await db.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'published', eventDetails: { seo: { urlSlug: slug }, info: { name: `C${k}` } } })
    if (ledger) await db.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, ...ledger })
    for (let i = 0; i < existingCertificates; i++) {
      const id = `ccs-cert-${d}-${i}`
      paths.add(`certificates/${id}`)
      await db.doc(`certificates/${id}`).set({ eventId: d, organizerUid: UID, eventSlug: slug, status: 'generated', registrationId: `r${i}`, downloadCount: 0, fileKey: `k${i}` })
    }
    return d
  }
  const stats = async (d: string) => {
    const res = await GET(new NextRequest(`http://localhost/api/organizer/events/${d}/certificates/stats`, { headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ eventId: d }) })
    expect(res.status).toBe(200)
    return await res.json() as CertificateStatsResponse
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ GET } = await import('@/app/api/organizer/events/[eventId]/certificates/stats/route') as never)
  }, T)
  afterAll(async () => { for (const p of paths) await db.recursiveDelete(db.doc(p)).catch(() => null) }, T)

  it('nothing bought ⇒ none: generation blocked with the License & Services link; existing certificates still reported', async () => {
    const d = await draft(null, 2)
    const s = await stats(d)
    expect(s.certificateCapacity).toMatchObject({ state: 'none', purchased: 0, used: 0, available: 0 })
    expect(s.certificateCapacity!.manageHref).toContain('service=certificates')
    expect(s.certificateCapacity!.manageHref).toContain(`draftId=${d}`)
    const g = certificateIssueGate(s.certificateCapacity)
    expect(g).toMatchObject({ blocked: true, tone: 'warning', href: s.certificateCapacity!.manageHref })
    expect(g.message).toContain('already issued stay available')
    expect(s.current?.total).toBe(2)                                     // history is not hidden
  }, T)

  it('bought and partly used ⇒ available with the exact remainder; not blocked', async () => {
    const d = await draft({ certificates: { purchased: 10, consumed: 4, onExhausted: 'block' } })
    const s = await stats(d)
    expect(s.certificateCapacity).toMatchObject({ state: 'available', purchased: 10, used: 4, available: 6 })
    expect(certificateIssueGate(s.certificateCapacity)).toMatchObject({ blocked: false, tone: 'info' })
  }, T)

  it('fully used ⇒ exhausted; blocked; existing certificates still reported', async () => {
    const d = await draft({ certificates: { purchased: 3, consumed: 3, onExhausted: 'block' } }, 3)
    const s = await stats(d)
    expect(s.certificateCapacity).toMatchObject({ state: 'exhausted', available: 0 })
    expect(certificateIssueGate(s.certificateCapacity).blocked).toBe(true)
    expect(s.current?.total).toBe(3)
  }, T)

  it('units held by an in-flight licence refund are not available (same as generateCertificate)', async () => {
    const d = await draft({ certificates: { purchased: 5, consumed: 3, onExhausted: 'block' }, refundHold: { units: { certificates: 2 } } })
    expect((await stats(d)).certificateCapacity).toMatchObject({ state: 'exhausted', available: 0 })
  }, T)

  it('carried-in units count as capacity', async () => {
    const d = await draft({ certificates: { purchased: 0, consumed: 0, carriedIn: 4 } })
    expect((await stats(d)).certificateCapacity).toMatchObject({ state: 'available', purchased: 4, available: 4 })
  }, T)
})
