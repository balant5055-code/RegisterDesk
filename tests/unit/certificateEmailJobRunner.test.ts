// RD-CERT-EMAIL-BULK — bulk delivery, driven through the REAL job runner.
//
// ═══ WHY THIS FILE WAS REWRITTEN ═════════════════════════════════════════════
// It used to `vi.mock('@/lib/certificates/email')`. That single line hid a defect that made
// bulk delivery send NOTHING, ever, while reporting complete success — and it hid it for as
// long as the feature existed:
//
//   processItem() claimed the certificate, then handed it to emailCertificate(), which
//   claims again because it is the single owner of the claim for all three of its callers.
//   claimCertificateEmail has no re-entrancy — deliberately, so two senders can never both
//   proceed — so the inner claim saw the outer claim's own `processing` + live lease and
//   returned `busy`. `busy` is a skip; the skip was counted as a success. Every run
//   finished `succeeded: N, failed: 0` with zero provider calls, and left N certificates
//   stuck in `processing` until their lease lapsed into `needs_review`, which no automatic
//   intent may take. The certificates became permanently unsendable.
//
// Mocking emailCertificate meant the inner claim never ran, so the collision could not
// occur in a test. The mock asserted the very thing that was broken.
//
// ═══ WHERE THE BOUNDARY IS NOW ═══════════════════════════════════════════════
// REAL: emailCertificate, claimCertificateEmail, recordCertificateEmail, getSettings, the
//       placeholder resolver, getEmailAppUrl, the job runner and its strategy.
// DOUBLED: Firestore (an in-memory store with real transaction/FieldValue/Timestamp
//       semantics), the notification provider, and the per-event provider resolver.
//
// So the claim/lease/record lifecycle is exercised exactly as production runs it, and the
// only thing that cannot happen is an email actually being sent. Nothing here sends mail.

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface SendRecord {
  type:     string
  provider: string
  params:   Record<string, unknown>
}

const h = vi.hoisted(() => {
  // Declared HERE, not at module scope: vi.mock factories are hoisted above ordinary
  // declarations, so a top-level class would not exist yet when the firestore mock runs.
  class FakeTimestamp {
    constructor(private readonly ms: number) {}
    static fromMillis(ms: number) { return new FakeTimestamp(ms) }
    toMillis() { return this.ms }
    toDate()   { return new Date(this.ms) }
  }
  const state = {
    /** The whole "database": `collection/docId` → document. */
    docs:              new Map<string, Record<string, unknown>>(),
    sends:             [] as SendRecord[],
    committed:         [] as Array<{ processed: number; succeeded: number; failed: number; skipped: number }>,
    cancelAfter:       Number.POSITIVE_INFINITY,
    failSendFor:       new Set<string>(),
    providerAvailable: true,
    resolveThrows:     false,
    sendThrows:        false,
  }
  return { state, FakeTimestamp }
})

// ─── Firestore double ────────────────────────────────────────────────────────
// Small, but faithful where it matters: transactions read-then-write, FieldValue sentinels
// are applied rather than stored, and Timestamp is a real class so the claim's
// `instanceof Timestamp` lease check behaves as it does in production.

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion:      (...items: unknown[]) => ({ __arrayUnion: items }),
    increment:       (n: number) => ({ __inc: n }),
    serverTimestamp: () => ({ __serverTs: true }),
    delete:          () => ({ __delete: true }),
  },
  FieldPath: { documentId: () => '__name__' },
  Timestamp: h.FakeTimestamp,
}))

vi.mock('@/lib/firebase/admin', () => {
  const apply = (path: string, patch: Record<string, unknown>) => {
    const cur = { ...(h.state.docs.get(path) ?? {}) } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && '__arrayUnion' in (v as object)) {
        const prev = Array.isArray(cur[k]) ? cur[k] as unknown[] : []
        cur[k] = [...prev, ...(v as { __arrayUnion: unknown[] }).__arrayUnion]
      } else if (v && typeof v === 'object' && '__inc' in (v as object)) {
        cur[k] = (typeof cur[k] === 'number' ? cur[k] as number : 0) + (v as { __inc: number }).__inc
      } else if (v && typeof v === 'object' && '__serverTs' in (v as object)) {
        cur[k] = new h.FakeTimestamp(Date.now())
      } else if (v && typeof v === 'object' && '__delete' in (v as object)) {
        delete cur[k]
      } else {
        cur[k] = v
      }
    }
    h.state.docs.set(path, cur)
  }

  const docRef = (path: string) => ({
    path,
    get:    async () => ({ exists: h.state.docs.has(path), data: () => h.state.docs.get(path) }),
    update: async (patch: Record<string, unknown>) => {
      if (!h.state.docs.has(path)) throw new Error(`NOT_FOUND ${path}`)
      apply(path, patch)
    },
    set:    async (v: Record<string, unknown>) => { h.state.docs.set(path, v) },
  })

  return {
    adminDb: {
      collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
      doc:        (p: string) => docRef(p),
      runTransaction: async <T>(fn: (tx: {
        get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => unknown }>
        update: (ref: { path: string }, patch: Record<string, unknown>) => void
      }) => Promise<T>): Promise<T> => fn({
        get:    async ref => ({ exists: h.state.docs.has(ref.path), data: () => h.state.docs.get(ref.path) }),
        update: (ref, patch) => apply(ref.path, patch),
      }),
    },
  }
})

