// ─── A pricing bullet is a promise ───────────────────────────────────────────
//
// `featureList` is display metadata, which is exactly why it drifted: nothing gates on it,
// so nothing failed when it went stale. But buildPricingTiers() spreads it straight into the
// public /pricing tier cards, and it also reaches three protected surfaces — the wizard's
// the organizer upgrade `benefits`, and the admin licensing editor. (The wizard's
// LicenseCards grid was removed by RD-CAPACITY-01 — the builder now sells capacity.)
//
// /pricing advertised "Waitlist" as a headline FREE-tier feature while
// WAITLIST_ENABLED is false platform-wide — a capability no organizer on any tier can use.
// Phase 8A removed that claim from three marketing files; it survived here because
// lib/licensing is the pricing ENGINE, not marketing content, so the copy sweeps never
// looked at it.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// The invariant, not the wording: a bullet may name a capability only while that capability
// is reachable at that tier. Each assertion pairs the bullet with the flag or constant that
// decides it, so re-adding "Waitlist" is only possible once the kill switch flips. The rest
// guard the blast radius — prices, fees, limits, entitlements, tier names and order are all
// asserted unchanged, because this was meant to be a display-only edit.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  EVENT_LICENSE_DEFINITIONS_V2,
  EVENT_LICENSE_TIERS_V2,
  EVENT_LICENSE_DEFINITIONS_BY_VERSION,
  EVENT_LICENSE_TIERS,
} from '@/lib/licensing/eventLicense'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { buildPricingPlans } from '@/content/marketing/pricing'
import { getDefaultFeeConfig } from '@/lib/fees/config'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')

const V2 = EVENT_LICENSE_DEFINITIONS_V2
/** Every V1 definition table, whatever versions are registered. */
const V1_TABLES = Object.values(EVENT_LICENSE_DEFINITIONS_BY_VERSION)
const ALL_DEFS = [
  ...Object.values(V2),
  ...V1_TABLES.flatMap(t => Object.values(t)),
] as Array<{ tier: string; name: string; featureList: string[] }>

// ═══════════════════════════════════════════════════════════════════════════════

describe('no tier advertises the waitlist while it is switched off', () => {
  it('the kill switch is still off — the reason the bullet had to go', () => {
    // Read from SOURCE, not imported: lib/registrations/gate.ts transitively pulls in
    // lib/firebase/admin, which parses a service-account key at module load and cannot be
    // imported by a bootless unit test. The literal is the same contract either way.
    const gate = read('lib/registrations/gate.ts')
    expect(gate).toContain('export const WAITLIST_ENABLED = false')
    expect(gate).not.toMatch(/export const WAITLIST_ENABLED = true/)
  })

  it('V2 Free does not list it', () => {
    expect(V2.free.featureList).not.toContain('Waitlist')
  })

  it('V1 Starter does not list it', () => {
    for (const table of V1_TABLES) {
      expect(Object.values(table).find(d => d.tier === 'starter')?.featureList).not.toContain('Waitlist')
    }
  })

  it('NO tier in EITHER catalog lists it', () => {
    // The general rule rather than the two known spots — a new tier cannot reintroduce it.
    for (const d of ALL_DEFS) {
      expect(d.featureList, `${d.name} still advertises a waitlist`)
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/wait-?list/i)]))
    }
  })

  it('and no public pricing card exposes it', () => {
    // RD-CAPACITY-02 · /pricing now builds two capacity-based cards from the commercial
    // terms rather than five tier cards from the catalog. The invariant is unchanged: a
    // bullet is a promise, so none may name a capability the kill switch disables.
    // RD-PRICING-CALC — the cards also take the resolved ticket fee (code defaults; RD-FEE-01: no fixed part, no minimum).
    const row = getDefaultFeeConfig('event_registration', 'starter')
    const fee = { percent: DEFAULT_COMMERCIAL_TERMS.attendeeTransactionFeePercent, fixedPaise: 0,
      minPaise: 0, maxPaise: row.platformFeeMaxPaise, gstRatePercent: row.gstRatePercent }
    for (const t of buildPricingPlans(DEFAULT_COMMERCIAL_TERMS, fee)) {
      expect(t.features.join(' '), `${t.name} card`).not.toMatch(/wait-?list/i)
    }
  })

  it('but the waitlist implementation is untouched', () => {
    // Gated, not deleted. Removing the code would be a product decision; this was a copy fix.
    expect(existsSync(resolvePath(ROOT, 'lib/waitlist/waitlistSettings.ts'))).toBe(true)
    expect(existsSync(resolvePath(ROOT, 'app/api/waitlist/join/route.ts'))).toBe(true)
    expect(existsSync(resolvePath(ROOT, 'app/events/[slug]/register/WaitlistJoinClient.tsx'))).toBe(true)
    expect(read('lib/registrations/gate.ts')).toMatch(/const waitlistEnabled = WAITLIST_ENABLED &&/)
  })
})

