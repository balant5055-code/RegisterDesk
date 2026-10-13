// RD-PRINT-AUDIT — packaging never stores or returns an exception's text. A packaging step
// fails with an Error whose message quotes an attendee (name, email, phone); on REAL
// Firestore + the REAL job kernel + a REAL Auth-emulator ID token through the real GET
// route, the job's stored `error`, its view and the log line carry only the fixed message.
// Stubbed: the item listing (to throw), and Next's `after()`.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `prpk-${process.pid}`
const OWNER = `${P}-owner`
const EV = `${P}-ev`
const SRC = `pgen_${P}-src`
const PW = 'PrintPkgPassw0rd!'
const SENSITIVE = 'Zxqv Pkg-Sentinel <zxqv.sentinel@example.test> +91 98765 43210'

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/notifications/inbox/notify', async (orig) => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifyPrintJobComplete: async () => {} }))
vi.mock('@/lib/printAssets/generationJob', async (orig) => {
  const real = await orig<typeof import('@/lib/printAssets/generationJob')>()
  return {
    ...real,
    listPrintJobItems: async (jobId: string) => {
      if (jobId === SRC) throw new Error(`could not read item for ${SENSITIVE}`)
      return real.listPrintJobItems(jobId)
    },
  }
})

describeEmu('RD-PRINT-AUDIT · packaging errors are fixed text (real Auth, Firestore, job kernel)', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  let token = ''
  const pkgIds: string[] = []

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const admin = await import('@/lib/firebase/admin')
    adminAuth = admin.adminAuth; adminDb = admin.adminDb
    await adminAuth.deleteUser(OWNER).catch(() => null)
    await adminAuth.createUser({ uid: OWNER, email: `${OWNER}@registerdesk.test`, password: PW, emailVerified: true })
    await adminDb.doc(`users/${OWNER}`).set({ uid: OWNER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    // A completed source generation job owned by this workspace (metadata only).
    await adminDb.doc(`printGenerationJobs/${SRC}`).set({
      jobId: SRC, organizerUid: OWNER, createdBy: OWNER, eventId: EV, eventSlug: EV, assetType: 'ID_CARD',
      templateId: 't', templateVersion: 1, status: 'completed', counts: { total: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0 },
      cursor: null, lockedUntil: null, error: null, createdAt: new Date(), updatedAt: new Date(),
    })
    const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${OWNER}@registerdesk.test`, password: PW, returnSecureToken: true }),
    })
    token = ((await r.json()) as { idToken: string }).idToken
  }, T)

  afterAll(async () => {
    for (const id of pkgIds) await adminDb.recursiveDelete(adminDb.doc(`printPackageJobs/${id}`)).catch(() => null)
    await adminDb.recursiveDelete(adminDb.doc(`printGenerationJobs/${SRC}`)).catch(() => null)
    await adminDb.recursiveDelete(adminDb.doc(`users/${OWNER}`)).catch(() => null)
    await adminAuth.deleteUser(OWNER).catch(() => null)
  }, T)

  it('a packaging exception quoting an attendee is neither persisted, returned nor logged', async () => {
    const pkg = await import('@/lib/printAssets/packageJob')
    const job = await pkg.createPrintPackageJob({ sourceJobId: SRC, eventId: EV, eventSlug: EV, assetType: 'ID_CARD', filters: {}, organizerUid: OWNER, createdBy: OWNER })
    pkgIds.push(job.jobId)

    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      for (let i = 0; i < 3; i++) if ((await pkg.processPrintPackageChunk(job.jobId)).status !== 'processing') break
    } finally { spy.mockRestore() }

    const stored = (await adminDb.doc(`printPackageJobs/${job.jobId}`).get()).data() as Record<string, unknown>
    expect(stored.error).toBe(pkg.PACKAGE_FAILED_MESSAGE)
    expect((stored.counts as Record<string, number>).failed).toBe(1)

    const { GET } = await import('@/app/api/organizer/print-packages/[jobId]/route')
    const res = await GET(new NextRequest(`http://localhost/x`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ jobId: job.jobId }) })
    expect(res.status).toBe(200)
    const view = (await res.json()) as { job: { error: string | null } }
    expect(view.job.error).toBe(pkg.PACKAGE_FAILED_MESSAGE)

    const everything = JSON.stringify({ stored, view, logged: logged.map(a => a.map(x => x instanceof Error ? `${x.name}:${x.message}` : x)) })
    for (const s of ['Pkg-Sentinel', 'zxqv.sentinel@example.test', '98765', 'could not read item']) expect(everything).not.toContain(s)
    expect(logged.some(a => String(a[0]).includes('[print] packaging failed'))).toBe(true)
  }, T)
})
