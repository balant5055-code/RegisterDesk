// RD-CERT-PHOTO-01 — the attendee-photo image SOURCE, end to end through validation and
// the builder's save filter.
//
// The whole feature rests on one property: an image element whose bytes come from the
// attendee has NO design-time assetUrl, and four separate layers used to treat that as
// invalid. Each of those layers is asserted here, together with the compatibility case
// that matters most — a template written before this field existed must validate and
// behave exactly as it always did.

import { describe, it, expect } from 'vitest'
import { validateLayout } from '@/lib/certificates/validation'
import { toSavedLayout, isIncompleteImage, createElement } from '@/components/certificates/builder/lib'
import type { CertificateDimensions, LayoutElement } from '@/lib/certificates/types'

const CANVAS: CertificateDimensions = { width: 842, height: 595, unit: 'pt' }

const base = { id: 'el-1', zIndex: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
const STATIC_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/logo.png?alt=media'

function layout(elements: unknown[]): unknown {
  return { version: 1, canvas: CANVAS, elements }
}

describe('RD-CERT-PHOTO-01 · layout validation', () => {
  it('accepts an existing static image element with no `source` (legacy template)', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'contain' }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const el = r.value.elements[0] as { assetUrl: string; source?: string }
    expect(el.assetUrl).toBe(STATIC_URL)
    // Absent stays absent — nothing is written into old templates.
    expect(el.source).toBeUndefined()
  })

  it('accepts an explicit source: static, and does not persist the redundant field', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'cover', source: 'static' }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value.elements[0] as { source?: string }).source).toBeUndefined()
  })

  it('accepts an attendeePhoto element with NO assetUrl', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', fit: 'contain', source: 'attendeePhoto' }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const el = r.value.elements[0] as { assetUrl: string; source?: string }
    expect(el.source).toBe('attendeePhoto')
    expect(el.assetUrl).toBe('')
  })

  it('accepts an attendeePhoto element with an explicitly empty assetUrl', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'contain', source: 'attendeePhoto' }]))
    expect(r.ok).toBe(true)
  })

  it('REJECTS a static image with no assetUrl — unchanged from before the feature', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'contain' }]))
    expect(r.ok).toBe(false)
  })

  it('REJECTS an unknown source rather than silently downgrading it to static', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'contain', source: 'somethingElse' }]))
    expect(r.ok).toBe(false)
  })

  it('REJECTS a stray assetUrl riding along on an attendeePhoto element', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'contain', source: 'attendeePhoto' }]))
    expect(r.ok).toBe(false)
  })

  it('does not weaken static URL validation', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: 'http://insecure.example/x.png', fit: 'contain' }]))
    expect(r.ok).toBe(false)
  })
})

describe('RD-CERT-PHOTO-01 · attendee photo is contain-only', () => {
  it('REJECTS fit: cover on an attendeePhoto element (crafted client input)', () => {
    // The builder hides the control, but the rule has to hold against a hand-rolled
    // request too — pdf-lib cannot clip, so cover would paint outside the box.
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'cover', source: 'attendeePhoto' }]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/contain/i)
  })

  it('accepts fit: contain on an attendeePhoto element', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'contain', source: 'attendeePhoto' }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value.elements[0] as { fit: string }).fit).toBe('contain')
  })

  it('STILL allows fit: cover on a static image — existing behaviour is unchanged', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'cover' }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value.elements[0] as { fit: string }).fit).toBe('cover')
  })

  it('STILL allows fit: cover on an explicitly static-sourced image', () => {
    const r = validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'cover', source: 'static' }]))
    expect(r.ok).toBe(true)
  })

  it('rejects a nonsense fit for both sources, as before', () => {
    expect(validateLayout(layout([{ ...base, type: 'image', assetUrl: STATIC_URL, fit: 'stretch' }])).ok).toBe(false)
    expect(validateLayout(layout([{ ...base, type: 'image', assetUrl: '', fit: 'stretch', source: 'attendeePhoto' }])).ok).toBe(false)
  })

  it('the palette creates the attendee photo element already contain', () => {
    const el = createElement('attendeePhoto', 1)
    expect(el.type).toBe('image')
    if (el.type !== 'image') return
    expect(el.fit).toBe('contain')
  })

  it('a builder-created attendee photo survives validation unchanged', () => {
    const el = createElement('attendeePhoto', 1)
    const saved = toSavedLayout(CANVAS, [el])
    const r = validateLayout(JSON.parse(JSON.stringify(saved)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value.elements[0] as { fit: string }).fit).toBe('contain')
  })
})

describe('RD-CERT-PHOTO-01 · builder save filter', () => {
  const attendeeEl = { ...base, type: 'image', assetUrl: '', fit: 'contain', source: 'attendeePhoto' } as LayoutElement
  const emptyStatic = { ...base, id: 'el-2', type: 'image', assetUrl: '', fit: 'contain' } as LayoutElement
  const goodStatic = { ...base, id: 'el-3', type: 'image', assetUrl: STATIC_URL, fit: 'contain' } as LayoutElement

  it('an attendeePhoto element is COMPLETE without an assetUrl', () => {
    expect(isIncompleteImage(attendeeEl)).toBe(false)
  })

  it('a static image without an assetUrl is still incomplete', () => {
    expect(isIncompleteImage(emptyStatic)).toBe(true)
  })

  it('autosave keeps the attendeePhoto element and still drops the empty static one', () => {
    const saved = toSavedLayout(CANVAS, [attendeeEl, emptyStatic, goodStatic])
    const ids = saved.elements.map(e => e.id)
    expect(ids).toContain('el-1')     // attendee photo survived
    expect(ids).toContain('el-3')     // complete static survived
    expect(ids).not.toContain('el-2') // incomplete static dropped, as before
  })

  it('survives the full autosave → server validation → reload round trip', () => {
    const saved = toSavedLayout(CANVAS, [attendeeEl])
    const r = validateLayout(JSON.parse(JSON.stringify(saved)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const el = r.value.elements[0] as { type: string; source?: string; assetUrl: string }
    expect(el.type).toBe('image')
    expect(el.source).toBe('attendeePhoto')
    expect(el.assetUrl).toBe('')
  })
})

describe('RD-CERT-PHOTO-01 · palette', () => {
  it('creates an image element carrying the attendeePhoto source and no fake URL', () => {
    const el = createElement('attendeePhoto', 3)
    expect(el.type).toBe('image')
    if (el.type !== 'image') return
    expect(el.source).toBe('attendeePhoto')
    expect(el.assetUrl).toBe('')
    expect(el.fit).toBe('contain')   // the crop is already baked in; never needs to clip
  })

  it('still creates ordinary static image roles unchanged', () => {
    for (const kind of ['logo', 'signature', 'seal', 'image'] as const) {
      const el = createElement(kind, 1)
      expect(el.type).toBe('image')
      if (el.type !== 'image') continue
      expect(el.source).toBeUndefined()
      expect(el.role).toBe(kind === 'image' ? 'image' : kind)
    }
  })
})
