// RD-LEGACY-01 — the retired licence-tier model (Free / Starter / Professional / Business /
// Enterprise plans, tier feature switches, tier limits) and Media Credits are gone from ACTIVE
// behaviour, while historical records stay readable.
//
// Two kinds of proof, as everywhere in this suite:
//   • BEHAVIOUR — the real route handlers / pure functions, only auth and Firestore stubbed;
//   • SOURCE CONTRACTS — the places a tier could quietly come back are pinned shut.
// The current pay-as-you-go model (capacity + service allowances + paid photo capacity) is
// covered by servicePricingFinal / photoCapacity / publicPricing*; the ceiling fix and the
// historical-licence media resolution run on Firestore in phase4Stage1 / eventCommerceDefects.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.setConfig({ testTimeout: 60_000 })

const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('{/*')).join('\n')

// ─── Stubs: auth + Firestore only. A write of any kind fails the test. ─────────
const h = vi.hoisted(() => ({ superUid: null as string | null, serviceCalls: [] as string[] }))
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: 'org-1', callerUid: 'org-1', permissions: ['wallet', 'events'] }),
}))
vi.mock('@/lib/admin/financialGuard', () => ({
  requireSuperAdmin: async () => (h.superUid ? { uid: h.superUid } : { response: new Response(JSON.stringify({ code: 'SUPER_ADMIN_REQUIRED' }), { status: 403 }) }),
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: new Proxy({}, { get: () => { throw new Error('Firestore must not be touched by a retired route') } }),
  adminAuth: {},
}))
vi.mock('@/features/media-credits/services/purchaseService', () => ({
  purchaseService: new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { h.serviceCalls.push(`purchase.${String(k)}`); void a; return {} } }),
}))
vi.mock('@/features/media-credits/services/refundService', () => ({
  refundService: new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { h.serviceCalls.push(`refund.${String(k)}`); void a; return {} } }),
}))
vi.mock('@/features/media-credits/services/grantService', () => ({
  grantService: new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { h.serviceCalls.push(`grant.${String(k)}`); void a; return {} } }),
}))

