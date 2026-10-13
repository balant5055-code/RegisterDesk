// RD-PRINT-P8 — unit tests for the Phase 8 code work: the paid ID-badge pilot (W5), the dedicated
// badge-round recovery cron and its monitoring (W6) and the print route budgets / Operations Center
// settlement (W2). Module mocks only: no database, no network. Real Firestore behaviour is in
// tests/emulator/printBadgePurchase.emu.test.ts (P8-P*), printBadgeGenerationBilling.emu.test.ts (P8-G*)
// and badgeRoundRecovery.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>, loadFailed: false, throws: false, calls: [] as Array<{ fresh?: boolean } | undefined>,
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: new Proxy({}, { get: () => () => { throw new Error('no database in unit tests') } }) }))
vi.mock('@/lib/config/businessConfigService', () => ({
  businessConfig: {
    getStoredLayer: async (opts?: { fresh?: boolean }) => {
      h.calls.push(opts)
      if (h.throws) throw new Error('boom')
      return { stored: h.stored, loadFailed: h.loadFailed }
    },
  },
}))

import {
  validatePrintBadgePilot, parsePrintBadgePilot, isPilotOrganizer, withPilotMembership, printBadgePilotLocks,
  DEFAULT_PRINT_BADGE_PILOT, PRINT_BADGE_PILOT_MAX_ORGANIZERS, PILOT_ENFORCEMENT_LOCKED,
} from '@/lib/licensing/printBadgePilot'
import { readPrintBadgePilot } from '@/lib/licensing/printBadgePilotServer'
import {
  badgeSettingsOf, badgeSettingsChanged, badgeSettingsProblems, describeBadgeSettingsIssue, defaultBadgeSettings,
} from '@/lib/licensing/printBadgeSettings'
import { PAID_BADGE_GENERATION_RELEASED, type EffectivePrintBadgeTerms } from '@/lib/licensing/printBadgeCommercial'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'
import { evaluateAlerts, type OperationsHealth } from '@/lib/operations/healthMetrics'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const ORG = 'org_pilot_1'

beforeEach(() => { h.stored = {}; h.loadFailed = false; h.throws = false; h.calls = [] })

describe('release gates stay closed', () => {
  it('both code gates are false; pilot enforcement cannot be switched off by configuration', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
    expect(PILOT_ENFORCEMENT_LOCKED).toBe(true)
    expect(read('lib/licensing/printBadgeCommercial.ts')).toContain('export const PAID_BADGE_GENERATION_RELEASED = false')
    expect(read('lib/licensing/serviceAllowances.ts')).toMatch(/print_badges: false,\n\}\)/)
  })
})

