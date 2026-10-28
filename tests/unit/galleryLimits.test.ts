// RD-GALLERY-01 — event gallery: at most 6 UPLOADED images and at most 20 added BY URL, counted
// separately; uploads compressed (≤ 1920 px, WebP when supported, ~200–400 KB, never > 1 MB).
// Pure rules + compression decisions + source contracts here; the draft-save route on real
// Firestore: tests/emulator/galleryLimits.emu.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GALLERY_UPLOAD_MAX, GALLERY_URL_MAX, GALLERY_COMPRESSION,
  countGallery, galleryOrigin, galleryProblem, galleryChangeProblem, galleryOf, isPlatformStorageUrl, platformStorageHosts,
} from '@/lib/events/galleryLimits'
import { compressToBudget, GalleryCompressionError } from '@/lib/media/galleryCompression'
import { buildLiveContentSync } from '@/lib/events/editing/liveContentSync'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const FB = (n: number) => `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/event-assets%2Fu%2Fd%2Fgallery%2Fg${n}.webp?alt=media`
const up  = (n: number) => ({ source: 'url', value: FB(n), origin: 'upload' })
const url = (n: number) => ({ source: 'url', value: `https://images.example.com/p${n}.jpg`, origin: 'url' })
const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

afterEach(() => { vi.unstubAllEnvs() })

describe('RD-GALLERY-01 · limits and counting', () => {
  it('6 uploads and 20 URL images — separate limits', () => {
    expect(GALLERY_UPLOAD_MAX).toBe(6)
    expect(GALLERY_URL_MAX).toBe(20)
  })
  it('classifies uploads by marker, data URL or platform storage address; links otherwise; empty ignored', () => {
    expect(galleryOrigin(up(1))).toBe('upload')
    expect(galleryOrigin({ source: 'upload', value: 'data:image/webp;base64,AAAA' })).toBe('upload')
    expect(galleryOrigin(url(1))).toBe('url')
    expect(galleryOrigin({ source: 'url', value: '   ' })).toBeNull()
    expect(countGallery([up(1), url(1), { value: '' }, null, 'x'])).toEqual({ uploads: 1, urls: 1 })
  })
  it('a forged "url" marker on an image in platform storage still counts as an upload', () => {
    expect(galleryOrigin({ source: 'url', value: FB(9), origin: 'url' })).toBe('upload')
    expect(galleryOrigin({ source: 'url', value: 'https://storage.googleapis.com/demo/x.jpg' })).toBe('upload')
  })
  it('the R2 public host (server R2_PUBLIC_URL or browser NEXT_PUBLIC_R2_PUBLIC_HOST) is platform storage', () => {
    vi.stubEnv('R2_PUBLIC_URL', 'https://assets.registerdesk.in')
    expect(isPlatformStorageUrl('https://assets.registerdesk.in/event-gallery/a.webp')).toBe(true)
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_R2_PUBLIC_HOST', 'cdn.example.r2.dev')
    expect(platformStorageHosts()).toContain('cdn.example.r2.dev')
    expect(isPlatformStorageUrl('https://other.example.com/a.webp')).toBe(false)
  })
  it('legacy entries without a marker: an uploaded image (storage URL) counts as upload, a link as URL', () => {
    expect(countGallery([{ source: 'url', value: FB(1) }, { source: 'url', value: 'https://x.test/a.png' }])).toEqual({ uploads: 1, urls: 1 })
  })
  it('galleryOf reads eventDetails.media.galleryImages, tolerating absence', () => {
    expect(galleryOf({ media: { galleryImages: [up(1)] } })).toHaveLength(1)
    expect(galleryOf(null)).toEqual([])
    expect(galleryOf({ media: { galleryImages: 'nope' } })).toEqual([])
  })
})

describe('RD-GALLERY-01 · strict rule (a new event / first publish)', () => {
  it('6 uploads OK; the 7th refused', () => {
    expect(galleryProblem(many(6, up))).toBeNull()
    expect(galleryProblem(many(7, up))).toMatch(/up to 6 uploaded images \(this event has 7\)/)
  })
  it('20 URL images OK; the 21st refused — URLs never inherit the upload limit', () => {
    expect(galleryProblem(many(20, url))).toBeNull()
    expect(galleryProblem(many(10, url))).toBeNull()              // >6 links is fine
    expect(galleryProblem(many(21, url))).toMatch(/up to 20 images added by URL/)
  })
  it('mixed galleries: 6 uploads + 20 links is the most allowed; uploads never borrow URL slots', () => {
    expect(galleryProblem([...many(6, up), ...many(20, url)])).toBeNull()
    expect(galleryProblem([...many(7, up), ...many(0, url)])).not.toBeNull()
    expect(galleryProblem([...many(6, up), ...many(21, url)])).not.toBeNull()
  })
})

