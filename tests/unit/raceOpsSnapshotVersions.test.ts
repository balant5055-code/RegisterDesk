// RD-RACEOPS-02G · Snapshot version allocation — the PURE half.
//
// A version number is an allocation, never a pointer. After `live v6 → rollback → v4` the
// next build must be v7; before this sprint it was `doc.version + 1` = v5, a number that
// already had entries. These tests pin the allocator's arithmetic and the two fail-closed
// detections the repositories rely on; the transactional behaviour is proven on the
// emulator in `tests/emulator/snapshotVersionAllocation.emu.test.ts`.

import { describe, it, expect } from 'vitest'
import {
  findDuplicateVersion, highestAllocatedVersion, inconsistentHistoryMessage,
  nextAllocatableVersion, versionAlreadyPublished,
} from '@/features/race-operations/utils/snapshotVersions'

const history = (...versions: number[]) => versions.map(version => ({ version }))

describe('RD-RACEOPS-02G · nextAllocatableVersion never reuses a number', () => {
  it('a race that has never published starts at v1', () => {
    expect(nextAllocatableVersion({})).toBe(1)
    expect(nextAllocatableVersion({ version: 0, versions: [] })).toBe(1)
  })

  it('a live race with no history field moves on from the live pointer', () => {
    expect(nextAllocatableVersion({ version: 3 })).toBe(4)
  })

  it('the exact 02F shape: live rolled back 6 → 4 with history [1,3,4,6] allocates v7, never v5', () => {
    const doc = { version: 4, versions: history(1, 3, 4, 6) }
    expect(nextAllocatableVersion(doc)).toBe(7)
  })

  it('an abandoned pending lane counts as allocated', () => {
    // live v4 (rolled back), lane v5 abandoned by another session, v6 published.
    expect(nextAllocatableVersion({ version: 4, pendingVersion: 5, versions: history(1, 3, 4, 6) })).toBe(7)
    // a lane above everything published is stepped past too
    expect(nextAllocatableVersion({ version: 2, pendingVersion: 9, versions: history(1, 2) })).toBe(10)
  })

  it('maxVersion is the authority once present, whatever the live pointer says', () => {
    expect(nextAllocatableVersion({ version: 2, maxVersion: 8, versions: history(1, 2, 3) })).toBe(9)
    expect(highestAllocatedVersion({ version: 2, maxVersion: 8 })).toBe(8)
  })

  it('a legacy document derives maxVersion from every field that can hold a version', () => {
    expect(highestAllocatedVersion({ version: 4, pendingVersion: null, versions: history(1, 2, 3, 4, 5, 6) })).toBe(6)
    expect(highestAllocatedVersion({ version: 6, pendingVersion: 7, versions: history(1, 6) })).toBe(7)
  })

  it('a stale or corrupt maxVersion below the history can never pull the allocator down', () => {
    expect(nextAllocatableVersion({ version: 4, maxVersion: 2, versions: history(1, 3, 4, 6) })).toBe(7)
  })

  it('garbage in the version fields is treated as "nothing allocated", never as NaN', () => {
    expect(nextAllocatableVersion({ version: Number.NaN, maxVersion: -3, pendingVersion: undefined, versions: null })).toBe(1)
    expect(nextAllocatableVersion({ versions: [{ version: 2.9 }, { version: Number.POSITIVE_INFINITY }] })).toBe(3)
  })

  it('repeated rollbacks with corrections in between keep climbing', () => {
    // publish 1..4, rollback 4→2, correction → 5, rollback 5→3, correction → 6
    let doc = { version: 4, maxVersion: 4, versions: history(1, 2, 3, 4) }
    doc = { ...doc, version: 2 }
    expect(nextAllocatableVersion(doc)).toBe(5)
    doc = { version: 5, maxVersion: 5, versions: history(1, 2, 3, 4, 5) }
    doc = { ...doc, version: 3 }
    expect(nextAllocatableVersion(doc)).toBe(6)
  })
})

describe('RD-RACEOPS-02G · history integrity checks', () => {
  it('findDuplicateVersion names the first repeated version, or null', () => {
    expect(findDuplicateVersion(history(1, 3, 4, 6))).toBeNull()
    expect(findDuplicateVersion(history(1, 3, 4, 6, 5, 6))).toBe(6)
    expect(findDuplicateVersion(history(2, 2))).toBe(2)
    expect(findDuplicateVersion([])).toBeNull()
    expect(findDuplicateVersion(undefined)).toBeNull()
  })

  it('versionAlreadyPublished says whether promoting a version would duplicate a record', () => {
    expect(versionAlreadyPublished(history(1, 3, 4, 6), 6)).toBe(true)
    expect(versionAlreadyPublished(history(1, 3, 4, 6), 5)).toBe(false)
    expect(versionAlreadyPublished(history(1, 3, 4, 6), 7)).toBe(false)
    expect(versionAlreadyPublished(null, 1)).toBe(false)
  })

  it('the fail-closed message names the duplicated version and says what is blocked', () => {
    const msg = inconsistentHistoryMessage(6)
    expect(msg).toContain('version 6')
    expect(msg).toMatch(/cannot be published or restored/)
  })
})
