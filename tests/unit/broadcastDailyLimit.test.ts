// RD-BCAST-LIMIT-01 · the daily broadcast campaign cap, and its explicit unlimited mode.
//
// WHY THIS EXISTS. The cap is real abuse-and-spend containment: it bounds the blast radius
// of a compromised organizer account and caps platform-funded send volume. It is NOT being
// removed. What it gains here is an honest way to say "this organizer is exempt" — a word,
// not a 999999 that no future reader could distinguish from a typo.
//
// THE INVARIANT THAT MATTERS MOST: the resolver FAILS TO THE DEFAULT, never to unlimited.
// A malformed value must not silently delete a protection. Several tests below exist purely
// to hold that line.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

const read = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8')

// ─── Firestore doubles ────────────────────────────────────────────────────────

let limitsDoc: Record<string, unknown> | null = null
/** Campaigns "created today", as the counting query would see them. */
let todayCampaigns: Array<{ recipientCount?: number }> = []

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromDate: (d: Date) => ({ __ts: d.getTime() }) },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    doc: () => ({ get: async () => ({ exists: limitsDoc !== null, data: () => limitsDoc }) }),
    collection: () => {
      const q = {
        where:  () => q,
        select: () => q,
        get:    async () => ({
          size: todayCampaigns.length,
          docs: todayCampaigns.map(c => ({ data: () => c })),
        }),
      }
      return q
    },
  },
}))

const {
  checkBroadcastLimits, resolveBroadcastsPerDay,
  BROADCASTS_PER_DAY_UNLIMITED, DEFAULT_MAX_BROADCASTS_PER_DAY, DEFAULT_MAX_RECIPIENTS_PER_DAY,
} = await import('@/lib/broadcasts/limits')

/** n campaigns today, each with `each` recipients. */
const campaigns = (n: number, each = 1) => Array.from({ length: n }, () => ({ recipientCount: each }))

beforeEach(() => { limitsDoc = null; todayCampaigns = [] })

// ─── E. The resolver — precedence and safe fallback ──────────────────────────

describe('resolveBroadcastsPerDay', () => {
  it('A — absent means the existing default, unchanged', () => {
    expect(resolveBroadcastsPerDay(undefined)).toBe(DEFAULT_MAX_BROADCASTS_PER_DAY)
    expect(resolveBroadcastsPerDay(null)).toBe(10)
  })

  it('a number is honoured exactly', () => {
    expect(resolveBroadcastsPerDay(20)).toBe(20)
    expect(resolveBroadcastsPerDay(1)).toBe(1)
    expect(resolveBroadcastsPerDay(0)).toBe(0)   // explicit block is explicit
  })

  it('"unlimited" is recognised, tolerantly — a human types this into a console', () => {
    for (const v of ['unlimited', 'UNLIMITED', ' Unlimited ', 'UnLiMiTeD']) {
      expect(resolveBroadcastsPerDay(v), String(v)).toBe(BROADCASTS_PER_DAY_UNLIMITED)
    }
  })

  it('E — an invalid value falls back to the DEFAULT, never to unlimited', () => {
    // The whole security posture of this feature is in this test. If any of these ever
    // returned 'unlimited', a typo would silently remove a protection.
    for (const v of ['unlimted', 'none', 'infinite', '', '10', true, {}, [], -1, 1.5, NaN, Infinity]) {
      expect(resolveBroadcastsPerDay(v), JSON.stringify(v)).toBe(DEFAULT_MAX_BROADCASTS_PER_DAY)
    }
  })

  it('the sentinel is a word, not a magic number', () => {
    expect(BROADCASTS_PER_DAY_UNLIMITED).toBe('unlimited')
    expect(resolveBroadcastsPerDay(999999)).toBe(999999)   // a number is just a number
  })
})

// ─── A · B · C · I. Enforcement for ordinary organizers ──────────────────────

