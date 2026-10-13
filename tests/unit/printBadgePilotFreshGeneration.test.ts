// RD-PRINT-P8.2 — a NEW generation job reads the paid ID-badge pilot FRESH (bypassing the 60-second
// configuration cache); quote previews and summaries keep the cached read. Unit tests of
// resolvePrintJobBillingMode with the stored-configuration layer split into a FRESH view (what Firestore
// holds now) and a CACHED view (what the 60 s cache still holds). Module mocks only — no database.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const ORG = 'org_p82'
const h = vi.hoisted(() => ({
  gateOpen: true,
  fresh: { licensing: { printBadgePilot: { enforced: true, organizerUids: ['org_p82'] } } } as Record<string, unknown>,
  cached: { licensing: { printBadgePilot: { enforced: true, organizerUids: ['org_p82'] } } } as Record<string, unknown>,
  freshFails: false, cachedFails: false,
  storedCalls: [] as Array<{ fresh?: boolean } | undefined>,
  eventReads: 0, termsReads: 0,
}))

// The configuration service: `fresh: true` sees Firestore now; otherwise the (possibly stale) cache.
vi.mock('@/lib/config/businessConfigService', () => ({
  businessConfig: {
    getStoredLayer: async (opts?: { fresh?: boolean }) => {
      h.storedCalls.push(opts)
      return opts?.fresh === true ? { stored: h.fresh, loadFailed: h.freshFails } : { stored: h.cached, loadFailed: h.cachedFails }
    },
  },
}))
// The paid-generation code gate, opened in this test process only (the source constant stays false).
vi.mock('@/lib/licensing/printBadgeCommercial', async orig => {
  const real = await orig<typeof import('@/lib/licensing/printBadgeCommercial')>()
  return { ...real, resolveEffectivePrintBadgeTerms: (g: Parameters<typeof real.printBadgePrecedence>[0], o: unknown) => (h.gateOpen ? real.printBadgePrecedence(g, o) : real.resolveEffectivePrintBadgeTerms(g, o)) }
})
vi.mock('@/lib/licensing/printBadgeTermsServer', () => ({
  getGlobalPrintBadgeTerms: async () => { h.termsReads++; return { ok: true, terms: { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }, saleState: 'available' } },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name !== 'events') throw new Error(`unexpected read ${name}/${id}`)
          h.eventReads++
          const data: Record<string, unknown> = { uid: ORG, draftId: 'draft_p82' }
          return { exists: true, get: (k: string) => data[k] }
        },
      }),
    }),
  },
}))

import { resolvePrintJobBillingMode } from '@/lib/printAssets/badgeBilling/store'
import { PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const OWNER = { organizerUid: ORG, draftId: 'draft_p82' }
const PILOT = (uids: string[]) => ({ licensing: { printBadgePilot: { enforced: true, organizerUids: uids } } })
const newJob = () => resolvePrintJobBillingMode('ID_CARD', 'ev-p82', OWNER, { freshPilot: true })
const preview = () => resolvePrintJobBillingMode('ID_CARD', 'ev-p82', OWNER)

beforeEach(() => {
  h.gateOpen = true; h.fresh = PILOT([ORG]); h.cached = PILOT([ORG]); h.freshFails = false; h.cachedFails = false
  h.storedCalls = []; h.eventReads = 0; h.termsReads = 0
})

describe('RD-PRINT-P8.2 · fresh pilot read at generation-job creation', () => {
  it('the source release gates are still closed', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
  })

  it('A · a new job reads the pilot FRESH — the stored value decides, not a cache that differs', async () => {
    h.cached = PILOT([])                                   // stale cache: not a member
    h.fresh = PILOT([ORG])                                 // stored now: a member
    const r = await newJob()
    expect(h.storedCalls).toEqual([{ fresh: true }])
    expect(r).toMatchObject({ ok: true, mode: 'paid' })
    expect(r.ok && r.notInPilot).toBeFalsy()
  })

  it('B · a pilot REMOVED since the cache was filled: the new job is NOT paid — the established free path, no event or terms read', async () => {
    h.cached = PILOT([ORG])                                // the cache still lists the organizer
    h.fresh = PILOT([])                                    // removed in the stored configuration
    const r = await newJob()
    expect(r).toEqual({ ok: true, mode: 'free', terms: null, notInPilot: true })
    expect(h.eventReads).toBe(0)
    expect(h.termsReads).toBe(0)
  })

  it('C · the fresh read failing ⇒ unavailable (503 at the route) — never free, never the stale cached allowlist', async () => {
    h.cached = PILOT([ORG])
    h.freshFails = true
    expect(await newJob()).toEqual({ ok: false, reason: 'unavailable' })
    h.freshFails = false
    h.fresh = { licensing: { printBadgePilot: { enforced: true, organizerUids: 'broken' } } }   // malformed ⇒ the same
    expect(await newJob()).toEqual({ ok: false, reason: 'unavailable' })
    expect(h.eventReads).toBe(0)
    expect(h.termsReads).toBe(0)
  })

  it('D · gate CLOSED: free, with NO pilot read at all (the established free path)', async () => {
    h.gateOpen = false
    expect(await newJob()).toEqual({ ok: true, mode: 'free', terms: null })
    expect(await preview()).toEqual({ ok: true, mode: 'free', terms: null })
    expect(h.storedCalls).toEqual([])
    expect(h.eventReads + h.termsReads).toBe(0)
  })

  it('E · a current pilot keeps the existing paid path (ownership + terms + precedence); a non-chargeable type reads nothing', async () => {
    const r = await newJob()
    expect(r).toMatchObject({ ok: true, mode: 'paid', terms: { mode: 'paid', unitPricePaise: 20, gstRatePercent: 18 } })
    expect(h.eventReads).toBe(1)
    expect(h.termsReads).toBe(1)
    h.storedCalls = []
    expect(await resolvePrintJobBillingMode('BIB', 'ev-p82', OWNER, { freshPilot: true })).toEqual({ ok: true, mode: 'free', terms: null })
    expect(h.storedCalls).toEqual([])
  })

  it('E · a non-pilot (readable configuration) is free without event or terms reads', async () => {
    h.fresh = PILOT(['someone-else'])
    expect(await newJob()).toEqual({ ok: true, mode: 'free', terms: null, notInPilot: true })
    expect(h.eventReads + h.termsReads).toBe(0)
  })

  it('E · quote previews (and summaries) keep the CACHED read — the stale cache still answers them', async () => {
    h.cached = PILOT([ORG]); h.fresh = PILOT([])
    const r = await preview()
    expect(h.storedCalls).toEqual([{ fresh: false }])
    expect(r).toMatchObject({ ok: true, mode: 'paid' })
  })

  it('call sites: only the job-create route asks for a fresh read; the quote route and summary do not', () => {
    expect(read('app/api/organizer/print-jobs/route.ts')).toContain('{ organizerUid: authz.workspaceUid, draftId: template.eventId }, { freshPilot: true })')
    const quote = read('app/api/organizer/print-jobs/quote/route.ts')
    expect(quote).toContain('resolvePrintJobBillingMode(template.assetType, eventSlug, { organizerUid: authz.workspaceUid, draftId: template.eventId })')
    expect(quote).not.toContain('freshPilot')
    expect(read('lib/printAssets/badgeBilling/summary.ts')).not.toContain('freshPilot')
    // The cache itself is untouched: still 60 s, still the default for every other reader.
    const svc = read('lib/config/businessConfigService.ts')
    expect(svc).toContain('const CACHE_TTL_MS = 60_000')
    expect(svc).toContain('const c = await this.loadStored(opts.fresh === true)')
  })
})