describe('the surviving bullets still match their tier entitlements', () => {
  const feat = (t: keyof typeof V2) => V2[t].features as unknown as Record<string, boolean>
  const lim  = (t: keyof typeof V2) => V2[t].limits as unknown as Record<string, number>

  it('a bullet naming a gated capability appears only from the tier that grants it', () => {
    // Each pair: the bullet text, and the flag that actually decides it.
    const GATED: Array<[string, string]> = [
      ['API access',    'apiAccess'],
      ['White label',   'whiteLabel'],
      ['Custom domain', 'customDomain'],
      ['Advanced reports', 'advancedReports'],
      ['Priority support', 'prioritySupport'],
    ]
    for (const [bullet, flag] of GATED) {
      for (const t of EVENT_LICENSE_TIERS_V2) {
        if (V2[t].featureList.includes(bullet)) {
          expect(feat(t)[flag], `${V2[t].name} advertises "${bullet}" but ${flag} is false`).toBe(true)
        }
      }
    }
  })

  it('team-member counts match the declared limits', () => {
    expect(V2.free.featureList).toContain('1 team member')
    expect(lim('free').maxTeamMembers).toBe(1)
    expect(V2.starter.featureList).toContain('3 team members')
    expect(lim('starter').maxTeamMembers).toBe(3)
    expect(V2.professional.featureList).toContain('5 team members')
    expect(lim('professional').maxTeamMembers).toBe(5)
    expect(V2.business.featureList).toContain('10 team members')
    expect(lim('business').maxTeamMembers).toBe(10)
    expect(V2.enterprise.featureList).toContain('Unlimited team members')
  })

  it('the Free bullets that remain are all real capabilities', () => {
    expect(V2.free.featureList).toEqual([
      'Unlimited email', 'QR tickets', 'Certificates', 'Coupons', 'Early bird pricing',
      'Multiple passes', 'Basic analytics', '1 team member',
    ])
  })
})

describe('the edit was display-only — nothing else moved', () => {
  it('prices are unchanged', () => {
    expect(V2.free.licensePricePaise).toBe(0)
    expect(V2.starter.licensePricePaise).toBe(99_900)
    expect(V2.professional.licensePricePaise).toBe(149_900)
    expect(V2.business.licensePricePaise).toBe(249_900)
    expect(V2.enterprise.licensePricePaise).toBe(799_900)
  })

  it('transaction fees are unchanged', () => {
    expect(V2.free.transactionFeePercent).toBe(2.0)
    expect(V2.starter.transactionFeePercent).toBe(1.5)
    expect(V2.professional.transactionFeePercent).toBe(1.0)
    expect(V2.business.transactionFeePercent).toBe(1.0)
    expect(V2.enterprise.transactionFeePercent).toBe(0.5)
  })

  it('tier names and order are unchanged', () => {
    expect(EVENT_LICENSE_TIERS_V2).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    expect(EVENT_LICENSE_TIERS_V2.map(t => V2[t].name))
      .toEqual(['Free', 'Starter', 'Professional', 'Business', 'Enterprise'])
    expect(EVENT_LICENSE_TIERS.length).toBeGreaterThan(0)
  })

  it('entitlement flags are unchanged', () => {
    expect(V2.free.features).toEqual({
      offlineCheckin: false, teamAccess: false, apiAccess: false, whiteLabel: false,
      customDomain: false, advancedReports: false, prioritySupport: false,
    })
    expect(V2.enterprise.features).toEqual({
      offlineCheckin: true, teamAccess: true, apiAccess: true, whiteLabel: true,
      customDomain: true, advancedReports: true, prioritySupport: true,
    })
  })

  it('every tier still has bullets to show', () => {
    for (const d of ALL_DEFS) {
      expect(d.featureList.length, `${d.name} has an empty feature list`).toBeGreaterThan(0)
    }
  })
})
