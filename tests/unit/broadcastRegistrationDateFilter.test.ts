// RD-BCAST-DATE-01 · the registration-date audience filter.
//
// The feature exists to STOP sending to everyone. Its failure mode is therefore not a
// crash but a quiet under-send: an audience that looks plausible and is missing people.
// Almost everything below is aimed at that — the range must reach Firestore as a `where`
// so the cap bounds the filtered set, and "today" must be frozen at creation so a
// scheduled campaign cannot drift onto a different day.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseRegistrationDateFilter, resolveRegistrationDateWindow, applyRegistrationDateRange,
  persistedDateBounds, toFilterRecord,
  DATED_LOWER_BOUND, DATED_UPPER_BOUND,
} from '@/lib/broadcasts/registrationDateFilter'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const IST  = 'Asia/Kolkata'
const TODAY = '2026-08-20'

const win = (input: Parameters<typeof resolveRegistrationDateWindow>[0], tz = IST, today = TODAY) => {
  const r = resolveRegistrationDateWindow(input, tz, today)
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.window
}

/** Minimal Firestore-query stand-in that records the constraints applied, in order. */
function fakeQuery() {
  const calls: Array<[string, string, unknown]> = []
  const q = {
    calls,
    where(field: string, op: '>=' | '<', value: Date) { calls.push([field, op, value]); return q },
  }
  return q
}

// ─── Selection → window ───────────────────────────────────────────────────────