// Module-level imports of lib/certificates/firestore.ts that this suite never exercises.
vi.mock('@/lib/firebase/storage/admin', () => ({ deleteServerFile: async () => {} }))
vi.mock('@/features/platform-storage', () => ({ storage: { download: async () => null } }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))

// ─── The provider boundary — the ONLY thing standing in for a real send ──────
vi.mock('@/lib/notifications', () => ({
  NotificationType:    { CERTIFICATE_READY: 'CERTIFICATE_READY' },
  NotificationChannel: { EMAIL: 'EMAIL' },
  notificationEngine: {
    isAvailable: () => h.state.providerAvailable,
    send: async (type: string, params: Record<string, unknown>, provider: string) => {
      if (h.state.sendThrows) throw new Error('provider exploded')
      h.state.sends.push({ type, provider, params })
      const id = String(params.certificateId)
      return h.state.failSendFor.has(id)
        ? { success: false, error: 'provider rejected' }
        : { success: true, messageId: `msg-${id}` }
    },
  },
}))

vi.mock('@/lib/email/resolveEventProvider', () => ({
  resolveEventEmailProvider: async () => {
    if (h.state.resolveThrows) throw new Error('event lookup failed')
    return 'resend'
  },
}))

// Only the PAGING helpers are stubbed. claimCertificateEmail, recordCertificateEmail and
// getSettings stay REAL and run against the store above — they are the lifecycle under test.
vi.mock('@/lib/certificates/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/certificates/firestore')>()
  const all = () => [...h.state.docs.entries()]
    .filter(([k]) => k.startsWith('certificates/'))
    .map(([, v]) => v as { certificateId: string; emailStatus?: string | null })
  return {
    ...actual,
    listCertificatesForDelivery: async (
      _e: string, _u: string, scope: string,
      o: { pageSize: number; cursor: string | null },
    ) => {
      const matching = all().filter(c =>
        scope === 'failed'
          ? c.emailStatus === 'failed'
          : c.emailStatus == null || c.emailStatus === 'pending' || c.emailStatus === 'failed')
      const start = o.cursor ? matching.findIndex(c => c.certificateId === o.cursor) + 1 : 0
      const slice = matching.slice(start, start + o.pageSize)
      return {
        certificates: slice,
        nextCursor:   slice.length ? slice[slice.length - 1].certificateId : o.cursor,
        hasMore:      start + slice.length < matching.length,
      }
    },
    getCertificatesByIds: async (_e: string, _u: string, ids: string[]) =>
      all().filter(c => ids.includes(c.certificateId)),
  }
})

import { processEmailJobChunk } from '@/lib/certificates/emailJobs'
import * as kernel from '@/lib/jobs/kernel'

const JOB = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1', organizerUid: 'org-1', createdBy: 'org-1', eventId: 'draft-1',
  scopeType: 'unsent', certificateIds: null, needsReview: 0,
  status: 'pending', counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
  cursor: null, error: null, lockedUntil: null,
  ...over,
})

let currentJob: Record<string, unknown>

/** Seeds N certificates. Slug is per-event and deliberately NOT derived from the cert id. */
const seed = (n: number, over: Record<string, unknown> = {}) => {
  for (let i = 0; i < n; i++) {
    const certificateId = `RDC-2026-${String(i).padStart(6, '0')}`
    h.state.docs.set(`certificates/${certificateId}`, {
      certificateId,
      eventId:       'draft-1',
      eventSlug:     'spring-charity-run-2026',
      eventName:     'Spring Charity Run 2026',
      attendeeName:  `Runner ${i}`,
      attendeeEmail: `runner${i}@example.test`,
      verificationToken: `vtok-secret-${i}`,
      fileKey:       `events/spring-charity-run-2026/certificates/${certificateId}.pdf`,
      emailStatus:   null,
      data:          { participantName: `Runner ${i}`, eventName: 'Spring Charity Run 2026', certificateId },
      ...over,
    })
  }
}

