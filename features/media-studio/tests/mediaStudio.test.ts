// RD-MEDIA-01 · Media Studio — the pure core.
//
// Covers the brief's list where it can be covered honestly: upload queue, resume, retry,
// duplicate detection, compression profiles, metadata shape, pagination contract, delete
// semantics, replace semantics, gallery/album naming (the CRUD rules), and the estimate
// maths behind the upload preview.
//
// Firestore- and DOM-touching code is exercised by its types and by these invariants, not by
// integration tests. See "Not verified" in the report.

import { describe, it, expect } from 'vitest'
import {
  COMPRESSION_PROFILES, CUSTOM_LIMITS, DEFAULT_PROFILE_ID,
  buildCustomProfile, estimateBatch, estimateCompressedBytes, estimateStoredBytes,
  findProfile, resolveProfile,
} from '@/features/media-studio/utils/compressionProfiles'
import {
  MAX_CONCURRENT_UPLOADS, canTransition, countByState, isQueueSettled, isRetryable,
  isTerminal, nextState, queueProgressPercent, selectNextToStart,
  type UploadItemState,
} from '@/features/media-studio/utils/queueMachine'
import {
  applyResolution, scanForDuplicates, isDuplicateResolution,
  type DuplicateCandidate, type ExistingAssetRef,
} from '@/features/media-studio/utils/duplicates'
import {
  toSlug, uniqueSlug, validateDescription, validateName, isGalleryPreset, presetName,
} from '@/features/media-studio/utils/naming'
import { DEFAULT_MEDIA_SETTINGS, MEDIA_RENDITIONS } from '@/features/media-studio/types'

const MB = 1024 * 1024
const PLAN = { keepOriginal: true, generateMedium: true, generateThumbnail: true }

// ═══════════════════ Compression profiles ═══════════════════

