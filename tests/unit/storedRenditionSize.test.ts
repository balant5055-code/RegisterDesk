// RD-MEDIA-SIZE-01 — the pure verdict /uploads/complete applies to each stored rendition.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { storedRenditionSizeError } from '@/features/media-studio/services/uploadService'
import { maxBytesFor } from '@/features/platform-storage'

describe('storedRenditionSizeError', () => {
  it('accepts an object of exactly the declared size within the ceiling', () => {
    expect(storedRenditionSizeError('original', 1_000, 1_000)).toBeNull()
    expect(storedRenditionSizeError('thumbnail', 5_000, 5_000)).toBeNull()
  })

  it('refuses any difference from the declared size', () => {
    expect(storedRenditionSizeError('original', 1_001, 1_000)).toMatch(/does not match/)
    expect(storedRenditionSizeError('original', 999, 1_000)).toMatch(/does not match/)
  })

  it('refuses above the platform ceiling for the rendition type, even with no declaration (legacy 0)', () => {
    const max = maxBytesFor('event-photo-original')
    expect(storedRenditionSizeError('original', max, 0)).toBeNull()
    expect(storedRenditionSizeError('original', max + 1, 0)).toMatch(/larger than allowed/)
    expect(storedRenditionSizeError('thumbnail', maxBytesFor('event-photo-thumbnail') + 1, 0)).toMatch(/larger than allowed/)
  })

  it('refuses empty / unreadable sizes and unknown renditions', () => {
    expect(storedRenditionSizeError('original', 0, 0)).toMatch(/empty/)
    expect(storedRenditionSizeError('original', Number.NaN, 0)).toMatch(/empty/)
    expect(storedRenditionSizeError('poster' as never, 10, 10)).toMatch(/Unknown rendition/)
  })
})
