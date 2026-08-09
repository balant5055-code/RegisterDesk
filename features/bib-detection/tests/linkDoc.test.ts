// RD-BIB-01 — the stored link.
//
// Kept out of the repository so importing it does not boot the Admin SDK. The properties
// under test are the ones a privacy review would ask about: what a link contains, what it
// deliberately does not, and that nothing is ever born verified.

import { describe, it, expect } from 'vitest'
import {
  buildLink, buildLinks, linkId, serializeLink, toBibSummary,
} from '@/features/bib-detection/utils/linkDoc'
import { BIB_SCHEMA_VERSION, type PhotoBibLinkDoc } from '@/features/bib-detection/types'
import type { MatchDecision } from '@/features/bib-detection/matching/matcher'

const decision = (over: Partial<MatchDecision> = {}): MatchDecision => ({
  detection: {
    bibNumber: 'A-101', bibKey: 'A101', confidence: 0.82,
    boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  },
  matchStatus: 'matched',
  candidates: [{ passId: '10k', passSlug: '10-km', passName: '10 KM', snapshotVersion: 2 }],
  snapshotVersion: 2,
  ...over,
})

const COMMON = {
  organizerUid: 'org_1',
  eventId:      'evt_1',
  eventSlug:    'mumbai-marathon-2026',
  assetId:      'med_abc123',
  galleryId:    'gal_1',
  albumId:      null,
  provider:        'fake',
  modelVersion:    'fake-1',
  pipelineVersion: 1,
  jobId:    'med_abc123__bib-detect',
  resultId: 'med_abc123__bib-detect',
}

// ═══════════════ Identity ═══════════════

describe('linkId', () => {
  it('is deterministic — re-running detection overwrites, never accumulates', () => {
    expect(linkId('med_1', 'A101')).toBe(linkId('med_1', 'A101'))
  })

  it('separates photos and bibs', () => {
    expect(linkId('med_1', 'A101')).not.toBe(linkId('med_2', 'A101'))
    expect(linkId('med_1', 'A101')).not.toBe(linkId('med_1', 'A102'))
  })

  it('never contains a path separator', () => {
    expect(linkId('med_abc123', 'A101')).not.toContain('/')
  })
})

// ═══════════════ What a link contains ═══════════════