describe('RD-GALLERY-01 · growth-only rule (existing galleries are preserved)', () => {
  const legacy = many(10, up)                                     // saved under the old 20 limit
  it('an existing over-limit gallery can be saved unchanged, reordered or trimmed', () => {
    expect(galleryChangeProblem(legacy, legacy)).toBeNull()
    expect(galleryChangeProblem(legacy, [...legacy].reverse())).toBeNull()
    expect(galleryChangeProblem(legacy, legacy.slice(0, 8))).toBeNull()
    expect(galleryChangeProblem(legacy, [...legacy, ...many(5, url)])).toBeNull()   // links still allowed
  })
  it('but may not grow while it is over', () => {
    expect(galleryChangeProblem(legacy, [...legacy, up(99)])).toMatch(/this event has 11/)
  })
  it('a within-limit gallery may grow only up to the limit', () => {
    expect(galleryChangeProblem(many(5, up), many(6, up))).toBeNull()
    expect(galleryChangeProblem(many(6, up), many(7, up))).not.toBeNull()
    expect(galleryChangeProblem(many(20, url), many(21, url))).not.toBeNull()
  })
  it('a duplicate submission of the same gallery is a no-op, never a refusal', () => {
    const g = [...many(6, up), ...many(3, url)]
    expect(galleryChangeProblem(g, g)).toBeNull()
  })
})

describe('RD-GALLERY-01 · compression decisions (fake encoders)', () => {
  const OPTS = { type: 'image/webp', maxDimension: GALLERY_COMPRESSION.maxDimension, targetBytes: GALLERY_COMPRESSION.targetBytes, maxBytes: GALLERY_COMPRESSION.maxBytes }
  it('targets: 1920 px, ~400 KB, never above 1 MB; originals still limited to 5 MB PNG/JPG/WEBP', () => {
    expect(GALLERY_COMPRESSION).toMatchObject({ maxDimension: 1920, targetBytes: 400 * 1024, maxBytes: 1024 * 1024, originalMaxBytes: 5 * 1024 * 1024 })
    expect(GALLERY_COMPRESSION.acceptedTypes).toEqual(['image/png', 'image/jpeg', 'image/webp'])
  })
  it('resizes the longest side to 1920, keeps the aspect ratio, never upscales', async () => {
    const enc = vi.fn(async (w: number, h: number) => ({ size: 300_000, type: 'image/webp', w, h }))
    const big = await compressToBudget({ w: 4000, h: 3000 }, enc, OPTS)
    expect([big.w, big.h]).toEqual([1920, 1440])
    const small = await compressToBudget({ w: 800, h: 600 }, enc, OPTS)
    expect([small.w, small.h]).toEqual([800, 600])
  })
  it('steps quality down until within the ~400 KB target', async () => {
    const sizes = [900_000, 700_000, 380_000]
    let i = 0
    const out = await compressToBudget({ w: 1920, h: 1080 }, async () => ({ size: sizes[i++] ?? 1, type: 'image/webp' }), OPTS)
    expect(out.result.size).toBe(380_000)
    expect(out.quality).toBeCloseTo(0.74)
  })
  it('shrinks further when quality alone cannot get under 1 MB', async () => {
    const out = await compressToBudget({ w: 4000, h: 4000 }, async w => ({ size: w >= 1920 ? 2_000_000 : 500_000, type: 'image/webp' }), OPTS)
    expect(out.w).toBeLessThan(1920)
    expect(out.result.size).toBeLessThanOrEqual(GALLERY_COMPRESSION.maxBytes)
  })
  it('compression failures THROW — never a silent oversized original', async () => {
    await expect(compressToBudget({ w: 3000, h: 2000 }, async () => ({ size: 5_000_000, type: 'image/webp' }), OPTS)).rejects.toBeInstanceOf(GalleryCompressionError)
    await expect(compressToBudget({ w: 3000, h: 2000 }, async () => null, OPTS)).rejects.toThrow('could not compress')
    await expect(compressToBudget({ w: 3000, h: 2000 }, async () => ({ size: 10, type: 'image/png' }), OPTS)).rejects.toThrow('could not compress')
    await expect(compressToBudget({ w: 0, h: 0 }, async () => ({ size: 10, type: 'image/webp' }), OPTS)).rejects.toThrow('could not be read')
  })
})

