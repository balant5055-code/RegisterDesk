// MC-08.2 · Purchase flow decisions. Pure — no React, no gateway, no network.
//
// These assert the outcomes that cost money if they are wrong. The 202 case is the one worth
// reading twice: money captured, credits not yet granted. Anything that reports that as a
// failure invites a second payment for credits already bought.

import { describe, it, expect } from 'vitest'
import {
  MAX_CREDITS_PER_PURCHASE, canRetry, canSubmit, cancelledView, classifyIntentFailure,
  classifyVerifyResponse, gatewayUnavailableView, isBusy, shouldRefetch,
  type PurchasePhase,
} from '@/features/media-credits/utils/purchaseFlow'

const ALL: PurchasePhase[] =
  ['idle', 'creating', 'paying', 'verifying', 'granted', 'pending', 'failed']

describe('classifyVerifyResponse — the money-critical branch', () => {
  it('202 is PENDING, never failed', () => {
    // The payment succeeded and the grant did not. Calling this "failed" is how a double
    // charge happens.
    const v = classifyVerifyResponse(202, { success: false, pending: true })
    expect(v.phase).toBe('pending')
    expect(v.tone).not.toBe('danger')
  })

  it('a pending body is honoured even on an unexpected status', () => {
    // The server is authoritative about `pending`, not the HTTP code.
    expect(classifyVerifyResponse(200, { pending: true }).phase).toBe('pending')
    expect(classifyVerifyResponse(500, { pending: true }).phase).toBe('pending')
  })

  it('the pending message explicitly tells the organizer NOT to pay again', () => {
    const v = classifyVerifyResponse(202, { pending: true })
    expect(v.message.toLowerCase()).toContain('do not pay again')
  })

  it('200 + success grants', () => {
    const v = classifyVerifyResponse(200, { success: true })
    expect(v.phase).toBe('granted')
    expect(v.tone).toBe('success')
  })

  it('200 WITHOUT success is not a grant', () => {
    // A 2xx alone is not evidence of a grant — only the explicit flag is.
    expect(classifyVerifyResponse(200, { success: false }).phase).toBe('failed')
    expect(classifyVerifyResponse(200, null).phase).toBe('failed')
  })

  it('a rejected payment fails, preferring the server wording', () => {
    const v = classifyVerifyResponse(400, { error: 'Credits are disabled for this account.' })
    expect(v.phase).toBe('failed')
    expect(v.message).toBe('Credits are disabled for this account.')
  })

  it('falls back to safe copy when the server says nothing', () => {
    const v = classifyVerifyResponse(400, null)
    expect(v.phase).toBe('failed')
    expect(v.message.length).toBeGreaterThan(0)
  })
})

describe('classifyIntentFailure — nothing has been charged yet', () => {
  it('429 reads as a rate limit, not a payment problem', () => {
    const v = classifyIntentFailure(429)
    expect(v.phase).toBe('failed')
    expect(v.tone).toBe('warning')          // not danger: nothing broke
    expect(v.title.toLowerCase()).toContain('too many')
  })

  it('403 reads as a permission problem', () => {
    expect(classifyIntentFailure(403).title.toLowerCase()).toContain('unavailable')
  })

  it('a network failure (status 0) still produces a usable message', () => {
    const v = classifyIntentFailure(0)
    expect(v.phase).toBe('failed')
    expect(v.message).toContain('before any payment was taken')
  })

  it('every intent failure is retryable — no money moved', () => {
    for (const status of [0, 400, 403, 429, 500, 503]) {
      expect(canRetry(classifyIntentFailure(status).phase)).toBe(true)
    }
  })
})

describe('cancelling is not an error', () => {
  it('returns to idle with neutral tone', () => {
    const v = cancelledView()
    expect(v.phase).toBe('idle')
    expect(v.tone).toBe('neutral')
  })

  it('says no payment was taken', () => {
    expect(cancelledView().message.toLowerCase()).toContain('no payment was taken')
  })

  it('leaves the purchase submittable again', () => {
    expect(canSubmit(cancelledView().phase, 500)).toBe(true)
  })
})

describe('gateway unavailable', () => {
  it('is a failure, and retryable — the modal never opened', () => {
    const v = gatewayUnavailableView('offline')
    expect(v.phase).toBe('failed')
    expect(canRetry(v.phase)).toBe(true)
  })
})

describe('isBusy', () => {
  it('covers exactly the three in-flight phases', () => {
    expect(ALL.filter(isBusy)).toEqual(['creating', 'paying', 'verifying'])
  })
})

describe('shouldRefetch', () => {
  it('refreshes after a grant', () => {
    expect(shouldRefetch('granted')).toBe(true)
  })

  it('refreshes after a DEFERRED grant too', () => {
    // Reconciliation may land the credits at any moment; refusing to re-read would leave a
    // stale balance on screen long after they arrived.
    expect(shouldRefetch('pending')).toBe(true)
  })

  it('does not refresh on any phase where the wallet cannot have moved', () => {
    for (const p of ['idle', 'creating', 'paying', 'verifying', 'failed'] as PurchasePhase[]) {
      expect(shouldRefetch(p)).toBe(false)
    }
  })
})

describe('canRetry', () => {
  it('is never offered once money has been taken', () => {
    expect(canRetry('granted')).toBe(false)
    expect(canRetry('pending')).toBe(false)
  })

  it('is never offered mid-flight', () => {
    expect(canRetry('creating')).toBe(false)
    expect(canRetry('paying')).toBe(false)
    expect(canRetry('verifying')).toBe(false)
  })
})

describe('canSubmit', () => {
  it('allows a sane quantity from a resting phase', () => {
    expect(canSubmit('idle', 500)).toBe(true)
    expect(canSubmit('failed', 500)).toBe(true)
  })

  it('blocks every non-resting phase — this is the double-click guard', () => {
    for (const p of ['creating', 'paying', 'verifying', 'granted', 'pending'] as PurchasePhase[]) {
      expect(canSubmit(p, 500)).toBe(false)
    }
  })

  it('rejects quantities the server would reject anyway', () => {
    expect(canSubmit('idle', 0)).toBe(false)
    expect(canSubmit('idle', -1)).toBe(false)
    expect(canSubmit('idle', 1.5)).toBe(false)
    expect(canSubmit('idle', NaN)).toBe(false)
    expect(canSubmit('idle', Infinity)).toBe(false)
    expect(canSubmit('idle', MAX_CREDITS_PER_PURCHASE + 1)).toBe(false)
  })

  it('allows exactly the server ceiling', () => {
    expect(canSubmit('idle', MAX_CREDITS_PER_PURCHASE)).toBe(true)
  })
})