describe('buildLink', () => {
  it('persists everything the data model requires', () => {
    const link = buildLink({ ...COMMON, decision: decision() })
    expect(link.assetId).toBe('med_abc123')          // photoId
    expect(link.bibNumber).toBe('A-101')             // bib, as read
    expect(link.bibKey).toBe('A101')                 // bib, normalised
    expect(link.confidence).toBe(0.82)
    expect(link.boundingBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    expect(link.provider).toBe('fake')
    expect(link.modelVersion).toBe('fake-1')
    expect(link.snapshotVersion).toBe(2)
    expect(link.reviewStatus).toBe('pending')
    expect(link.schemaVersion).toBe(BIB_SCHEMA_VERSION)
  })

  it('is NEVER born verified, however confident the model was', () => {
    const link = buildLink({
      ...COMMON,
      decision: decision({
        detection: { bibNumber: '101', bibKey: '101', confidence: 1, boundingBox: null },
      }),
    })
    expect(link.reviewStatus).toBe('pending')
    expect(link.reviewedBy).toBeNull()
  })

  it('stores NO participant data — a link is a pointer, not a copy', () => {
    // No name, no time, no rank. Those live in the published snapshot and are read from
    // there, so this collection never becomes a second, drifting copy of results.
    const link = buildLink({ ...COMMON, decision: decision() }) as unknown as Record<string, unknown>
    for (const field of ['name', 'participantName', 'chipTimeMs', 'gunTimeMs', 'overallRank', 'passRank']) {
      expect(link[field], field).toBeUndefined()
    }
  })

  it('records the pass a candidate points at, and nothing about the person in it', () => {
    const link = buildLink({ ...COMMON, decision: decision() })
    expect(Object.keys(link.candidates[0]).sort())
      .toEqual(['passId', 'passName', 'passSlug', 'snapshotVersion'])
  })

  it('an unmatched link carries no candidate and no version', () => {
    const link = buildLink({
      ...COMMON,
      decision: decision({ matchStatus: 'unmatched', candidates: [], snapshotVersion: null }),
    })
    expect(link.matchStatus).toBe('unmatched')
    expect(link.candidates).toEqual([])
    expect(link.snapshotVersion).toBeNull()
  })

  it('an ambiguous link carries every candidate and no version', () => {
    const link = buildLink({
      ...COMMON,
      decision: decision({
        matchStatus: 'ambiguous',
        candidates: [
          { passId: '5k',  passSlug: '5-km',  passName: '5 KM',  snapshotVersion: 1 },
          { passId: '10k', passSlug: '10-km', passName: '10 KM', snapshotVersion: 2 },
        ],
        snapshotVersion: null,
      }),
    })
    expect(link.candidates).toHaveLength(2)
    expect(link.snapshotVersion).toBeNull()
  })

  it('sets no timestamp — only the server may mint one', () => {
    const link = buildLink({ ...COMMON, decision: decision() }) as unknown as Record<string, unknown>
    for (const field of ['detectedAt', 'createdAt', 'updatedAt', 'reviewedAt']) {
      expect(link[field], field).toBeUndefined()
    }
  })
})

describe('buildLinks', () => {
  it('builds one link per detection, with distinct ids', () => {
    const links = buildLinks([
      decision(),
      decision({ detection: { bibNumber: '202', bibKey: '202', confidence: 0.7, boundingBox: null } }),
    ], COMMON)
    expect(links).toHaveLength(2)
    expect(new Set(links.map(l => l.linkId)).size).toBe(2)
  })

  it('no detections means no links — which is how a stale link gets removed', () => {
    expect(buildLinks([], COMMON)).toEqual([])
  })
})

// ═══════════════ The wire shape ═══════════════

const DOC: PhotoBibLinkDoc = {
  ...buildLink({ ...COMMON, decision: decision() }),
  reviewedAt:  null,
  detectedAt:  { toDate: () => new Date('2026-07-01T10:00:00.000Z') },
  createdAt:   { toDate: () => new Date('2026-07-01T10:00:00.000Z') },
  updatedAt:   null,
}

describe('serializeLink', () => {
  it('turns the Firestore Timestamp into an ISO string', () => {
    expect(serializeLink(DOC).detectedAt).toBe('2026-07-01T10:00:00.000Z')
  })

  it('survives a missing timestamp instead of throwing', () => {
    expect(serializeLink({ ...DOC, detectedAt: undefined }).detectedAt).toBeNull()
  })

  it('NEVER carries the tenant key or the internal identifiers', () => {
    const view = serializeLink(DOC) as unknown as Record<string, unknown>
    for (const field of ['organizerUid', 'eventId', 'eventSlug', 'albumId', 'jobId', 'reviewedBy']) {
      expect(view[field], field).toBeUndefined()
    }
  })

  it('exposes what an organizer needs to judge the link', () => {
    const view = serializeLink(DOC)
    expect(view.bibNumber).toBe('A-101')
    expect(view.confidence).toBe(0.82)
    expect(view.matchStatus).toBe('matched')
    expect(view.reviewStatus).toBe('pending')
    expect(view.provider).toBe('fake')
    expect(view.snapshotVersion).toBe(2)
  })
})

// ═══════════════ Summaries ═══════════════

describe('toBibSummary', () => {
  it('totals the MATCH statuses only — every link has exactly one', () => {
    const s = toBibSummary({
      matched: 10, unmatched: 3, ambiguous: 2,
      pending: 14, verified: 1, rejected: 0,
    })
    expect(s.total).toBe(15)
    expect(s.pending).toBe(14)
  })

  it('never reports a negative or fractional count', () => {
    const s = toBibSummary({ matched: -4, unmatched: 2.9, ambiguous: NaN })
    expect(s.matched).toBe(0)
    expect(s.unmatched).toBe(2)
    expect(s.ambiguous).toBe(0)
    expect(s.total).toBe(2)
  })

  it('an empty event is all zeros', () => {
    expect(toBibSummary({}).total).toBe(0)
  })
})
