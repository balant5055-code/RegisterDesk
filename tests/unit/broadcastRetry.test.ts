// RD-BROADCAST-RETRY-01 · bounded retry of failed broadcast recipients (C3).
//
// ═══ THE TENSION THIS RESOLVES ═══════════════════════════════════════════════
// Before this, a recipient whose send failed was never retried: the cursor is a document-id
// watermark that only moves forward, so the page containing that recipient was never revisited.
// Transient rate limits meant permanently undelivered messages.
//
// The naive fix — rewind the cursor and sweep failures — is worse than the bug. It would drag
// already-sent recipients back through processItem, and it would re-attempt the INDETERMINATE
// failures (a timeout, where Meta may already hold the message), turning one lost message into
// one duplicate PAID message. So retry happens in-page, before the cursor advances, and only
// for failures the provider definitively refused.
//
// ═══ WHAT IS ASSERTED ════════════════════════════════════════════════════════
// The retryable/non-retryable split, that a success is never sent twice, that the bound holds
// both within an invocation and across resumes, and that a poison recipient cannot starve the
// rest of the broadcast.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  classifyWhatsAppFailure,
  isRetryableWhatsAppFailure,
  isRecipientFault,
  type WhatsAppFailureReason,
} from '@/lib/whatsapp/failureReason'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const WA = strip(read('lib/broadcasts/whatsappJob.ts'))
const EB = strip(read('lib/broadcasts/emailJob.ts'))

// ─── 1 · transient failures ARE retryable ────────────────────────────────────

describe('a failure Meta definitively refused is retryable', () => {
  it.each([
    ['HTTP 429 rate limit',   { httpStatus: 429 },              'RATE_LIMITED'],
    ['code 4 rate limit',     { httpStatus: 400, code: 4 },     'RATE_LIMITED'],
    ['messaging limit',       { httpStatus: 400, code: 131048 }, 'RATE_LIMITED'],
    ['HTTP 500',              { httpStatus: 500 },              'META_SERVER_ERROR'],
    ['HTTP 503',              { httpStatus: 503 },              'META_SERVER_ERROR'],
    ['code 1 unavailable',    { httpStatus: 400, code: 1 },     'META_SERVER_ERROR'],
  ])('%s ⇒ %s ⇒ retryable', (_l, input, expected) => {
    const reason = classifyWhatsAppFailure(input)
    expect(reason).toBe(expected)
    expect(isRetryableWhatsAppFailure(reason)).toBe(true)
  })
})

// ─── 2 · permanent AND indeterminate failures are NOT retried ────────────────

describe('a failure that a resend cannot fix is never retried', () => {
  it.each([
    ['expired token',        { httpStatus: 400, code: 190 },    'AUTHENTICATION_ERROR'],
    ['permission denied',    { httpStatus: 403 },               'AUTHENTICATION_ERROR'],
    ['invalid parameter',    { httpStatus: 400, code: 100 },    'INVALID_RECIPIENT'],
    ['not in allow list',    { httpStatus: 400, code: 131030 }, 'INVALID_RECIPIENT'],
    ['template missing',     { httpStatus: 400, code: 132000 }, 'TEMPLATE_ERROR'],
    ['24h window closed',    { httpStatus: 400, code: 131047 }, 'TEMPLATE_ERROR'],
  ])('permanent: %s ⇒ %s ⇒ NOT retryable', (_l, input, expected) => {
    const reason = classifyWhatsAppFailure(input)
    expect(reason).toBe(expected)
    expect(isRetryableWhatsAppFailure(reason)).toBe(false)
  })

  it.each([
    ['timeout',        { error: 'Meta API request timed out' }, 'NETWORK_TIMEOUT'],
    ['network error',  { error: 'Meta API network error' },     'NETWORK_ERROR'],
    ['no signal',      { error: 'something else' },             'UNKNOWN_ERROR'],
  ])('INDETERMINATE: %s ⇒ %s ⇒ NOT retryable', (_l, input, expected) => {
    // httpStatus absent ⇒ Meta never answered ⇒ it may already hold the message.
    const reason = classifyWhatsAppFailure(input)
    expect(reason).toBe(expected)
    expect(isRetryableWhatsAppFailure(reason)).toBe(false)
  })

  it('an indeterminate failure stays non-retryable even with a retryable-looking code', () => {
    // The transport check runs first, so a stale code cannot promote a timeout.
    const reason = classifyWhatsAppFailure({ code: 4, error: 'Meta API request timed out' })
    expect(reason).toBe('NETWORK_TIMEOUT')
    expect(isRetryableWhatsAppFailure(reason)).toBe(false)
  })

  it('auto-retry is STRICTLY narrower than recipient-fault (they answer different questions)', () => {
    const all: WhatsAppFailureReason[] = [
      'INVALID_WHATSAPP_NUMBER', 'INVALID_RECIPIENT', 'TEMPLATE_ERROR', 'AUTHENTICATION_ERROR',
      'RATE_LIMITED', 'META_SERVER_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR',
    ]
    // Exactly two reasons may be resent unattended.
    expect(all.filter(isRetryableWhatsAppFailure)).toEqual(['RATE_LIMITED', 'META_SERVER_ERROR'])
    // And nothing is both a recipient fault and auto-retryable.
    for (const r of all) {
      if (isRecipientFault(r)) expect(isRetryableWhatsAppFailure(r), r).toBe(false)
    }
  })

  it('does NOT drive retry off NormalizedMetaError.retriable', () => {
    // That flag is transport-retry semantics and is TRUE for timeouts; using it would resend
    // every indeterminate message. The job must never read it.
    expect(WA).not.toContain('r.retriable')
    expect(WA).not.toContain('.retriable')
  })
})