describe('W5 · the pilot setting (pure)', () => {
  it('absent ⇒ enforced with NOBODY; a valid list ⇒ exactly those organizers', () => {
    const none = parsePrintBadgePilot(undefined)
    expect(none.ok).toBe(true)
    expect(isPilotOrganizer(none, ORG)).toBe(false)
    const one = parsePrintBadgePilot({ enforced: true, organizerUids: [ORG] })
    expect(isPilotOrganizer(one, ORG)).toBe(true)
    expect(isPilotOrganizer(one, 'someone-else')).toBe(false)
    expect(isPilotOrganizer(one, undefined)).toBe(false)
    expect(DEFAULT_PRINT_BADGE_PILOT).toEqual({ enforced: true, organizerUids: [] })
  })

  it('malformed ⇒ invalid (denies); enforcement off ⇒ invalid while locked — never an open door', () => {
    const bad: unknown[] = [
      null, 'x', [], { enforced: true }, { organizerUids: [ORG] }, { enforced: 'yes', organizerUids: [ORG] },
      { enforced: true, organizerUids: ORG }, { enforced: true, organizerUids: [ORG, ORG] }, { enforced: true, organizerUids: ['bad uid!'] },
      { enforced: true, organizerUids: [ORG], extra: 1 },
      { enforced: true, organizerUids: Array.from({ length: PRINT_BADGE_PILOT_MAX_ORGANIZERS + 1 }, (_, i) => `u${i}`) },
    ]
    for (const v of bad) {
      expect(validatePrintBadgePilot(v).length, JSON.stringify(v)).toBeGreaterThan(0)
      const r = parsePrintBadgePilot(v)
      expect(r, JSON.stringify(v)).toEqual({ ok: false, reason: 'invalid' })
      expect(isPilotOrganizer(r, ORG)).toBe(false)
    }
    expect(validatePrintBadgePilot({ enforced: false, organizerUids: [ORG] })).toEqual([])    // well-formed …
    expect(parsePrintBadgePilot({ enforced: false, organizerUids: [ORG] })).toEqual({ ok: false, reason: 'invalid' })   // … but not honoured
    expect(printBadgePilotLocks({ enforced: false, organizerUids: [] })).toHaveLength(1)
    expect(printBadgePilotLocks({ enforced: true, organizerUids: [] })).toEqual([])
    expect(validatePrintBadgePilot({ enforced: true, organizerUids: Array.from({ length: PRINT_BADGE_PILOT_MAX_ORGANIZERS }, (_, i) => `u${i}`) })).toEqual([])
  })

  it('effective terms: outside the pilot a paid / complimentary event becomes FREE (not_in_pilot); members are unchanged', () => {
    const paid = { mode: 'paid', reason: 'paid', chargeable: true, unitPricePaise: 20, gstRatePercent: 18, couponsAllowed: true, priceConfigured: true, sources: { mode: 'global', unitPricePaise: 'global', couponsAllowed: 'default' } } as EffectivePrintBadgeTerms
    expect(withPilotMembership(paid, true)).toBe(paid)
    expect(withPilotMembership(paid, false)).toMatchObject({ mode: 'free', reason: 'not_in_pilot', chargeable: false })
    expect(withPilotMembership({ ...paid, mode: 'complimentary', chargeable: false, reason: 'complimentary' }, false)).toMatchObject({ mode: 'free', reason: 'not_in_pilot' })
    const free = { ...paid, mode: 'free', chargeable: false, reason: 'global_disabled' } as EffectivePrintBadgeTerms
    expect(withPilotMembership(free, false)).toBe(free)
  })
})

