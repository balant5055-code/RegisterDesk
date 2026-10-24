// RD-EVENT-11 · Attendance, asserted as rules.
//
// The defects these pin were found by auditing the real code and then opening it in a
// browser against four different event types:
//
//   A1 · The tab READ UP TO 1000 REGISTRATION DOCUMENTS on every load, and refreshed
//        itself every 30 seconds forever — 120,000 document reads an hour from a tab
//        left open on a gate laptop — in order to render twenty rows.
//   A2 · The hourly chart bucketed on `new Date(iso).getHours()`, the SERVER's local
//        hour, while labelling with an event-agnostic string. A 09:30 arrival in
//        Chennai landed in the 04:00 bucket of a UTC server.
//   A3 · That same chart's window was "the newest 1000 check-ins", not a day, so a
//        large event folded several days into 24 buckets and captioned it as today.
//   A4 · Five KPI cards restated what the RD-EVENT-08 shell strip says directly above
//        — and disagreed with it: "213 registered" in the strip beside "Total
//        Registrations 240" in a card, two definitions of one word.
//   A5 · `attendanceRate` was `confirmed > 0 ? … : 0`, so an event whose counters
//        could not be read and an event with no confirmed registrations both rendered
//        "0%" as a measurement.
//   A6 · There was NO search, NO participant list and NO check-in action. Attendance
//        could report a rate; it could not admit anybody.
//   A7 · The identifier column was going to be "BIB". RegisterDesk runs conferences
//        and expos; the organizer NAMES that field.
//   A8 · The tab received only `eventId` and `token`, so it could not respect the
//        event lifecycle without a second read — and it did not respect it at all.
//   A9 · A draft event has no slug, and the endpoint answered 404, which the tab
//        rendered as "Failed to load dashboard" — a broken product rather than an
//        early one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  UNAVAILABLE, attendanceGate, attendanceMetrics, attendancePercent, checkInClock,
  filterEmptyMessage, filterParam, hourBarPercent, hourLabel, hourRangeDate, hourlyView,
  identifierColumnLabel, isAttendanceFilter, isLiveAttendance, participantNoun, rowAction,
  rowFromRegistration, rowFromSearchResult, shouldSearch, sinceLabel, todayHourRanges,
  CHECKIN_LIFECYCLE_STATES, SEARCH_MIN_CHARS,
} from '@/lib/attendance/attendanceView'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const TAB     = strip(read('app/(dashboard)/dashboard/events/[eventId]/tabs/AttendanceTab.tsx'))
const API     = strip(read('app/api/organizer/events/[eventId]/attendance/route.ts'))
const REGAPI  = strip(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const SHELL   = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))
const LIB     = strip(read('lib/attendance/attendanceView.ts'))
const GATE    = strip(read('lib/checkin/eventStatus.ts'))

const IST = 'Asia/Kolkata'
const counts = (over: Partial<{ confirmed: number; checkedIn: number; cancelled: number; pending: number; total: number }> = {}) =>
  ({ confirmed: 213, checkedIn: 84, cancelled: 11, pending: 16, total: 240, ...over })

// ═══ A1 · read cost ═══════════════════════════════════════════════════════════

