// RD-CERT-EMAIL-BULK — the bulk delivery worker, driven through the REAL job runner.
//
// ═══ WHAT THIS PROVES ════════════════════════════════════════════════════════
// The runner checkpoints per PAGE, and its contract is that replaying a page is safe
// *because each item is idempotent*. For email that is not free — it is exactly what the
// Phase 2B claim provides. So the properties worth pinning are the ones a page replay
// would otherwise break:
//
//   • a crashed chunk that is replayed sends NOTHING twice
//   • a certificate whose outcome is unknown is counted, never re-sent
//   • "retry failed" claims failed certificates and nothing else
//   • cancellation stops claiming
//
// The kernel is mocked at its boundary (leaseJob/commitChunk) rather than reimplemented,
// so the strategy is exercised exactly as production calls it. No email is sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Cert { certificateId: string; emailStatus: string | null }

const h = vi.hoisted(() => {
  const state = {
    certs:       [] as Cert[],
    claims:      [] as Array<{ id: string; intent: string }>,
    sends:       [] as string[],
    needsReview: 0,
    committed:   [] as Array<{ processed: number; succeeded: number; failed: number }>,
    cancelAfter: Number.POSITIVE_INFINITY,
    failSendFor: new Set<string>(),
    reviewFor:   new Set<string>(),
    busyFor:     new Set<string>(),
  }
  return { state }
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({ doc: () => ({ update: async () => { h.state.needsReview++ } }) }),
  },
}))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n: number) => ({ __inc: n }), serverTimestamp: () => '__ts__' },
  Timestamp:  class { static fromMillis(ms: number) { return { toMillis: () => ms } } },
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))

// The claim (Phase 2B) — the single decision point for whether anything is sent.
vi.mock('@/lib/certificates/firestore', () => ({
  claimCertificateEmail: async (id: string, opts: { intent: string }) => {
    h.state.claims.push({ id, intent: opts.intent })
    if (h.state.busyFor.has(id))   return { ok: false, reason: 'busy' }
    if (h.state.reviewFor.has(id)) return { ok: false, reason: 'needs_review' }
    const cert = h.state.certs.find(c => c.certificateId === id)
    if (!cert) return { ok: false, reason: 'not_found' }
    if (opts.intent === 'retry_failed' && cert.emailStatus !== 'failed') {
      return { ok: false, reason: 'not_failed' }
    }
    if ((cert.emailStatus === 'sent' || cert.emailStatus === 'processing') && opts.intent === 'send') {
      return { ok: false, reason: 'already_sent' }
    }
    cert.emailStatus = 'processing'
    return { ok: true, certificate: cert }
  },
  listCertificatesForDelivery: async (
    _e: string, _u: string, _s: string, o: { pageSize: number; cursor: string | null },
  ) => {
    const start = o.cursor ? h.state.certs.findIndex(c => c.certificateId === o.cursor) + 1 : 0
    const slice = h.state.certs.slice(start, start + o.pageSize)
    return {
      certificates: slice,
      nextCursor:   slice.length ? slice[slice.length - 1].certificateId : o.cursor,
      hasMore:      start + slice.length < h.state.certs.length,
    }
  },
  getCertificatesByIds: async (_e: string, _u: string, ids: string[]) =>
    h.state.certs.filter(c => ids.includes(c.certificateId)),
}))

// The provider boundary. Every send is recorded, so duplicates are observable.
vi.mock('@/lib/certificates/email', () => ({
  emailCertificate: async (cert: Cert) => {
    h.state.sends.push(cert.certificateId)
    if (h.state.failSendFor.has(cert.certificateId)) {
      cert.emailStatus = 'failed'
      return { success: false, skipped: false, error: 'provider rejected' }
    }
    cert.emailStatus = 'sent'
    return { success: true, skipped: false }
  },
}))

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

