// MC-10.5 · Classifying a credit shortfall. Pure — no DOM, no network.
//
// Before this, a 402 fell through every prose match to `unknown`, whose copy is "Retry. If it
// keeps happening, contact support." Both halves of that are wrong: retrying cannot succeed
// until credits are bought, and support cannot help. These tests pin the distinction.

import { describe, it, expect } from 'vitest'
import {
  UploadRequestError, classifyUploadError, hasRetryableFailure, summariseFailures,
} from '@/features/media-studio/utils/uploadErrors'

/** What `/uploads/prepare` actually returns on a credit shortfall. */
const shortfall402 = (required: number, available: number) =>
  new UploadRequestError(
    `Not enough credits: ${required} required, ${available} available.`,
    402,
    'INSUFFICIENT_CREDITS',
    { error: 'Not enough credits', code: 'INSUFFICIENT_CREDITS', required, available },
  )

describe('classifyUploadError — insufficient credits', () => {
  it('is its own kind, not unknown', () => {
    expect(classifyUploadError(shortfall402(100, 40)).kind).toBe('insufficient_credits')
  })

  it('is NOT retryable', () => {
    // The whole point. Retrying is guaranteed to fail until credits are bought.
    expect(classifyUploadError(shortfall402(100, 40)).retryable).toBe(false)
  })

  it('carries the numbers the organizer needs', () => {
    const f = classifyUploadError(shortfall402(100, 40))
    expect(f.credits).toEqual({ required: 100, available: 40, shortfall: 60 })
  })

  it('says what happened and what to do, without mentioning support', () => {
    const f = classifyUploadError(shortfall402(100, 40))
    expect(f.reason).toContain('Not enough Media Credits')
    expect(f.action.toLowerCase()).toContain('buy credits')
    expect(f.action.toLowerCase()).not.toContain('support')
  })

  it('never reports a negative shortfall', () => {
    // A 402 where available already covers required means the balance moved between the
    // server's check and its response. "Buy -5 credits" helps nobody.
    expect(classifyUploadError(shortfall402(40, 100)).credits?.shortfall).toBe(0)
  })

  it('treats missing or corrupt numbers as zero, never NaN', () => {
    const err = new UploadRequestError('nope', 402, 'INSUFFICIENT_CREDITS', {
      required: 'lots' as unknown as number, available: undefined,
    })
    const c = classifyUploadError(err).credits!
    expect(Number.isFinite(c.required)).toBe(true)
    expect(Number.isFinite(c.available)).toBe(true)
    expect(Number.isFinite(c.shortfall)).toBe(true)
  })

  it('is decided by the CODE, not by the status or the prose', () => {
    // A different 402 must not be mistaken for a credit shortfall, and a credit shortfall
    // must be recognised whatever sentence the server chose.
    const otherCode = new UploadRequestError('Payment required', 402, 'SOMETHING_ELSE', {})
    expect(classifyUploadError(otherCode).kind).not.toBe('insufficient_credits')

    const oddWording = new UploadRequestError('Wallet is short.', 402, 'INSUFFICIENT_CREDITS', {
      required: 5, available: 1,
    })
    expect(classifyUploadError(oddWording).kind).toBe('insufficient_credits')
  })

  it('a plain Error is still classified by prose — the old path is intact', () => {
    expect(classifyUploadError(new Error('failed to fetch')).kind).toBe('network')
    expect(classifyUploadError(new Error('Upload failed (503)')).kind).toBe('provider')
    expect(classifyUploadError(new Error('something odd')).kind).toBe('unknown')
  })

  it('a structured error with no credit code falls back to prose', () => {
    const err = new UploadRequestError('Upload failed (503)', 503, null, null)
    expect(classifyUploadError(err).kind).toBe('provider')
  })
})

describe('summariseFailures — the shortfall shown to the organizer', () => {
  it('keeps the WORST shortfall across the failed photos', () => {
    // Each photo reports the wallet as it stood when IT failed. The largest is the amount
    // that actually clears the queue — a smaller one would send them back to buy twice.
    const rows = summariseFailures([
      classifyUploadError(shortfall402(50, 40)),    // short by 10
      classifyUploadError(shortfall402(200, 40)),   // short by 160
      classifyUploadError(shortfall402(80, 40)),    // short by 40
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(3)
    expect(rows[0].credits?.shortfall).toBe(160)
  })

  it('groups credit failures separately from other causes', () => {
    const rows = summariseFailures([
      classifyUploadError(shortfall402(100, 0)),
      classifyUploadError(new Error('failed to fetch')),
      classifyUploadError(new Error('failed to fetch')),
    ])
    const kinds = rows.map(r => r.kind)
    expect(kinds).toContain('insufficient_credits')
    expect(kinds).toContain('network')
    // Most common first.
    expect(rows[0].kind).toBe('network')
  })

  it('other kinds carry no credit detail', () => {
    const [row] = summariseFailures([classifyUploadError(new Error('failed to fetch'))])
    expect(row.credits).toBeUndefined()
  })
})

describe('hasRetryableFailure', () => {
  it('is false when the only problem is credits', () => {
    // This is what hides the Retry button.
    expect(hasRetryableFailure([classifyUploadError(shortfall402(100, 0))])).toBe(false)
  })

  it('stays true when something genuinely retryable is also present', () => {
    expect(hasRetryableFailure([
      classifyUploadError(shortfall402(100, 0)),
      classifyUploadError(new Error('failed to fetch')),
    ])).toBe(true)
  })
})
