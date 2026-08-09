// RD-EVENT-12 — the render/persistence split must never lose an edit or render stale data.
//
// Two invariants define this architecture, and every test below serves one of them:
//
//   INV-1  An edit advances persistence and pending, and NEVER render.
//          (This is the optimisation. If it breaks, the per-keystroke render is back.)
//   INV-2  After ANY audited synchronisation point, render === persistence.
//          (This is the safety property. If it breaks, a step seeds from stale data.)
//
// `pending` is asserted throughout because it IS the Firestore payload — proving it is
// untouched by the split is how "Firestore payloads are unchanged" is demonstrated.

import { describe, it, expect } from 'vitest'
import {
  createSplit, applyEdit, syncRenderState, commitSave, failSave, replaceDraft,
  isRenderStale, SYNC_POINTS, type DraftSplit,
} from '@/lib/hooks/draftRenderSync'

const initial = { eventType: 'sports', pricing: { passes: [] }, eventDetails: { name: '' } }

/** Types `n` characters into one field, one autosave emit per character. */
function type(state: DraftSplit, field: string, text: string): DraftSplit {
  let s = state
  for (let i = 1; i <= text.length; i++) s = applyEdit(s, { [field]: { name: text.slice(0, i) } })
  return s
}

describe('INV-1 · editing never touches render state', () => {
  it('20 keystrokes leave render state completely untouched', () => {
    const start = createSplit(initial)
    const after = type(start, 'eventDetails', 'City Marathon 2026!!!')
    expect(after.render).toBe(start.render)          // identity, not just equality
    expect(after.persistence).not.toBe(start.persistence)
  })

  it('persistence accumulates every edit', () => {
    const s = type(createSplit(initial), 'eventDetails', 'abc')
    expect(s.persistence.eventDetails).toEqual({ name: 'abc' })
  })

  it('pending — the Firestore payload — accumulates exactly the edited fields', () => {
    let s = createSplit(initial)
    s = applyEdit(s, { pricing: { passes: [1] } })
    s = applyEdit(s, { eventDetails: { name: 'x' } })
    expect(Object.keys(s.pending).sort()).toEqual(['eventDetails', 'pricing'])
    // Untouched fields are NOT in the payload — the split must not widen a write.
    expect(s.pending).not.toHaveProperty('eventType')
  })

  it('later edits to the same field overwrite earlier ones, as coalescing requires', () => {
    const s = type(createSplit(initial), 'eventDetails', 'abc')
    expect(s.pending.eventDetails).toEqual({ name: 'abc' })
    expect(Object.keys(s.pending)).toEqual(['eventDetails'])
  })

  it('render is reported stale precisely while edits are unsynced', () => {
    const clean = createSplit(initial)
    expect(isRenderStale(clean)).toBe(false)
    const dirty = applyEdit(clean, { eventDetails: { name: 'a' } })
    expect(isRenderStale(dirty)).toBe(true)
    expect(isRenderStale(syncRenderState(dirty))).toBe(false)
  })
})

describe('INV-2 · every audited sync point makes render match persistence', () => {
  const edited = () => type(createSplit(initial), 'eventDetails', 'City Marathon')

  it('navigation', () => {
    const s = syncRenderState(edited())
    expect(s.render).toBe(s.persistence)
    expect(isRenderStale(s)).toBe(false)
  })

  it('saveSuccess', () => {
    const s = commitSave(edited())
    expect(s.render).toBe(s.persistence)
    expect(s.pending).toEqual({})              // the write landed
  })

  it('saveFailure', () => {
    const s = failSave(edited(), { eventDetails: { name: 'in-flight' } })
    expect(s.render).toBe(s.persistence)
    expect(isRenderStale(s)).toBe(false)
  })

  it('conflictResolved', () => {
    const replacement = { eventType: 'meetup', pricing: null, eventDetails: { name: 'Server' } }
    const s = replaceDraft(edited(), replacement)
    expect(s.render).toBe(s.persistence)
    expect(s.render).toBe(replacement)
  })

  it('load / create start with both copies equal', () => {
    const s = createSplit(initial)
    expect(s.render).toEqual(s.persistence)
    expect(isRenderStale(s)).toBe(false)
  })

  it('the audited list is exactly these six — a new point needs justification', () => {
    expect([...SYNC_POINTS]).toEqual([
      'navigation', 'saveSuccess', 'saveFailure', 'conflictResolved', 'load', 'create',
    ])
  })
})

describe('navigation seeds the next step from current data', () => {
  it('the scenario the sync point exists to prevent', () => {
    // Edit passes in Pricing, then Continue to Form. Form seeds its pass list from render
    // state. Without the sync it would seed from the PRE-EDIT pricing.
    let s = createSplit(initial)
    s = applyEdit(s, { pricing: { passes: ['Early Bird', 'Regular'] } })
    expect((s.render.pricing as { passes: string[] }).passes).toEqual([])   // stale, pre-sync
    s = syncRenderState(s)
    expect((s.render.pricing as { passes: string[] }).passes).toEqual(['Early Bird', 'Regular'])
  })
})

describe('persistence is unchanged by the split', () => {
  it('a save clears pending without discarding persisted content', () => {
    const s = commitSave(type(createSplit(initial), 'eventDetails', 'abc'))
    expect(s.pending).toEqual({})
    expect(s.persistence.eventDetails).toEqual({ name: 'abc' })
    expect(s.persistence.eventType).toBe('sports')      // untouched fields survive
  })

  it('a failed save re-queues in-flight fields, newer edits winning on collision', () => {
    // Mirrors `pendingRef.current = { ...inFlight, ...pendingRef.current }` in useDraft.
    let s = createSplit(initial)
    s = applyEdit(s, { eventDetails: { name: 'newer' } })
    const failed = failSave(s, { eventDetails: { name: 'older' }, pricing: { passes: [] } })
    expect(failed.pending.eventDetails).toEqual({ name: 'newer' })   // newer wins
    expect(failed.pending).toHaveProperty('pricing')                 // in-flight restored
  })

  it('edits arriving DURING a save are not lost by the commit', () => {
    // useDraft empties pendingRef before awaiting, so mid-write edits accumulate separately.
    // Modelled here as: commit, then the new edit is still pending afterwards.
    let s = commitSave(type(createSplit(initial), 'eventDetails', 'abc'))
    s = applyEdit(s, { eventDetails: { name: 'abcd' } })
    expect(s.pending.eventDetails).toEqual({ name: 'abcd' })
    expect(isRenderStale(s)).toBe(true)                 // and it will sync at the next point
  })
})

describe('a full typing session ends consistent', () => {
  it('type, pause, save, type again, navigate — nothing is lost or stale', () => {
    let s = createSplit(initial)
    s = type(s, 'eventDetails', 'City')          // burst 1
    expect(isRenderStale(s)).toBe(true)
    s = commitSave(s)                            // debounce elapsed, write succeeded
    expect(isRenderStale(s)).toBe(false)

    s = type(s, 'eventDetails', 'City Marathon') // burst 2
    expect(isRenderStale(s)).toBe(true)

    s = syncRenderState(s)                       // Continue pressed
    expect(isRenderStale(s)).toBe(false)
    expect(s.render.eventDetails).toEqual({ name: 'City Marathon' })
    expect(s.pending.eventDetails).toEqual({ name: 'City Marathon' })
  })
})
