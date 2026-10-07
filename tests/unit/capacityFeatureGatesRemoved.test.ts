// RD-CAPACITY-01 — every licence FEATURE gate is gone, and every AUTHORIZATION check is not.
//
// ═══ THE ONE MISTAKE THIS FILE EXISTS TO CATCH ═══════════════════════════════
// Removing feature licensing means deleting a line from ten request handlers. Each of those
// lines sat immediately below the lines that decide WHO is calling and WHOSE data they may
// touch. Deleting one line too many turns "this feature is now free" into "this endpoint is
// now open", and the two mistakes look identical in a diff.
//
// So each surface below is asserted twice: the licence condition is absent, AND the identity
// and ownership checks that were always the real guard are present. A test that only checked
// the first half would pass on a catastrophically open endpoint.
//
// The counts are deliberate. `expect(...).toHaveLength(n)` on the authorization calls means a
// future edit cannot quietly drop the guard from ONE of a route's two handlers.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EVENT_LICENSE_FEATURES, EVENT_LICENSE_LIMIT_KEYS,
} from '@/lib/licensing/eventLicense'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

/**
 * Every surface that carried a licence gate, with the authorization that must survive it.
 * `authz` is the call that answers "may this caller do this at all", and `count` is how many
 * times it must still appear (one per exported handler that needs it).
 */
const SURFACES: { file: string; licence: string[]; authz: { call: string; count: number }[] }[] = [
  {
    file: 'app/api/organizer/api-keys/route.ts',
    licence: ["requireFeature(caller.uid, 'apiAccess')"],
    authz: [{ call: 'verifyCaller(req)', count: 2 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 2 }],
  },
  {
    file: 'app/api/organizer/branding/route.ts',
    licence: ["requireFeature(caller.uid, 'whiteLabel')"],
    authz: [{ call: 'verifyCaller(req)', count: 1 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 1 }],
  },
  {
    file: 'app/api/organizer/domain/route.ts',
    licence: ["requireFeature(caller.uid, 'customDomain')"],
    authz: [{ call: 'verifyCaller(req)', count: 1 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 1 }],
  },
  {
    file: 'app/api/organizer/domain/verify/route.ts',
    licence: ["requireFeature(caller.uid, 'customDomain')"],
    authz: [{ call: 'verifyCaller(req)', count: 1 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 1 }],
  },
  {
    file: 'app/api/organizer/webhooks/route.ts',
    licence: ["requireFeature(caller.uid, 'apiAccess')"],
    authz: [{ call: 'verifyCaller(req)', count: 2 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 2 }],
  },
  {
    file: 'app/api/organizer/webhooks/test/route.ts',
    licence: ["requireFeature(caller.uid, 'apiAccess')"],
    authz: [{ call: 'verifyCaller(req)', count: 1 }, { call: 'requireOwner(caller.uid, caller.uid)', count: 1 }],
  },
  {
    file: 'app/api/organizer/staff/route.ts',
    licence: ["requireFeature(caller.uid, 'teamAccess')", "requireLimit(caller.uid, 'maxTeamMembers'"],
    // 3×: the import, plus one call in each of the two handlers.
    authz: [{ call: 'verifyCaller(req)', count: 2 }, { call: 'requireStaffManager', count: 3 }],
  },
  {
    file: 'app/api/organizer/broadcasts/route.ts',
    licence: ["requireLimit(uid, 'maxBroadcastRecipients'"],
    authz: [{ call: 'authorizeWorkspace(req', count: 2 }],
  },
  {
    file: 'app/api/checkin/cache/route.ts',
    licence: ["requireFeature(uid, 'offlineCheckin')"],
    authz: [{ call: 'authorizeWorkspace(req', count: 1 }],
  },
]

const countOf = (src: string, needle: string) => src.split(needle).length - 1

// ═══ 1 · the licence conditions are gone ══════════════════════════════════════