describe('compression profiles', () => {
  it('offers exactly the three presets that remain, with Balanced recommended', () => {
    const ids = COMPRESSION_PROFILES.map(p => p.id)
    // RD-MS-CLEANUP-01 · 'original' and 'premium' were withdrawn. This assertion is the
    // guard that stops either reappearing by accident.
    expect(ids).toEqual(['balanced', 'web', 'ultra'])
    expect(COMPRESSION_PROFILES.find(p => p.recommended)?.id).toBe('balanced')
    expect(DEFAULT_PROFILE_ID).toBe('balanced')
  })

  // ── RD-MS-CLEANUP-01 · legacy ids keep working ────────────────────────────

  it("resolves a legacy original setting to Balanced instead of failing", () => {
    // Events configured before the profile was withdrawn still carry this id. Their
    // documents are read, never re-validated, so the fallback is the whole migration.
    expect(findProfile('original').id).toBe('balanced')
  })

  it("resolves a legacy premium setting to Balanced", () => {
    expect(findProfile('premium').id).toBe('balanced')
  })

  it('resolves ANY unknown id to the default — one fallback, not one per call site', () => {
    for (const id of ['', 'nope', 'ORIGINAL', 'legacy-preset']) {
      expect(findProfile(id).id).toBe('balanced')
    }
  })

  it('still returns the real profile for the three that remain', () => {
    for (const id of ['balanced', 'web', 'ultra']) {
      expect(findProfile(id).id).toBe(id)
    }
  })

  it('a custom profile is NOT swallowed by the fallback', () => {
    // The trap this fallback could have created: `custom` is resolved before findProfile is
    // reached, so an inline definition still wins and a missing one is still null.
    expect(resolveProfile('custom', null)).toBeNull()
  })
  it('orders star ratings so a higher rating never means a smaller target', () => {
    const rated = COMPRESSION_PROFILES.filter(p => p.targetBytes !== null)
    for (let i = 1; i < rated.length; i++) {
      if (rated[i].stars < rated[i - 1].stars) {
        expect(rated[i].targetBytes!).toBeLessThanOrEqual(rated[i - 1].targetBytes!)
      }
    }
  })

  it('leaves a null-target profile untouched', () => {
    // RD-MS-CLEANUP-01 · was the "Original" preset, which is no longer offered. A CUSTOM
    // profile can still carry a null target, so this arithmetic is still reachable and
    // still worth pinning.
    const built = buildCustomProfile({
      targetBytes: null, maxWidth: null, jpegQuality: 100, webpQuality: 100,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(estimateCompressedBytes(12 * MB, built.profile)).toBe(12 * MB)
  })

  it('never INFLATES a photo already smaller than the target', () => {
    const ultra = findProfile('ultra')!
    expect(estimateCompressedBytes(100 * 1024, ultra)).toBe(100 * 1024)
  })

  it('compresses a large photo down to the target', () => {
    const balanced = findProfile('balanced')!
    expect(estimateCompressedBytes(9 * MB, balanced)).toBe(balanced.targetBytes)
  })
})

describe('custom profile', () => {
  const valid = { targetBytes: 2 * MB, maxWidth: 3000, jpegQuality: 85, webpQuality: 80 }

  it('accepts sane settings', () => {
    const out = buildCustomProfile(valid)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.profile.id).toBe('custom')
  })

  it('rejects a target size outside the documented bounds', () => {
    expect(buildCustomProfile({ ...valid, targetBytes: 1024 }).ok).toBe(false)
    expect(buildCustomProfile({ ...valid, targetBytes: 500 * MB }).ok).toBe(false)
  })

  it('rejects an implausible width', () => {
    expect(buildCustomProfile({ ...valid, maxWidth: 10 }).ok).toBe(false)
    expect(buildCustomProfile({ ...valid, maxWidth: 99999 }).ok).toBe(false)
  })

  it('rejects a quality outside 40–100 rather than silently clamping', () => {
    expect(buildCustomProfile({ ...valid, jpegQuality: 5 }).ok).toBe(false)
    expect(buildCustomProfile({ ...valid, webpQuality: 200 }).ok).toBe(false)
    expect(buildCustomProfile({ ...valid, jpegQuality: CUSTOM_LIMITS.minQuality }).ok).toBe(true)
  })

  it('allows a null target (resize only)', () => {
    expect(buildCustomProfile({ ...valid, targetBytes: null }).ok).toBe(true)
  })

  it('resolveProfile handles both presets and inline custom', () => {
    expect(resolveProfile('web')?.id).toBe('web')
    expect(resolveProfile('custom', valid)?.id).toBe('custom')
    expect(resolveProfile('custom', null)).toBeNull()      // custom needs a definition
    // RD-MS-CLEANUP-01 · an unknown id now resolves to the default rather than null, so a
    // legacy `original` / `premium` setting keeps working. `custom` without a definition
    // is still null — that branch is handled before findProfile is reached.
    expect(resolveProfile('nope')?.id).toBe('balanced')
  })
})

describe('upload preview estimates', () => {
  it('accounts for every rendition that will be stored', () => {
    const balanced = findProfile('balanced')!
    const withAll  = estimateStoredBytes(9 * MB, balanced, PLAN)
    const onlyOrig = estimateStoredBytes(9 * MB, balanced, {
      keepOriginal: true, generateMedium: false, generateThumbnail: false,
    })
    expect(withAll).toBeGreaterThan(onlyOrig)
  })

  it('never reports zero stored bytes, even for a plan that keeps nothing', () => {
    const balanced = findProfile('balanced')!
    expect(estimateStoredBytes(5 * MB, balanced, {
      keepOriginal: false, generateMedium: false, generateThumbnail: false,
    })).toBeGreaterThan(0)
  })

  it('reports a real saving for a batch of large photos', () => {
    const sizes = Array.from({ length: 100 }, () => 8 * MB)
    const out = estimateBatch(sizes, findProfile('balanced')!, PLAN)
    expect(out.photoCount).toBe(100)
    expect(out.currentBytes).toBe(800 * MB)
    expect(out.savedBytes).toBeGreaterThan(0)
    expect(out.savingsPercent).toBeGreaterThan(0)
    expect(out.savingsPercent).toBeLessThanOrEqual(100)
  })

  it('reports NO saving when nothing is compressed — an honest zero', () => {
    // RD-MS-CLEANUP-01 · was the "Original" preset; a custom null-target profile is the
    // remaining way to ask for no compression.
    const built = buildCustomProfile({
      targetBytes: null, maxWidth: null, jpegQuality: 100, webpQuality: 100,
    })
    if (!built.ok) throw new Error('custom profile rejected')
    const out = estimateBatch([5 * MB, 5 * MB], built.profile, {
      keepOriginal: true, generateMedium: false, generateThumbnail: false,
    })
    expect(out.savedBytes).toBe(0)
    expect(out.savingsPercent).toBe(0)
  })

  it('estimates upload time from the bytes actually sent', () => {
    const out = estimateBatch([10 * MB], findProfile('web')!, PLAN, 1_000_000)
    expect(out.estimatedSeconds).toBeGreaterThan(0)
    expect(out.estimatedSeconds).toBe(Math.ceil(out.estimatedBytes / 1_000_000))
  })

  it('handles an empty selection without dividing by zero', () => {
    const out = estimateBatch([], findProfile('balanced')!, PLAN)
    expect(out).toMatchObject({ photoCount: 0, currentBytes: 0, savingsPercent: 0 })
  })
})

// ═══════════════════ Upload queue ═══════════════════

describe('upload queue state machine', () => {
  it('runs the happy path', () => {
    expect(nextState('queued', 'start')).toBe('uploading')
    expect(nextState('uploading', 'beginProcessing')).toBe('processing')
    expect(nextState('processing', 'succeed')).toBe('completed')
  })

  it('supports pause and resume', () => {
    expect(nextState('queued', 'pause')).toBe('paused')
    expect(nextState('uploading', 'pause')).toBe('paused')
    expect(nextState('paused', 'resume')).toBe('queued')
  })

  it('supports retry from failed', () => {
    expect(nextState('uploading', 'fail')).toBe('failed')
    expect(nextState('failed', 'retry')).toBe('queued')
    expect(isRetryable('failed')).toBe(true)
  })

  it('supports cancel from every non-terminal state', () => {
    for (const s of ['queued', 'uploading', 'processing', 'failed', 'paused', 'duplicate'] as UploadItemState[]) {
      expect(nextState(s, 'cancel')).toBe('cancelled')
    }
  })

  it('treats completed and cancelled as terminal', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    for (const action of ['start', 'retry', 'resume', 'cancel'] as const) {
      expect(canTransition('completed', action)).toBe(false)
      expect(canTransition('cancelled', action)).toBe(false)
    }
  })

  it('refuses to retry a CANCELLED item — cancelling is a human decision', () => {
    expect(nextState('cancelled', 'retry')).toBeNull()
    expect(isRetryable('cancelled')).toBe(false)
  })

  it('refuses an illegal transition rather than guessing', () => {
    expect(nextState('queued', 'succeed')).toBeNull()
    expect(nextState('paused', 'start')).toBeNull()
    expect(nextState('processing', 'pause')).toBeNull()
  })

  it('routes a duplicate through the organizer decision', () => {
    expect(nextState('queued', 'markDuplicate')).toBe('duplicate')
    expect(nextState('duplicate', 'resolveDuplicate')).toBe('queued')
  })
})

