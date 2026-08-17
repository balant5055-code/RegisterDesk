// RD-CERT-PHOTO-01 — the attendee photo KEY reaching BULK generation.
//
// This is a one-line propagation, and a one-line propagation is exactly the kind of change
// that is easy to believe and hard to notice missing: nothing fails, no type complains, and
// every certificate in a 10,000-strong job simply comes out without its photo.
//
// So this drives the REAL strategy. `runJobChunk` is mocked only to hand back the strategy
// object the job kernel would drive, and `processItem` — the genuine per-registration path,
// including its ownership and confirmed-status gates — is then invoked directly. What is
// asserted is the input `generateCertificate` actually received.
//
// The other half of the contract is COST: jobs.ts must not read the photo itself. The
// registration is already in hand, so the key rides along for free, and the BYTES are fetched
// inside generateCertificate only when the template places a photo element.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JobStrategy } from '@/lib/jobs/runner'

/** Every `input` object handed to generateCertificate. */
const generated: Array<Record<string, unknown>> = []
/** Anything jobs.ts asked object storage for — must stay empty. */
const storageCalls: string[] = []
/** Firestore reads issued while processing ONE registration — must stay empty. */
const extraReads: string[] = []

let captured: JobStrategy<never, never, never> | null = null

vi.mock('@/lib/jobs/runner', () => ({
  runJobChunk: async (_id: string, strategy: unknown) => {
    captured = strategy as JobStrategy<never, never, never>
    return { processed: 0, done: true }
  },
}))

vi.mock('@/lib/certificates/generate', () => ({
  generateCertificate: async (params: { input: Record<string, unknown> }) => {
    generated.push(params.input)
    return { certificate: { certificateId: 'RDC-2026-AB12CD' }, created: true }
  },
  loadRenderAssets: async () => ({ templateBytes: new Uint8Array([1]), assets: new Map() }),
  CertificateInProgressError: class CertificateInProgressError extends Error {},
}))

vi.mock('@/features/platform-storage', () => ({
  storage: {
    download: async (k: string) => { storageCalls.push(k); return { body: new Uint8Array([1]) } },
    upload:   async () => ({ metadata: { path: 'x', size: 1 } }),
  },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => {
      extraReads.push(name)
      throw new Error(`unexpected Firestore read while processing one item: ${name}`)
    },
  },
}))

vi.mock('@/lib/certificates/firestore', () => ({ getTemplateById: async () => TEMPLATE }))
vi.mock('@/lib/notifications/inbox/notify', () => ({ notifyCertificateJobComplete: async () => {} }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))
vi.mock('@/features/race-operations/services/certificateResults', () => ({
  resolveCertificateRaceResult: async () => ({ distance: '10K', finishTime: '00:52:10', position: '7' }),
}))

import { processJobChunk } from '@/lib/certificates/jobs'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEMPLATE = { templateId: 'TPL-1', organizerUid: 'org-1', eventId: 'draft-1', layout: null } as never

const EVENT_CTX = {
  eventSlug: 'noyyal-marathon-2026', eventName: 'Noyyal Marathon 2026',
  eventDate: '15 June 2026', eventLocation: 'Coimbatore', organizerName: 'Noyyal Trust',
} as never

const JOB = {
  jobId: 'JOB-1', eventId: 'draft-1', organizerUid: 'org-1',
  certificateType: 'participation', templateId: 'TPL-1', createdBy: 'op-1',
  counts: { succeeded: 0, failed: 0 },
} as never

const PHOTO_KEY = 'events/noyyal-marathon-2026/attendee-photos/reg-1/photo.jpg'

const reg = (over: Record<string, unknown> = {}) => ({
  id: 'reg-1', organizerUid: 'org-1', eventSlug: 'noyyal-marathon-2026', status: 'confirmed',
  attendee: { name: 'Bala Kumar', email: 'bala@example.com' },
  ticketCode: 'TKT-1', passName: '10K', bibNumber: '1234', bibCategory: 'M', passId: 'pass-1',
  ...over,
}) as never