const cert = (id: string) => h.state.docs.get(`certificates/${id}`) as Record<string, unknown>
const allCerts = () => [...h.state.docs.entries()].filter(([k]) => k.startsWith('certificates/')).map(([, v]) => v)
const totals = () => h.state.committed.reduce((a, c) => ({
  processed: a.processed + c.processed, succeeded: a.succeeded + c.succeeded,
  failed:    a.failed    + c.failed,    skipped:   a.skipped   + c.skipped,
}), { processed: 0, succeeded: 0, failed: 0, skipped: 0 })

beforeEach(() => {
  h.state.docs.clear()
  h.state.sends = []
  h.state.committed = []
  h.state.cancelAfter = Number.POSITIVE_INFINITY
  h.state.failSendFor = new Set()
  h.state.providerAvailable = true
  h.state.resolveThrows = false
  h.state.sendThrows = false
  currentJob = JOB()
  h.state.docs.set('certificateEmailJobs/job-1', { jobId: 'job-1', needsReview: 0 })

  vi.spyOn(kernel, 'leaseJob').mockImplementation(async () =>
    ({ proceed: true, job: currentJob as never, leaseTag: 1 }))
  vi.spyOn(kernel, 'failJob').mockImplementation(async () => {})
  vi.spyOn(kernel, 'commitChunk').mockImplementation(async (_c, _j, c) => {
    h.state.committed.push({
      processed: c.deltaProcessed, succeeded: c.deltaSucceeded,
      failed:    c.deltaFailed,    skipped:   c.deltaSkipped ?? 0,
    })
    currentJob.cursor = c.cursor
    const cancelled = h.state.committed.length >= h.state.cancelAfter
    return {
      status:   cancelled ? 'cancelled' : (c.finished ? 'completed' : 'processing'),
      leaseTag: 1,
      fenced:   false,
    }
  })
})

// ═══ A · Bulk send actually reaches the provider ═════════════════════════════

describe('A · bulk send calls the provider for every certificate', () => {
  it('N certificates → N provider calls, N sent, ZERO left processing', async () => {
    seed(60)
    await processEmailJobChunk('job-1')

    // THE REGRESSION. Before the fix this was 0 — the inner claim refused every one.
    expect(h.state.sends).toHaveLength(60)
    expect(new Set(h.state.sends.map(s => s.params.certificateId)).size).toBe(60)

    const statuses = allCerts().map(c => (c as { emailStatus: string }).emailStatus)
    expect(statuses.filter(s => s === 'sent')).toHaveLength(60)
    expect(statuses.filter(s => s === 'processing')).toHaveLength(0)
  })

  it('every send is recorded on the certificate, releasing the claim', async () => {
    seed(3)
    await processEmailJobChunk('job-1')

    for (const c of allCerts()) {
      const doc = c as { emailStatus: string; emailHistory: Array<{ status: string; provider: string }>; emailLeaseExpiresAt: unknown }
      expect(doc.emailStatus).toBe('sent')
      expect(doc.emailHistory).toHaveLength(1)
      expect(doc.emailHistory[0].status).toBe('sent')
      expect(doc.emailHistory[0].provider).toBe('resend')
      expect(doc.emailLeaseExpiresAt).toBeNull()      // the claim is released
    }
  })

  it('the job counts what actually happened', async () => {
    seed(10)
    await processEmailJobChunk('job-1')
    const t = totals()
    expect(t.succeeded).toBe(10)
    expect(t.failed).toBe(0)
    expect(t.skipped).toBe(0)
  })

  it('commits per PAGE, not per certificate', async () => {
    seed(60)                                   // 60 / BULK_PAGE_SIZE(25) → 3 commits
    await processEmailJobChunk('job-1')
    expect(h.state.committed).toHaveLength(3)
    expect(h.state.committed[0].processed).toBe(25)
  })
})

// ═══ B · The duplicate-claim regression ══════════════════════════════════════

