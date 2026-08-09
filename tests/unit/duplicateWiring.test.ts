// MS-FINAL-01 · The duplicate pipeline's decision points. Pure — no DOM, no network.
//
// The scanner and its resolutions were already unit-tested (features/media-studio/tests).
// What was never tested is the part that was missing: that a photo recognised as a duplicate
// is EXCLUDED from credit slot assignment, and that the organizer's decision puts it back in
// or takes it out for good.
//
// Those two properties are what make the feature safe to enable alongside Media Credits: a
// duplicate that received a slot would reserve — and eventually be charged for — a photo that
// was never uploaded.

import { describe, it, expect } from 'vitest'
import { assignSlots } from '@/features/media-studio/utils/uploadSession'
import { nextState } from '@/features/media-studio/utils/queueMachine'
import { scanForDuplicates, type ExistingAssetRef } from '@/features/media-studio/utils/duplicates'

const sum = (n: number) => String(n).padStart(64, '0')
const item = (id: string, state = 'queued', sessionId: string | null = null) =>
  ({ id, state, sessionId })

const stored: ExistingAssetRef[] = [
  {
    assetId: 'med_1', checksum: sum(1), galleryId: 'gal_1', albumId: null,
    originalFilename: 'IMG_0001.jpg', uploadedAtMs: 1_700_000_000_000,
  },
]

describe('a duplicate never receives a credit slot', () => {
  it('is excluded from slot assignment', () => {
    // THE property. `assignSlots` only slots `queued` and `paused`, so moving a match into
    // the existing `duplicate` state removes it from the batch with no special case.
    const out = assignSlots([
      item('a'), item('b', 'duplicate'), item('c'),
    ], 'us_1')

    expect(out.map(s => s.id)).toEqual(['a', 'c'])
    expect(out.map(s => s.slotIndex)).toEqual([0, 1])   // no gap where the duplicate was
  })

  it('shrinks the session to the photos that will actually upload', () => {
    // The session is opened to hold exactly `sessionSlots` credits. Counting duplicates
    // would hold credits for photos that are never sent.
    const out = assignSlots([
      item('a'), item('b', 'duplicate'), item('c', 'duplicate'), item('d'),
    ], 'us_1')
    expect(out).toHaveLength(2)
    expect(out.every(s => s.sessionSlots === 2)).toBe(true)
  })

  it('a batch that is ENTIRELY duplicates opens no session at all', () => {
    // Nothing is assigned, so no session id ever reaches the server and no credits are held.
    expect(assignSlots([
      item('a', 'duplicate'), item('b', 'duplicate'),
    ], 'us_1')).toEqual([])
  })
})

describe('the organizer decides', () => {
  it('"upload anyway" returns the item to the queue', () => {
    expect(nextState('duplicate', 'resolveDuplicate')).toBe('queued')
  })

  it('a re-queued duplicate then gets a slot like any other photo', () => {
    // It never held one, so it is simply un-slotted and joins the next assignment.
    const out = assignSlots([item('a'), item('b')], 'us_2')
    expect(out.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('"skip" cancels it, which is terminal', () => {
    expect(nextState('duplicate', 'cancel')).toBe('cancelled')
    expect(nextState('cancelled', 'resolveDuplicate')).toBeNull()
  })

  it('a skipped duplicate never becomes slottable again', () => {
    expect(assignSlots([item('a', 'cancelled'), item('b')], 'us_1').map(s => s.id))
      .toEqual(['b'])
  })

  it('the decision reaches ONLY duplicates — the rest of the queue is untouched', () => {
    // What stops "skip all duplicates" from cancelling the whole batch.
    for (const state of ['queued', 'uploading', 'processing', 'completed', 'failed', 'paused']) {
      expect(nextState(state as never, 'resolveDuplicate')).toBeNull()
    }
  })
})

describe('the scan splits a mixed batch correctly', () => {
  it('separates fresh from already-stored', () => {
    const scan = scanForDuplicates([
      { itemId: 'i1', checksum: sum(1) },   // stored
      { itemId: 'i2', checksum: sum(2) },   // new
    ], stored)

    expect(scan.matches.map(m => m.itemId)).toEqual(['i1'])
    expect(scan.fresh.map(c => c.itemId)).toEqual(['i2'])
  })

  it('a batch with no duplicates leaves everything fresh', () => {
    const scan = scanForDuplicates([
      { itemId: 'i1', checksum: sum(7) }, { itemId: 'i2', checksum: sum(8) },
    ], stored)
    expect(scan.matches).toHaveLength(0)
    expect(scan.intraBatch).toHaveLength(0)
    expect(scan.fresh).toHaveLength(2)
  })

  it('an intra-batch repeat keeps the FIRST occurrence uploadable', () => {
    // The organizer picked the same file twice. One copy should upload, not zero.
    const scan = scanForDuplicates([
      { itemId: 'i1', checksum: sum(9) }, { itemId: 'i2', checksum: sum(9) },
    ], [])
    expect(scan.fresh.map(c => c.itemId)).toEqual(['i1'])
    expect(scan.intraBatch.map(m => m.itemId)).toEqual(['i2'])
  })

  it('the intra-batch stand-in carries no invented gallery', () => {
    // Its "existing" is an earlier QUEUE item, not a stored asset — the UI reads the empty
    // galleryId as "selected twice in this batch" rather than printing a blank location.
    const scan = scanForDuplicates([
      { itemId: 'i1', checksum: sum(9) }, { itemId: 'i2', checksum: sum(9) },
    ], [])
    expect(scan.intraBatch[0].existing.galleryId).toBe('')
    expect(scan.intraBatch[0].existing.originalFilename).toBeNull()
  })

  it('carries the filename and date the organizer needs to recognise the match', () => {
    const scan = scanForDuplicates([{ itemId: 'i1', checksum: sum(1) }], stored)
    expect(scan.matches[0].existing.originalFilename).toBe('IMG_0001.jpg')
    expect(scan.matches[0].existing.uploadedAtMs).toBeGreaterThan(0)
  })
})