describe('W5 · the server read (stored layer only, fail closed)', () => {
  it('reads the STORED licensing.printBadgePilot; a failed load or a throw ⇒ unavailable', async () => {
    h.stored = { licensing: { printBadgePilot: { enforced: true, organizerUids: [ORG] } } }
    expect(isPilotOrganizer(await readPrintBadgePilot(), ORG)).toBe(true)
    h.stored = {}
    expect(await readPrintBadgePilot()).toMatchObject({ ok: true })            // absent ⇒ nobody
    h.loadFailed = true
    expect(await readPrintBadgePilot()).toEqual({ ok: false, reason: 'unavailable' })
    h.loadFailed = false; h.throws = true
    expect(await readPrintBadgePilot()).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('`fresh` reaches the configuration service (cache bypass) only when asked for', async () => {
    await readPrintBadgePilot()
    await readPrintBadgePilot({ fresh: true })
    expect(h.calls).toEqual([{ fresh: false }, { fresh: true }])
    const svc = read('lib/config/businessConfigService.ts')
    expect(svc).toContain('async getStoredLayer(opts: { fresh?: boolean } = {})')
    expect(svc).toContain('const c = await this.loadStored(opts.fresh === true)')
  })
})

describe('W5 · authorization boundaries (source contracts; behaviour in the emulator suites)', () => {
  it('purchase: quote checks the pilot right after the code gate; order creation reads it FRESH', () => {
    const q = read('lib/licensing/printBadgePurchase/quote.ts')
    const gate = q.indexOf("return no(403, 'NOT_RELEASED'"), pilot = q.indexOf('const pilot = await readPrintBadgePilot({ fresh: args.freshPilot === true })'), owner = q.indexOf("no(403, 'OWNER_REQUIRED'")
    expect(gate).toBeGreaterThan(0); expect(pilot).toBeGreaterThan(gate); expect(owner).toBeGreaterThan(pilot)
    expect(q).toContain("no(403, 'PILOT_ONLY'")
    expect(q).toContain("no(503, 'CONFIG_UNAVAILABLE'")
    expect(read('lib/licensing/printBadgePurchase/orders.ts')).toContain('freshPilot: true })')
  })
  it('activation: one FRESH read; unreadable ⇒ throw (retry, no hold); not a member ⇒ refusal (hold) — after the gate check', () => {
    const s = read('lib/licensing/printBadgePurchase/settle.ts')
    expect(s).toContain('const pilot = await readPrintBadgePilot({ fresh: true })')
    const gate = s.indexOf("return refuse('not_released')")
    const thr = s.indexOf('if (!pilot.ok) throw new BadgePilotUnavailableError(pilot.reason)')
    const ref = s.indexOf("if (!isPilotOrganizer(pilot, o.organizerUid)) return refuse('not_in_pilot')")
    expect(gate).toBeGreaterThan(0); expect(thr).toBeGreaterThan(gate); expect(ref).toBeGreaterThan(thr)
    // The early returns (already paid / held / not payable) come BEFORE the pilot is evaluated.
    expect(s.indexOf("return pay.paymentId === o.razorpayPaymentId ? { kind: 'already' }")).toBeLessThan(thr)
  })
  it('generation: gate first (no read), then the pilot; outside it free with NO event read; unreadable ⇒ unavailable', () => {
    const s = read('lib/printAssets/badgeBilling/store.ts')
    const fn = s.slice(s.indexOf('export async function resolvePrintJobBillingMode'), s.indexOf('// ─── Reads'))
    const gate = fn.indexOf("if (gate.mode === 'free') return { ok: true, mode: 'free', terms: null }")
    const pilot = fn.indexOf('const pilot = await readPrintBadgePilot({ fresh: opts.freshPilot === true })')   // RD-PRINT-P8.2
    const unavailable = fn.indexOf("if (!pilot.ok) return { ok: false, reason: 'unavailable' }")
    const notMember = fn.indexOf("if (!isPilotOrganizer(pilot, owner.organizerUid)) return { ok: true, mode: 'free', terms: null, notInPilot: true }")
    const eventRead = fn.indexOf("adminDb.collection('events').doc(eventSlug).get()")
    expect(gate).toBeGreaterThan(0)
    expect(pilot).toBeGreaterThan(gate); expect(unavailable).toBeGreaterThan(pilot); expect(notMember).toBeGreaterThan(unavailable)
    expect(eventRead).toBeGreaterThan(notMember)
  })
  it('paid reopen outside the pilot ⇒ PILOT_REMOVED (409), unreadable ⇒ BILLING_UNAVAILABLE (503) — billing never switched in place', () => {
    const s = read('lib/printAssets/generationJob.ts')
    const fn = s.slice(s.indexOf('async function reopenPaidPrintJob'))
    expect(fn.indexOf("code: 'PILOT_REMOVED'")).toBeGreaterThan(0)
    expect(fn.indexOf("code: 'BILLING_UNAVAILABLE'")).toBeGreaterThan(0)
    expect(fn.indexOf("code: 'PILOT_REMOVED'")).toBeLessThan(fn.indexOf('await reopenTargets('))
    // RD-PRINT-P8.3 — the reopen decision reads the pilot FRESH (never a stale cached membership).
    expect(fn.slice(0, fn.indexOf("code: 'PILOT_REMOVED'"))).toContain('const pilot = await readPrintBadgePilot({ fresh: true })')
    expect(read('components/print-assets/badges/badgeErrors.ts')).toContain("case 'PILOT_REMOVED':")
  })
  it('refund processing never consults the pilot or the purchase gate', () => {
    const s = read('lib/wallet/serviceRequests.ts')
    const fn = s.slice(s.indexOf('async function stageBadgeRefundProcessing'), s.indexOf('export async function decideServiceRequest'))
    expect(fn).not.toMatch(/readPrintBadgePilot|isPilotOrganizer|isServicePurchaseReleased/)
  })
  it('displays agree with the server: summary and the admin terms route apply membership; no client authority', () => {
    expect(read('lib/printAssets/badgeBilling/summary.ts')).toContain("else if (!isPilotOrganizer(pilot, args.workspaceUid)) state = 'not_in_pilot'")
    const admin = read('app/api/admin/events/[slug]/print-badges/route.ts')
    expect(admin).toContain('pilotEffective(global.ok ? resolveEffectivePrintBadgeTerms(global.terms, storedRaw) : null, pilot, ev.uid)')
    for (const f of ['components/admin/AdminPrintBadgePanel.tsx', 'components/print-assets/badges/badgeErrors.ts', 'app/(admin)/admin/business-configuration/LicensingEditor.tsx']) {
      expect(read(f), f).not.toMatch(/readPrintBadgePilot|printBadgePilotServer/)
    }
  })
})

describe('W5 · badge settings: the pilot list is a badge setting (reason + audit), enforcement off is locked', () => {
  it('change detection: absent ≡ default; a new list is a change', () => {
    const base = badgeSettingsOf({})
    expect(badgeSettingsChanged(base, badgeSettingsOf({ printBadgePilot: { enforced: true, organizerUids: [] } }))).toBe(false)
    expect(badgeSettingsChanged(base, badgeSettingsOf({ printBadgePilot: { enforced: true, organizerUids: [ORG] } }))).toBe(true)
  })
  it('problems: invalid list ⇒ errors; enforcement off ⇒ locked; a valid list ⇒ nothing', () => {
    expect(badgeSettingsProblems(badgeSettingsOf({ printBadgePilot: { enforced: true, organizerUids: [ORG] } }))).toEqual({ errors: [], locked: [] })
    expect(badgeSettingsProblems(badgeSettingsOf({ printBadgePilot: { enforced: true, organizerUids: ['bad uid'] } })).errors.length).toBe(1)
    expect(badgeSettingsProblems(badgeSettingsOf({ printBadgePilot: { enforced: false, organizerUids: [ORG] } })).locked.length).toBe(1)
    const issue = describeBadgeSettingsIssue(badgeSettingsProblems(badgeSettingsOf({ printBadgePilot: { enforced: true, organizerUids: [ORG, ORG] } })).errors[0])
    expect(issue).toEqual({ field: 'printBadgePilot', message: 'The pilot list contains the same organizer more than once.' })
    expect(defaultBadgeSettings().printBadgePilot).toEqual({ enforced: true, organizerUids: [] })
  })
  it('the settings route audits the pilot list before and after, in the save transaction', () => {
    const r = read('app/api/admin/business-config/route.ts')
    expect(r).toContain('printBadgePilot: before.printBadgePilot ?? null')
    expect(r).toContain('printBadgePilot: after.printBadgePilot ?? null')
    const cfg = read('lib/config/businessConfig.ts')
    expect(cfg).toContain('if (c?.printBadgePilot !== undefined) errors.push(...validatePrintBadgePilot(c.printBadgePilot))')
  })
})

describe('W2 · print route budgets and Operations Center settlement', () => {
  it('the six long-running print routes declare maxDuration = 60 on the Node runtime', () => {
    for (const f of [
      'app/api/organizer/print-jobs/route.ts', 'app/api/organizer/print-jobs/quote/route.ts',
      'app/api/organizer/print-jobs/[jobId]/process/route.ts', 'app/api/organizer/print-jobs/[jobId]/retry/route.ts',
      'app/api/organizer/print-packages/route.ts', 'app/api/organizer/print-packages/[jobId]/process/route.ts',
    ]) {
      const s = read(f)
      expect(s, f).toContain('export const maxDuration = 60')
      expect(s, f).not.toMatch(/export const runtime\s*=\s*['"]edge['"]/)
    }
  })
  it('Operations Center cancel settles a print job round after a successful cancel, and never fakes success', () => {
    const s = read('app/api/admin/operations-center/jobs/cancel/route.ts')
    const cancel = s.indexOf('const status = await cancelJob(collection, jobId)')
    const notFound = s.indexOf("if (status === null) return NextResponse.json({ error: 'Job not found' }, { status: 404 })")
    const settle = s.indexOf("await settlePrintBadgeRound(jobId, 'admin_cancel')")
    expect(cancel).toBeGreaterThan(0); expect(notFound).toBeGreaterThan(cancel); expect(settle).toBeGreaterThan(notFound)
    expect(s).toContain('if (collection === BILLED_JOBS_COLLECTION) {')
    expect(s).toContain("captureError(err, { scope: 'admin.ops_cancel.badge_round', area: 'print' })")
    expect(s).toContain('const adminUid = await resolveAdminUid(')              // authorization unchanged
  })
})

describe('W6 · the dedicated recovery cron and its monitoring', () => {
  it('route: cron auth, metrics name, 60 s; walk: 40 s budget, 100 per page, compare-and-set cursor', () => {
    const r = read('app/api/cron/badge-rounds-reconcile/route.ts')
    expect(r).toContain('if (!isAuthorizedCron(req)) return cronUnauthorized()')
    expect(r).toContain("export const POST = withCronMetrics('badge-rounds-reconcile', handle)")
    expect(r).toContain('export const maxDuration = 60')
    const w = read('lib/printAssets/badgeBilling/roundRecovery.ts')
    expect(w).toContain('export const ROUND_BUDGET_MS = 40_000')
    expect(w).toContain('export const ROUND_PAGE = 100')
    expect(w).toContain('if (readState(snap.exists ? snap.data() : undefined).version !== expectedVersion) return null')
    expect(w).not.toMatch(/\.(update|delete)\(|txn\.create|claimBadgeForItem|createBilledJob|txnTrimUnits/)    // it only commits its cursor; settlement is the store's
    expect(read('.github/workflows/cron-recovery.yml')).toContain('/api/cron/badge-rounds-reconcile')
    expect(read('app/api/cron/print-generation/route.ts')).toContain('badgeRounds = await sweepPrintBadgeRounds()')   // the fast path stays
  })

  const health = (over: Partial<OperationsHealth['financial']> = {}, crons: OperationsHealth['crons'] = []): OperationsHealth => ({
    financial: {
      pendingSettlements: 0, failedRefunds: 0, pendingWalletTopups: 0, walletTopupsNeedsReview: 0, walletTopupsExhausted: 0, walletTopupDuplicatePayments: 0,
      pendingRegistrationReconciliation: 0, pendingDonationReconciliation: 0, outstandingClawbacks: 0, badgeSuspiciousUnreviewed: 0, badgeRoundsStale: 0, ...over,
    },
    webhook: { pendingDeliveries: 0, failedDeliveries: 0, exhaustedRetries: 0, oldestPendingAt: null },
    broadcast: { scheduled: 0, sending: 0, failed: 0, stuckSending: 0 },
    dataIntegrity: { eventMismatches: 0, passMismatches: 0, campaignMismatches: 0, sessionMismatches: 0, walletMismatches: 0 },
    crons, generatedAt: new Date(0).toISOString(),
  } as OperationsHealth)
  const cron = (cronName: string) => ({ cronName, lastSuccessAt: null, lastFailureAt: null, runCount: 1, failureCount: 0, lastOk: true, failedWithin24h: false, stale: true })

  it('a stale badge cron is a CRITICAL page (both); both are tracked for staleness', () => {
    const alerts = evaluateAlerts(health({}, [cron('badge-orders-reconcile'), cron('badge-rounds-reconcile')] as OperationsHealth['crons']))
    expect(alerts.find(a => a.id === 'cron_stale_critical')?.message).toMatch(/badge-orders-reconcile, badge-rounds-reconcile/)
    const m = read('lib/operations/healthMetrics.ts')
    expect(m).toContain("'badge-orders-reconcile': 10 * MIN, 'badge-rounds-reconcile': 10 * MIN,")
  })
  it('stale open rounds and unreviewed suspicious badge payments raise WARNINGS; a failed count (-1) raises nothing', () => {
    const a = evaluateAlerts(health({ badgeRoundsStale: 2, badgeSuspiciousUnreviewed: 1 }))
    expect(a.find(x => x.id === 'badge_rounds_stale')?.severity).toBe('warning')
    expect(a.find(x => x.id === 'badge_suspicious_payments')?.severity).toBe('warning')
    expect(evaluateAlerts(health({ badgeRoundsStale: -1, badgeSuspiciousUnreviewed: -1 })).filter(x => x.id.startsWith('badge_'))).toEqual([])
  })
})
