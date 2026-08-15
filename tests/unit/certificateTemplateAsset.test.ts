// RD-CERT-TPL-R2 — where a certificate TEMPLATE's bytes come from.
//
// WHAT THIS PINS. Templates used to be uploaded by the browser straight to Firebase Storage
// and identified by a download URL; they now live in R2 behind a `fileKey`, with the old
// `fileUrl` still honoured so existing events keep rendering. That is two stores behind one
// renderer, and the failure modes that matters are:
//
//   1. PRECEDENCE. `fileKey` wins whenever both fields are present. A re-upload writes the
//      new key and may leave the old URL as provenance, so `fileUrl` means SUPERSEDED.
//   2. NO FALLBACK ON FAILURE. An unreadable `fileKey` must NOT drop through to `fileUrl`.
//      Rendering the previous design onto a real attendee's certificate produces a document
//      that looks plausible and is wrong — nothing downstream would flag it. Failing is the
//      safer outcome, and it is asserted head-on rather than assumed.
//   3. CACHE IDENTITY. The render cache used to key on `templateId:fileUrl`. Re-uploading to
//      R2 leaves that string unchanged while the artwork changes, which would serve the old
//      design from cache. The source must therefore be part of the key.
//   4. KEY SCOPING. The object key is server-generated and carries the organizer and event,
//      which is the entire reason a client-supplied key can be validated by prefix.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const R2_BYTES     = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // "%PDF-1.7"
const LEGACY_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])                          // PNG magic
const LEGACY_URL   = 'https://firebasestorage.googleapis.com/v0/b/x/o/certificates%2Ftemplates%2Fu1%2Fevt-1%2Fa.pdf?alt=media'

let downloadOutcome: 'ok' | 'throw' = 'ok'
const downloads:      string[] = []
const legacyFetches:  string[] = []

// The storage boundary. Every read is recorded, so "did not fall back" is a POSITIVE
// assertion about calls made rather than an inference from a thrown error.
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,                                   // buildObjectKey stays REAL: the key shape is under test
    storage: {
      download: async (key: string) => {
        downloads.push(key)
        if (downloadOutcome === 'throw') throw new Error('R2 is not configured')
        return { body: R2_BYTES, contentType: 'application/pdf' }
      },
    },
  }
})

// The LEGACY Firebase path, mocked at the same seam generate.ts already used.
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { legacyFetches.push(url); return LEGACY_BYTES },
  validateEventTemplateUrl:  (url: string) => ({ ok: true, url }),
  validateGlobalTemplateUrl: (url: string) => ({ ok: true, url }),
}))

const {
  loadTemplateBytes, templateSourceIdentity, buildTemplateObjectKey, buildTemplateKeyPrefix,
  isR2Template, TemplateAssetError,
} = await import('@/lib/certificates/templateAsset')

// The REAL key guard the storage layer applies, so the sanitiser is checked against the
// thing that will actually reject it rather than a restatement of its own rules.
const { assertSafeKey } = await import('@/features/platform-storage/utils/paths')

const checkUrl = (url: string) => ({ ok: true as const, url }) as never

beforeEach(() => {
  downloadOutcome = 'ok'
  downloads.length = 0
  legacyFetches.length = 0
})

describe('loadTemplateBytes — source resolution', () => {
  it('reads R2 when only fileKey is set, and never touches Firebase', async () => {
    const bytes = await loadTemplateBytes({ fileKey: 'events/evt-1/certificates/templates/u1/t1/a.pdf' }, checkUrl)

    expect(bytes).toEqual(R2_BYTES)
    expect(downloads).toEqual(['events/evt-1/certificates/templates/u1/t1/a.pdf'])
    expect(legacyFetches).toEqual([])
  })

  it('reads the legacy fileUrl when there is no fileKey', async () => {
    const bytes = await loadTemplateBytes({ fileUrl: LEGACY_URL }, checkUrl)

    expect(bytes).toEqual(LEGACY_BYTES)
    expect(legacyFetches).toEqual([LEGACY_URL])
    expect(downloads).toEqual([])
  })

  it('PRECEDENCE: fileKey wins when both are present — fileUrl is a superseded render', async () => {
    const bytes = await loadTemplateBytes(
      { fileKey: 'events/evt-1/certificates/templates/u1/t2/new.pdf', fileUrl: LEGACY_URL },
      checkUrl,
    )

    expect(bytes).toEqual(R2_BYTES)
    expect(legacyFetches).toEqual([])
  })

  it('NO FALLBACK: an unreadable fileKey fails instead of rendering the old fileUrl', async () => {
    downloadOutcome = 'throw'

    await expect(loadTemplateBytes(
      { fileKey: 'events/evt-1/certificates/templates/u1/t2/new.pdf', fileUrl: LEGACY_URL },
      checkUrl,
    )).rejects.toMatchObject({ name: 'TemplateAssetError', code: 'storage_failure' })

    // The property that actually matters: the legacy source was never even attempted.
    expect(legacyFetches).toEqual([])
  })

  it('a template with no stored file fails with a message an organizer can act on', async () => {
    const err = await loadTemplateBytes({}, checkUrl).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TemplateAssetError)
    expect((err as InstanceType<typeof TemplateAssetError>).code).toBe('missing_source')
    expect((err as Error).message).toMatch(/re-upload/i)
  })
})