// ─── 3 · a success is never sent twice ───────────────────────────────────────

describe('retry can never cause a duplicate successful send', () => {
  it('both jobs still short-circuit on the sent marker before anything else', () => {
    expect(WA).toContain('if (item.sent) return { ok: true }')
    expect(EB).toContain('if (item.sent) return { ok: true }')
  })

  it('the retry loop breaks immediately on success', () => {
    expect(WA).toContain("if (r.success) { errorMsg = undefined; failureReason = undefined; break }")
    expect(EB).toContain('if (r.success) { errorMsg = undefined; break }')
  })

  it('no cursor rewind was introduced — the watermark still only moves forward', () => {
    for (const src of [WA, EB]) {
      expect(src).not.toContain('cursor: null')
      expect(src).not.toContain('startAt(')
      expect(src).not.toContain('resetCursor')
    }
    // fetchPage still pages strictly forward from the stored cursor.
    expect(WA).toContain('if (cursor) q = q.startAfter(cursor)')
    expect(EB).toContain('if (cursor) q = q.startAfter(cursor)')
  })

  it('email never retries a THROW — the one indeterminate email case', () => {
    expect(EB).toContain('indeterminate = true')
    expect(EB).toContain('if (indeterminate) break')
  })

  it('the shared notificationEngine is untouched: BROADCAST stays non-retrying there', () => {
    const engine = read('lib/notifications/engine.ts')
    expect(engine).toContain('const NON_RETRY_TYPES = new Set<NotificationType>([NotificationType.BROADCAST, NotificationType.CUSTOM_EMAIL])')
  })
})

// ─── 4-6 · the bound: within an invocation, and across resumes ───────────────