beforeEach(() => {
  h.state.certs = []
  h.state.claims = []
  h.state.sends = []
  h.state.needsReview = 0
  h.state.committed = []
  h.state.cancelAfter = Number.POSITIVE_INFINITY
  h.state.failSendFor = new Set()
  h.state.reviewFor = new Set()
  h.state.busyFor = new Set()
  currentJob = JOB()

  vi.spyOn(kernel, 'leaseJob').mockImplementation(async () =>
    ({ proceed: true, job: currentJob as never, leaseTag: 1 }))
  vi.spyOn(kernel, 'failJob').mockImplementation(async () => {})
  vi.spyOn(kernel, 'commitChunk').mockImplementation(async (_c, _j, c) => {
    h.state.committed.push({
      processed: c.deltaProcessed, succeeded: c.deltaSucceeded, failed: c.deltaFailed,
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

const seed = (n: number, status: string | null = null) => {
  h.state.certs = Array.from({ length: n }, (_, i) => ({
    certificateId: `RDC-2026-${String(i).padStart(6, '0')}`, emailStatus: status,
  }))
}

describe('bulk delivery — normal run', () => {
  it('sends every unsent certificate exactly once', async () => {
    seed(60)
    await processEmailJobChunk('job-1')

    expect(h.state.sends.length).toBe(60)
    expect(new Set(h.state.sends).size).toBe(60)
  })

  it('claims with intent "send" for an unsent scope', async () => {
    seed(3)
    await processEmailJobChunk('job-1')
    expect(h.state.claims.every(c => c.intent === 'send')).toBe(true)
  })

  it('commits per PAGE, not per certificate', async () => {
    seed(60)                                   // 60 / BULK_PAGE_SIZE(25) → 3 commits
    await processEmailJobChunk('job-1')
    expect(h.state.committed.length).toBe(3)
    expect(h.state.committed[0].processed).toBe(25)
  })
})

describe('bulk delivery — replay after a crash', () => {
  it('re-running the SAME work sends nothing twice', async () => {
    seed(10)
    await processEmailJobChunk('job-1')
    expect(h.state.sends.length).toBe(10)

    // A crashed chunk resumes from the last committed cursor. Everything already sent is
    // refused by the claim, so the replay adds no provider calls.
    currentJob = JOB({ cursor: null })
    await processEmailJobChunk('job-1')

    expect(h.state.sends.length).toBe(10)      // ← zero duplicates
    expect(new Set(h.state.sends).size).toBe(10)
  })

  it('10,000 certificates with a full restart → zero duplicate sends', async () => {
    seed(10_000)
    await processEmailJobChunk('job-1')
    const first = h.state.sends.length
    expect(first).toBeGreaterThan(0)

    currentJob = JOB({ cursor: null })         // strictest case: restart from the beginning
    await processEmailJobChunk('job-1')

    expect(h.state.sends.length).toBe(first)
    expect(new Set(h.state.sends).size).toBe(h.state.sends.length)
  })
})

describe('bulk delivery — needs_review', () => {
  it('counts an unknown-delivery certificate and NEVER sends it', async () => {
    seed(3)
    const target = h.state.certs[1].certificateId
    h.state.reviewFor.add(target)

    await processEmailJobChunk('job-1')

    expect(h.state.sends).not.toContain(target)
    expect(h.state.needsReview).toBe(1)
  })

  it('does not count it as a failure — Retry Failed must not pick it up', async () => {
    seed(1)
    h.state.reviewFor.add(h.state.certs[0].certificateId)
    await processEmailJobChunk('job-1')
    expect(h.state.committed[0].failed).toBe(0)
  })
})

describe('bulk delivery — scopes', () => {
  it('a failed scope claims with intent "retry_failed"', async () => {
    seed(3, 'failed')
    currentJob = JOB({ scopeType: 'failed' })
    await processEmailJobChunk('job-1')

    expect(h.state.claims.every(c => c.intent === 'retry_failed')).toBe(true)
    expect(h.state.sends.length).toBe(3)
  })

  it('retry_failed skips certificates that are not failed', async () => {
    seed(3, 'sent')
    currentJob = JOB({ scopeType: 'failed' })
    await processEmailJobChunk('job-1')
    expect(h.state.sends).toEqual([])
  })

  it('a selected scope sends only the listed certificates', async () => {
    seed(5)
    const ids = [h.state.certs[1].certificateId, h.state.certs[3].certificateId]
    currentJob = JOB({ scopeType: 'selected', certificateIds: ids })

    await processEmailJobChunk('job-1')

    expect([...h.state.sends].sort()).toEqual([...ids].sort())
  })
})

describe('bulk delivery — failure isolation and concurrency', () => {
  it('a provider failure is counted and does not stop the run', async () => {
    seed(5)
    h.state.failSendFor.add(h.state.certs[2].certificateId)

    await processEmailJobChunk('job-1')

    expect(h.state.sends.length).toBe(5)               // all attempted
    expect(h.state.committed[0].failed).toBe(1)
    expect(h.state.committed[0].succeeded).toBe(4)
  })

  it('a certificate another worker holds is skipped, not duplicated', async () => {
    seed(3)
    const held = h.state.certs[0].certificateId
    h.state.busyFor.add(held)

    await processEmailJobChunk('job-1')

    expect(h.state.sends).not.toContain(held)
    expect(h.state.committed[0].failed).toBe(0)        // busy is not a failure
  })
})

describe('bulk delivery — cancellation', () => {
  it('stops claiming once the job is cancelled', async () => {
    seed(200)
    h.state.cancelAfter = 1                            // cancelled at the first commit
    await processEmailJobChunk('job-1')
    expect(h.state.sends.length).toBe(25)              // one page only
  })
})