describe('queue scheduling', () => {
  it('respects the concurrency cap', () => {
    const states: UploadItemState[] = Array(10).fill('queued')
    expect(selectNextToStart(states)).toHaveLength(MAX_CONCURRENT_UPLOADS)
  })

  it('counts in-flight work against the cap', () => {
    const states: UploadItemState[] = ['uploading', 'processing', 'queued', 'queued', 'queued']
    expect(selectNextToStart(states, 4)).toHaveLength(2)
  })

  it('starts nothing when the cap is full', () => {
    const states: UploadItemState[] = ['uploading', 'uploading', 'uploading', 'uploading', 'queued']
    expect(selectNextToStart(states, 4)).toEqual([])
  })

  it('never starts a paused, failed or duplicate item', () => {
    const states: UploadItemState[] = ['paused', 'failed', 'duplicate', 'cancelled', 'completed']
    expect(selectNextToStart(states)).toEqual([])
  })

  it('counts every state', () => {
    const counts = countByState(['queued', 'queued', 'uploading', 'completed', 'failed'])
    expect(counts).toMatchObject({ total: 5, queued: 2, uploading: 1, completed: 1, failed: 1 })
  })

  it('reports progress excluding cancelled work', () => {
    expect(queueProgressPercent(['completed', 'completed', 'queued', 'queued'])).toBe(50)
    expect(queueProgressPercent(['completed', 'cancelled'])).toBe(100)
    expect(queueProgressPercent([])).toBe(100)
  })

  it('settles only when nothing can still progress', () => {
    expect(isQueueSettled(['completed', 'failed', 'paused'])).toBe(true)
    expect(isQueueSettled(['completed', 'queued'])).toBe(false)
    expect(isQueueSettled(['uploading'])).toBe(false)
  })
})