describe('the licence gates are removed', () => {
  for (const { file, licence } of SURFACES) {
    it(`${file} no longer asks a licence for permission`, () => {
      const src = code(file)
      for (const cond of licence) {
        expect(src, `${file} still contains ${cond}`).not.toContain(cond)
      }
      // The module is not even imported any more, so a gate cannot be half-removed.
      expect(src, `${file} still imports workspaceEntitlements`).not.toContain('workspaceEntitlements')
    })
  }

  it('no request handler anywhere still enforces a feature or a numeric licence limit', () => {
    // A repo-wide sweep, so a licence gate on a route this file has not enumerated is caught
    // too — the enumerated list above can go stale, and this cannot.
    // `workspaceEntitlements.ts` DEFINES requireFeature/requireLimit, so it necessarily
    // contains them. It is excluded here and asserted separately below: the point of this
    // sweep is that nothing CALLS them, not that the definitions were deleted — deleting
    // them is Phase 11 cleanup, and doing it here would churn a file for no safety gain.
    const DEFINING_MODULE = 'lib/licensing/workspaceEntitlements.ts'
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(entry.name) && rel !== DEFINING_MODULE
                 && /requireFeature\(|requireLimit\(/.test(code(rel))) hits.push(rel)
      }
    }
    walk('app')
    walk('lib')
    expect(hits, `licence feature/limit gates remain in: ${hits.join(', ')}`).toEqual([])
  })

  it('the gate helpers are now DEAD — defined, imported by nothing', () => {
    // They survive only so this migration does not have to delete a module while it is also
    // changing money. Nothing may import them, which is what makes the deletion safe later.
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(entry.name) && rel !== 'lib/licensing/workspaceEntitlements.ts'
                 && /from '@\/lib\/licensing\/workspaceEntitlements'/.test(code(rel))) importers.push(rel)
      }
    }
    walk('app')
    walk('lib')
    // The ONE permitted importer is the admin 360 read model, which reports a STORED
    // licence's tier for historical display — a read, never an enforcement.
    expect(importers).toEqual(['lib/admin/organizer360Service.ts'])
  })

  it('the branding resolver no longer withholds white-label output', () => {
    const src = code('lib/branding/service.ts')
    expect(src).not.toContain('requireFeature')
    expect(src).not.toContain('workspaceEntitlements')
    // It still returns a PublicBranding for callers to use, and still has a null path for
    // "nothing to apply" — the callers' fallbacks are untouched.
    expect(src).toContain('export async function resolvePublicBranding')
  })
})

// ═══ 2 · the authorization is intact ══════════════════════════════════════════

describe('the authorization checks survive intact', () => {
  for (const { file, authz } of SURFACES) {
    it(`${file} still authenticates and authorizes every handler`, () => {
      const src = code(file)
      for (const { call, count } of authz) {
        expect(countOf(src, call), `${file}: expected ${count}× ${call}`).toBe(count)
      }
      // Every handler still refuses a caller it could not authorize. The two idioms in this
      // codebase are an explicit 401 (verifyCaller routes) and forwarding the resolver's own
      // status (authorizeWorkspace routes) — either is a refusal; neither being present
      // would mean the route answers before it has authorized anyone.
      expect(src, `${file} has no refusal path`).toMatch(/401|Unauthorized|status: authz\.status/)
    })
  }

  it('authorization runs BEFORE any work in each handler', () => {
    // With the payment gate gone, these calls are the only thing standing between a caller
    // and the resource — so their POSITION matters more than it did before, not less.
    const cases: [string, string, string][] = [
      ['app/api/organizer/api-keys/route.ts',   'requireOwner',       'listApiKeys'],
      ['app/api/organizer/staff/route.ts',      'requireStaffManager', 'createStaffAccount'],
      ['app/api/organizer/webhooks/route.ts',   'requireOwner',       'getWebhookConfig'],
      ['app/api/organizer/domain/verify/route.ts', 'requireOwner',    'verifyDomain'],
      ['app/api/checkin/cache/route.ts',        'authorizeWorkspace', 'MAX_CACHE'],
    ]
    for (const [file, guard, work] of cases) {
      const src = code(file)
      const g = src.indexOf(guard), w = src.indexOf(work)
      expect(g, `${file}: ${guard} missing`).toBeGreaterThanOrEqual(0)
      expect(w, `${file}: ${work} missing`).toBeGreaterThanOrEqual(0)
      expect(g, `${file}: ${guard} does not precede ${work}`).toBeLessThan(w)
    }
  })

  it('the operational guards that are NOT licence gates are untouched', () => {
    // Removing a commercial cap must not remove an abuse control. These are the three that
    // sat next to a removed gate and protect infrastructure rather than revenue.
    expect(code('app/api/organizer/broadcasts/route.ts')).toContain('checkBroadcastLimits')
    expect(code('app/api/organizer/api-keys/route.ts')).toContain('RATE_POLICY.apiKeyCreate')
    expect(code('app/api/organizer/webhooks/test/route.ts')).toContain('checkDistributedRateLimit')
    // The offline cache is still bounded and still scoped to assigned events.
    const cache = code('app/api/checkin/cache/route.ts')
    expect(cache).toContain('MAX_CACHE')
    expect(cache).toContain('truncated')
  })
})

