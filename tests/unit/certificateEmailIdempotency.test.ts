// RD-CERT-EMAIL-IDEMPOTENCY — a certificate must never be emailed twice.
//
// ═══ THE DEFECT THIS PINS ════════════════════════════════════════════════════
// Delivery used to be: compare `certificate.emailStatus` on the object the caller had
// already fetched → send → record the result. Two consequences, both reachable in
// production at 10,000 certificates:
//
//   1. NO SERIALIZATION. Two senders (a bulk worker and a manual resend, or two workers)
//      could read the same pre-send status and both deliver.
//   2. SEND-THEN-RECORD. The status was written only after the provider accepted, so a
//      crash in between left no trace and the retry re-sent. The job runner made this
//      worse: it checkpoints per CHUNK and its contract (lib/jobs/kernel.ts) is that
//      replaying a page is safe *because each item is idempotent* — which email was not.
//      One crash could therefore re-send an entire page.
//
// The claim closes both by re-reading inside a transaction BEFORE the provider is called.
//
// The transaction double below SERIALIZES on the document, which is what Firestore does
// for a contended doc — without that, a "concurrent" test would prove nothing.
//
// Nothing here sends an email or touches Firestore/R2.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const CERT_ID = 'RDC-2026-S368ZI'
const LEASE_MS = 120_000

// ── Firestore double: one document store + a genuinely serialized transaction ──
const h = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>()
  let chain: Promise<unknown> = Promise.resolve()
  const updates: Array<Record<string, unknown>> = []
  let failNextUpdate = false

  class FakeTimestamp {
    constructor(public ms: number) {}
    toMillis() { return this.ms }
    static fromMillis(ms: number) { return new FakeTimestamp(ms) }
  }

  const docRef = (id: string) => ({ id })

  const adminDb = {
    collection: () => ({ doc: (id: string) => docRef(id) }),
    // Serialized: each transaction runs to completion before the next starts, exactly as
    // Firestore's optimistic locking forces for a contended document.
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        const tx = {
          get: async (ref: { id: string }) => {
            const data = store.get(ref.id)
            return { exists: data !== undefined, data: () => data }
          },
          update: (ref: { id: string }, patch: Record<string, unknown>) => {
            store.set(ref.id, { ...(store.get(ref.id) ?? {}), ...patch })
          },
        }
        return fn(tx)
      })
      chain = run.catch(() => undefined)
      return run as Promise<T>
    },
  }

  return { store, updates, adminDb, FakeTimestamp,
    setFailNextUpdate: (v: boolean) => { failNextUpdate = v },
    getFailNextUpdate: () => failNextUpdate }
})

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }) },
  FieldPath:  { documentId: () => '__id__' },
  Timestamp:  h.FakeTimestamp,
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: h.adminDb }))
vi.mock('@/lib/firebase/storage/admin', () => ({ deleteServerFile: async () => {} }))
vi.mock('@/lib/certificates/urlGuard', () => ({
  validateStorageUrl: () => true,
  safeFetchBytes: async () => null,
  validateGeneratedCertificateUrl: () => true,
}))

import { claimCertificateEmail } from '@/lib/certificates/firestore'

const seed = (over: Record<string, unknown> = {}) => {
  h.store.clear()
  h.store.set(CERT_ID, {
    certificateId: CERT_ID,
    eventId:       'draft-1',
    organizerUid:  'org-1',
    emailStatus:   null,
    ...over,
  })
}

const doc = () => h.store.get(CERT_ID) as Record<string, unknown>

beforeEach(() => { h.store.clear() })

// ─── 1 · the claim itself ─────────────────────────────────────────────────────

