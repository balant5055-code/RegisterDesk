// RD-MEDIA-03 — upload failure classification.
//
// An upload can fail in ways that need completely different responses — retry, wait, fix
// configuration, remove the file — and they all used to read "Upload failed." These tests
// pin which message an organizer gets, and in particular which failures are worth retrying.

import { describe, it, expect } from 'vitest'
import {
  classifyUploadError, formatUploadFailure, hasRetryableFailure, summariseFailures,
} from '@/features/media-studio/utils/uploadErrors'

const kindOf = (message: string) => classifyUploadError(new Error(message)).kind

// ═══════════════ Classification ═══════════════

describe('classifyUploadError', () => {
  it('recognises a timeout, including the browser abort that produces one', () => {
    expect(kindOf('Upload timed out.')).toBe('timeout')
    expect(kindOf('The operation timeout was reached')).toBe('timeout')
    expect(kindOf('Upload aborted.')).toBe('timeout')
  })

  it('recognises an expired session', () => {
    expect(kindOf('Your session has expired. Please sign in again.')).toBe('auth')
    expect(kindOf('Upload failed (401). Please retry.')).toBe('auth')
  })

  it('recognises the storage-path failure this sprint fixed', () => {
    // `Invalid event slug for a storage path: "kochi-marathon-YYw3OU"` — retrying can never
    // help, and telling the organizer to keep trying would waste their afternoon.
    expect(kindOf('Invalid event slug for a storage path: "kochi-marathon-YYw3OU".')).toBe('storage_path')
    expect(kindOf('Unsafe storage key: "../escape"')).toBe('storage_path')
    expect(classifyUploadError(new Error('Invalid event slug')).retryable).toBe(false)
  })

  it('treats an unpublished event as a storage-path problem, because that is what it is', () => {
    expect(kindOf('Publish this event before uploading media — photos are stored under its public URL.'))
      .toBe('storage_path')
  })

  it('recognises unconfigured storage', () => {
    expect(kindOf('Media storage is not configured')).toBe('not_configured')
    expect(classifyUploadError(new Error('not configured')).retryable).toBe(false)
  })

  it('recognises a target deleted in another tab', () => {
    expect(kindOf('Gallery not found')).toBe('missing_target')
    expect(kindOf('Album not found in this gallery')).toBe('missing_target')
  })

  it('reads the HTTP status the browser layer formats as "(503)"', () => {
    // The status is wrapped in parentheses, so a space-anchored pattern would never fire.
    expect(kindOf('Upload failed (503). Please retry.')).toBe('provider')
    expect(kindOf('Upload failed (429). Please retry.')).toBe('provider')
    expect(kindOf('Upload failed (413). Please retry.')).toBe('file_rejected')
  })

  it('separates an expired signature from a rejected file', () => {
    expect(kindOf('Upload failed (403). Please retry.')).toBe('expired')
    expect(kindOf('Upload failed (400). Please retry.')).toBe('file_rejected')
  })

  it('recognises a dropped connection', () => {
    expect(kindOf('Failed to fetch')).toBe('network')
    expect(kindOf('Load failed')).toBe('network')
    expect(kindOf('NetworkError when attempting to fetch resource')).toBe('network')
  })

  it('falls back to unknown — and keeps it RETRYABLE', () => {
    // Telling an organizer not to bother retrying is worse than letting them try once more.
    const failure = classifyUploadError(new Error('something inexplicable'))
    expect(failure.kind).toBe('unknown')
    expect(failure.retryable).toBe(true)
  })

  it('never throws, whatever it is handed', () => {
    for (const v of [null, undefined, '', 42, {}, [], new Error('')]) {
      expect(() => classifyUploadError(v)).not.toThrow()
      expect(classifyUploadError(v).reason.length).toBeGreaterThan(0)
    }
  })

  it('is case-insensitive', () => {
    expect(kindOf('GALLERY NOT FOUND')).toBe('missing_target')
    expect(kindOf('Upload TIMED OUT')).toBe('timeout')
  })
})

// ═══════════════ Every failure is actionable ═══════════════

describe('every failure says what to do', () => {
  const MESSAGES = [
    'Upload timed out.', 'Your session has expired.', 'Invalid event slug',
    'not configured', 'Gallery not found', 'Upload failed (503).',
    'Upload failed (413).', 'Upload failed (403).', 'Failed to fetch', 'mystery',
  ]

  it('carries a reason AND an action, always', () => {
    for (const m of MESSAGES) {
      const f = classifyUploadError(new Error(m))
      expect(f.reason.trim().length, m).toBeGreaterThan(0)
      expect(f.action.trim().length, m).toBeGreaterThan(0)
      // The action is the half that tells the organizer what to do next.
      expect(f.action, m).not.toBe(f.reason)
    }
  })

  it('formats into one sentence pair', () => {
    const f = classifyUploadError(new Error('Upload timed out.'))
    expect(formatUploadFailure(f)).toBe(`${f.reason} ${f.action}`)
  })

  it('marks the permanent failures as not retryable', () => {
    for (const m of ['Invalid event slug', 'not configured', 'Gallery not found', 'Upload failed (413).']) {
      expect(classifyUploadError(new Error(m)).retryable, m).toBe(false)
    }
  })

  it('marks the transient ones as retryable', () => {
    for (const m of ['Upload timed out.', 'Upload failed (503).', 'Failed to fetch', 'Upload failed (403).']) {
      expect(classifyUploadError(new Error(m)).retryable, m).toBe(true)
    }
  })
})

// ═══════════════ Summarising a queue ═══════════════

describe('summariseFailures', () => {
  const failures = [
    classifyUploadError(new Error('Upload timed out.')),
    classifyUploadError(new Error('Upload timed out.')),
    classifyUploadError(new Error('Upload timed out.')),
    classifyUploadError(new Error('Gallery not found')),
  ]

  it('groups by cause and counts each', () => {
    const summary = summariseFailures(failures)
    expect(summary).toHaveLength(2)
    expect(summary[0].kind).toBe('timeout')
    expect(summary[0].count).toBe(3)
  })

  it('puts the most common cause first — that is the one worth acting on', () => {
    const summary = summariseFailures(failures)
    expect(summary.map(s => s.count)).toEqual([3, 1])
  })

  it('an empty queue summarises to nothing', () => {
    expect(summariseFailures([])).toEqual([])
    expect(hasRetryableFailure([])).toBe(false)
  })

  it('reports whether retrying could plausibly help', () => {
    expect(hasRetryableFailure(failures)).toBe(true)
    expect(hasRetryableFailure([classifyUploadError(new Error('Invalid event slug'))])).toBe(false)
  })
})
