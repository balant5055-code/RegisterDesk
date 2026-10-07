// RD-DASH-11A · Check-in status — the source, the definition, and the number it refuses to tidy.
//
// ═══ THE DEFECT THIS SUITE ENCODES ═══════════════════════════════════════════
// The dashboard carried a per-event `checkedIn` read straight off
// `registrationCounters/{slug}.checkedInCount`. Measured in production:
//
//   base counter doc  .checkedInCount = 0
//   attendance SHARDS .checkedInCount = 288   (10 shards, 22–35 each)
//   getRegistrationCounter() FOLDED   = 288
//   registrations with checkedInAt    = 288
//   registrations with checkedIn=true = 288
//
// Check-in writes go to distributed attendance shards; the base document is never
// incremented. A card built on that field would have reported 0 of 2,295 at 0% for an event
// whose gate processed 288 people. It survived only because nothing rendered it.
//
// ═══ AND THE ONE THAT CANNOT BE CLAMPED ══════════════════════════════════════
// `checkInBlockReason` refuses a CANCELLED registration at every entry point, so nobody can
// check in a cancelled participant. But `cancelRegistration` decrements `totalCount` (the
// confirmed figure) and leaves `checkedInAt` and the attendance shard untouched — so
// cancelling someone who already checked in leaves them in the numerator and removes them
// from the denominator. `checkedIn > confirmed` is structurally reachable.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `foldAttendanceShards` is pure, but it lives beside the Admin SDK import. Doubled rather
// than booted — the real one parses a service-account key this environment does not have.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
import {
  resolveCheckInStatus, EMPTY_CHECK_IN, type CheckInInput,
} from '@/lib/dashboard/checkInStatus'
import { foldAttendanceShards } from '@/lib/firebase/firestore/registrationCounters'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments carry the audit's prose, including the field the CODE must not read. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PURE     = read('lib/dashboard/checkInStatus.ts')
const ADMIN    = read('lib/dashboard/checkInStatusAdmin.ts')
const PANEL    = read('components/dashboard/CheckInPanel.tsx')
const ROUTE    = read('app/api/organizer/dashboard/route.ts')
const PAGE     = read('app/(dashboard)/dashboard/page.tsx')
const COUNTERS = read('lib/firebase/firestore/registrationCounters.ts')
const REGS     = read('lib/firebase/firestore/registrations.ts')
const ELIGIBLE = read('lib/registrations/checkinEligibility.ts')
const REGISTRY = read('lib/eventSetup/registry.ts')
const SECTIONS = read('lib/dashboard/sections.ts')
const TOKENS   = read('styles/tokens.css')

/** A healthy event. Each test perturbs only its own subject. */
const input = (over: Partial<CheckInInput> = {}): CheckInInput => ({
  checkedIn: 288, confirmed: 2295,
  passCheckedIn: { p1: 99, p2: 170, p3: 19 },
  passConfirmed: { p1: 1260, p2: 983, p3: 52 },
  passNames: { p1: 'Walk', p2: 'Half', p3: 'Full' },
  supported: true, ...over,
})

// ═══ 1 · the source ══════════════════════════════════════════════════════════