describe('claimCertificateEmail — normal send', () => {
  it('claims a never-attempted certificate and marks it processing', async () => {
    seed()
    const r = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })

    expect(r.ok).toBe(true)
    expect(doc().emailStatus).toBe('processing')
    expect(doc().emailAttempts).toBe(1)
    expect(doc().emailLeaseExpiresAt).toBeDefined()
  })

  it('claims a previously failed certificate', async () => {
    seed({ emailStatus: 'failed', emailAttempts: 1 })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })

    expect(r.ok).toBe(true)
    expect(doc().emailAttempts).toBe(2)   // attempts accumulate across retries
  })

  it('refuses a certificate that does not exist', async () => {
    const r = await claimCertificateEmail('RDC-2026-NOPE01', { intent: 'send', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('claimCertificateEmail — already sent', () => {
  it('is NOT claimable by a normal send', async () => {
    seed({ emailStatus: 'sent' })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })

    expect(r).toEqual({ ok: false, reason: 'already_sent' })
    expect(doc().emailStatus).toBe('sent')     // untouched
  })

  it('is NOT claimable by Retry Failed either', async () => {
    seed({ emailStatus: 'sent' })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'retry_failed', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'already_sent' })
  })

  it('IS claimable by an explicit resend — and still takes the claim', async () => {
    seed({ emailStatus: 'sent' })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'resend', leaseMs: LEASE_MS })

    expect(r.ok).toBe(true)
    expect(doc().emailStatus).toBe('processing')   // resend is not a bypass of the claim
  })
})

describe('claimCertificateEmail — Retry Failed scope', () => {
  it('claims only failed certificates', async () => {
    seed({ emailStatus: 'failed' })
    expect((await claimCertificateEmail(CERT_ID, { intent: 'retry_failed', leaseMs: LEASE_MS })).ok).toBe(true)
  })

  it('refuses a never-attempted certificate', async () => {
    seed({ emailStatus: null })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'retry_failed', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'not_failed' })
  })
})

// ─── 2 · concurrency — the property that could not hold before ────────────────

describe('concurrent claims', () => {
  it('two simultaneous sends → exactly ONE wins', async () => {
    seed()
    const [a, b] = await Promise.all([
      claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS }),
      claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS }),
    ])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(loser.ok).toBe(false)
    if (!loser.ok) expect(loser.reason).toBe('busy')
    expect(doc().emailAttempts).toBe(1)      // the loser did not increment
  })

  it('two workers on the same certificate → one claim', async () => {
    seed()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })),
    )
    expect(results.filter(r => r.ok)).toHaveLength(1)
  })

  it('a manual resend cannot claim while a bulk worker holds the claim', async () => {
    seed()
    const worker = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })
    expect(worker.ok).toBe(true)

    const manual = await claimCertificateEmail(CERT_ID, { intent: 'resend', leaseMs: LEASE_MS })
    expect(manual).toEqual({ ok: false, reason: 'busy' })
  })

  it('two concurrent explicit resends → exactly one wins', async () => {
    seed({ emailStatus: 'sent' })
    const results = await Promise.all([
      claimCertificateEmail(CERT_ID, { intent: 'resend', leaseMs: LEASE_MS }),
      claimCertificateEmail(CERT_ID, { intent: 'resend', leaseMs: LEASE_MS }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
  })
})

// ─── 3 · the crash window ─────────────────────────────────────────────────────

describe('crash recovery', () => {
  it('a live lease is busy — a crashed-looking worker is not stolen from', async () => {
    seed({ emailStatus: 'processing', emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() + 60_000) })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'busy' })
  })

  it('an EXPIRED lease is needs_review — and is NEVER auto-claimed', async () => {
    // The sender died. Whether the provider accepted is unknowable from here, so the only
    // safe action is to refuse and surface it: re-sending risks the duplicate this
    // mechanism exists to prevent.
    seed({ emailStatus: 'processing', emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() - 1) })

    const r = await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })

    expect(r).toEqual({ ok: false, reason: 'needs_review' })
    expect(doc().emailStatus).toBe('processing')   // left as-is for an operator
  })

  it('not even an ordinary resend silently overrides needs_review', async () => {
    // A UI "Resend" button must not be able to take the duplicate risk by accident.
    seed({ emailStatus: 'processing', emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() - 1) })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'resend', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'needs_review' })
  })

  it('Retry Failed does not sweep up a needs_review certificate either', async () => {
    seed({ emailStatus: 'processing', emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() - 1) })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'retry_failed', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'needs_review' })
  })
})