describe('B · the claim is owned by exactly one place', () => {
  it('emailJobs.ts does not claim — the defect is an absence, so assert the absence', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'lib/certificates/emailJobs.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    expect(src).not.toContain('claimCertificateEmail')
    // …and it receives the certificate straight from the page, not from a claim.
    expect(src).toContain('emailCertificate(certificate, { intent: intentFor(job) })')
  })

  it('a replayed page sends nothing twice — idempotency still comes from the ONE claim', async () => {
    seed(10)
    await processEmailJobChunk('job-1')
    expect(h.state.sends).toHaveLength(10)

    currentJob = JOB({ cursor: null })          // strictest replay: from the beginning
    await processEmailJobChunk('job-1')

    expect(h.state.sends).toHaveLength(10)      // zero duplicates
  })

  it('a concurrent holder still blocks a second sender (the claim genuinely works)', async () => {
    seed(1)
    const id = 'RDC-2026-000000'
    // Someone else is mid-send, with a LIVE lease.
    h.state.docs.set(`certificates/${id}`, {
      ...cert(id), emailStatus: 'processing',
      emailLeaseExpiresAt: h.FakeTimestamp.fromMillis(Date.now() + 60_000),
    })
    // SELECTED scope, because that is the only way this certificate reaches the worker: the
    // `unsent` query filters `processing` out server-side, so an organizer meets this case by
    // picking the row explicitly. Reaching the claim is the whole point of the test.
    currentJob = JOB({ scopeType: 'selected', certificateIds: [id] })

    await processEmailJobChunk('job-1')

    expect(h.state.sends).toHaveLength(0)       // refused, correctly
    expect(totals().succeeded).toBe(0)          // and NOT reported as sent
    expect(totals().skipped).toBe(1)
  })
})

// ═══ C · A skip is never a success ═══════════════════════════════════════════

describe('C · skipped/busy does not inflate "Sent"', () => {
  it('an already-sent certificate is skipped, not counted as succeeded', async () => {
    seed(3)
    const id = 'RDC-2026-000001'
    h.state.docs.set(`certificates/${id}`, { ...cert(id), emailStatus: 'sent' })
    // Selected scope: the organizer ticked all three rows, one of which is already sent.
    currentJob = JOB({
      scopeType: 'selected',
      certificateIds: ['RDC-2026-000000', id, 'RDC-2026-000002'],
    })

    await processEmailJobChunk('job-1')

    const t = totals()
    expect(h.state.sends).toHaveLength(2)   // only the two genuinely unsent
    expect(t.succeeded).toBe(2)             // ← the whole point: 2, not 3
    expect(t.skipped).toBe(1)
    expect(t.failed).toBe(0)
  })

  it('needs_review is withheld, counted for review, and never sent', async () => {
    seed(3)
    const id = 'RDC-2026-000001'
    // Claimed, then the worker died: `processing` with a LAPSED lease.
    h.state.docs.set(`certificates/${id}`, {
      ...cert(id), emailStatus: 'processing',
      emailLeaseExpiresAt: h.FakeTimestamp.fromMillis(Date.now() - 1),
    })
    currentJob = JOB({
      scopeType: 'selected',
      certificateIds: ['RDC-2026-000000', id, 'RDC-2026-000002'],
    })

    await processEmailJobChunk('job-1')

    expect(h.state.sends.map(s => s.params.certificateId)).not.toContain(id)
    expect((h.state.docs.get('certificateEmailJobs/job-1') as { needsReview: number }).needsReview).toBe(1)
    const t = totals()
    expect(t.succeeded).toBe(2)
    expect(t.skipped).toBe(1)               // withheld — not a success, not a failure
    expect(t.failed).toBe(0)
  })

  it('"retry failed" claims failed certificates and skips the rest', async () => {
    seed(3)
    h.state.docs.set('certificates/RDC-2026-000000', { ...cert('RDC-2026-000000'), emailStatus: 'failed' })
    currentJob = JOB({ scopeType: 'failed' })

    await processEmailJobChunk('job-1')

    expect(h.state.sends).toHaveLength(1)
    expect(h.state.sends[0].params.certificateId).toBe('RDC-2026-000000')
  })
})

// ═══ D · A claimed certificate is never stranded ═════════════════════════════

