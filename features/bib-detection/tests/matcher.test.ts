// RD-BIB-01 — the matching decision.
//
// The rule that decides whether a photograph is attached to a named runner. The case that
// matters most is the third one: a bib is unique within a RACE, not within an EVENT, so a
// detected number can legitimately be two different people.

import { describe, it, expect } from 'vitest'
import {
  confidenceBand, decideMatch, decideMatches, formatConfidence,
} from '@/features/bib-detection/matching/matcher'
import type { BibDetection, BibMatchCandidate } from '@/features/bib-detection/types'

const detection = (bib = '101', confidence = 0.9): BibDetection => ({
  bibNumber: bib, bibKey: bib.toUpperCase(), confidence, boundingBox: null,
})

const race = (passId: string, version = 1): BibMatchCandidate => ({
  passId, passSlug: `${passId}-slug`, passName: passId.toUpperCase(), snapshotVersion: version,
})

// ═══════════════ Exact match ═══════════════

describe('exactly one published runner', () => {
  it('links, and records the snapshot version it was decided against', () => {
    const d = decideMatch({ detection: detection('101'), candidates: [race('10k', 3)] })
    expect(d.matchStatus).toBe('matched')
    expect(d.candidates).toHaveLength(1)
    expect(d.candidates[0].passId).toBe('10k')
    expect(d.snapshotVersion).toBe(3)
  })

  it('carries the detection through untouched', () => {
    const det = detection('A-101', 0.61)
    const d = decideMatch({ detection: det, candidates: [race('5k')] })
    expect(d.detection).toBe(det)
    expect(d.detection.confidence).toBe(0.61)
  })
})

// ═══════════════ Unknown bib ═══════════════

describe('no published runner', () => {
  it('is unmatched, not discarded', () => {
    // An unmatched bib means the results are incomplete or the read was wrong. Both are
    // things the organizer needs to be able to see.
    const d = decideMatch({ detection: detection('999'), candidates: [] })
    expect(d.matchStatus).toBe('unmatched')
    expect(d.candidates).toEqual([])
    expect(d.snapshotVersion).toBeNull()
  })
})

// ═══════════════ The case the brief does not cover ═══════════════

describe('more than one published runner', () => {
  it('is ambiguous — and links to NONE of them', () => {
    // Attaching a stranger's photograph to a runner is a worse failure than leaving it
    // unlinked, so nothing is picked.
    const d = decideMatch({ detection: detection('101'), candidates: [race('5k'), race('10k')] })
    expect(d.matchStatus).toBe('ambiguous')
    expect(d.snapshotVersion).toBeNull()
  })

  it('stores EVERY candidate, so a human can resolve it', () => {
    const d = decideMatch({
      detection: detection('101'),
      candidates: [race('5k', 2), race('10k', 1), race('21k', 4)],
    })
    expect(d.candidates.map(c => c.passId)).toEqual(['10k', '21k', '5k'])
    expect(d.candidates.map(c => c.snapshotVersion)).toEqual([1, 4, 2])
  })

  it('orders candidates deterministically, so an identical run does not churn the document', () => {
    const a = decideMatch({ detection: detection(), candidates: [race('c'), race('a'), race('b')] })
    const b = decideMatch({ detection: detection(), candidates: [race('b'), race('c'), race('a')] })
    expect(a.candidates.map(c => c.passId)).toEqual(b.candidates.map(c => c.passId))
  })

  it('the same race twice is ONE candidate, not ambiguity', () => {
    const d = decideMatch({ detection: detection(), candidates: [race('10k'), race('10k')] })
    expect(d.matchStatus).toBe('matched')
    expect(d.candidates).toHaveLength(1)
  })
})

// ═══════════════ Confidence is never a gate ═══════════════

describe('confidence never changes the decision', () => {
  it('a 1%-confident detection matches exactly like a 99% one', () => {
    const low  = decideMatch({ detection: detection('101', 0.01), candidates: [race('10k')] })
    const high = decideMatch({ detection: detection('101', 0.99), candidates: [race('10k')] })
    expect(low.matchStatus).toBe(high.matchStatus)
    expect(low.matchStatus).toBe('matched')
  })

  it('and never causes a detection to be dropped', () => {
    const decisions = decideMatches([
      { detection: detection('1', 0), candidates: [] },
      { detection: detection('2', 1), candidates: [race('10k')] },
    ])
    expect(decisions).toHaveLength(2)
  })
})

describe('confidence presentation', () => {
  it('bands are display-only and nothing branches on them', () => {
    expect(confidenceBand(0.95)).toBe('high')
    expect(confidenceBand(0.9)).toBe('high')
    expect(confidenceBand(0.82)).toBe('medium')
    expect(confidenceBand(0.7)).toBe('medium')
    expect(confidenceBand(0.61)).toBe('low')
    expect(confidenceBand(0)).toBe('low')
  })

  it('formats the way the brief writes them', () => {
    expect(formatConfidence(0.95)).toBe('95%')
    expect(formatConfidence(0.82)).toBe('82%')
    expect(formatConfidence(0.61)).toBe('61%')
  })

  it('formats safely outside the range', () => {
    expect(formatConfidence(-1)).toBe('0%')
    expect(formatConfidence(7)).toBe('100%')
  })
})

// ═══════════════ Batches ═══════════════

describe('decideMatches', () => {
  it('decides each detection independently', () => {
    const decisions = decideMatches([
      { detection: detection('101'), candidates: [race('10k')] },
      { detection: detection('202'), candidates: [] },
      { detection: detection('303'), candidates: [race('5k'), race('10k')] },
    ])
    expect(decisions.map(d => d.matchStatus)).toEqual(['matched', 'unmatched', 'ambiguous'])
  })

  it('preserves order and length', () => {
    const inputs = ['1', '2', '3', '4'].map(b => ({ detection: detection(b), candidates: [] }))
    expect(decideMatches(inputs).map(d => d.detection.bibKey)).toEqual(['1', '2', '3', '4'])
  })

  it('an empty batch decides nothing', () => {
    expect(decideMatches([])).toEqual([])
  })
})