describe('the default cap still protects ordinary organizers', () => {
  it('A — no override: the 10th campaign passes, the 11th is refused', async () => {
    todayCampaigns = campaigns(9)
    expect((await checkBroadcastLimits('u1', 5)).ok).toBe(true)

    todayCampaigns = campaigns(10)
    const r = await checkBroadcastLimits('u1', 5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('DAILY_LIMIT_REACHED')
    expect(r.status).toBe(429)
  })

  it('B — broadcastsPerDay = 10 behaves identically to the default', async () => {
    limitsDoc = { broadcastsPerDay: 10 }
    todayCampaigns = campaigns(10)
    expect((await checkBroadcastLimits('u1', 5)).ok).toBe(false)
  })

  it('C — broadcastsPerDay = 20: the 20th passes, the 21st is refused', async () => {
    limitsDoc = { broadcastsPerDay: 20 }
    todayCampaigns = campaigns(19)
    expect((await checkBroadcastLimits('u1', 5)).ok).toBe(true)

    todayCampaigns = campaigns(20)
    const r = await checkBroadcastLimits('u1', 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.limit).toBe(20)
  })

  it('E — an invalid override does NOT become unlimited; the default still bites', async () => {
    limitsDoc = { broadcastsPerDay: 'unlimted' }   // typo, deliberately
    todayCampaigns = campaigns(10)
    const r = await checkBroadcastLimits('u1', 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.limit).toBe(10)
  })

  it('I — no regression: the refusal keeps its stable machine code', async () => {
    todayCampaigns = campaigns(10)
    const r = await checkBroadcastLimits('u1', 5)
    if (r.ok) throw new Error('expected refusal')
    expect(r.code).toBe('DAILY_LIMIT_REACHED')
  })
})

// ─── D. Unlimited ─────────────────────────────────────────────────────────────

describe('D — explicit unlimited exempts the campaign-COUNT check only', () => {
  it('passes regardless of how many campaigns already went out today', async () => {
    limitsDoc = { broadcastsPerDay: BROADCASTS_PER_DAY_UNLIMITED }
    for (const n of [10, 50, 500]) {
      todayCampaigns = campaigns(n)
      expect((await checkBroadcastLimits('u1', 5)).ok, `${n} campaigns`).toBe(true)
    }
  })

  it('applies only to the organizer configured for it', async () => {
    // Same code path, no override doc ⇒ still capped. Exemption is per-organizer by
    // construction: the value is read from that organizer's own document.
    limitsDoc = null
    todayCampaigns = campaigns(10)
    expect((await checkBroadcastLimits('u2', 5)).ok).toBe(false)
  })

  it('F — recipient limits STILL apply under unlimited', async () => {
    // The exemption is from a count of campaigns, not from volume protection.
    limitsDoc = { broadcastsPerDay: BROADCASTS_PER_DAY_UNLIMITED }
    todayCampaigns = campaigns(50, 500)          // 25,000 recipients already today
    const r = await checkBroadcastLimits('u1', 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('RECIPIENT_LIMIT_REACHED')
  })

  it('F — the per-broadcast cap STILL applies under unlimited', async () => {
    limitsDoc = { broadcastsPerDay: BROADCASTS_PER_DAY_UNLIMITED }
    todayCampaigns = []
    const r = await checkBroadcastLimits('u1', 5_001)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BROADCAST_TOO_LARGE')
  })

  it('unlimited does not raise the daily recipient ceiling', async () => {
    limitsDoc = { broadcastsPerDay: BROADCASTS_PER_DAY_UNLIMITED }
    todayCampaigns = campaigns(1, DEFAULT_MAX_RECIPIENTS_PER_DAY)
    expect((await checkBroadcastLimits('u1', 1)).ok).toBe(false)
  })
})

// ─── 9. The refusal is actionable ────────────────────────────────────────────

describe('a refusal explains itself', () => {
  it('carries a human message, the counts, and a reset instant', async () => {
    todayCampaigns = campaigns(10)
    const r = await checkBroadcastLimits('u1', 5)
    if (r.ok) throw new Error('expected refusal')
    expect(r.message).toContain('10 of 10')
    expect(r.used).toBe(10)
    expect(r.limit).toBe(10)
    expect(r.resetAt).toBeTruthy()
    // Next UTC midnight, strictly in the future.
    expect(new Date(r.resetAt!).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(r.resetAt!).toISOString()).toMatch(/T00:00:00\.000Z$/)
  })

  it('the message never leaks the raw machine token', async () => {
    todayCampaigns = campaigns(10)
    const r = await checkBroadcastLimits('u1', 5)
    if (r.ok) throw new Error('expected refusal')
    expect(r.message).not.toContain('DAILY_LIMIT_REACHED')
  })

  it('the other two refusals explain themselves too', async () => {
    todayCampaigns = []
    const big = await checkBroadcastLimits('u1', 6_000)
    if (big.ok) throw new Error('expected refusal')
    expect(big.message).toContain('6,000')

    todayCampaigns = campaigns(1, DEFAULT_MAX_RECIPIENTS_PER_DAY)
    const many = await checkBroadcastLimits('u1', 1)
    if (many.ok) throw new Error('expected refusal')
    expect(many.message).toContain('25,00')
  })
})

// ─── G · H. Wiring: unchanged ordering, shared by both channels ──────────────

describe('the surrounding guarantees are unchanged', () => {
  const route  = read('app/api/organizer/broadcasts/route.ts')
  const client = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')

  it('G — the limit check still precedes campaign creation AND billing', async () => {
    // A refusal must cost nothing: no campaign document, no wallet movement, no provider call.
    const check  = route.indexOf('checkBroadcastLimits(uid, recipientCount)')
    const create = route.indexOf('campaignRef.set(')
    const send   = route.indexOf('startBroadcastCampaign({')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(create)
    expect(check).toBeLessThan(send)
  })

  it('G — nothing about wallet or billing was touched', () => {
    expect(read('lib/communications/billing.ts')).toContain('chargeAndStartCampaign')
    expect(route).toContain('startBroadcastCampaign({')
  })

  it('H — one counter, shared by email and WhatsApp', () => {
    const limits = read('lib/broadcasts/limits.ts')
    const query  = limits.slice(limits.indexOf("collection('broadcastCampaigns')"), limits.indexOf('const broadcastsToday'))
    // No channel filter ⇒ the same configuration governs both channels.
    expect(query).not.toContain("'channel'")
    expect(route).toContain('checkBroadcastLimits(uid, recipientCount)')
    expect(route.indexOf('checkBroadcastLimits')).toBeLessThan(route.indexOf('campaignRef.set('))
  })

  it('the UI shows the message, not the token', () => {
    expect(client).toContain('data.message ?? data.error')
    expect(client).toContain('resetNote')
  })

  it('recipient caps and the per-broadcast cap keep their existing defaults', () => {
    const limits = read('lib/broadcasts/limits.ts')
    expect(limits).toContain('DEFAULT_MAX_RECIPIENTS_PER_BROADCAST = 5_000')
    expect(limits).toContain('DEFAULT_MAX_BROADCASTS_PER_DAY       = 10')
    expect(limits).toContain('DEFAULT_MAX_RECIPIENTS_PER_DAY       = 25_000')
  })

  it('unlimited is not applied to recipientsPerDay or recipientsPerBroadcast', () => {
    const limits = read('lib/broadcasts/limits.ts')
    expect(limits).toContain('overrides?.recipientsPerDay       ?? DEFAULT_MAX_RECIPIENTS_PER_DAY')
    expect(limits).toContain('overrides?.recipientsPerBroadcast ?? DEFAULT_MAX_RECIPIENTS_PER_BROADCAST')
  })
})