// ═══════════════════ Duplicate detection ═══════════════════

const sum = (n: number) => String(n).padStart(64, '0')

describe('duplicate detection', () => {
  const existing: ExistingAssetRef[] = [
    { assetId: 'med_1', checksum: sum(1), galleryId: 'gal_1', albumId: null,
      originalFilename: 'IMG_0001.jpg', uploadedAtMs: 1_700_000_000_000 },
  ]

  it('matches an already-stored photo by checksum', () => {
    const out = scanForDuplicates([{ itemId: 'i1', checksum: sum(1) }], existing)
    expect(out.matches).toHaveLength(1)
    expect(out.matches[0].existing.assetId).toBe('med_1')
    expect(out.fresh).toHaveLength(0)
  })

  it('passes a new photo through as fresh', () => {
    const out = scanForDuplicates([{ itemId: 'i2', checksum: sum(2) }], existing)
    expect(out.fresh).toHaveLength(1)
    expect(out.matches).toHaveLength(0)
  })

  it('catches duplicates WITHIN one batch — the classic bulk-upload bug', () => {
    const candidates: DuplicateCandidate[] = [
      { itemId: 'a', checksum: sum(9) },
      { itemId: 'b', checksum: sum(9) },
      { itemId: 'c', checksum: sum(9) },
    ]
    const out = scanForDuplicates(candidates, [])
    expect(out.fresh.map(f => f.itemId)).toEqual(['a'])     // first wins
    expect(out.intraBatch.map(d => d.itemId)).toEqual(['b', 'c'])
  })

  it('scales to a large batch without losing anything', () => {
    const candidates = Array.from({ length: 5000 }, (_, i) => ({ itemId: `i${i}`, checksum: sum(i) }))
    const out = scanForDuplicates(candidates, existing)
    expect(out.matches.length + out.fresh.length + out.intraBatch.length).toBe(5000)
  })

  it('ignores filenames entirely — two cameras writing DSC_0001 are two photos', () => {
    const out = scanForDuplicates(
      [{ itemId: 'x', checksum: sum(11) }, { itemId: 'y', checksum: sum(12) }], [],
    )
    expect(out.fresh).toHaveLength(2)
  })
})

describe('duplicate resolutions', () => {
  const match = {
    itemId: 'i1', checksum: sum(1),
    existing: {
      assetId: 'med_1', checksum: sum(1), galleryId: 'gal_1', albumId: null,
      originalFilename: 'IMG_0001.jpg', uploadedAtMs: 1_700_000_000_000,
    },
  }

  it('skip uploads nothing', () => {
    expect(applyResolution(match, 'skip')).toEqual({ upload: false, replaceAssetId: null })
  })

  it('replace re-uploads onto the SAME record, so links stay valid', () => {
    expect(applyResolution(match, 'replace')).toEqual({ upload: true, replaceAssetId: 'med_1' })
  })

  it('keep-both creates a second record with the same checksum', () => {
    expect(applyResolution(match, 'keep-both')).toEqual({ upload: true, replaceAssetId: null })
  })

  it('validates the resolution value', () => {
    expect(isDuplicateResolution('skip')).toBe(true)
    expect(isDuplicateResolution('merge')).toBe(false)
  })
})

// ═══════════════════ Gallery + album naming (CRUD rules) ═══════════════════

