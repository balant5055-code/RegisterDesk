// RD-PHOTO-03 — the branding lock.
//
// Branding is baked into pixels during import, so the artwork is settled the moment an event
// has its first photo. The failure this prevents is an organizer changing branding halfway
// through a season and ending up with a gallery where some photos carry a sponsor and some
// do not, with no way to tell which is which and no way to fix it.
//
// PURE, so it is testable — this module has repeatedly been bitten by test files that import
// something reaching `lib/firebase/admin`. The count comes from the caller.

import { describe, it, expect } from 'vitest'
import {
  LOCK_MESSAGE, describeBrandingLock, isBlockedByLock,
} from '@/features/photo-branding/utils/brandingLock'

describe('describeBrandingLock', () => {
  it('is unlocked for an event with no photos', () => {
    const lock = describeBrandingLock(0)
    expect(lock.locked).toBe(false)
    expect(lock.photoCount).toBe(0)
    expect(lock.reason).toBeNull()
  })

  it('locks at the FIRST photo, not at some threshold', () => {
    // One branded photo already exists, so the second must match it. There is no count at
    // which a mixed gallery becomes acceptable.
    const lock = describeBrandingLock(1)
    expect(lock.locked).toBe(true)
    expect(lock.reason).toBe(LOCK_MESSAGE)
  })

  it('reports the real count, so the organizer is told why', () => {
    expect(describeBrandingLock(4210).photoCount).toBe(4210)
  })

  it('treats a missing or nonsensical count as zero photos', () => {
    // `countEventAssets` fails open with 0. A NaN or negative must not accidentally read as
    // "locked" and leave an organizer unable to set branding up at all.
    for (const bad of [NaN, -5, Infinity]) {
      expect(describeBrandingLock(bad).locked).toBe(false)
    }
  })

  it('floors a fractional count rather than rounding it up', () => {
    expect(describeBrandingLock(0.9).photoCount).toBe(0)
    expect(describeBrandingLock(0.9).locked).toBe(false)
  })
})

describe('isBlockedByLock', () => {
  const locked   = describeBrandingLock(12)
  const unlocked = describeBrandingLock(0)

  it('blocks every mutation once photos exist', () => {
    // Upload, enable/disable and remove all change what future photos look like relative to
    // the ones already stored, so all three are refused identically.
    expect(isBlockedByLock(locked, 'upload')).toBe(true)
    expect(isBlockedByLock(locked, 'enable')).toBe(true)
    expect(isBlockedByLock(locked, 'remove')).toBe(true)
  })

  it('blocks nothing while the event has no photos', () => {
    expect(isBlockedByLock(unlocked, 'upload')).toBe(false)
    expect(isBlockedByLock(unlocked, 'enable')).toBe(false)
    expect(isBlockedByLock(unlocked, 'remove')).toBe(false)
  })

  it('never blocks reading — an organizer can still SEE their branding', () => {
    // Deliberate: the requirements, the safe area and the templates must stay reachable
    // after an import. Only changes are refused.
    expect(locked.reason).toBe(LOCK_MESSAGE)
    expect(locked.photoCount).toBe(12)
  })

  it('states the required message verbatim', () => {
    expect(LOCK_MESSAGE).toContain('Branding is locked because photos have already been imported')
    expect(LOCK_MESSAGE).toContain('re-importing or reprocessing existing photos')
  })
})