describe('selection resolves to an absolute window', () => {
  it('Today is the creation day, in the event timezone', () => {
    const w = win({ type: 'today' })!
    expect(w.fromISO).toBe(TODAY)
    expect(w.toISO).toBe(TODAY)
    expect(w.startUtc.toISOString()).toBe('2026-08-19T18:30:00.000Z')
    expect(w.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')
  })

  it('Yesterday is the day before, and excludes today', () => {
    const w = win({ type: 'yesterday' })!
    expect(w.fromISO).toBe('2026-08-19')
    expect(w.endUtcExclusive.toISOString()).toBe('2026-08-19T18:30:00.000Z')
    // Today's first instant is exactly the exclusive bound — outside the window.
    expect(w.endUtcExclusive.getTime()).toBe(win({ type: 'today' })!.startUtc.getTime())
  })

  it('a custom date ignores "today" entirely', () => {
    expect(win({ type: 'date', date: '2026-01-05' })!.fromISO).toBe('2026-01-05')
  })

  it('a range spans both ends inclusively', () => {
    const w = win({ type: 'range', from: '2026-08-01', to: '2026-08-20' })!
    expect(w.fromISO).toBe('2026-08-01')
    expect(w.toISO).toBe('2026-08-20')
    expect(w.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')
  })

  it('All registrations resolves to NO window — the whole point of the default', () => {
    expect(win({ type: 'all' })).toBeNull()
  })

  it('labels the window for the organizer', () => {
    expect(win({ type: 'today' })!.label).toBe('20 Aug 2026')
    expect(win({ type: 'range', from: '2026-08-01', to: '2026-08-20' })!.label).toBe('1 Aug 2026 – 20 Aug 2026')
  })

  it('yesterday crosses a month boundary correctly', () => {
    expect(win({ type: 'yesterday' }, IST, '2026-09-01')!.fromISO).toBe('2026-08-31')
  })
})

// ─── Validation ───────────────────────────────────────────────────────────────

describe('server-side validation', () => {
  it('an absent filter means "all" — every existing caller keeps working', () => {
    expect(parseRegistrationDateFilter(undefined)).toEqual({ ok: true, value: { type: 'all' } })
    expect(parseRegistrationDateFilter(null)).toEqual({ ok: true, value: { type: 'all' } })
  })

  it('rejects an unknown type', () => {
    expect(parseRegistrationDateFilter({ type: 'last_week' }).ok).toBe(false)
    expect(parseRegistrationDateFilter({ type: 42 }).ok).toBe(false)
    expect(parseRegistrationDateFilter('today').ok).toBe(false)
  })

  it('rejects a custom date that is missing or malformed', () => {
    expect(parseRegistrationDateFilter({ type: 'date' })).toEqual({ ok: false, error: 'missing_date' })
    expect(parseRegistrationDateFilter({ type: 'date', date: '20-08-2026' })).toEqual({ ok: false, error: 'invalid_date' })
    expect(parseRegistrationDateFilter({ type: 'date', date: '2026-02-30' })).toEqual({ ok: false, error: 'invalid_date' })
  })

  it('rejects an incomplete range', () => {
    expect(parseRegistrationDateFilter({ type: 'range', from: '2026-08-01' })).toEqual({ ok: false, error: 'missing_date' })
  })

  it('rejects start after end', () => {
    expect(resolveRegistrationDateWindow({ type: 'range', from: '2026-08-20', to: '2026-08-01' }, IST, TODAY))
      .toEqual({ ok: false, error: 'start_after_end' })
  })

  it('rejects an invalid timezone rather than silently using UTC', () => {
    expect(resolveRegistrationDateWindow({ type: 'today' }, 'Mars/Olympus', TODAY))
      .toEqual({ ok: false, error: 'invalid_timezone' })
  })
})

// ─── The query constraint ─────────────────────────────────────────────────────

describe('the range is a Firestore where clause', () => {
  it('applies BOTH bounds, half-open, on registeredAt', () => {
    const q = fakeQuery()
    const w = win({ type: 'today' })!
    applyRegistrationDateRange(q, w)
    expect(q.calls).toEqual([
      ['registeredAt', '>=', w.startUtc],
      ['registeredAt', '<',  w.endUtcExclusive],
    ])
  })

  it('never emits <= — the 23:59:59 family of bugs cannot appear', () => {
    const q = fakeQuery()
    applyRegistrationDateRange(q, win({ type: 'today' })!)
    expect(q.calls.map(c => c[1])).not.toContain('<=')
  })

  it('a null window leaves the query untouched — byte-identical to before the feature', () => {
    const q = fakeQuery()
    expect(applyRegistrationDateRange(q, null)).toBe(q)
    expect(q.calls).toHaveLength(0)
  })
})

// ─── Persistence → delivery ───────────────────────────────────────────────────

describe('persisted bounds are what delivery uses', () => {
  const asTimestamp = (d: Date) => ({ toDate: () => d })

  it('rebuilds the exact window from Firestore Timestamps', () => {
    const w = win({ type: 'today' })!
    const b = persistedDateBounds(asTimestamp(w.startUtc), asTimestamp(w.endUtcExclusive))
    expect(b).toEqual({ startUtc: w.startUtc, endUtcExclusive: w.endUtcExclusive })
  })

  it('accepts plain Dates too', () => {
    expect(persistedDateBounds(new Date('2026-08-19T18:30:00Z'), new Date('2026-08-20T18:30:00Z')))
      .not.toBeNull()
  })

  it('absent bounds mean NO filter — this is what protects every existing campaign', () => {
    expect(persistedDateBounds(undefined, undefined)).toBeNull()
    expect(persistedDateBounds(null, null)).toBeNull()
  })

  it('a HALF-written pair is treated as no filter, never as one open-ended side', () => {
    // An open-ended range would silently widen the audience — worse than not filtering.
    const d = new Date('2026-08-19T18:30:00Z')
    expect(persistedDateBounds(d, undefined)).toBeNull()
    expect(persistedDateBounds(undefined, d)).toBeNull()
  })

  it('ignores junk rather than producing an Invalid Date bound', () => {
    expect(persistedDateBounds('2026-08-20', 'nonsense')).toBeNull()
    expect(persistedDateBounds({ toDate: () => new Date('nope') }, { toDate: () => new Date('nope') })).toBeNull()
  })

  it('SCHEDULED: a campaign created on 20 Aug still targets 20 Aug when sent on 21 Aug', () => {
    // Creation-time resolution, frozen.
    const created = win({ type: 'today' }, IST, '2026-08-20')!
    const stored  = { from: asTimestamp(created.startUtc), to: asTimestamp(created.endUtcExclusive) }

    // Delivery, a day later. Nothing about the send path consults a clock.
    const atDelivery = persistedDateBounds(stored.from, stored.to)!
    expect(atDelivery.startUtc.toISOString()).toBe('2026-08-19T18:30:00.000Z')
    expect(atDelivery.endUtcExclusive.toISOString()).toBe('2026-08-20T18:30:00.000Z')

    // And it is emphatically NOT what "today" would resolve to on the 21st.
    const if_reinterpreted = win({ type: 'today' }, IST, '2026-08-21')!
    expect(atDelivery.startUtc.getTime()).not.toBe(if_reinterpreted.startUtc.getTime())
  })

  it('the persisted record explains the window without re-deriving it', () => {
    const w = win({ type: 'today' })!
    expect(toFilterRecord({ type: 'today' }, w)).toEqual({
      type: 'today', label: '20 Aug 2026', timezone: IST, fromISO: TODAY, toISO: TODAY,
      undatedExcluded: 0,
    })
  })

  it('the record CARRIES the undated count, so history cannot imply full coverage', () => {
    // The composer's warning vanishes once the campaign is sent. This is what remains.
    expect(toFilterRecord({ type: 'today' }, win({ type: 'today' })!, 12).undatedExcluded).toBe(12)
  })
})

// ─── Wiring: the properties that cannot be unit-tested in isolation ───────────

describe('the range reaches Firestore BEFORE the limit, everywhere', () => {
  const create = read('app/api/organizer/broadcasts/route.ts')
  const count  = read('app/api/organizer/broadcasts/count/route.ts')
  const send   = read('lib/broadcasts/send.ts')

  const before = (src: string, a: string, b: string, name: string) => {
    const ia = src.indexOf(a), ib = src.indexOf(b)
    expect(ia, `${name}: missing ${a}`).toBeGreaterThan(-1)
    expect(ib, `${name}: missing ${b}`).toBeGreaterThan(-1)
    expect(ia, `${name}: ${a} must come before ${b}`).toBeLessThan(ib)
  }

  it('CREATE applies the range before the cap gate and before limit()', () => {
    before(create, 'applyRegistrationDateRange(regsQuery', 'regsQuery.count().get()', 'create/cap')
    before(create, 'applyRegistrationDateRange(regsQuery', 'regsQuery.limit(maxRecipients + 1)', 'create/limit')
  })

  it('CREATE passes the RESOLVED window, not a placeholder', () => {
    // Pinning only the call site let a mutation swap the argument for `null` and survive:
    // the range would be applied in the preview and silently dropped from what is billed
    // and sent. The argument is the assertion.
    expect(create).toContain('applyRegistrationDateRange(regsQuery, dateWindow)')
  })

  it('COUNT applies the range before every branch loads documents', () => {
    before(count, 'applyRegistrationDateRange(query', 'limit(maxRecipients + 1)', 'count/limit')
    before(count, 'applyRegistrationDateRange(query', 'query.count().get()', 'count/aggregate')
  })

  it('SEND applies the range before limit(), on BOTH channels', () => {
    // BOTH call sites must pass the persisted bounds. Counting the full call — not just the
    // function name — is what stops one channel being quietly neutered to `null` while the
    // other keeps the constraint and the suite stays green.
    expect(send.match(/applyRegistrationDateRange\(regsQuery, persistedDateBounds\(c\.registeredFrom, c\.registeredTo\)\)/g)?.length).toBe(2)
    expect(send.match(/applyRegistrationDateRange\(regsQuery/g)?.length).toBe(2)
    // Sliced from the function DECLARATIONS — the first bare mention of
    // deliverWhatsAppCampaign is the dispatch call, which sits above both bodies.
    const emailHalf = send.slice(send.indexOf('async function deliverEmailCampaign'), send.indexOf('async function deliverWhatsAppCampaign'))
    const waHalf    = send.slice(send.indexOf('async function deliverWhatsAppCampaign'))
    for (const [name, half] of [['send/email', emailHalf], ['send/whatsapp', waHalf]] as const) {
      before(half, 'applyRegistrationDateRange(regsQuery', 'regsQuery.limit(maxRecipients + 1)', name)
    }
  })

  it('SEND never re-resolves the date — no clock, no timezone, no "today"', () => {
    // The whole scheduled-campaign guarantee reduces to this.
    expect(send).not.toContain('todayISOInTz')
    expect(send).not.toContain('resolveRegistrationDateWindow')
    expect(send).not.toContain('resolveBroadcastTimezone')
    expect(send).toContain('persistedDateBounds(c.registeredFrom, c.registeredTo)')
  })

  it('SEND still short-circuits on an existing job id — resume never re-resolves', () => {
    expect(send).toContain('if (c.emailJobId) { await processEmailBroadcastChunk(c.emailJobId); return }')
    expect(send).toContain('if (!jobId) {')
  })

  it('the create route persists ABSOLUTE instants, not the word "today"', () => {
    expect(create).toContain('registeredFrom:         Timestamp.fromDate(dateWindow.startUtc)')
    expect(create).toContain('registeredTo:           Timestamp.fromDate(dateWindow.endUtcExclusive)')
  })

  it('nothing filters dates in memory', () => {
    for (const [name, src] of [['create', create], ['count', count], ['send', send]] as const) {
      expect(src, name).not.toMatch(/\.filter\([^)]*registeredAt/)
    }
  })
})

describe('channel isolation is preserved', () => {
  const send = read('lib/broadcasts/send.ts')

  it('email delivery never reads the WhatsApp dedupe flag', () => {
    const email = send.slice(send.indexOf('async function deliverEmailCampaign'), send.indexOf('async function deliverWhatsAppCampaign'))
    expect(email).toContain('c.dedupeEmails')
    expect(email).not.toContain('c.dedupePhones')
  })

  it('WhatsApp delivery never reads the email dedupe flag or suppression', () => {
    const wa = send.slice(send.indexOf('async function deliverWhatsAppCampaign'))
    expect(wa).toContain('c.dedupePhones')
    expect(wa).not.toContain('c.dedupeEmails')
    expect(wa).not.toContain('getOrganiserSuppressionSet')
  })

  it('the date filter is shared by both, because it filters REGISTRATIONS', () => {
    const email = send.slice(send.indexOf('async function deliverEmailCampaign'), send.indexOf('async function deliverWhatsAppCampaign'))
    const wa    = send.slice(send.indexOf('async function deliverWhatsAppCampaign'))
    expect(email).toContain('applyRegistrationDateRange')
    expect(wa).toContain('applyRegistrationDateRange')
  })
})

describe('missing registeredAt is measured, not assumed away', () => {
  const count  = read('app/api/organizer/broadcasts/count/route.ts')
  const create = read('app/api/organizer/broadcasts/route.ts')
  const undated = read('lib/broadcasts/undatedRegistrations.ts')
  const client = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')

  it('counts undated registrations BEFORE the range hides them', () => {
    const ia = count.indexOf('countUndatedRegistrations(query)')
    const ib = count.indexOf('applyRegistrationDateRange(query')
    expect(ia).toBeGreaterThan(-1)
    expect(ia).toBeLessThan(ib)
  })

  it('does the same on the create path', () => {
    expect(create.indexOf('countUndatedRegistrations(regsQuery)'))
      .toBeLessThan(create.indexOf('applyRegistrationDateRange(regsQuery'))
  })

  it('uses two index-only aggregates, never a document read', () => {
    expect(undated).toContain('.count().get()')
    expect(undated).not.toContain('.select(')
    expect(undated).not.toContain('.docs')
  })

  it('bounds ABOVE as well as below, so a string registeredAt is not counted as dated', () => {
    expect(undated).toContain("'>=', DATED_LOWER_BOUND")
    expect(undated).toContain("'<',  DATED_UPPER_BOUND")
    expect(DATED_LOWER_BOUND.getTime()).toBe(0)
    expect(DATED_UPPER_BOUND.getTime()).toBeGreaterThan(Date.parse('2999-01-01'))
  })

  it('the composer SHOWS the number rather than swallowing it', () => {
    expect(client).toContain('undatedNotice(dateMeta.undatedCount)')
    expect(client).toContain('are not included.')
  })

  it('only counts when a filter is actually active — no cost for "All registrations"', () => {
    expect(count).toContain('dateWindow ? await countUndatedRegistrations')
    expect(create).toContain('dateWindow ? await countUndatedRegistrations')
  })

  it('the create path PERSISTS the count rather than computing and discarding it', () => {
    expect(create).toContain('toFilterRecord(parsedDate.value, dateWindow, undatedCount)')
  })
})

describe('preview and create resolve identically', () => {
  const count  = read('app/api/organizer/broadcasts/count/route.ts')
  const create = read('app/api/organizer/broadcasts/route.ts')
  const client = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')

  it('both server routes use the same parser, resolver and timezone chain', () => {
    for (const [name, src] of [['count', count], ['create', create]] as const) {
      expect(src, name).toContain('parseRegistrationDateFilter(')
      expect(src, name).toContain('resolveRegistrationDateWindow(')
      expect(src, name).toContain('resolveBroadcastTimezone(eventSlug, uid)')
      expect(src, name).toContain('todayISOInTz(timezone)')
    }
  })

  it('the composer sends ONE filter object to both endpoints', () => {
    expect(client).toContain('registrationDate: RegistrationDateFilterInput')
    expect(client).toContain('registrationDate: regDate')  // preview
    expect(client).toContain('registrationDate,')          // create
  })

  it('the browser never computes the window itself', () => {
    expect(client).not.toContain('resolvedOptions()')
    expect(client).not.toContain('zonedDayRange')
  })
})

describe('existing behaviour is untouched', () => {
  const create = read('app/api/organizer/broadcasts/route.ts')
  const client = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')

  it('the campaign fields are written ONLY when a filter was chosen — no migration', () => {
    expect(create).toContain('...(dateWindow ? {')
  })

  it('the composer defaults to All registrations', () => {
    expect(client).toContain("useState<RegistrationDateFilterType>('all')")
  })

  it('existing audience semantics are unchanged', () => {
    expect(create).toContain("if (audience !== 'all') {")
    expect(read('lib/broadcasts/send.ts')).toContain("if (c.audience !== 'all') regsQuery = regsQuery.where('status', '==', c.audience)")
  })

  it('the cap still refuses explicitly instead of truncating', () => {
    expect(create).toContain("error: 'BROADCAST_TOO_LARGE'")
  })
})