// ─── 3b · the ONLY way out of needs_review ────────────────────────────────────

describe('needs_review recovery — an explicit, reviewed operator decision', () => {
  const expired = () => ({
    emailStatus: 'processing',
    emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() - 1),
    emailAttempts: 1,
  })

  it('resend_after_review CAN claim it — the certificate is not stranded forever', async () => {
    seed(expired())
    const r = await claimCertificateEmail(CERT_ID, { intent: 'resend_after_review', leaseMs: LEASE_MS })

    expect(r.ok).toBe(true)
    expect(doc().emailStatus).toBe('processing')   // a fresh claim, not a bypass
    expect(doc().emailAttempts).toBe(2)
  })

  it('takes a REAL claim — a live lease still blocks it', async () => {
    seed({ emailStatus: 'processing', emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() + 60_000) })
    const r = await claimCertificateEmail(CERT_ID, { intent: 'resend_after_review', leaseMs: LEASE_MS })
    expect(r).toEqual({ ok: false, reason: 'busy' })
  })

  it('two operators reviewing the same certificate → exactly ONE resends', async () => {
    seed(expired())
    const results = await Promise.all([
      claimCertificateEmail(CERT_ID, { intent: 'resend_after_review', leaseMs: LEASE_MS }),
      claimCertificateEmail(CERT_ID, { intent: 'resend_after_review', leaseMs: LEASE_MS }),
    ])

    expect(results.filter(r => r.ok)).toHaveLength(1)
    const loser = results.find(r => !r.ok)
    expect(loser && !loser.ok && loser.reason).toBe('busy')
    expect(doc().emailAttempts).toBe(2)   // only the winner incremented
  })

  it('completes the lifecycle: processing → expired → review → sent', async () => {
    seed(expired())
    const claim = await claimCertificateEmail(CERT_ID, { intent: 'resend_after_review', leaseMs: LEASE_MS })
    expect(claim.ok).toBe(true)

    // The send completes and recordCertificateEmail writes the terminal status.
    h.store.set(CERT_ID, { ...doc(), emailStatus: 'sent', emailLeaseExpiresAt: null })

    // Back to ordinary rules — automatic senders leave it alone again.
    expect(await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS }))
      .toEqual({ ok: false, reason: 'already_sent' })
  })

  it('a crash BEFORE the provider call leaves the claim, and the retry does not re-send', async () => {
    seed()
    await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS })   // then "crash"
    // Same worker restarts within the lease:
    expect(await claimCertificateEmail(CERT_ID, { intent: 'send', leaseMs: LEASE_MS }))
      .toEqual({ ok: false, reason: 'busy' })
  })
})

// ─── 4 · a 10,000-certificate run with a mid-run crash ────────────────────────

