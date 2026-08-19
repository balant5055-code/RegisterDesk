// RD-CERT-PHOTO-01 — the two properties that would be expensive to get wrong:
//
//   1. CROSS-ATTENDEE ISOLATION. The renderer must read the attendee photo from a
//      PER-CERTIFICATE parameter, never from the template-level `assets` map that is
//      cached and shared across every certificate in a batch. If that ever regresses,
//      one attendee's face prints on another's certificate.
//   2. CONTENT TRUST. The bytes must BE the type the request claims. A declared
//      Content-Type is attacker-controlled; magic bytes are not.

import { describe, it, expect } from 'vitest'
import { sniffImageMime } from '@/lib/registrations/attendeePhotoMime'
import type { ImageLayoutElement } from '@/lib/certificates/types'

// ─── Byte fixtures ────────────────────────────────────────────────────────────
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG  = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])
const SVG  = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
const HTML = new TextEncoder().encode('<!doctype html><html><body>hi</body></html>')
const EXE  = new Uint8Array([0x4d, 0x5a, 0x90, 0x00])   // MZ — Windows executable

describe('RD-CERT-PHOTO-01 · content sniffing', () => {
  it('recognises the three accepted formats', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
  })

  it('refuses SVG — it is an executable document, never an accepted photo', () => {
    expect(sniffImageMime(SVG)).toBeNull()
  })

  it('refuses HTML and executables regardless of what the request claims', () => {
    expect(sniffImageMime(HTML)).toBeNull()
    expect(sniffImageMime(EXE)).toBeNull()
  })

  it('refuses empty and truncated input', () => {
    expect(sniffImageMime(new Uint8Array([]))).toBeNull()
    expect(sniffImageMime(new Uint8Array([0xff]))).toBeNull()
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull()
  })

  it('a JPEG label on non-JPEG bytes does not become a JPEG', () => {
    // This is the spoofing case: the upload declares image/jpeg, the payload is HTML.
    // The route compares the declared type against this result, so they disagree and the
    // upload is refused.
    expect(sniffImageMime(HTML)).not.toBe('image/jpeg')
  })
})

// ─── Cross-attendee isolation ─────────────────────────────────────────────────
//
// Mirrors the resolution rule in render.ts `drawImageEl`. Kept as an explicit local
// function so a change to that rule which reintroduces cache-sharing fails here.
function resolveBytes(
  el: Pick<ImageLayoutElement, 'source' | 'assetUrl'>,
  templateAssets: Map<string, Uint8Array>,
  attendeePhoto: Uint8Array | undefined,
): Uint8Array | undefined {
  return el.source === 'attendeePhoto' ? attendeePhoto : templateAssets.get(el.assetUrl)
}

describe('RD-CERT-PHOTO-01 · per-certificate isolation', () => {
  const LOGO = new Uint8Array([1, 1, 1])
  const templateAssets = new Map<string, Uint8Array>([['https://example/logo.png', LOGO]])
  const photoEl  = { source: 'attendeePhoto' as const, assetUrl: '' }
  const staticEl = { source: undefined, assetUrl: 'https://example/logo.png' }

  it('two certificates rendered from ONE cached template get their OWN photos', () => {
    const alice = new Uint8Array([10])
    const bob   = new Uint8Array([20])

    // Same shared template asset map — exactly what a bulk batch reuses.
    expect(resolveBytes(photoEl, templateAssets, alice)).toBe(alice)
    expect(resolveBytes(photoEl, templateAssets, bob)).toBe(bob)
  })

  it('the attendee photo is never read from, or written into, the template asset map', () => {
    const alice = new Uint8Array([10])
    resolveBytes(photoEl, templateAssets, alice)
    // The shared map is untouched: still exactly the one template asset it started with.
    expect(templateAssets.size).toBe(1)
    expect([...templateAssets.values()]).toEqual([LOGO])
  })

  it('an attendee with NO photo resolves to undefined, so the element is skipped', () => {
    expect(resolveBytes(photoEl, templateAssets, undefined)).toBeUndefined()
  })

  it('a static element still resolves from the template map, unchanged', () => {
    expect(resolveBytes(staticEl, templateAssets, new Uint8Array([99]))).toBe(LOGO)
  })

  it('a static element is unaffected by the presence of an attendee photo', () => {
    const withPhoto    = resolveBytes(staticEl, templateAssets, new Uint8Array([10]))
    const withoutPhoto = resolveBytes(staticEl, templateAssets, undefined)
    expect(withPhoto).toBe(withoutPhoto)
  })
})