/** The real strategy the job kernel would drive. */
async function strategy(): Promise<JobStrategy<never, never, never>> {
  captured = null
  await processJobChunk('JOB-1', EVENT_CTX)
  if (!captured) throw new Error('strategy was not captured')
  return captured
}

const CTX = { event: EVENT_CTX, template: TEMPLATE, prefetched: { templateBytes: new Uint8Array([1]), assets: new Map() } } as never

beforeEach(() => { generated.length = 0; storageCalls.length = 0; extraReads.length = 0 })

// ─── 1–2. Propagation ─────────────────────────────────────────────────────────

describe('1 · the photo key reaches generateCertificate', () => {
  it('passes attendeePhotoKey through from the registration', async () => {
    const s = await strategy()
    const r = await s.processItem(reg({ attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(r.ok).toBe(true)
    expect(generated).toHaveLength(1)
    expect(generated[0].attendeePhotoKey).toBe(PHOTO_KEY)
  })

  it('5 · it is an object KEY, never a URL', async () => {
    const s = await strategy()
    await s.processItem(reg({ attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    const key = String(generated[0].attendeePhotoKey)
    expect(key).not.toMatch(/^https?:\/\//)
    expect(key).not.toContain('://')
  })
})

describe('2 · a registration WITHOUT a photo is still generated', () => {
  it('passes undefined and issues normally', async () => {
    const s = await strategy()
    const r = await s.processItem(reg(), JOB, CTX)
    expect(r.ok).toBe(true)
    expect(generated[0].attendeePhotoKey).toBeUndefined()
  })

  it('every other field is unchanged by this port', async () => {
    const s = await strategy()
    await s.processItem(reg({ attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(generated[0]).toMatchObject({
      eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026', organizerUid: 'org-1',
      registrationId: 'reg-1', attendeeName: 'Bala Kumar', attendeeEmail: 'bala@example.com',
      ticketCode: 'TKT-1', passName: '10K', bibNumber: '1234', category: 'M',
      distance: '10K', finishTime: '00:52:10', position: '7',
    })
  })
})

// ─── 3–4. Cost and existing gates ─────────────────────────────────────────────

describe('4 · no additional read is introduced', () => {
  it('jobs.ts performs NO Firestore read while processing one registration', async () => {
    const s = await strategy()
    await s.processItem(reg({ attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(extraReads).toEqual([])
  })

  it('jobs.ts NEVER downloads the photo bytes itself — that stays in generate.ts', async () => {
    const s = await strategy()
    await s.processItem(reg({ attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(storageCalls).toEqual([])
  })

  it('no N+1: ten registrations cost ten generate calls and nothing else', async () => {
    const s = await strategy()
    for (let i = 0; i < 10; i++) {
      await s.processItem(reg({ id: `reg-${i}`, attendeePhotoKey: `${PHOTO_KEY}-${i}` }), JOB, CTX)
    }
    expect(generated).toHaveLength(10)
    expect(extraReads).toEqual([])
    expect(storageCalls).toEqual([])
    // Each certificate carried its OWN key — no cross-contamination through the shared chunk.
    expect(generated.map(g => g.attendeePhotoKey)).toEqual(
      Array.from({ length: 10 }, (_, i) => `${PHOTO_KEY}-${i}`))
  })
})

describe('3 · existing bulk gates still hold', () => {
  it('rejects a registration belonging to another organizer', async () => {
    const s = await strategy()
    const r = await s.processItem(reg({ organizerUid: 'someone-else', attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(r.ok).toBe(false)
    expect(generated).toHaveLength(0)
  })

  it('rejects a registration from another event', async () => {
    const s = await strategy()
    const r = await s.processItem(reg({ eventSlug: 'other-event' }), JOB, CTX)
    expect(r.ok).toBe(false)
    expect(generated).toHaveLength(0)
  })

  it('rejects an unconfirmed registration', async () => {
    const s = await strategy()
    const r = await s.processItem(reg({ status: 'pending', attendeePhotoKey: PHOTO_KEY }), JOB, CTX)
    expect(r.ok).toBe(false)
    expect(generated).toHaveLength(0)
  })
})