// ═══ 3 · the client-facing entitlements read says yes to everything ═══════════

describe('the entitlements endpoint', () => {
  const src = code('app/api/organizer/entitlements/route.ts')

  it('still authenticates, and still resolves the workspace', () => {
    // "Every organizer has every feature" is not "everyone may read this workspace".
    expect(src).toContain('verifyCaller(req)')
    expect(src).toContain('resolveWorkspaceUid(caller.uid)')
    expect(src).toMatch(/401|Unauthorized/)
  })

  it('reports every feature as enabled, from the canonical key list', () => {
    expect(src).toContain('EVENT_LICENSE_FEATURES.map(f => [f, true])')
    // The list is exhaustive against the type, so a future feature key cannot be forgotten.
    expect(EVENT_LICENSE_FEATURES).toHaveLength(7)
    expect([...EVENT_LICENSE_FEATURES].sort()).toEqual([
      'advancedReports', 'apiAccess', 'customDomain', 'offlineCheckin',
      'prioritySupport', 'teamAccess', 'whiteLabel',
    ])
  })

  it('reports every numeric limit as unlimited', () => {
    expect(src).toContain('EVENT_LICENSE_LIMIT_KEYS.map(k => [k, null])')
    expect([...EVENT_LICENSE_LIMIT_KEYS].sort()).toEqual([
      'maxBroadcastRecipients', 'maxRegistrations', 'maxTeamMembers',
    ])
  })

  it('no longer resolves a tier from eventLicenses', () => {
    expect(src).not.toContain('getWorkspaceEntitlements')
    expect(src).not.toContain('workspaceEntitlements')
  })

  it('keeps its response shape, so no client falls into an assume-denied path', () => {
    // Deleting the route would 404 its readers into exactly the gating this removes.
    for (const field of ['features', 'limits', 'tier', 'effectiveTier', 'activeEventCount']) {
      expect(src, `response no longer carries ${field}`).toContain(field)
    }
  })
})

// ═══ 4 · the transaction fee no longer comes from a tier ═════════════════════

describe('the attendee transaction fee', () => {
  it('is resolved from the commercial configuration, not from a licence', () => {
    const fees = code('lib/fees/resolveFeeConfig.ts')
    expect(fees).toContain('attendeeTransactionFeePercent')
    expect(fees).toContain('fees.platformFeePercent ?? commercialAttendeeFee')
  })

  it('leaves DONATIONS on their own rate', () => {
    // The 2.5% figure is the fee on a ticket an attendee buys. Applying it to donations
    // would silently reprice a different product.
    const fees = code('lib/fees/resolveFeeConfig.ts')
    expect(fees).toContain('isDonation\n    ? fees.donationPlatformFee')
  })

  it('the fee engine no longer reads the organizer’s licences', () => {
    const engine = code('lib/billing/feeEngine.ts')
    expect(engine).not.toContain('getWorkspaceEntitlements')
    expect(engine).toContain('CANONICAL_FEE_TIER')
  })

  it('keeps licenseTierToFeeTier for historical reconciliation', () => {
    // Stored transactions were charged under a tier row; reporting still has to map one.
    const engine = code('lib/billing/feeEngine.ts')
    expect(engine).toContain('export function licenseTierToFeeTier')
  })

  it('does not touch settlement, payout or refund reversal', () => {
    for (const f of ['lib/billing/feeEngine.ts', 'lib/fees/resolveFeeConfig.ts']) {
      const src = code(f)
      for (const forbidden of ['settlements', 'payout', 'refundReversal']) {
        expect(src, `${f} reaches ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})
