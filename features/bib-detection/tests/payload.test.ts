// RD-BIB-01 — the provider payload contract.
//
// This parser is the privacy boundary: everything a provider says passes through it, and it
// CONSTRUCTS its output field by field rather than spreading the input. The first block
// below is the test that makes "no face recognition" a property of the code.

import { describe, it, expect } from 'vitest'
import {
  MAX_DETECTIONS_PER_PHOTO, parseBoundingBox, parseDetectionPayload,
} from '@/features/bib-detection/utils/payload'
import { bibKey } from '@/features/race-operations/utils/publicKeys'

const det = (bib: string, confidence = 0.9, boundingBox?: unknown) => ({
  bibNumber: bib, confidence, ...(boundingBox === undefined ? {} : { boundingBox }),
})

// ═══════════════ The privacy boundary ═══════════════

describe('a provider cannot smuggle anything past the parser', () => {
  it('DROPS every field the contract does not name', () => {
    const { payload } = parseDetectionPayload({
      detections: [{
        bibNumber: '101',
        confidence: 0.9,
        // Everything a face/person model would want to return:
        faceEmbedding: [0.1, 0.2, 0.3],
        faceBox:       { x: 0, y: 0, w: 1, h: 1 },
        personId:      'person_42',
        age:           34,
        gender:        'female',
        emotion:       'happy',
        ocrText:       'FINISH LINE SPONSORED BY ACME',
        landmarks:     [[1, 2]],
      }],
    })

    expect(payload.detections).toHaveLength(1)
    expect(Object.keys(payload.detections[0]).sort())
      .toEqual(['bibKey', 'bibNumber', 'boundingBox', 'confidence'])
  })

  it('carries no top-level field either', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('101')],
      faces: [{ id: 'f1' }],
      text:  'banner copy',
    })
    expect(Object.keys(payload)).toEqual(['detections'])
  })
})

// ═══════════════ Bib normalisation ═══════════════

describe('bib normalisation', () => {
  it('uses the SAME normaliser the snapshot keyed its entries with', () => {
    // If these ever diverge, every lookup silently misses. Imported, never reimplemented.
    const { payload } = parseDetectionPayload({ detections: [det('a-101')] })
    expect(payload.detections[0].bibKey).toBe(bibKey('a-101'))
    expect(payload.detections[0].bibKey).toBe('A101')
  })

  it('keeps the bib exactly as read, alongside the key', () => {
    const { payload } = parseDetectionPayload({ detections: [det(' A 101 ')] })
    expect(payload.detections[0].bibNumber).toBe('A 101')
    expect(payload.detections[0].bibKey).toBe('A101')
  })

  it('preserves leading zeros — 0042 and 42 are different runners', () => {
    const { payload } = parseDetectionPayload({ detections: [det('0042'), det('42')] })
    expect(payload.detections.map(d => d.bibKey).sort()).toEqual(['0042', '42'])
  })

  it('discards anything that could not be a bib', () => {
    const { payload, discarded } = parseDetectionPayload({
      detections: [
        det('101'),
        det(''), det('   '), det('#!@'),
        det('x'.repeat(40)),
        { confidence: 0.9 },          // no bib at all
        'not an object', null, 42,
      ],
    })
    expect(payload.detections.map(d => d.bibKey)).toEqual(['101'])
    expect(discarded).toBe(8)
  })

  it('discards a purely alphabetic read — this feature does not do banner OCR', () => {
    // "FINISH LINE" survives the shape guard (a bib is alphanumeric) and would otherwise
    // sit in the queue forever as an unmatched detection. A bib carries a NUMBER.
    const { payload, discarded } = parseDetectionPayload({
      detections: [det('FINISH LINE'), det('NIKE'), det('SPONSORED BY ACME'), det('A101')],
    })
    expect(payload.detections.map(d => d.bibKey)).toEqual(['A101'])
    expect(discarded).toBe(3)
  })

  it('accepts the `bib` alias a provider might use', () => {
    const { payload } = parseDetectionPayload({ detections: [{ bib: '77', confidence: 0.8 }] })
    expect(payload.detections[0].bibNumber).toBe('77')
  })
})

// ═══════════════ Confidence ═══════════════

describe('confidence', () => {
  it('is stored as given', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('1', 0.95), det('2', 0.82), det('3', 0.61)],
    })
    const byBib = Object.fromEntries(payload.detections.map(d => [d.bibKey, d.confidence]))
    expect(byBib).toEqual({ '1': 0.95, '2': 0.82, '3': 0.61 })
  })

  it('NEVER rejects a low-confidence detection', () => {
    // Nothing is auto-rejected. A model that is 1% sure has still read something, and what
    // that is worth is the organizer's call — which is what reviewStatus is for.
    const { payload } = parseDetectionPayload({ detections: [det('101', 0.01)] })
    expect(payload.detections).toHaveLength(1)
    expect(payload.detections[0].confidence).toBe(0.01)
  })

  it('clamps out-of-range values instead of trusting them', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('1', 95), det('2', -3), det('3', NaN), det('4', 'high' as unknown as number)],
    })
    const byBib = Object.fromEntries(payload.detections.map(d => [d.bibKey, d.confidence]))
    expect(byBib).toEqual({ '1': 1, '2': 0, '3': 0, '4': 0 })
  })
})

