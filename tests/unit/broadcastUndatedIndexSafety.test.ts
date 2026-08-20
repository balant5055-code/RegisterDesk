// RD-BCAST-IDX-01 · the FAILED_PRECONDITION that took broadcasts down, and its two fixes.
//
// WHAT HAPPENED. Selecting a registration-date filter returned HTTP 500 on both channels:
//
//   Error: 9 FAILED_PRECONDITION: The query requires an index.
//     at countUndatedRegistrations (lib/broadcasts/undatedRegistrations.ts:33)
//     at POST (app/api/organizer/broadcasts/count/route.ts:94)
//
// The two-sided `registeredAt` range, composed with organizerUid + eventSlug + status,
// needs a four-field composite index that existed in neither the project nor the repo. The
// index it DID have differed in the equality-field order and in the range field's
// direction — which an earlier audit compared by field name only and wrongly passed.
//
// TWO INDEPENDENT FAILURES ARE PINNED HERE, because either alone would have been enough:
//   1. the index was missing        → the query shape must be declared (below)
//   2. a DIAGNOSTIC took down the PRIMARY function → it must never be able to again
//
// Fix 2 matters beyond this incident: it holds for any future cause — quota, permissions,
// a different missing index — not just the one we happened to hit.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

interface IndexField { fieldPath: string; order?: string }
interface IndexDef { collectionGroup: string; queryScope: string; fields: IndexField[] }

const INDEXES: IndexDef[] = JSON.parse(read('firestore.indexes.json')).indexes
const registrations = INDEXES.filter(i => i.collectionGroup === 'registrations')

/** Index signature ignoring the implicit __name__ tail. */
const sig = (i: IndexDef) =>
  i.fields.filter(f => f.fieldPath !== '__name__').map(f => `${f.fieldPath}:${f.order}`).join(',')

/**
 * Firestore canonicalises a composite index as: equality fields ASCENDING in alphabetical
 * order, then the range field. These are the shapes the broadcast audience path composes.
 */
const SHAPES = {
  allPlusDate:      'eventSlug:ASCENDING,organizerUid:ASCENDING,registeredAt:ASCENDING',
  statusPlusDate:   'eventSlug:ASCENDING,organizerUid:ASCENDING,status:ASCENDING,registeredAt:ASCENDING',
}

// ─── 1 · 2 · 3. The index the exception demanded ─────────────────────────────

describe('every broadcast registration-date query shape is declared', () => {
  it('1 — the exact index from the captured FAILED_PRECONDITION exists', () => {
    // Decoded verbatim from the console link in the exception. Field ORDER and DIRECTION
    // are both load-bearing: the pre-existing
    // `organizerUid,eventSlug,status,registeredAt:DESCENDING` does NOT serve this query,
    // which is precisely how the gap was missed.
    expect(registrations.map(sig)).toContain(SHAPES.statusPlusDate)
  })

  it('2 — covers audience=confirmed with the two-sided registeredAt range', () => {
    const match = registrations.find(i => sig(i) === SHAPES.statusPlusDate)!
    expect(match.queryScope).toBe('COLLECTION')
    expect(match.fields.map(f => f.fieldPath)).toEqual(['eventSlug', 'organizerUid', 'status', 'registeredAt'])
    expect(match.fields.every(f => f.order === 'ASCENDING')).toBe(true)
  })

  it('3 — audience=all with a date filter remains covered', () => {
    // This one already existed; the test exists so removing it is a visible act.
    expect(registrations.map(sig)).toContain(SHAPES.allPlusDate)
  })

  it('the new index appears exactly once — no duplicate was introduced', () => {
    expect(registrations.filter(i => sig(i) === SHAPES.statusPlusDate)).toHaveLength(1)
  })

  it('this change introduced no new duplicate', () => {
    // The file already carried two duplicate pairs before this fix; they are listed rather
    // than tolerated silently, so removing them is a deliberate act and ADDING a third one
    // fails here. Deleting a live index is a deploy-affecting change and is not in scope.
    const KNOWN_PRE_EXISTING = [
      'organizerUid:ASCENDING,registeredAt:DESCENDING',
      'organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING',
    ]
    const counts = new Map<string, number>()
    for (const s of registrations.map(sig)) counts.set(s, (counts.get(s) ?? 0) + 1)

    const duplicated = [...counts].filter(([, n]) => n > 1).map(([s]) => s).sort()
    expect(duplicated).toEqual([...KNOWN_PRE_EXISTING].sort())
  })

  it('the ASCENDING index does not replace the DESCENDING one other queries rely on', () => {
    // Registration LISTS order by registeredAt desc; that index must survive this change.
    expect(registrations.map(sig)).toContain('organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING,registeredAt:DESCENDING')
  })
})

// ─── 4 · 5 · 6 · 7. The diagnostic can no longer take down the primary count ──

