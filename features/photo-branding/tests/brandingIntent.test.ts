// RD-PHOTO-04 — the branding workflow state machine.
//
// Every branding surface (the import gate, the branding page, the Media Studio hub card, the
// gallery badge) renders from `resolveBrandingWorkflow`. These tests are what stop them
// disagreeing about an event.
//
// The defect this whole sprint exists to prevent: an organizer creates an event, imports
// 4,000 photos, and only then discovers branding is permanently unavailable — because
// nothing asked them first. `canImport` is the guard, and it is asserted here for every
// combination rather than trusted.
//
// PURE: no firebase-admin anywhere in the import graph.

import { describe, it, expect } from 'vitest'
import {
  isBrandingIntent, resolveBrandingWorkflow,
  type BrandingFacts, type BrandingWorkflowState,
} from '@/features/photo-branding/utils/brandingIntent'

const facts = (over: Partial<BrandingFacts> = {}): BrandingFacts => ({
  intent: null, hasOverlay: false, overlayEnabled: false, photoCount: 0, ...over,
})

describe('STATE 0 · undecided', () => {
  it('is the state when no decision has been recorded and no photos exist', () => {
    const w = resolveBrandingWorkflow(facts())
    expect(w.state).toBe('undecided')
    expect(w.canImport).toBe(false)
    expect(w.brandingApplies).toBe(false)
  })

  it('stays undecided even when artwork has been uploaded but never chosen', () => {
    // Artwork alone is not a decision. Uploading is what RECORDS the decision (the route
    // does that); a document written by hand, or an older event, must still be asked.
    const w = resolveBrandingWorkflow(facts({ hasOverlay: true, overlayEnabled: true }))
    expect(w.state).toBe('undecided')
    expect(w.canImport).toBe(false)
  })

  it('BLOCKS import — this is the guard against accidental unbranded imports', () => {
    expect(resolveBrandingWorkflow(facts()).canImport).toBe(false)
  })
})

describe('STATE 1 · enabled', () => {
  const w = resolveBrandingWorkflow(facts({
    intent: 'branded', hasOverlay: true, overlayEnabled: true,
  }))

  it('resolves when branding was chosen and usable artwork exists', () => {
    expect(w.state).toBe('enabled')
  })

  it('allows import and applies branding', () => {
    expect(w.canImport).toBe(true)
    expect(w.brandingApplies).toBe(true)
  })
})

describe('STATE 2 · disabled', () => {
  const w = resolveBrandingWorkflow(facts({ intent: 'unbranded' }))

  it('resolves when the organizer chose to import without branding', () => {
    expect(w.state).toBe('disabled')
  })

  it('allows import and applies nothing', () => {
    expect(w.canImport).toBe(true)
    expect(w.brandingApplies).toBe(false)
  })

  it('stays disabled even if artwork is lying around, because it is switched off', () => {
    // Choosing "without branding" switches the overlay off (`setBrandingIntent`), so this is
    // the state that combination lands in. The organizer's choice wins.
    const x = resolveBrandingWorkflow(facts({
      intent: 'unbranded', hasOverlay: true, overlayEnabled: false,
    }))
    expect(x.state).toBe('disabled')
    expect(x.brandingApplies).toBe(false)
  })
})

describe('STATE 3 · required', () => {
  it('resolves when branding was chosen but no artwork exists', () => {
    // The state that was UNREACHABLE before this sprint: `enabled` used to live on the
    // overlay document, so "I want branding" could not be expressed without artwork.
    const w = resolveBrandingWorkflow(facts({ intent: 'branded' }))
    expect(w.state).toBe('required')
    expect(w.canImport).toBe(false)
  })

  it('also resolves when artwork exists but is switched off', () => {
    // Importing here would silently produce unbranded photos for an organizer who expects
    // branding — so it blocks rather than proceeding.
    const w = resolveBrandingWorkflow(facts({
      intent: 'branded', hasOverlay: true, overlayEnabled: false,
    }))
    expect(w.state).toBe('required')
    expect(w.canImport).toBe(false)
  })
})