describe('10K delivery run with a mid-run crash', () => {
  it('never claims the same certificate twice — zero duplicate provider calls', async () => {
    const N = 10_000
    const ids = Array.from({ length: N }, (_, i) => `RDC-2026-${String(i).padStart(6, '0')}`)
    h.store.clear()
    for (const id of ids) h.store.set(id, { certificateId: id, emailStatus: null })

    const providerCalls: string[] = []
    // Worker: claim → "send" → record. It dies at 8,000 AFTER the provider accepted but
    // BEFORE the status was written — the exact window that used to duplicate.
    const runWorker = async (from: number, crashAt: number | null) => {
      for (let i = from; i < N; i++) {
        const id = ids[i]
        const claim = await claimCertificateEmail(id, { intent: 'send', leaseMs: LEASE_MS })
        if (!claim.ok) continue
        providerCalls.push(id)                       // provider accepted
        if (crashAt !== null && i === crashAt) return i   // die before recording
        h.store.set(id, { ...(h.store.get(id) as object), emailStatus: 'sent', emailLeaseExpiresAt: null })
      }
      return null
    }

    const diedAt = await runWorker(0, 8_000)
    expect(diedAt).toBe(8_000)

    // A fresh worker restarts the whole run from the beginning (the job cursor replays
    // its page; here we replay everything, which is the strictest case).
    await runWorker(0, null)

    const unique = new Set(providerCalls)
    expect(providerCalls.length).toBe(unique.size)   // ← THE PROPERTY: zero duplicates
    // Every certificate was delivered exactly once — including #8,000, which the provider
    // DID accept before the crash. The system cannot know that, which is precisely why it
    // is withheld from further sends rather than retried.
    expect(unique.size).toBe(N)

    // #8,000 is the single certificate left for an operator to resolve.
    const crashed = h.store.get(ids[8_000]) as Record<string, unknown>
    expect(crashed.emailStatus).toBe('processing')
    // …and a later run still refuses it once its lease has lapsed.
    h.store.set(ids[8_000], { ...crashed, emailLeaseExpiresAt: new h.FakeTimestamp(Date.now() - 1) })
    expect(await claimCertificateEmail(ids[8_000], { intent: 'send', leaseMs: LEASE_MS }))
      .toEqual({ ok: false, reason: 'needs_review' })
  })

  it('partial failure leaves only the failures retryable', async () => {
    const ids = ['a', 'b', 'c'].map(s => `RDC-2026-00000${s.charCodeAt(0) % 10}`)
    h.store.clear()
    ids.forEach((id, i) => h.store.set(id, {
      certificateId: id,
      emailStatus: i === 1 ? 'failed' : 'sent',
    }))

    const claimed: string[] = []
    for (const id of ids) {
      const r = await claimCertificateEmail(id, { intent: 'retry_failed', leaseMs: LEASE_MS })
      if (r.ok) claimed.push(id)
    }
    expect(claimed).toEqual([ids[1]])
  })
})

// ─── 5 · the lease must outlast the provider ──────────────────────────────────
//
// The claim is only meaningful while it is held. If the lease could expire while the
// provider call is still legitimately in flight, a second sender would take the
// certificate and deliver it a second time — the exact duplicate this file exists to
// prevent, reintroduced by a timing constant rather than by logic.
//
// These read the REAL constants, so changing either side without re-checking the
// relationship fails here rather than in production.

describe('lease duration outlasts the worst-case provider call', () => {
  it('the email lease exceeds the slowest possible send', async () => {
    const { BULK_LEASE_MS } = await import('@/lib/certificates/constants')

    // Worst case: every attempt runs to its timeout, plus the backoff between them.
    const SES_TIMEOUT_MS   = 20_000   // lib/email/ses.ts
    const MAX_SEND_ATTEMPTS = 3       // lib/notifications/engine.ts
    const BACKOFF_MS = 200 + 400      // 200 * 2^(n-1), between the 3 attempts
    const worstCase = SES_TIMEOUT_MS * MAX_SEND_ATTEMPTS + BACKOFF_MS   // 60,600ms

    expect(worstCase).toBe(60_600)
    expect(BULK_LEASE_MS).toBeGreaterThan(worstCase)
    // Headroom for the artifact download, settings read and the status write that all
    // happen inside the same claim.
    expect(BULK_LEASE_MS - worstCase).toBeGreaterThan(30_000)
  })

  it('the constants the assertion above depends on have not moved', async () => {
    // Pins the real sources, so a change to any of them surfaces here.
    const resend = await import('node:fs').then(fs =>
      fs.readFileSync('lib/email/resend.ts', 'utf8'))
    const ses = await import('node:fs').then(fs =>
      fs.readFileSync('lib/email/ses.ts', 'utf8'))
    const engine = await import('node:fs').then(fs =>
      fs.readFileSync('lib/notifications/engine.ts', 'utf8'))

    expect(resend).toContain('RESEND_TIMEOUT_MS = 15_000')
    expect(ses).toContain('SES_TIMEOUT_MS = 20_000')
    expect(engine).toContain('MAX_SEND_ATTEMPTS = 3')
    expect(engine).toContain('sleep(200 * 2 ** (attempt - 1))')
  })
})