const post = (url: string, body: unknown, method = 'POST') => {
  const r = new Request(`http://localhost${url}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  Object.assign(r, { nextUrl: new URL(r.url) })
  return r as never
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> })

beforeEach(() => { h.superUid = null; h.serviceCalls = [] })

// ═══ 4 / 5 · Media Credits cannot be bought, granted or newly refunded ═══════════
describe('Media Credits — no active purchase / grant / refund-request path', () => {
  it('organizer purchase: 410 MEDIA_CREDITS_RETIRED, no service call, no Firestore', async () => {
    const { POST } = await import('@/app/api/organizer/media-credits/purchases/route')
    const r = await json(await POST(post('/api/organizer/media-credits/purchases', { credits: 500 })))
    expect([r.status, r.body.code]).toEqual([410, 'MEDIA_CREDITS_RETIRED'])
    expect(h.serviceCalls).toEqual([])
  })
  it('organizer refund request: 410, no hold placed', async () => {
    const { POST } = await import('@/app/api/organizer/media-credits/refunds/route')
    const r = await json(await POST(post('/api/organizer/media-credits/refunds', { purchaseId: 'p1' })))
    expect([r.status, r.body.code]).toEqual([410, 'MEDIA_CREDITS_RETIRED'])
    expect(h.serviceCalls).toEqual([])
  })
  it('Super Admin grant: a non-admin is 403; a Super Admin gets 410 — nothing is ever granted', async () => {
    const { POST } = await import('@/app/api/admin/media-credits/grants/route')
    expect((await POST(post('/api/admin/media-credits/grants', { organizerUid: 'o', credits: 100 }))).status).toBe(403)
    h.superUid = 'super-1'
    const r = await json(await POST(post('/api/admin/media-credits/grants', { organizerUid: 'o', credits: 100, reason: 'support' })))
    expect([r.status, r.body.code]).toEqual([410, 'MEDIA_CREDITS_RETIRED'])
    expect(h.serviceCalls).toEqual([])
  })
  it('historical reads stay: purchases / refunds / grants keep their GET handlers', async () => {
    for (const m of [
      await import('@/app/api/organizer/media-credits/purchases/route'),
      await import('@/app/api/organizer/media-credits/refunds/route'),
      await import('@/app/api/admin/media-credits/grants/route'),
    ]) expect(typeof (m as { GET?: unknown }).GET).toBe('function')
  })
  it('the retirement does not rest on the policy constant alone, and the admin console offers no grant / approve', () => {
    for (const f of ['app/api/organizer/media-credits/purchases/route.ts', 'app/api/organizer/media-credits/refunds/route.ts', 'app/api/admin/media-credits/grants/route.ts']) {
      const src = code(f)
      expect(src, f).toContain('mediaCreditsRetiredResponse()')
      expect(src, f).not.toMatch(/createPurchaseIntent|createGrant|createRefundRequest/)
    }
    const ui = code('features/media-credits/components/AdminCreditsConsole.tsx')
    expect(ui).not.toContain('GrantCreditsDialog')
    expect(ui).not.toContain('Issue credits')
    expect(ui).not.toMatch(/approve: true/)
    expect(code('app/(dashboard)/dashboard/media-studio/credits/page.tsx')).toContain('Media Credits are no longer used')
  })
})

// ═══ 1 / 2 · no tier can be granted, bought or previewed ═══════════════════════
describe('no new tier: admin comp lever retired; coupons and previews are capacity-only', () => {
  it('PATCH /api/admin/organizers/[uid]/plan: non-admin 403, Super Admin 410 PLAN_RETIRED, no Firestore', async () => {
    const { PATCH } = await import('@/app/api/admin/organizers/[uid]/plan/route')
    expect((await PATCH(post('/api/admin/organizers/u/plan', { overrideTier: 'enterprise', reason: 'comp' }, 'PATCH'))).status).toBe(403)
    h.superUid = 'super-1'
    const r = await json(await PATCH(post('/api/admin/organizers/u/plan', { overrideTier: 'enterprise', reason: 'comp' }, 'PATCH')))
    expect([r.status, r.body.code]).toEqual([410, 'PLAN_RETIRED'])
  })
  it('activation purchase refuses a request without a capacity; a client-sent tier is ignored', () => {
    const src = code('app/api/licensing/purchase/route.ts')
    expect(src).toContain("failureReason: 'capacity_required'")
    expect(src).toContain('defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)')
  })
  it('coupon preview prices capacity only — no tier price is looked up', () => {
    const src = code('app/api/licensing/coupons/validate/route.ts')
    expect(src).toContain("failure: 'capacity_required'")
    expect(src).not.toContain('getEffectiveDefinitionForVersion')
  })
  it('a NEW coupon tier restriction is refused (clearing one is allowed)', () => {
    const src = code('lib/admin/licenseCouponService.ts')
    expect(src).toContain('if (input.tiers && input.tiers.length > 0) throw new CouponAdminError(')
  })
  it('licence admin: grant / upgrade / downgrade AND feature switches answer 410', () => {
    const src = code('lib/admin/licenseAdminService.ts')
    expect(src).toMatch(/action === 'grant' \|\| action === 'upgrade' \|\| action === 'downgrade'[\s\S]{0,300}410\)/)
    expect(src).toMatch(/action === 'overrideFeatures'\) \{\s*throw new LicenseActionError\('[^']*', 410\)/)
    expect(src).not.toContain("case 'overrideFeatures'")
    expect(code('app/(admin)/admin/licenses/PageClient.tsx')).not.toContain('Override feature')
  })
})

// ═══ 3 · no active feature or limit depends on a tier ═════════════════════════
describe('no active tier dependency', () => {
  it('the tier gate primitives are gone', async () => {
    const m = await import('@/lib/licensing/workspaceEntitlements') as Record<string, unknown>
    expect(m.requireFeature).toBeUndefined()
    expect(m.requireLimit).toBeUndefined()
  })
  it('the only reader of tier entitlements is the admin Organizer 360 service (display), and it shows no tier pills', () => {
    const readers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { if (e !== 'node_modules' && !e.startsWith('.')) walk(p); continue }
        if (/\.(ts|tsx)$/.test(e) && p.replace(/\\/g, '/') !== 'lib/licensing/workspaceEntitlements.ts' && code(p).includes('getWorkspaceEntitlements(')) readers.push(p.replace(/\\/g, '/'))
      }
    }
    for (const d of ['app', 'lib', 'features', 'components']) walk(d)
    expect(readers).toEqual(['lib/admin/organizer360Service.ts'])
    const ui = code('app/(admin)/admin/organizers/[organizerUid]/PageClient.tsx')
    expect(ui).not.toContain('entitlements.effectiveTier')
    expect(ui).not.toContain('No premium features enabled')
  })
  it('media limits never read a licence tier: event override → global only', () => {
    const src = code('lib/config/resolveMediaConfig.ts')
    expect(src).not.toMatch(/tierLimits|eventLicenses|EVENT_LICENSES_COLLECTION|resolveEventTier/)
    expect(src).toContain('mergeMediaLayers(global, {}, event, null)')
  })
  it('the organizer registration-limit ceiling is the event’s paid capacity, not a tier', () => {
    const src = code('app/api/organizer/events/[eventId]/pricing-override/route.ts')
    expect(src).toContain('trustedRegistrationCeiling(')
    expect(src).not.toMatch(/isEventLicenseTier|trustedLicenseTier|'starter'/)
  })
})

// ═══ 6 / 7 · photos: paid capacity only, max 3,000 ═════════════════════════════
describe('photos stay paid-capacity only', () => {
  it('max 3,000 per event; uploads reserve against paid capacity', async () => {
    const { MAX_EVENT_PHOTO_CAPACITY } = await import('@/lib/licensing/photoCapacity')
    expect(MAX_EVENT_PHOTO_CAPACITY).toBe(3000)
    const prep = code('app/api/organizer/media-studio/uploads/prepare/route.ts')
    expect(prep).toContain('reservePhotoUpload')
    expect(prep).not.toMatch(/openSession|consumeInTx|creditsPerPhoto/)
  })
})

// ═══ 10 / 11 · history stays readable ═════════════════════════════════════════
describe('historical tier licences and orders remain readable', () => {
  it('the V1 and V2 catalogs still resolve every historical tier (the config schema keeps the overrides)', async () => {
    const { getEventLicenseDefinition, getEventLicenseDefinitionV2, EVENT_LICENSE_TIERS_V2 } = await import('@/lib/licensing/eventLicense')
    expect(getEventLicenseDefinition('growth').name).toBeTruthy()
    for (const t of EVENT_LICENSE_TIERS_V2) expect(getEventLicenseDefinitionV2(t).name).toBeTruthy()
    const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
    expect(BUSINESS_CONFIG_DEFAULTS.licensing).toHaveProperty('tierOverridesV2')
    expect(BUSINESS_CONFIG_DEFAULTS.licensing).toHaveProperty('tierOverrides')
  })
  it('a historical tier licence is labelled legacy; a capacity licence reports its PAID capacity', () => {
    const api = code('app/api/organizer/licenses/route.ts')
    expect(api).toContain("const isCapacity = d.commercialModel === 'capacity'")
    expect(api).toContain('isCapacity ? (evCap ?? licCap ?? Infinity) : resolveLicenseEntryForVersion(')
    const tab = code('app/(dashboard)/dashboard/settings/billing/LicensesTab.tsx')
    expect(tab).toContain("'Pay as you go'")
    expect(tab).toContain('(legacy)')
    expect(tab).not.toContain('All tiers')
  })
  it('checkout/confirm still settles a pre-existing tier order (no historical payment is stranded)', () => {
    expect(code('app/api/licensing/checkout/confirm/route.ts')).toContain('getEffectiveDefinitionForVersion')
  })
})

// ═══ 14 · no tier UI in Business Configuration ════════════════════════════════
describe('Business Configuration shows only the current model', () => {
  it('Licensing: commercial model, coupons and service allowances — no tier cards, no dead toggle', () => {
    const src = code('app/(admin)/admin/business-configuration/LicensingEditor.tsx')
    for (const gone of ['EVENT_LICENSE_TIERS_V2', 'getEventLicenseDefinitionV2', 'setOverride', 'Offer price', 'Regular price', 'Max registrations', 'Feature list', 'Legacy tiers', 'purchasesEnabled']) {
      expect(src, gone).not.toContain(gone)
    }
    for (const kept of ['Commercial Model', 'License Coupons', 'ServiceAllowancesBlock', 'activationRatePaise', 'freeRegistrationCapacity', 'maximumEventCapacity']) {
      expect(src, kept).toContain(kept)
    }
  })
  it('Media Studio: no licence-tier limit table and no Media Credits block', () => {
    const src = code('app/(admin)/admin/business-configuration/MediaStudioEditor.tsx')
    for (const gone of ['Licence tier limits', 'EVENT_LICENSE_TIERS_V2', 'tierLimits', 'Media Credits', 'creditsPerPhoto', 'ADMIN_MEDIA_CREDITS']) {
      expect(src, gone).not.toContain(gone)
    }
  })
})

// ═══ 15 · navigation ══════════════════════════════════════════════════════════
describe('navigation carries no plan / tier destination', () => {
  it('admin: no Plans / Tiers / Subscriptions entry; Media Credits is labelled retired; no upgrade/tier keywords', async () => {
    const { ADMIN_SIDEBAR_NAV } = await import('@/config/navigation')
    const items = ADMIN_SIDEBAR_NAV.flatMap(g => g.items)
    for (const i of items) {
      expect(i.label).not.toMatch(/\b(plans?|tiers?|subscriptions?)\b/i)
      expect(String(i.keywords ?? '')).not.toMatch(/\b(upgrade|downgrade|tier|grant)\b/i)
    }
    const credits = items.find(i => /media credits/i.test(i.label))
    expect(credits?.label).toBe('Media Credits (retired)')
  })
  it('organizer: no plan / tier / credits entry', async () => {
    const { WORKSPACE_NAV_ITEMS } = await import('@/config/workspaceNav')
    for (const i of WORKSPACE_NAV_ITEMS) expect(i.label).not.toMatch(/\b(plans?|tiers?|subscriptions?|credits?)\b/i)
  })
})

// ═══ 16 · public website ══════════════════════════════════════════════════════
describe('public copy describes pay-as-you-go only', () => {
  const PUBLIC = [
    'app/pricing/page.tsx', 'app/contact/page.tsx', 'app/terms/page.tsx', 'app/refund-policy/page.tsx',
    'content/marketing/pricing.ts', 'content/marketing/faq.ts', 'content/marketing/final-cta.ts',
    'content/marketing/support.ts', 'content/marketing/security.ts',
  ]
  it('no Starter / Professional / Business / Enterprise plan, no paid plans, no plan upgrade, no Media Credits', () => {
    for (const f of PUBLIC) {
      const src = code(f)
      expect(src, f).not.toMatch(/\b(starter|professional|business|enterprise|growth)\s+(plan|tier|licen[cs]e)s?\b/i)
      expect(src, f).not.toMatch(/\bpaid plans?\b|\beligible plans?\b|\benterprise plans?\b|\bupgrade as you grow\b/i)
      expect(src, f).not.toMatch(/media credits?/i)
    }
  })
})

// ═══ Decisions 1–5 (final legacy cleanup) ══════════════════════════════════════
describe('decision 1 · a stored legacy tier restriction on a coupon is INERT', async () => {
  const { validateLicenseCoupon } = await import('@/lib/licensing/coupons/validate')
  const { couponDoc, couponCtx } = await import('../fixtures/coupon')
  const NOW = Date.parse('2026-10-07T00:00:00Z')

  it('an otherwise-valid coupon restricted to any retired tier applies to a capacity order (tier = free stamp)', () => {
    for (const t of ['starter', 'professional', 'business', 'enterprise', 'growth']) {
      const r = validateLicenseCoupon(couponDoc({ restrictions: { tiers: [t], eventTypes: [] } }), couponCtx({ tier: 'free' }), NOW)
      expect(r.ok, t).toBe(true)
    }
  })
  it('the restriction is preserved on the record (nothing rewritten) and the other restrictions still bind', () => {
    const c = couponDoc({ restrictions: { tiers: ['enterprise'], eventTypes: ['sports'] } })
    expect(validateLicenseCoupon(c, couponCtx({ tier: 'free', eventType: 'conference' }), NOW).ok).toBe(false)   // event type still enforced
    expect(c.restrictions.tiers).toEqual(['enterprise'])
  })
  it('a coupon never selects a tier: the validator result carries no tier, and the purchase stamps the free tier', () => {
    expect(code('lib/licensing/coupons/validate.ts')).not.toMatch(/r\.tiers[\s\S]{0,40}includes\(ctx\.tier\)/)
    expect(code('app/api/licensing/purchase/route.ts')).toContain('defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)')
    expect(code('app/(admin)/admin/license-center/PageClient.tsx')).toContain('Legacy tier restriction (inactive')
  })
})

describe('decision 2 · the Media Credits console is non-commercial', () => {
  it('no Buy / Grant / Approve, no live price, every section that remains says it is historical', () => {
    const ui = code('features/media-credits/components/AdminCreditsConsole.tsx')
    for (const gone of ['GrantCreditsDialog', 'Issue credits', 'approve: true', 'title="Pricing"', 'Credit price', 'Credits per photo']) expect(ui, gone).not.toContain(gone)
    expect(ui).toContain('title="Historical position (retired)"')
    expect(ui).toContain('title="Historical sales (retired)"')
    expect(ui).toContain('title="Credit grants (historical)"')
    expect(code('app/(admin)/admin/media-credits/page.tsx')).toContain('Media Credits (retired)')
  })
})

describe('decision 4 · no obsolete tier price or forged tier decides a NEW publish / order', () => {
  it('publish never reads the draft tier or a catalog price to decide payment; only a historical paid tier ORDER grants a tier', () => {
    const src = code('app/api/events/publish/route.ts')
    expect(src).not.toMatch(/draft\.licenseTier/)
    expect(src).not.toMatch(/isPaidTier|selectedDef|validatePublishEligibility|starterActiveEventCount/)
    expect(src).toContain("order.commercialModel !== 'capacity'")
    expect(src).toContain('const resolvedTier: AnyEventLicenseTier = legacyTier ?? freeStamp')
  })
  it('checkout/confirm settles ONLY an existing historical tier order (410 TIER_RETIRED otherwise), at its stored price', () => {
    const src = code('app/api/licensing/checkout/confirm/route.ts')
    expect(src).toContain("code: 'TIER_RETIRED'")
    expect(src).toMatch(/!preExisting \|\| preExisting\.commercialModel === 'capacity' \|\| preExisting\.tier !== body\.tier/)
    expect(src).not.toContain('pricePaise  = def.licensePricePaise')
  })
  it('a historical tier order is priced from what it stored, never the catalog (orderListPricePaise)', async () => {
    const { orderListPricePaise } = await import('@/lib/licensing/finalizeLicensePurchase')
    expect(orderListPricePaise({ amountPaise: 499_900 } as never, 123_400)).toBe(499_900)
    expect(orderListPricePaise({ amountPaise: 400_000, originalPricePaise: 499_900 } as never, 123_400)).toBe(499_900)
    expect(orderListPricePaise({ capacityChange: { totalPaise: 70_800 } } as never, 99_900)).toBe(70_800)   // capacity: its snapshot
    expect(orderListPricePaise(null, 0)).toBe(0)
  })
  it('the purchase route prices only the capacity quote (no tier price lookup)', () => {
    const src = code('app/api/licensing/purchase/route.ts')
    expect(src).toContain('pricePaise: quotedPricePaise,')
    expect(src).not.toContain('effectivePricePaise')
  })
})

describe('decision 5 · Admin Licenses status tabs scroll inside their own container', () => {
  it('FilterTabs has an opt-in scrollable mode (Finance approach) and only Admin Licenses enables it', () => {
    const ft = code('components/admin/FilterTabs.tsx')
    expect(ft).toContain("scrollable && 'max-w-full overflow-x-auto'")
    expect(ft).toContain("scrollable && 'shrink-0 whitespace-nowrap'")
    expect(code('app/(admin)/admin/licenses/PageClient.tsx')).toContain('<FilterTabs scrollable options={STATUS_FILTERS}')
  })
})