describe('one attendance load reads what it renders, and no more', () => {
  it('the recent window is the size of the list, not a thousand', () => {
    expect(API).toContain('const RECENT_CHECKIN_LIMIT = 20')
    expect(API).toContain('.limit(RECENT_CHECKIN_LIMIT)')
    // The old cap must not survive anywhere in this route.
    expect(API).not.toContain('RECENT_CHECKIN_CAP')
    expect(API).not.toMatch(/limit\(1000\)/)
  })

  it('the window is projected — no full documents, no surplus PII', () => {
    expect(API).toContain(".select('attendee.name', 'ticketCode', 'passName', 'passId', 'checkedInAt')")
  })

  it('hourly comes from count() aggregates that transfer zero documents', () => {
    expect(API).toContain('.count().get()')
    expect(API).toContain('fetchHourlyBuckets')
    // and NOT from a document scan
    expect(API).not.toContain('buildCheckinViews')
  })

  it('per-pass checked-in is aggregates too, never a tally over a capped window', () => {
    expect(API).toContain('fetchPassCheckedInCounts')
    expect(API).not.toMatch(/for \(const r of rows\) passCheckedInById/)
  })

  it('the independent reads share ONE wave', () => {
    expect(API).toContain('await Promise.all([')
    expect(API).toContain('getEventStats(slug).catch(() => null)')
    expect(API).toContain('fetchRecentCheckinRows(uid, slug).catch(() => null)')
  })

  it('the tab reuses the event the shell already loaded — no refetch', () => {
    expect(SHELL).toContain('<AttendanceTab eventId={eventId} token={token} event={event} />')
    expect(TAB).toContain('event:   EventDetailResponse')
    expect(TAB).not.toMatch(/fetch\(`\/api\/organizer\/events\/\$\{encodeURIComponent\(eventId\)\}`/)
  })

  it('the live refresh stops when nobody is looking, and when the event is over', () => {
    expect(TAB).toContain("document.visibilityState === 'hidden'")
    expect(TAB).toContain('isLiveAttendance(')
    expect(TAB).toContain('if (!token || !live) return')
  })

  it('performs no writes of its own — every mutation goes through a canonical route', () => {
    // Firestore write shapes specifically. (`p.set(…)` on URLSearchParams is not one.)
    for (const v of ['adminDb', 'runTransaction', 'writeBatch', 'FieldValue', 'doc(', 'collection(']) {
      expect(TAB, v).not.toContain(v)
    }
    expect(TAB).toContain("fetch('/api/checkin/scan'")
    expect(TAB).toContain('/undo-checkin')
  })
})

// ═══ A2 + A3 · the hourly chart tells the truth about time ════════════════════

describe('hour buckets are the EVENT\'s hours, and today\'s', () => {
  it('a day produces at most 24 elapsed buckets, oldest first', () => {
    const at = new Date('2026-08-28T17:30:00Z')       // 23:00 IST
    const r = todayHourRanges(at, IST)
    expect(r.length).toBeLessThanOrEqual(24)
    expect(r.length).toBe(24)
    expect(r[0].hour).toBe('00:00')
    expect(r[23].hour).toBe('23:00')
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].end.getTime()).toBe(r[i + 1].start.getTime())
    }
  })

  it('each bucket is exactly one hour', () => {
    for (const r of todayHourRanges(new Date('2026-08-28T09:00:00Z'), IST)) {
      expect(r.end.getTime() - r.start.getTime()).toBe(3_600_000)
    }
  })

  it('early in the local day there are FEW buckets, not a full empty day', () => {
    // 00:30 IST on the 29th is 19:00 UTC on the 28th.
    const r = todayHourRanges(new Date('2026-08-28T19:00:00Z'), IST)
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('12 AM')
  })

  it('the day boundary is the EVENT zone, so the same instant differs by zone', () => {
    const at = new Date('2026-08-28T19:00:00Z')
    expect(todayHourRanges(at, IST)).toHaveLength(1)              // 00:30 next day in IST
    expect(todayHourRanges(at, 'UTC').length).toBe(20)            // 19:00 same day in UTC
    expect(hourRangeDate(at, IST)).toBe('2026-08-29')
    expect(hourRangeDate(at, 'UTC')).toBe('2026-08-28')
  })

  it('survives a DST day without producing a 25th bucket', () => {
    const at = new Date('2026-11-01T20:00:00Z')     // US DST ends this day
    const r = todayHourRanges(at, 'America/New_York')
    expect(r.length).toBeLessThanOrEqual(24)
    for (const b of r) expect(b.end.getTime() - b.start.getTime()).toBe(3_600_000)
  })

  it('labels are hours, not indexes', () => {
    expect(hourLabel(0)).toBe('12 AM')
    expect(hourLabel(9)).toBe('9 AM')
    expect(hourLabel(12)).toBe('12 PM')
    expect(hourLabel(23)).toBe('11 PM')
  })

  it('the server never reads the hour off a client clock', () => {
    expect(API).not.toMatch(/new Date\([^)]*\)\.getHours\(\)/)
    expect(LIB).not.toMatch(/\.getHours\(\)/)
  })
})

// ═══ An unreadable hour is not an empty hour ══════════════════════════════════

describe('a bucket that could not be counted is never drawn as zero', () => {
  it('the server settles each aggregate to null, never 0', () => {
    expect(API).toContain('.catch(() => null)')
    expect(API).toContain('count: number | null')
  })

  it('barPercent passes null through', () => {
    expect(hourBarPercent(null, 10)).toBeNull()
    expect(hourBarPercent(0, 10)).toBe(0)
    expect(hourBarPercent(5, 10)).toBe(50)
    expect(hourBarPercent(3, 0)).toBe(0)
  })

  it('a partial day refuses to report a total', () => {
    const v = hourlyView([{ count: 3 }, { count: null }, { count: 7 }])
    expect(v.total).toBeNull()
    expect(v.partial).toBe(true)
    expect(v.peak).toBe(7)
  })

  it('a complete day reports an exact total', () => {
    const v = hourlyView([{ count: 3 }, { count: 0 }, { count: 7 }])
    expect(v.total).toBe(10)
    expect(v.partial).toBe(false)
    expect(v.allZero).toBe(false)
  })

  it('all-zero is distinguished from unreadable', () => {
    expect(hourlyView([{ count: 0 }, { count: 0 }]).allZero).toBe(true)
    expect(hourlyView([{ count: null }, { count: null }]).allZero).toBe(false)
  })

  it('the chart draws a gap for an unread hour and says so', () => {
    expect(TAB).toContain('p === null ? (')
    expect(TAB).toContain('border border-dashed border-border')
    expect(TAB).toContain("Some hours couldn&apos;t be counted and are shown as gaps — they are not zero.")
  })

  it('the bars have a resolvable height', () => {
    // A percentage height against a flex child whose own height is `auto` computes to
    // ZERO. That is exactly why the old chart drew its labels above nothing at all.
    expect(TAB).toContain('flex h-full min-w-0 flex-1 flex-col items-center justify-end')
  })
})