describe('STATE 4 · locked', () => {
  it('wins over every other state once photos exist', () => {
    const combos: Partial<BrandingFacts>[] = [
      { intent: null },
      { intent: 'branded', hasOverlay: true, overlayEnabled: true },
      { intent: 'unbranded' },
      { intent: 'branded' },
    ]
    for (const c of combos) {
      expect(resolveBrandingWorkflow(facts({ ...c, photoCount: 1 })).state).toBe('locked')
    }
  })

  it('still ALLOWS import — the lock settles what branding is, not whether importing continues', () => {
    const w = resolveBrandingWorkflow(facts({
      intent: 'branded', hasOverlay: true, overlayEnabled: true, photoCount: 900,
    }))
    expect(w.canImport).toBe(true)
    expect(w.brandingApplies).toBe(true)
    expect(w.photoCount).toBe(900)
  })

  it('reports what LEGACY events actually got, not what someone later chose', () => {
    // An event imported before this sprint has photos and no recorded intent. It must not
    // claim branding it never had.
    const w = resolveBrandingWorkflow(facts({ intent: null, photoCount: 4000 }))
    expect(w.state).toBe('locked')
    expect(w.brandingApplies).toBe(false)
  })
})

describe('the resolver as a whole', () => {
  it('returns exactly one state for every combination, with none unmapped', () => {
    const valid: BrandingWorkflowState[] = ['undecided', 'enabled', 'disabled', 'required', 'locked']
    for (const intent of [null, 'branded', 'unbranded'] as const) {
      for (const hasOverlay of [true, false]) {
        for (const overlayEnabled of [true, false]) {
          for (const photoCount of [0, 1, 5000]) {
            const w = resolveBrandingWorkflow({ intent, hasOverlay, overlayEnabled, photoCount })
            expect(valid).toContain(w.state)
            // `locked` and `photoCount > 0` must never disagree.
            expect(w.locked).toBe(photoCount > 0)
          }
        }
      }
    }
  })

  it('blocks import ONLY for undecided and required', () => {
    for (const intent of [null, 'branded', 'unbranded'] as const) {
      for (const hasOverlay of [true, false]) {
        for (const overlayEnabled of [true, false]) {
          for (const photoCount of [0, 1]) {
            const w = resolveBrandingWorkflow({ intent, hasOverlay, overlayEnabled, photoCount })
            const shouldBlock = w.state === 'undecided' || w.state === 'required'
            expect(w.canImport).toBe(!shouldBlock)
          }
        }
      }
    }
  })

  it('never promises branding it cannot deliver', () => {
    // `brandingApplies` is what the upload queue acts on. It must never be true without
    // usable artwork, or the wizard would promise a logo the pipeline cannot draw.
    for (const intent of [null, 'branded', 'unbranded'] as const) {
      for (const hasOverlay of [true, false]) {
        for (const overlayEnabled of [true, false]) {
          for (const photoCount of [0, 3]) {
            const w = resolveBrandingWorkflow({ intent, hasOverlay, overlayEnabled, photoCount })
            if (w.brandingApplies) expect(hasOverlay && overlayEnabled).toBe(true)
          }
        }
      }
    }
  })

  it('treats a nonsensical photo count as no photos', () => {
    expect(resolveBrandingWorkflow(facts({ photoCount: NaN })).locked).toBe(false)
    expect(resolveBrandingWorkflow(facts({ photoCount: -3 })).locked).toBe(false)
  })
})

describe('isBrandingIntent', () => {
  it('accepts only the two real values', () => {
    expect(isBrandingIntent('branded')).toBe(true)
    expect(isBrandingIntent('unbranded')).toBe(true)
  })

  it('rejects anything a hand-edited document could contain', () => {
    // The guard is what stops a third state entering the machine through Firestore.
    for (const bad of [null, undefined, '', 'BRANDED', 'true', 1, {}, []]) {
      expect(isBrandingIntent(bad)).toBe(false)
    }
  })
})