describe('the count comes from the shard fold, never the base counter', () => {
  it('the value is FOLDED from the attendance shards, by the platform\'s own function', () => {
    // RD-DASH-11B moved the fold up to the route so ONE result serves both this card and
    // `eventStatus`. The fold itself is unchanged — `foldAttendanceShards`, the same
    // function `getRegistrationCounter` composes.
    expect(ADMIN).toContain('foldAttendanceShards((base ?? {}) as RegistrationCounter, shards)')
    expect(ROUTE).toContain('getAttendanceShardSums(slug).catch(() => null)')
    expect(COUNTERS).toContain('foldAttendanceShards(snap.data() as RegistrationCounter, shards)')
  })

  it('no module here reads the base counter field or counts check-ins a second way', () => {
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      // The base document's own value — 0 on an event with 288 check-ins.
      // The COLLECTION, not the module path — the admin half legitimately imports
      // getRegistrationCounter from lib/firebase/firestore/registrationCounters.
      expect(code).not.toMatch(/collection\(['"]registrationCounters['"]\)/)
      // …and no parallel implementation.
      expect(code).not.toMatch(/checkedInAt/)
      expect(code).not.toMatch(/collection\(['"]registrations['"]\)/)
    }
  })

  it('the route reads it through the resolver and nothing else', () => {
    expect(ROUTE).toContain('const checkIn = resolveCheckInFromCounters(')
    // The stale `eventStatus.checkedIn` is still built from the base field for the existing
    // status shape; this card must never be wired to it.
    expect(strip(PANEL)).not.toMatch(/eventStatus|registrationStatus/)
  })

  it('the confirmed denominator is the SAME field every other surface uses', () => {
    // `totalCount` holds CONFIRMED. A different confirmed count here would give the card its
    // own denominator and let it disagree with Registration Status.
    expect(ADMIN).toContain('confirmed:     counter.totalCount ?? 0')
  })
})

// ═══ 2 · the definition ══════════════════════════════════════════════════════

describe('checked in means a registration, not a scan', () => {
  it('a repeated scan cannot inflate the figure — the shard counts registrations', () => {
    // buildCheckinDelta is +1 per check-in and -1 per undo, guarded by the registration's own
    // idempotent `checkedIn` flag. Nothing counts scan attempts.
    expect(COUNTERS).toContain('export function buildCheckinDelta(passId: string, dir: 1 | -1)')
    expect(COUNTERS).toMatch(/idempotent/)
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      // `ScanLine` is the lucide glyph, so the guard names the CONCEPTS a scan count would
      // introduce rather than the bare substring.
      expect(code).not.toMatch(/scanCount|scanAttempts|totalScans|qrScans/i)
    }
  })

  it('a cancelled participant can never CHECK IN — the canonical gate refuses them', () => {
    expect(ELIGIBLE).toContain("if (reg.status === 'cancelled')       return 'CANCELLED'")
    // Every entry point consults it.
    for (const f of [
      'app/api/checkin/scan/route.ts',
      'lib/firebase/firestore/registrations.ts',
      'lib/checkin/useOfflineCheckin.ts',
    ]) expect(read(f)).toContain('checkInBlockReason')
  })

  it('but cancelling a CHECKED-IN participant leaves the gate count intact', () => {
    // The reverse direction is unguarded, and this is why the ratio can exceed 100%.
    const cancel = REGS.slice(REGS.indexOf('status:    \'cancelled\''), REGS.indexOf('applyReleaseWrites'))
    expect(cancel).not.toMatch(/checkedIn/)
    expect(REGS).toContain('cancelledCount: FieldValue.increment(1)')
    expect(REGS).toContain('updates.totalCount                   = FieldValue.increment(-1)')
  })
})

// ═══ 3 · the number that is never clamped ════════════════════════════════════

describe('more check-ins than confirmed is surfaced, not corrected', () => {
  it('the true ratio is reported even above 100', () => {
    const s = resolveCheckInStatus(input({ checkedIn: 12, confirmed: 10 }))
    expect(s.percentage).toBeCloseTo(120, 6)
    expect(s.exceedsConfirmed).toBe(true)
  })

  it('nothing anywhere clamps the FIGURE', () => {
    expect(strip(PURE)).not.toMatch(/Math\.min\(100/)
    // The component clamps a BAR WIDTH, which is where clamping belongs — a bar cannot be
    // longer than its track, but the number beside it can and must say 120%.
    expect(PANEL).toContain('Math.min(100, Math.max(percentage')
  })

  it('remaining is withheld rather than shown negative or soothed to zero', () => {
    const s = resolveCheckInStatus(input({ checkedIn: 12, confirmed: 10 }))
    expect(s.remaining).toBeNull()
    expect(PANEL).toContain('More check-ins than confirmed')
  })

  it('nothing is silently subtracted to make the figures agree', () => {
    expect(strip(PURE)).not.toMatch(/cancelled/i)
    expect(strip(ADMIN)).not.toMatch(/cancelled/i)
  })

  it('the condition is announced, not just tinted', () => {
    expect(PANEL).toContain('role="alert"')
    expect(PANEL).toContain('More check-ins than confirmed registrations.')
  })
})

// ═══ 4 · the arithmetic happens once, on the server ══════════════════════════

describe('the component computes nothing', () => {
  it('remaining and percentage arrive resolved', () => {
    const s = resolveCheckInStatus(input())
    expect(s.checkedIn).toBe(288)
    expect(s.confirmed).toBe(2295)
    expect(s.remaining).toBe(2007)
    expect(s.percentage).toBeCloseTo(12.549, 2)
  })

  it('no subtraction or division survives in the component', () => {
    const code = strip(PANEL)
    expect(code).not.toMatch(/confirmed\s*-\s*checkedIn/)
    expect(code).not.toMatch(/checkedIn\s*\/\s*confirmed/)
    expect(code).not.toMatch(/\*\s*100/)
  })

  it('per-pass rates are resolved too, and the rows are NOT sorted here', () => {
    const s = resolveCheckInStatus(input())
    expect(s.byPass.map(r => r.passId)).toEqual(['p1', 'p2', 'p3'])
    expect(s.byPass[0].percentage).toBeCloseTo((99 / 1260) * 100, 6)
    // Configured order — the key order of `passNames`, which is built by walking
    // draft.pricing.passes. Sorting here would decide the order by accident.
    expect(strip(PANEL)).not.toMatch(/\.sort\(/)
    expect(PURE).toContain('Object.keys(input.passNames).map')
  })

  it('a pass with no confirmed base claims no rate', () => {
    const s = resolveCheckInStatus(input({ passConfirmed: { p1: 0 }, passCheckedIn: { p1: 4 }, passNames: { p1: 'Walk' } }))
    expect(s.byPass[0].confirmed).toBeNull()
    expect(s.byPass[0].percentage).toBeNull()
  })

  it('an empty pass is not given a row', () => {
    const s = resolveCheckInStatus(input({ passCheckedIn: {}, passConfirmed: {}, passNames: { p1: 'Walk' } }))
    expect(s.byPass).toHaveLength(0)
  })
})

// ═══ 5 · the four states ═════════════════════════════════════════════════════

describe('the four states are never collapsed', () => {
  it('READY — measured, with a denominator', () => {
    expect(resolveCheckInStatus(input()).state).toBe('ready')
  })

  it('NO CONFIRMED — measured, but a rate would divide by zero', () => {
    const s = resolveCheckInStatus(input({ checkedIn: 0, confirmed: 0 }))
    expect(s.state).toBe('no_confirmed')
    expect(s.percentage).toBeNull()
    expect(PANEL).toContain('No confirmed participants yet')
  })

  it('ZERO CHECKED IN is REAL DATA, not an absence', () => {
    const s = resolveCheckInStatus(input({ checkedIn: 0, confirmed: 500 }))
    expect(s.state).toBe('ready')
    expect(s.checkedIn).toBe(0)
    expect(s.remaining).toBe(500)
    expect(s.percentage).toBe(0)
    expect(PANEL).toContain('All confirmed participants remain to be checked in.')
  })

  it('UNAVAILABLE — an unread count is never zero', () => {
    for (const over of [{ checkedIn: null }, { confirmed: null }]) {
      const s = resolveCheckInStatus(input(over))
      expect(s.state).toBe('unavailable')
      expect(s.checkedIn).not.toBe(0)
    }
    expect(PANEL).toContain('Check-in data unavailable')
    expect(EMPTY_CHECK_IN.state).toBe('unavailable')
  })

  it('NOT SUPPORTED — the event cannot take check-ins at all', () => {
    const s = resolveCheckInStatus(input({ supported: false }))
    expect(s.state).toBe('not_supported')
    expect(PANEL).toContain('Select an event to view check-in progress')
  })

  it('COMPLETE is exact equality, not a rate that rounds to 100', () => {
    expect(resolveCheckInStatus(input({ checkedIn: 2295, confirmed: 2295 })).complete).toBe(true)
    expect(resolveCheckInStatus(input({ checkedIn: 2294, confirmed: 2295 })).complete).toBe(false)
    expect(PANEL).toContain('All confirmed participants have checked in.')
  })
})

// ═══ 6 · capability and scope ════════════════════════════════════════════════

describe('scope and capability come from existing rules', () => {
  it('the capability rule MIRRORS lib/eventSetup/registry — pinned, not guessed', () => {
    expect(REGISTRY).toContain("const PUBLISHED_LIKE = new Set(['published', 'registration_closed', 'completed'])")
    expect(ADMIN).toContain("['published', 'registration_closed', 'completed']")
    expect(REGISTRY).toContain('Publish the event to enable check-in.')
  })

  it('an unpublished event is refused, and the resolver cannot query at all', () => {
    // It has no slug, and a null slug would drop the filter and read the workspace. Since
    // RD-DASH-11B this function performs no query whatsoever, so that failure mode is
    // structurally impossible here rather than merely guarded against.
    expect(ADMIN).toContain('if (!scoped || !slug) return')
    expect(strip(ADMIN)).not.toMatch(/await|adminDb|\.get\(\)/)
    // …and the route only ever folds slugs it resolved from authorized event data.
    // RD-DASH-13 · the fold is now the selected event and nothing else, so the guard is
    // the whole expression rather than one branch of a union.
    expect(ROUTE).toContain('const shardSlugs = scoped && selectedSlug ? [selectedSlug] : []')
  })

  it('ALL-EVENTS mode reads nothing at all', () => {
    // Blending a finished race with an upcoming one produces a rate nobody can act on, and
    // it would cost one subcollection read per event to produce.
    expect(ADMIN).toContain('Check-in is a gate operation')
    expect(PANEL).toContain('there is no workspace-wide figure to show')
  })

  it('the route passes the selected event, and only that', () => {
    expect(ROUTE).toContain('slug:      selectedSlug,')
    expect(ROUTE).toContain('lifecycle: selectedLifecycle,')
    // No new identifier — the existing draftId → slug architecture.
    expect(strip(ADMIN)).not.toMatch(/draftId|eventId/)
  })

  it('ownership is the route\'s existing authorized path — no client value widens it', () => {
    expect(ROUTE).toContain('const uid = authz.workspaceUid')
    expect(strip(ADMIN)).not.toMatch(/searchParams|req\./)
  })
})

// ═══ 7 · read cost ═══════════════════════════════════════════════════════════

describe('the read is one counter and one shard fold', () => {
  it('no registration documents are read to produce this figure', () => {
    expect(strip(ADMIN)).not.toMatch(/\.get\(\)/)
    expect(strip(ADMIN)).not.toMatch(/count\(\)|aggregate\(/)
  })

  it('each slug\'s shards are folded EXACTLY ONCE for the whole request', () => {
    // The card and `eventStatus` share one result. Folding in both places would read the
    // selected event's shard subcollection twice on every dashboard load.
    expect((ROUTE.match(/getAttendanceShardSums\(/g) ?? []).length).toBe(1)
    expect((ROUTE.match(/resolveCheckInFromCounters\(/g) ?? []).length).toBe(1)
    expect(ROUTE).toContain('const attendanceBySlug = new Map<string, AttendanceShardSums | null>()')
  })

  it('the BASE counter is reused, never re-read', () => {
    // `getRegistrationCounter()` would fetch the base document again; the route already
    // holds every base counter in `counterBySlug`.
    expect(strip(ROUTE)).not.toMatch(/getRegistrationCounter\(/)
    // RD-DASH-13 · the route no longer folds at all — `eventStatus` dropped `checkedIn`,
    // which nothing read. The fold that remains is inside `resolveCheckInFromCounters`,
    // fed the base counter the route already holds. Still never a second document read.
    expect(strip(ROUTE)).not.toMatch(/foldAttendanceShards\(/)
    expect(ROUTE).toContain('counterBySlug.get(selectedSlug) ?? null')
  })
})

// ═══ 8 · it does not restate Registration Status ═════════════════════════════

describe('this is progress, not another status breakdown', () => {
  it('no ring, and no status vocabulary', () => {
    const code = strip(PANEL)
    expect(code).not.toMatch(/StatusRing|circle|svg/i)
    for (const w of [/pending/i, /waitlisted/i, /rejected/i]) expect(code).not.toMatch(w)
  })

  it('carries no money, coupon, communication or event-comparison figure', () => {
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      for (const w of [/Paise/, /revenue/i, /coupon/i, /broadcast/i, /₹/]) expect(code).not.toMatch(w)
    }
  })

  it('it does not introduce a second time window', () => {
    // `todayCheckins` already exists and is correct; this card answers all-time progress.
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      expect(code).not.toMatch(/todayCheckins|todayStart/)
    }
  })

  it('it is its own toggleable section, in its own full-width row', () => {
    expect(SECTIONS).toContain("{ id: 'checkin',        label: 'Check-in status' },")
    expect(SECTIONS).toContain("| 'checkin'")
    expect(PAGE).toContain('{visible.checkin && <CheckInPanel')
  })
})

// ═══ 9 · accessibility ═══════════════════════════════════════════════════════

describe('every figure is text, and none of it rests on colour', () => {
  it('the bar is decorative — its figures are written beside it', () => {
    expect(PANEL).toMatch(/style=\{\{ background: TRACK \}\} aria-hidden/)
    expect(PANEL).toContain('{n(checkedIn ?? 0)}')
    expect(PANEL).toContain('remaining</span>')
    expect(PANEL).toContain('confirmed</span>')
  })

  it('a pass row speaks its whole sentence', () => {
    expect(PANEL).toContain('role="group"')
    expect(PANEL).toContain('aria-label={spoken}')
    expect(PANEL).toContain('${n(row.checkedIn)} of ${n(row.confirmed)} checked in')
  })

  it('the glyph is decorative and the destination already exists', () => {
    expect(PANEL).toMatch(/<ScanLine className="size-3.5" \/>/)
    expect(PANEL).toContain("href = '/dashboard/check-in'")
    expect(PAGE).toContain("href: '/dashboard/check-in'")
  })
})

// ═══ 10 · design system ══════════════════════════════════════════════════════

describe('the card belongs to the dashboard design system', () => {
  it('carries no inline colour — every value is a token, in both themes', () => {
    expect(PANEL).not.toMatch(/#[0-9A-Fa-f]{6}/)
    for (const t of ['--checkin-fill', '--checkin-tint', '--checkin-ink', '--checkin-alert-tint', '--checkin-alert-ink']) {
      expect((TOKENS.match(new RegExp(t + ':', 'g')) ?? []).length).toBe(2)
    }
  })

  it('leaves the frozen KPI tokens untouched', () => {
    for (const k of ['capacity', 'people', 'money', 'fees']) {
      expect(TOKENS).toContain('--kpi-' + k + '-fill:')
    }
  })

  it('fills its track, pushes the breakdown to the bottom, no fixed height', () => {
    expect(PANEL).toContain('className="h-full"')
    expect(PANEL).toContain('bodyClassName="flex flex-col"')
    expect(PANEL).toContain('flex flex-1 flex-col')
    expect(PANEL).toContain('mt-auto')
    expect(PANEL).not.toMatch(/(^|[^-])\bh-\[\d+px\]/)
  })

  it('brings no glow, shadow or blur', () => {
    expect(PANEL).not.toMatch(/shadow-|drop-shadow|blur-/)
  })
})

// ═══ 11 · safety ═════════════════════════════════════════════════════════════

describe('this card reads, and does nothing else', () => {
  const all = [PURE, ADMIN, PANEL]

  it('performs no Firestore write and changes no check-in behaviour', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bbatch\(\)|FieldValue/)
      expect(strip(code)).not.toMatch(/buildCheckinDelta|writeCheckinDelta|checkInRegistration/)
    }
  })

  it('imports no Razorpay client', () => {
    for (const code of all) expect(code.toLowerCase()).not.toContain("from 'razorpay'")
  })

  it('the resolver is PURE — no I/O, no clock', () => {
    expect(strip(PURE)).not.toMatch(/adminDb|fetch\(|await|Date\./)
  })

  it('hardcodes no workspace, event or figure', () => {
    for (const code of [strip(PURE), strip(ADMIN), strip(PANEL)]) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/\b288\b|2,?295|2,?007/)
    }
  })
})
// ═══════════════════════════════════════════════════════════════════════════════
// RD-DASH-11B · the stale read model, repaired.
//
// The route built `eventStatus.checkedIn` two different ways in one request:
//
//   STALE events → aggregateRegistrationStatusCounts → orderBy(checkedInAt).count() ✅
//   FRESH events → base counter `checkedInCount`                                   ❌ always 0
//
// So the same dashboard load could answer "how many checked in" correctly for one event
// and with a zero for another, decided by nothing more than a stats version.
// ═══════════════════════════════════════════════════════════════════════════════

describe('eventStatus.checkedIn is folded, not read off the base counter', () => {
  it('the fresh branch no longer carries checkedIn at all', () => {
    // RD-DASH-13 · RD-DASH-11B made this field authoritative; RD-DASH-12 proved nothing
    // renders it. `EventStatusCounts` — the dashboard's own status shape — therefore has
    // no `checkedIn`, and with it went one attendanceShards read PER EVENT.
    expect(ROUTE).not.toContain('checkedIn: folded.checkedInCount ?? 0,')
    expect(ROUTE).not.toContain('checkedIn: c.checkedInCount ?? 0,')
    const ANALYTICS = read('lib/analytics/dashboardAnalytics.ts')
    expect(ANALYTICS).toContain('export interface EventStatusCounts')
    expect(strip(ANALYTICS)).not.toMatch(/checkedIn/)
  })

  it('the fold covers ONLY the selected event', () => {
    // `eventStatus` is built for every event in the lookup set, so every one of them needs
    // the authoritative value — not just the event whose card is on screen.
    // RD-DASH-13 · reversed deliberately. Folding every fresh event bought an unrendered
    // field at one subcollection read each — 50 of them on a 50-event workspace. The
    // Check-in card is the only consumer of a fold, and it covers one event.
    expect(ROUTE).not.toContain('...freshSlugs,')
    expect(ROUTE).toContain('const shardSlugs = scoped && selectedSlug ? [selectedSlug] : []')
    expect(ROUTE.match(/getAttendanceShardSums\(/g)?.length).toBe(1)
  })

  it('an audited-style fixture folds base 0 + shards N to N', () => {
    // The exact production shape: the base document says nothing happened, the shards hold
    // the truth. Synthetic figures — nothing here mirrors a real event.
    const base = { eventSlug: 'e', totalCount: 40, checkedInCount: 0, passCheckedInCounts: {} } as never
    const folded = foldAttendanceShards(base, { checkedInCount: 7, passCheckedInCounts: { p1: 5, p2: 2 } })
    expect(folded.checkedInCount).toBe(7)
    expect(folded.passCheckedInCounts).toEqual({ p1: 5, p2: 2 })
    // …and every other field is the base document's, untouched.
    expect(folded.totalCount).toBe(40)
  })

  it('only checkedIn changes — confirmed, cancelled and the rest stay base fields', () => {
    // §10: nothing else may shift meaning.
    expect(ROUTE).toContain('const confirmed = c.totalCount     ?? 0')
    expect(ROUTE).toContain('const cancelled = c.cancelledCount ?? 0')
    expect(ROUTE).toContain('const pending   = c.pendingCount   ?? 0')
    expect(ROUTE).toContain('const rejected  = c.rejectedCount  ?? 0')
  })

  it('a failed fold makes the breakdown unavailable — never checkedIn: 0', () => {
    // The same rule the failed-waitlist read already followed two lines above. Falling back
    // to the base document would reinstate the exact defect this phase removes.
    // RD-DASH-12 · NARROWED, deliberately. Applying the waitlist rule to the attendance
    // fold as well was measured to be disproportionate: failing one `attendanceShards`
    // read took `registrationTotals.confirmed` to 0 and emptied Registration Status, Pass
    // Distribution and Event Performance, while the Confirmed-registrations KPI — fed from
    // a different source — kept its real value. One screen, two answers.
    //
    // The fold contributes ONE field here, `checkedIn`, which no dashboard surface reads;
    // the Check-in card is served separately and still reports `unavailable` for exactly
    // this failure. So the waitlist keeps the veto (without it there is no `total`) and the
    // shard read no longer has one.
    expect(ROUTE).toContain('if (waitlisted === null) { eventStatus.set(slug, null); return }')
    expect(ROUTE).not.toContain('if (waitlisted === null || shards === null)')
    // RD-DASH-13 · there is no fold in the route any more, so a shard failure cannot
    // reach the breakdowns at all — it is confined to the Check-in card, which reports
    // `unavailable`. The guard below is the stronger form of the same promise.
    expect(strip(ROUTE)).not.toMatch(/foldAttendanceShards\(/)
  })

  it('the STALE branch is untouched — it was already correct', () => {
    expect(ROUTE).toContain('aggregateRegistrationStatusCounts(uid, slug).catch(() => null)')
    expect(COUNTERS).toContain("base.orderBy('checkedInAt', 'desc').count().get(),")
  })

  it('the card is the only surface that resolves a check-in figure', () => {
    // RD-DASH-13 · they cannot disagree because there is only one of them left.
    const fold = ROUTE.indexOf('const attendanceBySlug')
    expect(fold).toBeGreaterThan(-1)
    expect(ROUTE.indexOf('resolveCheckInFromCounters(')).toBeGreaterThan(fold)
    expect(strip(ROUTE)).not.toMatch(/checkedIn:/)
  })
})

describe('the repair changes no behaviour it was told not to', () => {
  it('checkedIn > confirmed is still not clamped anywhere', () => {
    const s = resolveCheckInStatus({
      checkedIn: 9, confirmed: 5, passCheckedIn: {}, passConfirmed: {}, passNames: {}, supported: true,
    })
    expect(s.percentage).toBeCloseTo(180, 6)
    expect(s.remaining).toBeNull()
    expect(s.exceedsConfirmed).toBe(true)
    expect(strip(ROUTE)).not.toMatch(/Math\.min\([^)]*checkedIn/)
  })

  it('cancellation still leaves the gate count intact — untouched by this phase', () => {
    const cancel = REGS.slice(REGS.indexOf('status:    \'cancelled\''), REGS.indexOf('applyReleaseWrites'))
    expect(cancel).not.toMatch(/checkedIn/)
  })

  it('no new counter, no registration query, no checkedInAt aggregate was added', () => {
    const added = strip(ADMIN)
    expect(added).not.toMatch(/checkedInAt/)
    expect(added).not.toMatch(/collection\(/)
    // The route gained ONE subcollection read per slug that needs a fold, and nothing else.
    expect(strip(ROUTE)).not.toMatch(/checkedInCount:\s*FieldValue/)
  })

  it('the shard-sums type was NAMED, not reimplemented', () => {
    // Purely additive: the shape `getAttendanceShardSums` already returned, given a name so
    // a caller that carries it can type it.
    expect(COUNTERS).toContain('export interface AttendanceShardSums {')
    expect(COUNTERS).toContain('): Promise<AttendanceShardSums> {')
    expect(COUNTERS).toContain('shards: AttendanceShardSums,')
  })

  it('the fold performs no write', () => {
    for (const code of [ADMIN, ROUTE]) {
      expect(code).not.toMatch(/attendanceShards[^\n]*\.(set|update|delete)\(/)
    }
    expect(strip(ADMIN)).not.toMatch(/FieldValue|runTransaction|batch\(\)/)
  })
})