describe('D · every failure path releases the claim as retryable', () => {
  it('provider not configured → failed, never left processing', async () => {
    seed(2)
    h.state.providerAvailable = false

    await processEmailJobChunk('job-1')

    for (const c of allCerts()) {
      const doc = c as { emailStatus: string; emailLeaseExpiresAt: unknown }
      expect(doc.emailStatus).toBe('failed')      // retryable — the claim accepts `failed`
      expect(doc.emailStatus).not.toBe('processing')
      expect(doc.emailLeaseExpiresAt).toBeNull()
    }
    expect(totals().failed).toBe(2)
    expect(totals().succeeded).toBe(0)
  })

  it('the event provider lookup throwing → failed, never left processing', async () => {
    seed(2)
    h.state.resolveThrows = true

    await processEmailJobChunk('job-1')

    for (const c of allCerts()) {
      expect((c as { emailStatus: string }).emailStatus).toBe('failed')
    }
  })

  it('the provider send throwing → failed, never left processing', async () => {
    seed(2)
    h.state.sendThrows = true

    await processEmailJobChunk('job-1')

    for (const c of allCerts()) {
      expect((c as { emailStatus: string }).emailStatus).toBe('failed')
    }
  })

  it('a provider rejection is a real failure and stays retryable', async () => {
    seed(2)
    h.state.failSendFor.add('RDC-2026-000000')

    await processEmailJobChunk('job-1')

    expect((cert('RDC-2026-000000') as { emailStatus: string }).emailStatus).toBe('failed')
    expect((cert('RDC-2026-000001') as { emailStatus: string }).emailStatus).toBe('sent')
    expect(totals().failed).toBe(1)
    expect(totals().succeeded).toBe(1)
  })

  it('a failed certificate can be picked up again — the strand is genuinely gone', async () => {
    seed(1)
    h.state.providerAvailable = false
    await processEmailJobChunk('job-1')
    expect((cert('RDC-2026-000000') as { emailStatus: string }).emailStatus).toBe('failed')

    // Recovery: the same job scope re-runs once the provider is back.
    h.state.providerAvailable = true
    h.state.committed = []
    currentJob = JOB({ cursor: null })
    await processEmailJobChunk('job-1')

    expect(h.state.sends).toHaveLength(1)
    expect((cert('RDC-2026-000000') as { emailStatus: string }).emailStatus).toBe('sent')
  })
})

// ═══ E/F/H · What the provider is actually handed ════════════════════════════

describe('E/F/H · the Certificate Center URL, built from real data', () => {
  it('carries /events/{eventSlug}/certificates using the certificate\'s own slug', async () => {
    seed(1)
    await processEmailJobChunk('job-1')

    const p = h.state.sends[0].params as { certificateCenterUrl: string; eventSlug: string }
    expect(p.eventSlug).toBe('spring-charity-run-2026')
    expect(p.certificateCenterUrl).toContain('/events/spring-charity-run-2026/certificates')
    expect(p.certificateCenterUrl).toMatch(/^https?:\/\/.+\/events\/spring-charity-run-2026\/certificates$/)
  })

  it('a DIFFERENT event yields a different URL — the slug is really read per certificate', async () => {
    seed(1)
    h.state.docs.set('certificates/RDC-2026-000000', {
      ...cert('RDC-2026-000000'), eventSlug: 'autumn-trail-ultra-2027',
    })
    await processEmailJobChunk('job-1')

    const p = h.state.sends[0].params as { certificateCenterUrl: string }
    expect(p.certificateCenterUrl).toContain('/events/autumn-trail-ultra-2027/certificates')
    expect(p.certificateCenterUrl).not.toContain('spring-charity-run-2026')
  })

  it('the certificateId NEVER substitutes for the slug', async () => {
    seed(1)
    await processEmailJobChunk('job-1')

    const p = h.state.sends[0].params as { certificateCenterUrl: string; certificateId: string }
    expect(p.certificateCenterUrl).not.toContain(`/events/${p.certificateId}/`)
    expect(p.certificateCenterUrl).not.toContain('RDC-2026')
  })

  it('F · no verification token and no direct file URL reach the provider', async () => {
    seed(1)
    await processEmailJobChunk('job-1')

    const blob = JSON.stringify(h.state.sends[0].params)
    expect(blob).not.toContain('vtok-secret')          // the seeded permanent token
    expect(blob).not.toContain('verificationToken')
    expect(blob).not.toContain('/api/certificates/')
    expect(blob).not.toContain('/file?token=')
    expect(blob).not.toContain('token=')
  })

  it('G · no PDF attachment is handed to the provider', async () => {
    seed(1)
    await processEmailJobChunk('job-1')

    const p = h.state.sends[0].params
    expect(p).not.toHaveProperty('pdf')
    expect(JSON.stringify(p)).not.toContain('contentBase64')
    // The stored artifact is never even fetched — the send path has no storage round-trip.
    expect(JSON.stringify(p)).not.toContain('.pdf')
  })

  it('the preserved verification link still goes out', async () => {
    seed(1)
    await processEmailJobChunk('job-1')
    const p = h.state.sends[0].params as { verifyUrl: string; certificateId: string }
    expect(p.verifyUrl).toContain(`/verify/certificate/${p.certificateId}`)
  })

  it('the default copy no longer claims anything is attached', async () => {
    seed(1)
    await processEmailJobChunk('job-1')
    const p = h.state.sends[0].params as { message: string }
    expect(p.message).not.toContain('attached')
    expect(p.message).toContain('upload your photo')
  })
})