describe('templateSourceIdentity — render cache key', () => {
  it('distinguishes an R2 source from a legacy one', () => {
    expect(templateSourceIdentity({ fileKey: 'k1' })).not.toBe(templateSourceIdentity({ fileUrl: 'k1' }))
  })

  it('changes when the same template is re-uploaded to a new key', () => {
    const before = templateSourceIdentity({ fileKey: 'events/e/certificates/templates/u/t1/a.pdf' })
    const after  = templateSourceIdentity({ fileKey: 'events/e/certificates/templates/u/t2/a.pdf' })
    expect(after).not.toBe(before)
  })

  it('ignores the superseded fileUrl once a fileKey exists, matching load precedence', () => {
    expect(templateSourceIdentity({ fileKey: 'k', fileUrl: 'u1' }))
      .toBe(templateSourceIdentity({ fileKey: 'k', fileUrl: 'u2' }))
  })
})

describe('buildTemplateObjectKey — scoping and sanitisation', () => {
  it('bakes the event and organizer into the path', () => {
    const key = buildTemplateObjectKey({ organizerUid: 'uid-1', eventId: 'evt-1', templateId: 'tpl-1', fileName: 'a.pdf' })
    expect(key).toBe('events/evt-1/certificates/templates/uid-1/tpl-1/a.pdf')
  })

  // assertSafeKey rejects any key containing ".." or "//", so the sanitiser has to produce a
  // key that survives it — otherwise a hostile name AND an innocent "report..final.pdf" both
  // fail at signing time with an opaque storage error instead of uploading.
  it.each([
    ['../../etc/passwd'],
    ['report..final.pdf'],
    ['a/b/c.pdf'],
    ['..'],
    [''],
    ['x'.repeat(400) + '.pdf'],
  ])('produces one safe segment for %j', (fileName) => {
    const key = buildTemplateObjectKey({ organizerUid: 'uid-1', eventId: 'evt-1', templateId: 'tpl-1', fileName })

    expect(key.startsWith('events/evt-1/certificates/templates/uid-1/tpl-1/')).toBe(true)
    expect(key.split('/').length).toBe(7)     // the filename never adds a path segment
    expect(key).not.toContain('..')
    expect(key).not.toContain('//')
    expect(() => assertSafeKey(key)).not.toThrow()
  })

  it('every minted key sits under the prefix the create route validates against', () => {
    const prefix = buildTemplateKeyPrefix({ organizerUid: 'uid-1', eventId: 'evt-1' })
    const key    = buildTemplateObjectKey({ organizerUid: 'uid-1', eventId: 'evt-1', templateId: 't', fileName: 'x.png' })

    expect(key.startsWith(prefix)).toBe(true)
    // ...and another workspace's key does not, which is what the 403 relies on.
    expect(buildTemplateObjectKey({ organizerUid: 'uid-2', eventId: 'evt-1', templateId: 't', fileName: 'x.png' })
      .startsWith(prefix)).toBe(false)
    expect(buildTemplateObjectKey({ organizerUid: 'uid-1', eventId: 'evt-2', templateId: 't', fileName: 'x.png' })
      .startsWith(prefix)).toBe(false)
  })
})

describe('isR2Template', () => {
  it('is true only for a non-empty fileKey', () => {
    expect(isR2Template({ fileKey: 'k' })).toBe(true)
    expect(isR2Template({ fileKey: '' })).toBe(false)
    expect(isR2Template({})).toBe(false)
  })
})