describe('gallery preset keys (RD-MEDIA-02)', () => {
  it('accepts any safe suggestion key — the valid set now depends on the event', () => {
    // Membership is no longer fixed: suggestions come from the event's template, so this is
    // a SHAPE check. It must still refuse anything hostile.
    expect(isGalleryPreset('21km')).toBe(true)
    expect(isGalleryPreset('keynote')).toBe(true)
    expect(isGalleryPreset('main-stage')).toBe(true)
    expect(isGalleryPreset('custom')).toBe(true)

    expect(isGalleryPreset('')).toBe(false)
    expect(isGalleryPreset('../escape')).toBe(false)
    expect(isGalleryPreset('Has Spaces')).toBe(false)
    expect(isGalleryPreset('x'.repeat(60))).toBe(false)
    expect(isGalleryPreset(42)).toBe(false)
  })

  it('labels a key from ANY template, so a stored gallery keeps its name', () => {
    expect(presetName('finish-line')).toBe('Finish Line')   // marathon
    expect(presetName('keynote')).toBe('Keynote')           // conference
    expect(presetName('main-stage')).toBe('Main Stage')     // music festival
    expect(presetName('unknown-key')).toBe('Custom')        // graceful fallback
  })
})

describe('naming rules', () => {
  it('slugifies a display name', () => {
    expect(toSlug('21 KM', 'x')).toBe('21-km')
    expect(toSlug('Camera 1', 'x')).toBe('camera-1')
    expect(toSlug('  Medal   Ceremony  ', 'x')).toBe('medal-ceremony')
  })

  it('falls back when a name has no usable characters', () => {
    expect(toSlug('!!!', 'fallback')).toBe('fallback')
    expect(toSlug('', 'fallback')).toBe('fallback')
  })

  it('makes a slug unique instead of colliding', () => {
    const taken = new Set(['camera-1', 'camera-1-2'])
    expect(uniqueSlug('camera-1', taken)).toBe('camera-1-3')
    expect(uniqueSlug('camera-2', taken)).toBe('camera-2')
  })

  it('requires a name and bounds its length', () => {
    expect(validateName('', 'Gallery name').ok).toBe(false)
    expect(validateName('   ', 'Gallery name').ok).toBe(false)
    expect(validateName('x'.repeat(200), 'Gallery name').ok).toBe(false)
    const ok = validateName('  Finish   Line ', 'Gallery name')
    expect(ok.ok && ok.value).toBe('Finish Line')      // whitespace collapsed
  })

  it('treats an absent description as valid and empty', () => {
    expect(validateDescription(undefined)).toEqual({ ok: true, value: '' })
    expect(validateDescription('x'.repeat(500)).ok).toBe(false)
  })
})

// ═══════════════════ Metadata + settings ═══════════════════

describe('metadata + settings contracts', () => {
  it('declares exactly three renditions', () => {
    expect(MEDIA_RENDITIONS).toEqual(['original', 'medium', 'thumbnail'])
  })

  it('defaults keep the original and generate both derivatives', () => {
    expect(DEFAULT_MEDIA_SETTINGS).toMatchObject({
      defaultProfileId: 'balanced',
      keepOriginal: true, generateMedium: true, generateThumbnail: true,
    })
  })

  it('defaults to a visibility the platform storage layer permits for photos', () => {
    expect(['PUBLIC', 'SIGNED_URL']).toContain(DEFAULT_MEDIA_SETTINGS.defaultVisibility)
  })
})

// ═══════════════════ Pagination contract ═══════════════════

describe('pagination contract', () => {
  /** Mirrors assetRepo.listAssets: a SHORT page means the end. */
  const nextCursor = (returned: number, limit: number, lastId: string | null) =>
    returned === limit ? lastId : null

  it('returns a cursor only when the page was full', () => {
    expect(nextCursor(60, 60, 'med_x')).toBe('med_x')
    expect(nextCursor(59, 60, 'med_x')).toBeNull()
    expect(nextCursor(0, 60, null)).toBeNull()
  })

  it('the cursor is a document id, not an offset', () => {
    expect(typeof nextCursor(60, 60, 'med_x')).toBe('string')
  })
})