// ═══ A5 · zero vs unavailable ═════════════════════════════════════════════════

describe('a measured zero is not the same fact as an unreadable counter', () => {
  it('states real zeros', () => {
    const m = attendanceMetrics(counts({ checkedIn: 0 }), false)
    expect(m.checkedIn.text).toBe('0')
    expect(m.checkedIn.unavailable).toBe(false)
    expect(m.rate.text).toBe('0%')
  })

  it('never claims 0 when the counters could not be read', () => {
    const m = attendanceMetrics(counts(), true)
    for (const k of ['checkedIn', 'remaining', 'rate'] as const) {
      expect(m[k].unavailable).toBe(true)
      expect(m[k].text).toBe(UNAVAILABLE)
      expect(m[k].text).not.toBe('0')
    }
    expect(attendanceMetrics(null, false).rate.text).toBe(UNAVAILABLE)
  })

  it('a rate over nothing is undefined, not 0%', () => {
    const m = attendanceMetrics(counts({ confirmed: 0, checkedIn: 0 }), false)
    expect(m.rate.text).toBe(UNAVAILABLE)
    expect(m.rate.unavailable).toBe(true)
    expect(attendancePercent(counts({ confirmed: 0 }), false)).toBeNull()
  })

  it('the progress bar is withheld when there is nothing authoritative behind it', () => {
    expect(attendancePercent(counts(), true)).toBeNull()
    expect(attendancePercent(null, false)).toBeNull()
    expect(attendancePercent(counts(), false)).toBe(39)
  })

  it('the bar can never exceed 100% even when the data disagrees with itself', () => {
    expect(attendancePercent(counts({ confirmed: 10, checkedIn: 25 }), false)).toBe(100)
  })

  it('remaining never goes negative', () => {
    expect(attendanceMetrics(counts({ confirmed: 10, checkedIn: 25 }), false).remaining.text).toBe('0')
  })

  it('a sub-line qualifies and never restates its own label', () => {
    const m = attendanceMetrics(counts(), false)
    expect(m.checkedIn.sub).toBe('of 213 confirmed')
    expect(m.remaining.sub).toBeNull()
    expect(m.rate.sub).toBeNull()
  })

  it('the server reports whether the summary is trustworthy', () => {
    expect(API).toContain('statsUnavailable')
    expect(API).toContain('statsUnavailable = true')
    expect(TAB).toContain('data?.statsUnavailable ?? true')
  })

  it('the UI announces unavailability in text, not colour', () => {
    expect(TAB).toContain('<span className="sr-only">Unavailable</span>')
    expect(TAB).toContain('unavailable — not zero')
  })

  it('large figures are rendered in full, never abbreviated', () => {
    expect(attendanceMetrics(counts({ confirmed: 2_000_000, checkedIn: 1_234_567 }), false).checkedIn.text)
      .toBe('12,34,567')
  })
})

// ═══ A4 · Attendance does not restate the shell ═══════════════════════════════

describe('Attendance owns arrivals, not the event summary', () => {
  it('the five KPI cards are gone', () => {
    expect(TAB).not.toContain('function StatCard')
    expect(TAB).not.toContain('Total Registrations')
    expect(TAB).not.toContain('Attendance Rate')
    expect(TAB).not.toMatch(/grid-cols-2 gap-3 sm:grid-cols-5/)
  })

  it('revenue and capacity — the shell strip\'s own figures — appear nowhere', () => {
    for (const owned of ['confirmedRevenuePaise', 'totalCapacity', 'revenue']) {
      expect(TAB, owned).not.toContain(owned)
    }
  })

  it('it renders no second event header', () => {
    expect(TAB).not.toContain('<h1')
    expect(TAB).not.toContain('bannerUrl')
    expect(TAB).not.toContain('event.name')
  })

  it('the scanner is LINKED, never reimplemented', () => {
    expect(TAB).toContain('/checkin`')
    expect(TAB).toContain('Open scanner')
    for (const scanner of ['QrScanner', 'getUserMedia', 'BarcodeDetector', 'WalkInForm']) {
      expect(TAB, scanner).not.toContain(scanner)
    }
  })
})

// ═══ A6 · the operational workflow exists ═════════════════════════════════════

