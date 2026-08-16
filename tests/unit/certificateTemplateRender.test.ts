// RD-CERT-TPL-R2 — the RENDER path actually reads the template from R2.
//
// The source-resolution rules are pinned in certificateTemplateAsset.test.ts. This file
// asserts the thing that makes them matter: `loadRenderAssets` — the function the on-demand
// download, the bulk job and the regen prefetch all go through — is wired to that resolver,
// so an R2-backed template renders and a legacy one keeps rendering unchanged.
//
// It also pins the property that keeps bulk issuing affordable: layout image assets are
// STILL Firebase URLs and are deliberately NOT migrated, so a template read must not start
// pulling them from object storage.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const R2_BYTES     = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // "%PDF-1.7"
const LEGACY_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const ASSET_BYTES  = new Uint8Array([0x01, 0x02])
const LEGACY_URL   = 'https://firebasestorage.googleapis.com/v0/b/x/o/legacy.pdf?alt=media'
const ASSET_URL    = 'https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media'

const downloads:  string[] = []
const urlFetches: string[] = []

// generate.ts pulls in the Firestore layer at import time; none of it is exercised here.
vi.mock('@/lib/firebase/admin', () => ({
  adminDb:   { doc: () => ({ get: async () => ({ exists: false }) }), collection: () => ({}) },
  adminAuth: {},
}))

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      download: async (key: string) => { downloads.push(key); return { body: R2_BYTES, contentType: 'application/pdf' } },
    },
  }
})

vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => {
    urlFetches.push(url)
    return url === ASSET_URL ? ASSET_BYTES : LEGACY_BYTES
  },
  validateEventTemplateUrl:  (url: string) => ({ ok: true, url }),
  validateGlobalTemplateUrl: (url: string) => ({ ok: true, url }),
}))

const { loadRenderAssets } = await import('@/lib/certificates/generate')

const base = {
  templateId: 'tpl-1', eventId: 'evt-1', organizerUid: 'uid-1',
  name: 'Finisher', templateType: 'pdf' as const, fileName: 'design.pdf', fileSize: 8,
} as never

const tpl = (over: Record<string, unknown>) => ({ ...(base as object), ...over }) as never

beforeEach(() => { downloads.length = 0; urlFetches.length = 0 })

describe('loadRenderAssets — template source', () => {
  it('renders from R2 when the template carries a fileKey', async () => {
    const { templateBytes } = await loadRenderAssets(tpl({ fileKey: 'events/evt-1/certificates/templates/uid-1/t/design.pdf' }))

    expect(templateBytes).toEqual(R2_BYTES)
    expect(downloads).toEqual(['events/evt-1/certificates/templates/uid-1/t/design.pdf'])
    expect(urlFetches).toEqual([])
  })

  it('still renders a LEGACY template from its Firebase fileUrl', async () => {
    const { templateBytes } = await loadRenderAssets(tpl({ fileUrl: LEGACY_URL }))

    expect(templateBytes).toEqual(LEGACY_BYTES)
    expect(urlFetches).toEqual([LEGACY_URL])
    expect(downloads).toEqual([])
  })

  it('prefers the R2 object over a superseded fileUrl left on the same record', async () => {
    const { templateBytes } = await loadRenderAssets(tpl({
      fileKey: 'events/evt-1/certificates/templates/uid-1/t2/new.pdf', fileUrl: LEGACY_URL,
    }))

    expect(templateBytes).toEqual(R2_BYTES)
    expect(urlFetches).toEqual([])
  })

  it('fails the render rather than silently using the old design when R2 cannot be read', async () => {
    const mod = await import('@/features/platform-storage')
    const spy = vi.spyOn(mod.storage, 'download').mockRejectedValueOnce(new Error('R2 down'))

    await expect(loadRenderAssets(tpl({ fileKey: 'events/evt-1/certificates/templates/uid-1/t/x.pdf', fileUrl: LEGACY_URL })))
      .rejects.toMatchObject({ code: 'storage_failure' })
    expect(urlFetches).toEqual([])

    spy.mockRestore()
  })

  it('leaves layout image assets on the Firebase path — they are NOT migrated', async () => {
    const { assets } = await loadRenderAssets(tpl({
      fileKey: 'events/evt-1/certificates/templates/uid-1/t/design.pdf',
      layout:  { elements: [{ type: 'image', assetUrl: ASSET_URL }] },
    }))

    expect(assets.get(ASSET_URL)).toEqual(ASSET_BYTES)
    expect(urlFetches).toEqual([ASSET_URL])      // fetched by URL, not by key
    expect(downloads).toHaveLength(1)            // exactly the template, nothing else
  })

  it('reads the template ONCE per call — bulk chunks reuse one RenderAssets', async () => {
    const t = tpl({
      fileKey: 'events/evt-1/certificates/templates/uid-1/t/design.pdf',
      layout:  { elements: [{ type: 'image', assetUrl: ASSET_URL }, { type: 'image', assetUrl: ASSET_URL }] },
    })
    const shared = await loadRenderAssets(t)

    // 500 certificates in a chunk share this object; the cost is one download + one asset
    // fetch regardless of how many are rendered from it.
    expect(downloads).toHaveLength(1)
    expect(urlFetches).toHaveLength(1)           // the duplicate assetUrl is de-duplicated
    expect(shared.templateBytes).toEqual(R2_BYTES)
  })
})