describe('retry attempts are bounded, and the bound survives a resume', () => {
  it('both channels cap total attempts at 3', () => {
    expect(WA).toContain('const WAB_MAX_ATTEMPTS = 3')
    expect(EB).toContain('const EB_MAX_ATTEMPTS = 3')
  })

  it('the in-loop bound is the REMAINING allowance, not a fresh one', () => {
    // `remaining = MAX - priorAttempts` is what makes a resume continue the budget instead of
    // restarting it. A fresh allowance per invocation is an unbounded loop.
    expect(WA).toContain('const remaining = WAB_MAX_ATTEMPTS - priorAttempts')
    expect(EB).toContain('const remaining = EB_MAX_ATTEMPTS - priorAttempts')
    for (const src of [WA, EB]) expect(src).toContain('priorAttempts')
  })

  it('a recipient at the cap is abandoned WITHOUT another send', () => {
    expect(WA).toContain('} else if (priorAttempts >= WAB_MAX_ATTEMPTS) {')
    expect(EB).toContain('if (priorAttempts >= EB_MAX_ATTEMPTS) {')
    // The exhausted branch sets an error and never reaches sendTemplate.
    const waBranch = WA.slice(WA.indexOf('priorAttempts >= WAB_MAX_ATTEMPTS'), WA.indexOf('const remaining = WAB_MAX_ATTEMPTS'))
    expect(waBranch).not.toContain('sendTemplate')
  })

  it('the running total is PERSISTED, which is what carries the bound across invocations', () => {
    expect(WA).toContain('attempts: priorAttempts + attemptsUsed')
    expect(EB).toContain('attempts: priorAttempts + attemptsUsed')
  })

  it('the loop is finite by construction — a bounded for, never while(true)', () => {
    for (const src of [WA, EB]) {
      expect(src).not.toContain('while (true)')
      expect(src).not.toContain('for (;;)')
    }
    expect(WA).toContain('for (let attempt = 1; attempt <= remaining; attempt++)')
    expect(EB).toContain('for (let attempt = 1; attempt <= remaining; attempt++)')
  })

  it('backoff is small enough to stay inside the budget/lease headroom', () => {
    // 250+750 = 1s worst case per WhatsApp recipient; 200+400 = 600ms for email. The gap
    // between budget (45s) and lease (60s) is 15s, so a full page of failures cannot push a
    // page past the lease and trigger fencing.
    expect(WA).toContain('const WAB_RETRY_BACKOFF_MS = [250, 750] as const')
    expect(EB).toContain('const EB_RETRY_BACKOFF_MS = [200, 400] as const')
    expect(WA).toContain('const WAB_MAX_ATTEMPTS = 3')
  })
})

// ─── 7 · one bad recipient cannot stall the broadcast ────────────────────────

describe('a failed recipient cannot block the broadcast forever', () => {
  it('a failure still returns a result — it never throws out of processItem', () => {
    // The runner counts failures per item and moves on; an escaping throw would abort the page.
    expect(WA).toContain('return { ok: false, error: errorMsg }')
    expect(EB).toContain('return { ok: false, error: errorMsg }')
  })

  it('the persistence write is best-effort and cannot abort the page', () => {
    for (const src of [WA, EB]) {
      const tail = src.slice(src.indexOf('attempts: priorAttempts + attemptsUsed'))
      expect(tail).toContain('catch (err)')
    }
  })

  it('the cursor still advances past a permanently failed recipient', () => {
    // nextCursor is the last document in the page regardless of per-item outcome, so a poison
    // recipient is left behind rather than re-fetched forever.
    expect(WA).toContain('nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor')
    expect(EB).toContain('nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor')
  })

  it('the final failure state is observable as a SYMBOL, not prose', () => {
    expect(WA).toContain('failureReason')
    expect(WA).toContain("failureReason = 'ATTEMPTS_EXHAUSTED'")
  })
})

// ─── 8 · D1/D2/D3 invariants untouched ───────────────────────────────────────

describe('the D1/D2/D3 invariants are untouched by this change', () => {
  it('D1 · one decision variable still controls release AND exit', () => {
    const runner = read('lib/jobs/runner.ts')
    expect(runner).toContain('const releaseLease = config.releaseLeaseOnHandoff === true && yieldingNow')
    expect(runner).toContain('if (yieldingNow) break')
    expect(runner.match(/Date\.now\(\) - startedAt >= config\.budgetMs/g) ?? []).toHaveLength(1)
  })

  it('D2 · an unleased commit is still fenced before any mutation', () => {
    const kernel = read('lib/jobs/kernel.ts')
    const zero  = kernel.indexOf('c.expectedLeaseTag === 0')
    const stale = kernel.indexOf('currentTag !== c.expectedLeaseTag')
    expect(zero).toBeGreaterThan(-1)
    expect(zero).toBeLessThan(stale)
  })

  it('the broadcast runners still opt into the hand-off, and no tunable moved', () => {
    for (const src of [WA, EB]) expect(src).toContain('releaseLeaseOnHandoff: true')
    expect(WA).toContain('const WAB_PAGE_SIZE = 5')
    expect(WA).toContain('const WAB_CONCURRENCY = 3')
    expect(WA).toContain('const WAB_BUDGET_MS = 45_000')
    expect(WA).toContain('const WAB_LEASE_MS  = 60_000')
    expect(EB).toContain('const EB_PAGE_SIZE = 2')
    expect(EB).toContain('const EB_BUDGET_MS = 45_000')
    expect(EB).toContain('const EB_LEASE_MS  = 60_000')
  })
})