describe('RD-GALLERY-01 · resubmit / republish copy (buildLiveContentSync)', () => {
  const live = (g: unknown[]) => ({ eventType: 'conference', eventDetails: { media: { galleryImages: g } }, pricing: {} })
  // buildLiveContentSync(draft, live, …): the DRAFT is what gets copied onto the live event.
  it('refuses a copy that grows the live gallery past a limit; allows unchanged / trimmed', () => {
    expect(buildLiveContentSync(live(many(7, up)), live(many(6, up)), 'e-slug', {})).toMatchObject({ ok: false, status: 422 })
    expect(buildLiveContentSync(live(many(10, up)), live(many(9, up)), 'e-slug', {})).toMatchObject({ ok: false, status: 422 })
    expect(buildLiveContentSync(live(many(9, up)), live(many(10, up)), 'e-slug', {}).ok).toBe(true)
    expect(buildLiveContentSync(live(many(20, url)), live(many(20, url)), 'e-slug', {}).ok).toBe(true)
  })
})

describe('RD-GALLERY-01 · wiring (source contracts)', () => {
  const UI = read('components/wizard/BrandingMediaSection.tsx')
  it('the gallery UI counts and limits uploads and URLs separately', () => {
    expect(UI).toContain('const counts           = countGallery(images)')
    expect(UI).toContain('GALLERY_UPLOAD_MAX - counts.uploads')
    expect(UI).toContain('GALLERY_URL_MAX - counts.urls')
    expect(UI).toContain('const accepted = files.slice(0, remainingUploads)')
    expect(UI).toContain('{counts.uploads} / {GALLERY_UPLOAD_MAX} uploaded · {counts.urls} / {GALLERY_URL_MAX} by URL')
    expect(UI).not.toMatch(/GALLERY_MAX\b/)
  })
  it('uploads are marked, validated in the handler, compressed first, and failures are reported', () => {
    expect(UI).toContain("origin: 'upload' })")
    expect(UI).toContain("{ source: 'url', value: v, origin: 'url' }")
    expect(UI).toContain('const invalid = validateFile(f, GALLERY_LIMIT)')
    expect(UI).toContain('const { dataUrl, ext } = await compressGalleryImage(f)')
    expect(UI).not.toContain('/* skip failed images */')
    expect(UI).toContain('data-testid="gallery-notices"')
  })
  it('a second selection while processing is refused (no double upload)', () => {
    expect(UI).toContain('if (busyRef.current) return')
  })
  it('logo and banner paths are unchanged (their own limits + cropper output sizes)', () => {
    expect(UI).toContain('const LOGO_LIMIT    = 5  * 1024 * 1024   // 5 MB')
    expect(UI).toContain('const BANNER_LIMIT  = 10 * 1024 * 1024   // 10 MB')
    expect(UI).toContain('<ImageCropperModal src={crop} aspectRatio={1} outputWidth={512} outputHeight={512}')
    expect(UI).toContain('outputWidth={1600}')
    expect(UI).not.toContain('compressToJpeg')   // its only caller was the old gallery path
  })
  it('the server enforces the limits on draft save, first publish, live edit and the resubmit copy', () => {
    expect(read('app/api/organizer/drafts/[draftId]/route.ts')).toContain('galleryChangeProblem(galleryOf(current.eventDetails), galleryOf(check.fields.eventDetails))')
    const pub = read('app/api/events/publish/route.ts')
    expect(pub).toContain('const galleryIssue = galleryProblem(galleryOf(draft.eventDetails))')
    expect(pub.indexOf('galleryProblem(galleryOf(draft.eventDetails))')).toBeLessThan(pub.indexOf('adminDb.runTransaction(async (txn) =>'))
    expect(read('app/api/organizer/events/[eventId]/edit/route.ts')).toContain("if (changedFields.includes('galleryImages')) {")
    expect(read('lib/events/editing/liveContentSync.ts')).toContain('galleryChangeProblem(galleryOf(live.eventDetails), galleryOf(dn.eventDetails))')
  })
  it('the Settings tab URL editor stops at the URL limit', () => {
    expect(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SettingsTab.tsx')).toContain('disabled={saving || galleryCounts.urls >= GALLERY_URL_MAX}')
  })
})
