// RD-CAPACITY-DEFAULT — the License & Services step persists the capacity it shows, so an
// organizer who leaves the default 100 free registrations untouched can publish.
// End-to-end (draft route → publish → stored totalCapacity) is in
// tests/emulator/defaultCapacityPublish.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { capacityIntentToPersist, isPersistedCapacity } from '@/lib/events/builder/capacityIntent'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { CURRENT_LICENSE_VERSION, defaultLicenseTierForVersion } from '@/lib/licensing/eventLicense'

// legacyEntitlement's reader needs Firestore; only its PURE rule is exercised here.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
const { resolveLegacyTier } = await import('@/lib/licensing/legacyEntitlement')

const FREE = DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity
const code = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n')
const draft = (extra: Record<string, unknown> = {}) => ({ id: 'd1', status: 'draft', ...extra })

describe('capacityIntentToPersist', () => {
  it('the free default is 100', () => {
    expect(FREE).toBe(100)
  })
  it('default, no interaction: the step persists the displayed 100', () => {
    expect(capacityIntentToPersist(draft(), true, FREE, false)).toBe(100)
  })
  it('a draft saved before the fix (no capacity) gets the default when License opens', () => {
    expect(capacityIntentToPersist(draft({ registrationCapacity: null }), true, FREE, false)).toBe(100)
  })
  it('only on the License & Services step, and only once the draft exists', () => {
    expect(capacityIntentToPersist(draft(), false, FREE, false)).toBeNull()
    expect(capacityIntentToPersist(null, true, FREE, false)).toBeNull()
    expect(capacityIntentToPersist({ status: 'draft' }, true, FREE, false)).toBeNull()
  })
  it('never overwrites a capacity the draft already carries (free or paid)', () => {
    expect(capacityIntentToPersist(draft({ registrationCapacity: 100 }), true, 100, false)).toBeNull()
    expect(capacityIntentToPersist(draft({ registrationCapacity: 437 }), true, 437, false)).toBeNull()
    expect(capacityIntentToPersist(draft({ registrationCapacity: 200_000 }), true, 200_000, false)).toBeNull()
  })
  it('an unusable stored value is replaced by what the step shows', () => {
    for (const bad of [0, -5, 1.5, '100', Number.NaN, true]) {
      expect(capacityIntentToPersist(draft({ registrationCapacity: bad }), true, FREE, false), String(bad)).toBe(100)
    }
  })
  it('a submitted event is never touched (capacity changes go through the capacity-change flow)', () => {
    for (const status of ['published', 'pending_review']) {
      expect(capacityIntentToPersist(draft({ status }), true, FREE, false), status).toBeNull()
    }
  })
  it('never writes an invalid displayed value', () => {
    expect(capacityIntentToPersist(draft(), true, 0, false)).toBeNull()
    expect(capacityIntentToPersist(draft(), true, 2.5, false)).toBeNull()
  })
  it('waits for the quote: nothing is written while the legacy verdict is unknown', () => {
    expect(capacityIntentToPersist(draft(), true, FREE, null)).toBeNull()
  })
  it('a VERIFIED legacy paid tier is never given the free default', () => {
    expect(capacityIntentToPersist(draft(), true, FREE, true)).toBeNull()
    expect(capacityIntentToPersist(draft({ licenseTier: 'professional' }), true, FREE, true)).toBeNull()
  })
  it('a tier named on the draft alone changes nothing — only the server verdict counts', () => {
    expect(capacityIntentToPersist(draft({ licenseTier: 'professional' }), true, FREE, false)).toBe(100)
  })
  it('isPersistedCapacity accepts positive whole numbers only', () => {
    expect([100, 1, 437].every(isPersistedCapacity)).toBe(true)
    expect([0, -1, 1.5, '100', null, undefined, Number.NaN].some(isPersistedCapacity)).toBe(false)
  })
})

describe('resolveLegacyTier — the publish route rule, now shared with the quote', () => {
  const V = CURRENT_LICENSE_VERSION
  const paid = { tier: 'professional', status: 'paid' }
  it('a paid historical tier order entitles its tier', () => {
    expect(resolveLegacyTier(paid, V)).toBe('professional')
  })
  it('no order, an unpaid order, a capacity order, the free stamp or an unknown tier: no entitlement', () => {
    expect(resolveLegacyTier(null, V)).toBeNull()
    expect(resolveLegacyTier({ ...paid, status: 'created' }, V)).toBeNull()
    expect(resolveLegacyTier({ ...paid, status: 'refunded' }, V)).toBeNull()
    expect(resolveLegacyTier({ ...paid, commercialModel: 'capacity' }, V)).toBeNull()
    expect(resolveLegacyTier({ ...paid, tier: defaultLicenseTierForVersion(V) }, V)).toBeNull()
    expect(resolveLegacyTier({ ...paid, tier: 'platinum' }, V)).toBeNull()
  })
})

describe('wiring — the wizard saves the default before Pay / Publish read the draft', () => {
  const page = code('app/(dashboard)/dashboard/events/new/page.tsx')
  it('the page persists the intent when the License step is open, once per draft', () => {
    expect(page).toContain("draft, currentStep === indexOfStep(wizardFlow, 'license'), selectedCapacity,")
    expect(page).toContain('legacyVerdict && legacyVerdict.draftId === draft?.id ? legacyVerdict.legacy : null')
    expect(page.match(/onLegacyEntitlement={onLegacyEntitlement}/g)?.length).toBe(2)
    expect(page).toContain('void updateDraft({ registrationCapacity: capacityIntent })')
    expect(page).toContain('capacityIntentWrittenFor.current = draft.id')
  })
  it('the displayed capacity is still the stored one, else the free allowance', () => {
    expect(page).toContain(': DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity')
  })
  it('Publish and Pay both settle the draft before the server reads it', () => {
    expect(page.match(/if \(!\(await settleDraft\(\)\)\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(code('components/wizard/ActivationPaymentPanel.tsx')).toContain('if (onSettle && !(await onSettle()))')
  })
  it('the License step reports the quote legacy verdict; the quote reads the shared rule', () => {
    const step = code('components/wizard/LicenseServicesStep.tsx')
    expect(step).toContain("quote && quote.mode === 'draft' ? quote.legacyEntitlement != null : null")
    const quote = code('app/api/licensing/checkout/quote/route.ts')
    expect(quote).toContain('await readLegacyEntitlement(eventId, uid)')
    expect(quote).toContain('legacyEntitlement,')
  })
  it('the publish route decides legacy entitlement with the SAME shared rule', () => {
    expect(code('app/api/events/publish/route.ts')).toContain('const legacyTier: AnyEventLicenseTier | null = resolveLegacyTier(order, currentVersion)')
  })
  it('the server still refuses a draft with no capacity (validation not removed)', () => {
    const route = code('app/api/events/publish/route.ts')
    expect(route).toContain("reason: 'CAPACITY_NOT_CONFIGURED'")
    expect(route).toContain('if (requestedCapacity === null && !hasLegacyPaidEntitlement)')
  })
})