// ═══════════════ Bounding boxes ═══════════════

describe('parseBoundingBox', () => {
  it('accepts a normalised box', () => {
    expect(parseBoundingBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }))
      .toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
  })

  it('accepts the w/h aliases', () => {
    expect(parseBoundingBox({ x: 0, y: 0, w: 0.5, h: 0.5 }))
      .toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 })
  })

  it('refuses a box that runs off the frame — the coordinates were not normalised', () => {
    expect(parseBoundingBox({ x: 0.9, y: 0, width: 0.5, height: 0.1 })).toBeNull()
    expect(parseBoundingBox({ x: 120, y: 340, width: 80, height: 40 })).toBeNull()
  })

  it('refuses a zero-area box — it says nothing about where the bib is', () => {
    expect(parseBoundingBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 })).toBeNull()
  })

  it('refuses anything malformed', () => {
    for (const v of [null, undefined, 'box', 42, {}, { x: 1 }, { x: NaN, y: 0, w: 1, h: 1 }]) {
      expect(parseBoundingBox(v)).toBeNull()
    }
  })

  it('a bad box never costs the detection', () => {
    // A bib read correctly is useful even when the box is nonsense.
    const { payload } = parseDetectionPayload({ detections: [det('101', 0.9, { x: 5, y: 5 })] })
    expect(payload.detections).toHaveLength(1)
    expect(payload.detections[0].boundingBox).toBeNull()
  })
})

// ═══════════════ Duplicates within one frame ═══════════════

describe('duplicate detections', () => {
  it('folds two reads of the same bib into one, keeping the higher confidence', () => {
    const { payload, deduplicated } = parseDetectionPayload({
      detections: [det('101', 0.6), det('101', 0.93), det('101', 0.4)],
    })
    expect(payload.detections).toHaveLength(1)
    expect(payload.detections[0].confidence).toBe(0.93)
    expect(deduplicated).toBe(2)
  })

  it('folds across formatting differences, because the KEY is what identifies a bib', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('A-101', 0.7), det('a 101', 0.8)],
    })
    expect(payload.detections).toHaveLength(1)
    expect(payload.detections[0].confidence).toBe(0.8)
  })

  it('the surviving box belongs to the surviving read', () => {
    const { payload } = parseDetectionPayload({
      detections: [
        det('101', 0.5, { x: 0, y: 0, width: 0.1, height: 0.1 }),
        det('101', 0.9, { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }),
      ],
    })
    expect(payload.detections[0].boundingBox).toEqual({ x: 0.5, y: 0.5, width: 0.2, height: 0.2 })
  })

  it('keeps genuinely different bibs apart', () => {
    const { payload, deduplicated } = parseDetectionPayload({
      detections: [det('101'), det('102'), det('103')],
    })
    expect(payload.detections).toHaveLength(3)
    expect(deduplicated).toBe(0)
  })
})

// ═══════════════ Multiple bibs, and the cap ═══════════════

describe('multiple bibs in one photo', () => {
  it('stores them all', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('101', 0.9), det('202', 0.8), det('303', 0.7)],
    })
    expect(payload.detections.map(d => d.bibKey)).toEqual(['101', '202', '303'])
  })

  it('orders by confidence, so a truncation drops the least certain reads', () => {
    const { payload } = parseDetectionPayload({
      detections: [det('1', 0.2), det('2', 0.95), det('3', 0.6)],
    })
    expect(payload.detections.map(d => d.bibKey)).toEqual(['2', '3', '1'])
  })

  it('breaks a confidence tie deterministically', () => {
    const run = () => parseDetectionPayload({
      detections: [det('300', 0.8), det('100', 0.8), det('200', 0.8)],
    }).payload.detections.map(d => d.bibKey)
    expect(run()).toEqual(['100', '200', '300'])
    expect(run()).toEqual(run())
  })

  it('caps the number kept, and REPORTS the truncation', () => {
    const many = Array.from({ length: MAX_DETECTIONS_PER_PHOTO + 7 },
      (_, i) => det(String(1000 + i), 0.5))
    const { payload, truncated } = parseDetectionPayload({ detections: many })
    expect(payload.detections).toHaveLength(MAX_DETECTIONS_PER_PHOTO)
    expect(truncated).toBe(7)
  })
})

// ═══════════════ Malformed payloads ═══════════════

describe('a malformed payload never throws', () => {
  it('yields no detections', () => {
    for (const raw of [null, undefined, 'nope', 42, {}, { detections: null }, { detections: 'x' }, []]) {
      expect(() => parseDetectionPayload(raw)).not.toThrow()
      expect(parseDetectionPayload(raw).payload.detections).toEqual([])
    }
  })

  it('an empty result is indistinguishable from an unusable one — both mean nothing to link', () => {
    expect(parseDetectionPayload({ detections: [] }).payload.detections).toEqual([])
  })
})
