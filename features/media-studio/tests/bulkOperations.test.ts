// RD-MEDIA-04 — bulk operations and reclamation contracts.
//
// The transactional halves of move/visibility/reclaim need Firestore and are reviewed, not
// executed (no test in this repo touches a database). What IS provable here is the shape of
// the contract every one of them depends on: the action allow-list, the visibility
// allow-list, the deterministic job id, and which statuses are reclaimable.

import { describe, it, expect } from 'vitest'
import {
  ASSIGNABLE_VISIBILITIES, MEDIA_BULK_ACTIONS, MEDIA_JOBS, RECLAIMABLE_STATUSES,
  isAssignableVisibility, isMediaBulkAction,
} from '@/features/media-studio/types'
// From the PURE module: importing the job strategy or the reclamation service would boot
// the Admin SDK and make this contract untestable.
import {
  RECLAIM_AFTER_MS, UPLOAD_URL_TTL_SECONDS, bulkJobId,
} from '@/features/media-studio/utils/bulkOps'

// ═══════════════ The action allow-list ═══════════════

describe('bulk actions', () => {
  it('is exactly delete, move and visibility', () => {
    expect([...MEDIA_BULK_ACTIONS]).toEqual(['delete', 'move', 'visibility'])
  })

  it('is an ALLOW-LIST — anything unrecognised is refused', () => {
    for (const v of ['purge', 'DELETE', '', null, undefined, 42, {}, ['delete']]) {
      expect(isMediaBulkAction(v), String(v)).toBe(false)
    }
  })

  it('accepts every action it declares', () => {
    for (const action of MEDIA_BULK_ACTIONS) expect(isMediaBulkAction(action)).toBe(true)
  })
})

// ═══════════════ The visibility allow-list ═══════════════

describe('assignable visibility', () => {
  it('offers all three, including PRIVATE', () => {
    // PRIVATE is a WITHDRAWAL, not a leak: an organizer must be able to pull a photo back
    // without deleting it. Omitting it would leave "unpublish" impossible.
    expect([...ASSIGNABLE_VISIBILITIES]).toEqual(['PUBLIC', 'PRIVATE', 'SIGNED_URL'])
  })

  it('refuses anything else', () => {
    for (const v of ['public', 'HIDDEN', '', null, undefined, 1, {}]) {
      expect(isAssignableVisibility(v), String(v)).toBe(false)
    }
  })
})

// ═══════════════ Job identity ═══════════════

describe('bulkJobId', () => {
  it('is deterministic — double-clicking "Delete all" resumes, it does not race', () => {
    expect(bulkJobId('gal_1', null, 'delete')).toBe(bulkJobId('gal_1', null, 'delete'))
  })

  it('separates action, gallery and album', () => {
    expect(bulkJobId('gal_1', null, 'delete')).not.toBe(bulkJobId('gal_1', null, 'move'))
    expect(bulkJobId('gal_1', null, 'delete')).not.toBe(bulkJobId('gal_2', null, 'delete'))
    expect(bulkJobId('gal_1', null, 'delete')).not.toBe(bulkJobId('gal_1', 'alb_1', 'delete'))
  })

  it('distinguishes "the whole gallery" from an album', () => {
    expect(bulkJobId('gal_1', null, 'delete')).toContain('__all__')
    expect(bulkJobId('gal_1', 'alb_1', 'delete')).toContain('__alb_1__')
  })

  it('never produces a value Firestore would read as a path', () => {
    for (const action of MEDIA_BULK_ACTIONS) {
      expect(bulkJobId('gal_1', 'alb_1', action)).not.toContain('/')
    }
  })

  it('addresses every action for a scope without a query', () => {
    // The GET route reads jobs by id precisely so listing progress needs no index and no
    // scan. If ids stopped being derivable, that would silently become a collection query.
    const ids = MEDIA_BULK_ACTIONS.map(a => bulkJobId('gal_1', null, a))
    expect(new Set(ids).size).toBe(MEDIA_BULK_ACTIONS.length)
  })
})

// ═══════════════ Reclamation ═══════════════

describe('reclamation', () => {
  it('reclaims exactly the two statuses that strand bytes', () => {
    // `pending`  — authorized, never finished. `deleted` — record marked, objects best-effort.
    // `ready` and `failed` are NOT here: reclaiming a ready asset would delete a real photo.
    expect([...RECLAIMABLE_STATUSES]).toEqual(['pending', 'deleted'])
  })

  it('NEVER includes ready', () => {
    expect(RECLAIMABLE_STATUSES).not.toContain('ready')
  })

  it('waits far longer than a signed upload URL can live', () => {
    // A reservation whose PUT URLs have expired can never complete, so the grace window only
    // has to exceed that TTL — but generously, in case a client retried near the edge.
    expect(RECLAIM_AFTER_MS).toBeGreaterThan(UPLOAD_URL_TTL_SECONDS * 1000 * 4)
  })

  it('is measured in hours, not minutes — a slow upload must never be swept', () => {
    expect(RECLAIM_AFTER_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
  })
})

describe('collections', () => {
  it('bulk jobs live in their own collection', () => {
    expect(MEDIA_JOBS).toBe('mediaJobs')
  })
})