describe('a failing undated diagnostic degrades, it does not throw', () => {
  const makeQuery = (opts: { totalOk?: boolean; rangeOk?: boolean; total?: number; dated?: number }) => {
    const { totalOk = true, rangeOk = true, total = 10, dated = 8 } = opts
    const agg = (ok: boolean, n: number) => ({
      get: async () => {
        if (!ok) throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 })
        return { data: () => ({ count: n }) }
      },
    })
    const q: Record<string, unknown> = {
      count: () => agg(totalOk, total),
      where: () => ({ where: () => ({ count: () => agg(rangeOk, dated) }) }),
    }
    return q as unknown as FirebaseFirestore.Query
  }

  let countUndatedRegistrations: typeof import('@/lib/broadcasts/undatedRegistrations').countUndatedRegistrations

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;({ countUndatedRegistrations } = await import('@/lib/broadcasts/undatedRegistrations'))
  })

  it('5 — a successful diagnostic still returns the real number', async () => {
    expect(await countUndatedRegistrations(makeQuery({ total: 10, dated: 8 }))).toBe(2)
  })

  it('4 — the exact FAILED_PRECONDITION no longer propagates', async () => {
    // The regression. Before the fix this rejection reached the route and became a 500.
    await expect(countUndatedRegistrations(makeQuery({ rangeOk: false }))).resolves.not.toThrow()
  })

  it('6 — a failed diagnostic returns null, NEVER 0', async () => {
    // 0 would render "0 registrations have no registration date" — a claim we cannot make.
    expect(await countUndatedRegistrations(makeQuery({ rangeOk: false }))).toBeNull()
    expect(await countUndatedRegistrations(makeQuery({ totalOk: false }))).toBeNull()
  })

  it('a genuine zero is still reported as 0, not conflated with unknown', async () => {
    expect(await countUndatedRegistrations(makeQuery({ total: 5, dated: 5 }))).toBe(0)
  })

  it('the failure is logged server-side so a missing index stays diagnosable', async () => {
    await countUndatedRegistrations(makeQuery({ rangeOk: false }))
    expect(console.error).toHaveBeenCalled()
  })

  it('clamps a negative skew between the two non-atomic aggregates', async () => {
    expect(await countUndatedRegistrations(makeQuery({ total: 3, dated: 5 }))).toBe(0)
  })
})

// ─── 7 · 8 · 9. The primary count stays authoritative and shared ─────────────

describe('the primary recipient count is untouched and authoritative', () => {
  const count  = read('app/api/organizer/broadcasts/count/route.ts')
  const create = read('app/api/organizer/broadcasts/route.ts')
  const send   = read('lib/broadcasts/send.ts')

  it('7 — recipientCount still comes from the filtered query, not the diagnostic', () => {
    expect(create).toContain('const recipientCount = recipients.length')
    // The diagnostic is never allowed to feed the billed number.
    expect(create).not.toMatch(/recipientCount\s*=\s*[^\n]*undated/)
  })

  it('the date range still reaches Firestore before the cap and the limit', () => {
    const applied = create.indexOf('applyRegistrationDateRange(regsQuery, dateWindow)')
    expect(applied).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(create.indexOf('regsQuery.count().get()'))
    expect(applied).toBeLessThan(create.indexOf('regsQuery.limit(maxRecipients + 1)'))
  })

  it('8 — Email and WhatsApp share the one corrected count path', () => {
    // The diagnostic and the range are applied once, above the channel branch.
    expect(count.indexOf('countUndatedRegistrations(query)')).toBeLessThan(count.indexOf("channel === 'whatsapp'"))
    expect(count.indexOf('applyRegistrationDateRange(query')).toBeLessThan(count.indexOf("channel === 'whatsapp'"))
    expect(count.match(/countUndatedRegistrations\(/g)).toHaveLength(1)
  })

  it('9 — billing and send were not touched by this fix', () => {
    expect(send).not.toContain('countUndatedRegistrations')
    expect(send).toContain('persistedDateBounds(c.registeredFrom, c.registeredTo)')
    expect(create).toContain('startBroadcastCampaign({')
  })

  it('the unknown state survives to the API response instead of being coerced', () => {
    expect(count).toContain('undatedCount?: number | null')
    expect(count).not.toContain('undatedCount ?? 0')
  })
})

// ─── 10. The date behaviour that was exonerated must stay exonerated ─────────

describe('10 — existing date-filter behaviour is unchanged', () => {
  it('17 Aug is still excluded from a 20 Aug "Today", 20 Aug still included', async () => {
    const { resolveRegistrationDateWindow } = await import('@/lib/broadcasts/registrationDateFilter')
    const r = resolveRegistrationDateWindow({ type: 'today' }, 'Asia/Kolkata', '2026-08-20')
    expect(r.ok).toBe(true)
    if (!r.ok || !r.window) throw new Error('no window')
    const inWindow = (iso: string) => {
      const t = new Date(iso).getTime()
      return t >= r.window!.startUtc.getTime() && t < r.window!.endUtcExclusive.getTime()
    }
    expect(inWindow('2026-08-17T06:00:00.000Z')).toBe(false)
    expect(inWindow('2026-08-20T05:00:00.000Z')).toBe(true)
  })

  it('the IST day boundary is still 18:30 UTC, half-open', async () => {
    const { zonedDayRange } = await import('@/lib/registrations/zonedDayRange')
    const r = zonedDayRange('2026-08-20', null, 'Asia/Kolkata')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.range.startUtc.toISOString()).toBe('2026-08-19T18:30:00.000Z')
    expect(r.range.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')
  })

  it('the date algorithm files were not edited by this fix', () => {
    // Exonerated by the stack trace; the fix is an index plus error handling.
    expect(read('lib/registrations/zonedDayRange.ts')).toContain('export function zonedDayRange(')
    expect(read('lib/broadcasts/registrationDateFilter.ts')).toContain('.where(\'registeredAt\', \'>=\', bounds.startUtc)')
  })
})