describe('Attendance can actually admit someone', () => {
  it('has a labelled search', () => {
    expect(TAB).toContain('id="att-search"')
    expect(TAB).toContain('htmlFor="att-search"')
    expect(TAB).toContain('type="search"')
  })

  it('debounces rather than querying per keystroke', () => {
    expect(TAB).toContain('setTimeout(() => { setDebounced(query.trim()); setCursor(null) }, 350)')
  })

  it('search is SERVER-side — never a browser filter over a page', () => {
    expect(TAB).toContain('/checkin/search?q=')
    expect(TAB).toContain('encodeURIComponent(debounced)')
    expect(TAB).not.toMatch(/rows\.filter\([^)]*toLowerCase/)
    expect(TAB).not.toMatch(/registrations\.filter\(/)
  })

  it('a NAME search does not go through the exact-lookup route', () => {
    // Browser QA found this. `/registrations?q=` is an EXACT ticket/email lookup:
    // "Bartholomew" satisfies its `^[a-z0-9]{6,}$` ticket heuristic, so a real
    // attendee was uppercased, looked up as a code, and reported as "no one matches";
    // and a Tamil name matched neither heuristic, fell through to the unfiltered page,
    // and returned EVERYONE as though they were all results.
    const browseBlock = TAB.slice(
      TAB.indexOf('const p = new URLSearchParams'),
      TAB.indexOf('setHasMore(j.hasMore)'),
    )
    expect(browseBlock.length).toBeGreaterThan(0)
    expect(browseBlock).not.toContain("p.set('q'")
    expect(TAB).toContain('shouldSearch(debounced)')
  })

  it('a search says it ignores the filter, and admits when it is truncated', () => {
    expect(TAB).toContain('regardless of the filter')
    expect(TAB).toContain('setSearchTruncated(j.truncated)')
    expect(TAB).toContain('Too many matches to show them all')
  })

  it('both sources produce ONE row shape', () => {
    const a = rowFromRegistration({
      id: 'r1', attendee: { name: 'Priya' }, ticketCode: 'RD-1', passName: '10K',
      status: 'confirmed', paymentStatus: 'paid', checkedIn: true,
      checkedInAt: '2026-08-28T09:00:00Z', identifier: { value: '1042' },
    })
    expect(a).toEqual({
      id: 'r1', name: 'Priya', ticketCode: 'RD-1', passName: '10K', status: 'confirmed',
      paymentStatus: 'paid', checkedIn: true, checkedInAt: '2026-08-28T09:00:00Z', identifier: '1042',
    })

    const b = rowFromSearchResult({
      id: 'r2', attendeeName: 'Murugan', ticketCode: 'RD-2', passName: 'Delegate',
      status: 'confirmed', checkedIn: false, checkedInAt: null,
    })
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    // The search route does not return paymentStatus, so it stays null rather than
    // being guessed — `rowAction` then defers, and the server owns the refunded rule.
    expect(b.paymentStatus).toBeNull()
  })

  it('missing fields degrade to empty, never to "undefined" on screen', () => {
    const r = rowFromRegistration({ id: 'x' })
    expect(r.name).toBe('')
    expect(r.checkedIn).toBe(false)
    expect(r.identifier).toBeNull()
    expect(String(Object.values(r))).not.toContain('undefined')
  })

  it("the search minimum matches the route's own", () => {
    expect(SEARCH_MIN_CHARS).toBe(2)
    expect(shouldSearch('a')).toBe(false)
    expect(shouldSearch('ab')).toBe(true)
    expect(shouldSearch('  a  ')).toBe(false)
    const search = strip(read('app/api/organizer/events/[eventId]/checkin/search/route.ts'))
    expect(search).toContain('if (q.length < 2)')
  })

  // ═══ RE-ANCHORED BY RD-CHECKIN-2.0 ═══════════════════════════════════════
  // `SCAN_DOC_CAP = 500` was pinned as evidence the route was "bounded, not a
  // full scan". It was bounded — and that was the defect, not the safeguard: the
  // route loaded the first 500 registrations of the event UNORDERED and filtered
  // them in-process, so on a 2,395-person event the attendee at document position
  // ~2,100 was unreachable by name, email or phone, and the operator was shown
  // "no results".
  //
  // The cap is gone, and its absence is now itself asserted. What replaced it is
  // not a bigger cap: every lookup is an indexed EQUALITY or an indexed PREFIX
  // RANGE, so reachability no longer depends on document position at all. The two
  // authorization facts this test actually cares about are unchanged and still
  // pinned — the event gate simply moved into the one shared readiness resolver.
  it('the search route it reuses is gated the same way Attendance is', () => {
    const search = strip(read('app/api/organizer/events/[eventId]/checkin/search/route.ts'))
    expect(search).toContain("authorizeEvent(req, 'checkin', eventId)")
    expect(search).toContain('resolveCheckinReadiness(uid, eventId)')
  })

  it('the search route no longer scans a fixed slice of the event', () => {
    const search = strip(read('app/api/organizer/events/[eventId]/checkin/search/route.ts'))
    expect(search).not.toContain('SCAN_DOC_CAP')
    // No in-process matching over a loaded page, in either direction.
    expect(search).not.toContain('matchesScan')
    expect(search).not.toMatch(/\.includes\(lower\)/)
  })

  it('the readiness resolver is shared, so the gate cannot disagree with itself', () => {
    const readiness = strip(read('lib/checkin/readiness.ts'))
    expect(readiness).toContain('getEventCheckInStatus(slug)')
    expect(readiness).toContain('eventDrafts')
  })

  it('the list is cursor-paginated over the WHOLE matching set', () => {
    expect(TAB).toContain("p.set('cursor', cursor)")
    expect(TAB).toContain('const PAGE_SIZE  = 25')
    expect(TAB).not.toContain("all=true")
    // hasMore comes from the server, never from counting what arrived.
    expect(TAB).toContain('setHasMore(j.hasMore)')
  })

  it('both filter directions are SERVER-side', () => {
    expect(filterParam('in')).toBe('yes')
    expect(filterParam('out')).toBe('no')
    expect(filterParam('all')).toBeNull()
    expect(REGAPI).toContain("if (checkinF === 'yes')     query = query.where('checkedIn', '==', true)")
    // RD-CHECKIN-FILTER-01 — 'no' is NOT an `== false` query: that excluded every paid
    // registration without the field. It is filtered while paging, server-side.
    expect(REGAPI).not.toContain("query.where('checkedIn', '==', false)")
    expect(REGAPI).toContain("const isNotCheckedIn = (d: FirebaseFirestore.QueryDocumentSnapshot) => d.get('checkedIn') !== true")
  })

  it('RD-CHECKIN-FILTER-01 · the not-arrived list includes registrations WITHOUT the field, and says it is complete', () => {
    // Firestore cannot match an ABSENT field, so a paid registration without `checkedIn`
    // used to vanish from the roll call. It is now filtered in memory (bounded, resumable).
    expect(REGAPI).toContain('NOT_CHECKED_IN_SCAN_CAP')
    expect(REGAPI).toContain("const checkinFilterComplete: boolean | undefined = checkinF === 'no' ? true : undefined")
    expect(TAB).toContain('setListComplete(j.checkinFilterComplete !== false)')
    expect(TAB).toContain('are missing from this')
    // …and newly settled PAID registrations carry the field, like free / walk-in ones.
    expect(readFileSync(resolve(process.cwd(), 'lib/payments/settleCapturedRegistration.ts'), 'utf8')).toMatch(/checkedIn:\s+false,/)
  })

  it('check-in and undo reuse the canonical routes', () => {
    expect(TAB).toContain("ticketCode: reg.ticketCode")
    expect(TAB).toContain('eventSlug:  event.slug ?? undefined')
    expect(TAB).toContain("source:     'attendance_tab'")
    expect(TAB).toContain('/undo-checkin')
  })

  it('a double click cannot fire a second write', () => {
    expect(TAB).toContain('if (busyRows[reg.id]) return')
    expect(TAB).toContain('setBusyRows(b => ({ ...b, [reg.id]: true }))')
    expect(TAB).toContain('disabled={busy}')
  })

  it('a mutation reports itself and never reloads the document', () => {
    expect(TAB).toContain('showToast(')
    expect(TAB).not.toContain('window.location.reload')
    expect(TAB).toContain("showToast(action === 'in' ? \"Check-in couldn't be completed.\" : \"Undo couldn't be completed.\", 'error')")
  })

  // RD-CHECKIN-ID-OPT-02 — identifiers are optional: this table has no identifier input,
  // so it admits WITHOUT one (assigning stays the scanner's job) and the toast says so.
  it('an identifier prompt is skipped here, and the operator is told no identifier was assigned', () => {
    expect(TAB).toContain('body.requiresIdentifier')
    expect(TAB).toContain('res  = await scanIn(true)')
    expect(TAB).toContain('...(skipIdentifier ? { skipIdentifier: true } : {})')
    expect(TAB).toContain('checked in without a ${withoutLabel}. Assign one from the check-in screen if needed.')
  })
})

// ═══ Row eligibility mirrors the ONE canonical rule ═══════════════════════════

describe('who a row offers to admit', () => {
  const base = { status: 'confirmed', paymentStatus: 'paid', checkedIn: false }

  it('offers check-in to a confirmed, unarrived registration', () => {
    expect(rowAction(base, true)).toEqual({ kind: 'check-in' })
  })

  it('offers undo to someone already in', () => {
    expect(rowAction({ ...base, checkedIn: true }, true)).toEqual({ kind: 'undo' })
  })

  it('blocks exactly what checkinEligibility blocks', () => {
    expect(rowAction({ ...base, status: 'cancelled' }, true).kind).toBe('blocked')
    expect(rowAction({ ...base, status: 'pending' }, true).kind).toBe('blocked')
    expect(rowAction({ ...base, status: 'rejected' }, true).kind).toBe('blocked')
    expect(rowAction({ ...base, paymentStatus: 'refunded' }, true).kind).toBe('blocked')
  })

  it('blocks everything when the event does not accept check-ins', () => {
    expect(rowAction(base, false)).toEqual({ kind: 'blocked', reason: 'Check-in is closed for this event' })
    expect(rowAction({ ...base, checkedIn: true }, false).kind).toBe('blocked')
  })

  it('every blocked row explains itself in words', () => {
    for (const r of [
      rowAction({ ...base, status: 'cancelled' }, true),
      rowAction({ ...base, status: 'pending' }, true),
      rowAction(base, false),
    ]) {
      expect(r.kind).toBe('blocked')
      if (r.kind === 'blocked') expect(r.reason.length).toBeGreaterThan(3)
    }
  })
})

// ═══ A8 · lifecycle ═══════════════════════════════════════════════════════════

describe('lifecycle', () => {
  it('the accepting set is EXACTLY the server\'s', () => {
    // lib/checkin/eventStatus is the rule every check-in route enforces. If that set
    // changes and this one does not, the UI offers a button the server refuses.
    for (const s of CHECKIN_LIFECYCLE_STATES) expect(GATE).toContain(`'${s}'`)
    expect(GATE).toContain("ACCEPTING_STATUSES = new Set(['published', 'registration_closed', 'completed'])")
    expect([...CHECKIN_LIFECYCLE_STATES].sort()).toEqual(['completed', 'published', 'registration_closed'])
  })

  it('resolves for EVERY lifecycle state without falling through', () => {
    const all: EventLifecycleStatus[] = ['draft', 'pending_review', 'changes_requested',
      'published', 'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']
    for (const ls of all) {
      const g = attendanceGate(ls, 'sports')
      if (g.accepts) continue
      expect(g.title.length, ls).toBeGreaterThan(3)
      expect(g.body.length, ls).toBeGreaterThan(10)
    }
  })

  it('accepts published, registration_closed and completed — and nothing else', () => {
    expect(attendanceGate('published').accepts).toBe(true)
    expect(attendanceGate('registration_closed').accepts).toBe(true)
    expect(attendanceGate('completed').accepts).toBe(true)
    for (const ls of ['draft', 'pending_review', 'changes_requested', 'unpublished', 'cancelled', 'archived']) {
      expect(attendanceGate(ls).accepts, ls).toBe(false)
    }
  })

  it('an unknown or missing state fails CLOSED', () => {
    expect(attendanceGate(null).accepts).toBe(false)
    expect(attendanceGate(undefined).accepts).toBe(false)
    expect(attendanceGate('something_new').accepts).toBe(false)
  })

  it('a draft explains itself rather than reporting a failure', () => {
    const g = attendanceGate('draft')
    expect(g.accepts).toBe(false)
    if (!g.accepts) {
      expect(g.title).toMatch(/published/i)
      expect(g.body).not.toMatch(/error|failed/i)
    }
  })

  it('a cancelled or archived event keeps its history and says so', () => {
    for (const ls of ['cancelled', 'archived']) {
      const g = attendanceGate(ls)
      expect(g.accepts).toBe(false)
      if (!g.accepts) expect(g.body).toMatch(/kept|read-only/i)
    }
  })

  it('only a live event polls — history does not change', () => {
    expect(isLiveAttendance('published')).toBe(true)
    expect(isLiveAttendance('registration_closed')).toBe(true)
    expect(isLiveAttendance('completed')).toBe(false)
    expect(isLiveAttendance('cancelled')).toBe(false)
  })

  it('A9 · a draft returns a STATE, not a 404', () => {
    // The slug-less branch answers 200 with an empty, honest payload. It used to 404,
    // which the tab rendered as "Failed to load dashboard" on every unpublished event.
    const draftBranch = API.slice(API.indexOf('if (!slug) {'), API.indexOf('// ── 3.'))
    expect(draftBranch).toContain('return NextResponse.json({')
    expect(draftBranch).toContain('checkInAccepted: false')
    expect(draftBranch).toContain('statsUnavailable: false')
    expect(draftBranch).not.toContain('status: 404')
  })

  it('the server still decides — the client gate only chooses words', () => {
    expect(API).toContain("authorizeEvent(req, 'checkin', eventId)")
    expect(TAB).toContain('attendanceGate(')
  })
})

// ═══ A7 · event-type behaviour ════════════════════════════════════════════════

describe('RegisterDesk is not a marathon platform', () => {
  it('the identifier column is the ORGANIZER\'s label, never "BIB"', () => {
    expect(identifierColumnLabel(true, 'Bib Number')).toBe('Bib Number')
    expect(identifierColumnLabel(true, 'Delegate ID')).toBe('Delegate ID')
    expect(identifierColumnLabel(true, 'Visitor Pass')).toBe('Visitor Pass')
  })

  it('an event that issues nothing has no column at all', () => {
    expect(identifierColumnLabel(false, 'Bib Number')).toBeNull()
    expect(identifierColumnLabel(true, '')).toBeNull()
    expect(identifierColumnLabel(true, '   ')).toBeNull()
    expect(identifierColumnLabel(true, null)).toBeNull()
  })

  it('the label comes from the identifier config the organizer edits', () => {
    expect(API).toContain('resolveIdentifierConfig(slug)')
    expect(API).toContain('identifierLabel:   idConfig?.enabled ? (idConfig.label ?? null) : null')
    expect(TAB).toContain('identifierColumnLabel(')
  })

  it('no marathon vocabulary is hardcoded anywhere in the tab or the resolver', () => {
    for (const word of [/\brunner/i, /\bbib\b/i, /\brace\b/i, /\bfinisher/i, /\bmarathon/i]) {
      expect(TAB, String(word)).not.toMatch(word)
      expect(LIB, String(word)).not.toMatch(word)
    }
  })

  it('the participant noun follows the event type', () => {
    expect(participantNoun('sports')).toEqual({ one: 'participant', many: 'participants' })
    for (const t of ['conference', 'exhibition', 'awards', 'cultural', null, undefined]) {
      expect(participantNoun(t).many, String(t)).toBe('attendees')
    }
  })

  it('attendance does not depend on ticket revenue, so a free or donation event works', () => {
    expect(API).not.toContain('revenuePaise')
    expect(API).not.toContain('isFreeEvent')
    expect(API).not.toContain('campaignType')
  })
})

// ═══ Filters + empty states ═══════════════════════════════════════════════════

describe('empty is not error is not unavailable', () => {
  it('validates the filter value', () => {
    expect(isAttendanceFilter('all')).toBe(true)
    expect(isAttendanceFilter('in')).toBe(true)
    expect(isAttendanceFilter('out')).toBe(true)
    expect(isAttendanceFilter('nonsense')).toBe(false)
    expect(isAttendanceFilter(null)).toBe(false)
  })

  it('every empty state says something DIFFERENT and true', () => {
    const noun = { many: 'attendees' }
    const msgs = new Set([
      filterEmptyMessage('all', false, noun),
      filterEmptyMessage('in', false, noun),
      filterEmptyMessage('out', false, noun),
      filterEmptyMessage('all', true, noun),
    ])
    expect(msgs.size).toBe(4)
    expect(filterEmptyMessage('all', true, noun)).toMatch(/search/i)
    expect(filterEmptyMessage('in', false, noun)).toMatch(/checked in/i)
  })

  it('a failed request is never rendered as an empty list', () => {
    expect(TAB).toContain("rowsState === 'error'")
    expect(TAB).toContain("Search couldn't be completed.")
    expect(TAB).toContain("Attendance couldn&apos;t be loaded")
    // the empty branch is reached only AFTER error and loading are excluded
    const errIdx   = TAB.indexOf("rowsState === 'error'")
    const emptyIdx = TAB.indexOf('rows.length === 0')
    expect(errIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(errIdx)
  })

  it('forbidden is its own state, distinct from empty and from error', () => {
    expect(TAB).toContain("setState('forbidden')")
    expect(TAB).toContain("setRowsState('forbidden')")
    expect(TAB).toContain("You don&apos;t have access to attendance")
  })

  it('retry actually issues another request', () => {
    expect(TAB).toContain('setRowsAttempt(a => a + 1)')
    expect(TAB).toContain('setAttempt(a => a + 1)')
    expect(TAB).toContain('rowsAttempt]')
    expect(TAB).toContain('eventId, attempt]')
  })

  it('a later page does not blank the rows already on screen', () => {
    expect(TAB).toContain('if (first) setRowsState(\'loading\'); else setPageBusy(true)')
    expect(TAB).toContain('setRows(prev => (first ? mapped : [...prev, ...mapped]))')
  })

  it('never leaks a raw error', () => {
    expect(TAB).not.toMatch(/\{error\}|e\.message|\.digest|body\.error/)
  })
})

// ═══ Time ═════════════════════════════════════════════════════════════════════

describe('times are the event\'s, and defend against bad input', () => {
  it('renders a check-in clock in the event timezone', () => {
    const iso = '2026-08-28T09:00:00Z'
    expect(checkInClock(iso, IST)).toBe('14:30')
    expect(checkInClock(iso, 'UTC')).toBe('09:00')
  })

  it('survives null, nonsense and an unknown zone', () => {
    expect(checkInClock(null, IST)).toBeNull()
    expect(checkInClock('not-a-date', IST)).toBeNull()
    expect(checkInClock('2026-08-28T09:00:00Z', 'Mars/Olympus')).toBeTruthy()
  })

  it('relative time is computed from a clock the caller owns', () => {
    const now = new Date('2026-08-28T12:00:00Z').getTime()
    expect(sinceLabel(new Date(now - 30_000).toISOString(), now)).toBe('30s ago')
    expect(sinceLabel(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago')
    expect(sinceLabel(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago')
    expect(sinceLabel(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago')
    expect(sinceLabel(new Date(now + 5_000).toISOString(), now)).toBe('just now')
    expect(sinceLabel(null, now)).toBeNull()
    expect(sinceLabel('nonsense', now)).toBeNull()
  })

  it('the tab does not call an impure clock during render', () => {
    expect(TAB).not.toContain('Date.now()')
    expect(TAB).toContain('const { now } = useEventContext()')
  })
})

// ═══ Security ═════════════════════════════════════════════════════════════════

describe('the server remains the boundary', () => {
  it('authorises by workspace AND by event assignment', () => {
    expect(API).toContain("authorizeEvent(req, 'checkin', eventId)")
    expect(API).toContain('const uid = authz.workspaceUid')
  })

  it('scopes every query by the AUTHENTICATED uid, never a client value', () => {
    expect(API).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)')
    for (const m of API.match(/where\('organizerUid', '==', [a-z]+\)/g) ?? []) {
      expect(m).toBe("where('organizerUid', '==', uid)")
    }
    expect(API).not.toMatch(/searchParams\.get\('uid'\)|body\.organizerUid/)
  })

  it('the client sends only the event id and its own token', () => {
    expect(TAB).not.toMatch(/organizerUid|workspaceUid|[?&]uid=/)
  })

  it('a forged event id cannot reach another workspace', () => {
    expect(API).toContain("return NextResponse.json({ error: 'Event not found' }, { status: 404 })")
    expect(API).not.toMatch(/users\/\$\{(?!uid)/)
  })
})

// ═══ Design system + accessibility ════════════════════════════════════════════

describe('it looks and behaves like the rest of the product', () => {
  it('uses typography and radius tokens, not arbitrary pixels', () => {
    expect(TAB).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(TAB).not.toMatch(/\brounded-(xl|lg|2xl|sm|full)\b/)
    expect(TAB).toMatch(/rounded-(control|surface|pill)/)
  })

  it('introduces no raw palette hues', () => {
    expect(TAB).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red|orange|blue|green|yellow)-\d{2,3}\b/)
    expect(TAB).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('adds no shadow, blur or glass, and spends no saturated brand fill', () => {
    expect(TAB).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
    expect(TAB).not.toMatch(/bg-primary(?![-/])/)
    expect(TAB).toContain('bg-primary/[0.08]')
    expect(TAB).toContain('text-[color:var(--primary-text)]')
  })

  it('uses h2 sections — the page H1 belongs to the shell header', () => {
    expect(TAB).not.toContain('<h1')
    expect(TAB).toContain('<h2')
    expect(TAB).toContain('<section aria-labelledby={id} className="min-w-0">')
    for (const id of ['att-progress', 'att-roll', 'att-hourly', 'att-recent', 'att-pass', 'att-gate']) {
      expect(TAB, id).toContain(`"${id}"`)
    }
  })

  it('the progress bar carries the complete ARIA contract', () => {
    expect(TAB).toContain('role="progressbar"')
    expect(TAB).toContain('aria-valuenow={pct}')
    expect(TAB).toContain('aria-valuemin={0}')
    expect(TAB).toContain('aria-valuemax={100}')
    expect(TAB).toMatch(/aria-label=\{`\$\{pct\}% of confirmed/)
  })

  it('status is a WORD, never a colour alone', () => {
    expect(TAB).toContain('function StatusPill')
    expect(TAB).toContain('Checked in')
    expect(TAB).toContain('Not arrived')
  })

  it('the filter group and its pressed state are announced', () => {
    expect(TAB).toContain('role="group" aria-label="Attendance filter"')
    expect(TAB).toContain('aria-pressed={filter === o.v}')
  })

  it('every repeated row action names its target', () => {
    expect(TAB).toContain('aria-label={`Check in ${r.name || r.ticketCode}`}')
    expect(TAB).toContain('aria-label={`Undo check-in for ${r.name || r.ticketCode}`}')
  })

  it('announces loading and async change', () => {
    expect(TAB).toContain('aria-busy="true"')
    expect(TAB).toContain('aria-live="polite"')
    expect(TAB).toContain('<span className="sr-only">Loading attendance…</span>')
  })

  it('touch targets are 44px, and the table can scroll without taking the page with it', () => {
    expect((TAB.match(/h-11/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(TAB).toContain('overflow-x-auto')
    expect((TAB.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('long and multilingual content wraps or truncates, never widens the page', () => {
    expect(TAB).toContain('truncate')
    expect(TAB).toContain('max-w-[16rem] truncate')
  })
})

// ═══ Nothing else was touched ═════════════════════════════════════════════════

describe('the phase stayed inside Attendance', () => {
  it('the tab registry and the tab URL are unchanged', () => {
    expect(SHELL).toContain("{activeTab === 'attendance' &&")
    const tabs = strip(read('lib/events/eventTabs.ts'))
    expect(tabs).toContain("{ key: 'attendance',            label: 'Attendance',     icon: ScanLine      },")
  })

  it('the registrations route gained ONLY the additive filter and its honesty flag', () => {
    // Everything the registrations list already did must still be there.
    for (const kept of ['const allMode  =', 'parseTrendDays', "params.get('status')", 'nextCursor', 'serializeDoc']) {
      expect(REGAPI, kept).toContain(kept)
    }
  })

  it('the check-in scanner and its routes are untouched by this phase', () => {
    const scan = strip(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain('checkInBlockReason')
    expect(scan).toContain("authorizeWorkspace(req, 'checkin')")
  })
})
