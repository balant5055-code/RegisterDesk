// RD-COMMS-P2-E — reminder reliability & controls: the pure rules.
//
//   • anchors are computed in the EVENT's IANA timezone (DST-aware); a missing zone keeps the
//     platform's IST assumption; a malformed zone/date/time yields NO anchor (never coerced);
//   • an offset is valid only when finite and ≥ 0 — NaN, ±Infinity, negatives, missing and
//     non-numeric values are rejected on write and replaced by the kind's default on read;
//   • the job id carries the anchor; a legacy job (no anchor) is matched by its sendAt;
//   • the custom subject stays escaped (Batch C), and email never touches billing.
// The dispatcher/scheduler behaviour on real Firestore is in
// tests/emulator/reminderReliabilityP2E.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ stored: undefined as Record<string, unknown> | undefined, writes: 0 }))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { doc: () => ({ get: async () => ({ exists: h.stored !== undefined, data: () => h.stored }), set: async () => { h.writes++ } }) },
  adminAuth: {},
}))

const read = (f: string) => readFileSync(f, 'utf8')
const { zonedWallTimeUtc } = await import('@/lib/registrations/zonedDayRange')
const anchor = await import('@/lib/reminders/anchor')
const config = await import('@/lib/reminders/config')
const { buildReminderContent } = await import('@/lib/reminders/templates')

const ed = (schedule: Record<string, unknown>) => ({ schedule })
beforeEach(() => { h.stored = undefined; h.writes = 0 })

describe('event-local time → UTC (zonedWallTimeUtc)', () => {
  it('IST is +05:30', () => {
    expect(zonedWallTimeUtc('2026-12-10', '09:00', 'Asia/Kolkata')!.toISOString()).toBe('2026-12-10T03:30:00.000Z')
  })
  it('a DST zone uses the offset in force on THAT day (New York, either side of 8 Mar 2026)', () => {
    expect(zonedWallTimeUtc('2026-03-07', '09:00', 'America/New_York')!.toISOString()).toBe('2026-03-07T14:00:00.000Z')   // EST −5
    expect(zonedWallTimeUtc('2026-03-09', '09:00', 'America/New_York')!.toISOString()).toBe('2026-03-09T13:00:00.000Z')   // EDT −4
  })
  it('malformed date / time / zone ⇒ null', () => {
    expect(zonedWallTimeUtc('2026-02-30', '09:00', 'Asia/Kolkata')).toBeNull()
    expect(zonedWallTimeUtc('2026-12-10', '9am', 'Asia/Kolkata')).toBeNull()
    expect(zonedWallTimeUtc('2026-12-10', '24:00', 'Asia/Kolkata')).toBeNull()
    expect(zonedWallTimeUtc('2026-12-10', '09:00', 'Mars/Olympus')).toBeNull()
  })
})

describe('reminder anchor + timezone source', () => {
  it('the event timezone is respected', () => {
    const ny = anchor.reminderAnchor('event_starting_soon', ed({ startDate: '2026-07-04', startTime: '10:00', timezone: 'America/New_York' }), {})
    expect(new Date(ny!).toISOString()).toBe('2026-07-04T14:00:00.000Z')
    const today = anchor.reminderAnchor('event_today', ed({ startDate: '2026-07-04', timezone: 'Europe/London' }), {})
    expect(new Date(today!).toISOString()).toBe('2026-07-04T07:00:00.000Z')     // 08:00 BST
  })
  it('a MISSING timezone keeps the platform IST assumption (unchanged behaviour)', () => {
    for (const tz of [undefined, null, '', '  ']) {
      const a = anchor.reminderAnchor('event_tomorrow', ed({ startDate: '2026-12-10', startTime: '06:00', timezone: tz }), {})
      expect(new Date(a!).toISOString(), String(tz)).toBe('2026-12-10T00:30:00.000Z')
    }
  })
  it('an INVALID timezone is never read as a valid one — no anchor at all', () => {
    for (const tz of ['Mars/Olympus', 'IST+5', 42, { tz: 'Asia/Kolkata' }]) {
      expect(anchor.reminderTimezone(ed({ timezone: tz })), JSON.stringify(tz)).toBeNull()
      expect(anchor.reminderAnchor('event_tomorrow', ed({ startDate: '2026-12-10', startTime: '06:00', timezone: tz }), {})).toBeNull()
    }
  })
  it('registration-closing / early-bird anchors use 23:59 event-local; early bird = earliest enabled end', () => {
    const pricing = { registrationEndDate: '2026-12-01', passes: [
      { earlyBirdEnabled: true, earlyBirdEndDate: '2026-11-20' }, { earlyBirdEnabled: true, earlyBirdEndDate: '2026-11-10' }, { earlyBirdEnabled: false, earlyBirdEndDate: '2026-11-01' },
    ] }
    const e = ed({ timezone: 'Asia/Kolkata' })
    expect(new Date(anchor.reminderAnchor('registration_closing', e, pricing)!).toISOString()).toBe('2026-12-01T18:29:00.000Z')
    expect(new Date(anchor.reminderAnchor('early_bird_ending', e, pricing)!).toISOString()).toBe('2026-11-10T18:29:00.000Z')
  })
  it('the job id carries the anchor; a legacy job is matched by its sendAt window', () => {
    expect(anchor.autoReminderId('ev', 'event_tomorrow', 123)).toBe('rem_ev_event_tomorrow_123')
    expect(anchor.legacyAutoReminderId('ev', 'event_tomorrow')).toBe('rem_ev_event_tomorrow')
    const A = Date.UTC(2026, 11, 10, 0, 30), due = A - 24 * 3600_000
    expect(anchor.legacySendAtMatches(due, A, 24)).toBe(true)
    expect(anchor.legacySendAtMatches(due + 90 * 60_000, A, 24)).toBe(true)                 // created late, clamped
    expect(anchor.legacySendAtMatches(due - 24 * 3600_000, A, 24)).toBe(false)              // built for an earlier date
    expect(anchor.legacySendAtMatches(due + 24 * 3600_000, A, 24)).toBe(false)              // built for a later date
  })
})

describe('reminder offsets — validated, never crash the run', () => {
  it('invalid: NaN, ±Infinity, negative, missing, non-numeric', () => {
    for (const v of [NaN, Infinity, -Infinity, -1, -0.5, undefined, null, '24', '', true, {}]) {
      expect(anchor.isValidOffsetHours(v), String(v)).toBe(false)
    }
  })
  it('valid: 0 (immediately) and any positive finite value, including every preset', () => {
    for (const v of [0, 0.5, 1, 6, 12, 24, 72, 168, 1000]) expect(anchor.isValidOffsetHours(v), String(v)).toBe(true)
  })
  it('stored garbage falls back PER KIND to that kind\'s default; valid values are kept', async () => {
    h.stored = { enabled: true, offsetHours: { event_tomorrow: NaN, event_starting_soon: Infinity, registration_closing: -5, early_bird_ending: '12', event_today: 3 }, kinds: { event_today: 'yes', event_tomorrow: false }, retryCount: 99 }
    const s = await config.getReminderSettings({ fresh: true })
    expect(s.offsetHours).toMatchObject({ event_tomorrow: 24, event_starting_soon: 1, registration_closing: 24, early_bird_ending: 24, event_today: 3 })
    expect(s.kinds.event_today).toBe(true)          // non-boolean ignored
    expect(s.kinds.event_tomorrow).toBe(false)
    expect(s.retryCount).toBe(1)                    // out of the console's 0–5 range
  })
  it('an admin PATCH with an invalid value is REJECTED and nothing is written', async () => {
    for (const bad of [
      { offsetHours: { event_tomorrow: NaN } }, { offsetHours: { event_tomorrow: Infinity } }, { offsetHours: { event_tomorrow: -1 } },
      { offsetHours: { event_tomorrow: '24' } }, { offsetHours: { event_tomorrow: null } }, { offsetHours: { not_a_kind: 1 } },
      { kinds: { event_today: 'on' } }, { enabled: 'yes' }, { retryCount: 1.5 }, { retryCount: 6 }, { retryCount: -1 },
    ]) {
      await expect(config.updateReminderSettings(bad as never, 'admin'), JSON.stringify(bad)).rejects.toBeInstanceOf(config.ReminderSettingsError)
    }
    expect(h.writes).toBe(0)
  })
  it('valid boundary values are accepted', async () => {
    const next = await config.updateReminderSettings({ offsetHours: { event_tomorrow: 0, event_starting_soon: 168 } as never, retryCount: 0 }, 'admin')
    expect(next.offsetHours.event_tomorrow).toBe(0)
    expect(next.offsetHours.event_starting_soon).toBe(168)
    expect(next.retryCount).toBe(0)
    expect(h.writes).toBe(1)
  })
})

describe('custom reminders keep the Batch C subject escaping', () => {
  it('the subject is one line in the header and escaped in the body', () => {
    const c = buildReminderContent({ kind: 'custom', eventName: 'E', customSubject: '<a href="//x">win</a>\r\nBcc: x@y', customMessage: 'hi' })
    expect(c.subject).not.toMatch(/[\r\n]/)
    expect(c.html).not.toContain('<a href="//x">')
    expect(c.html).toContain('&lt;a href=')
  })
})

describe('wiring contracts', () => {
  it('dispatch gates every job on CURRENT state, re-checks every recipient, and claims the ledger before sending', () => {
    const src = read('lib/reminders/dispatch.ts')
    expect(src).toContain('gate = await reminderExecutionBlock(id, data, env.settings, env.comm)')
    expect(src).toContain("getReminderSettings({ fresh: true })")
    expect(src).toMatch(/checkInBlockReason\(\{ status: String\(r\.status \?\? ''\), paymentStatus/)
    expect(src).toContain('consent = await suppressionStatus(r.email, data.organizerUid)')   // RD-COMMS-P2-G: both scopes
    const claim = src.indexOf('claimReminderDelivery(deliveryId')
    const sendAt = src.indexOf('notificationEngine.send(NotificationType.CUSTOM_EMAIL')
    expect(claim).toBeGreaterThan(-1)
    expect(claim).toBeLessThan(sendAt)
  })
  it('the cron still dispatches when materialize throws', () => {
    const src = read('app/api/cron/reminders/route.ts')
    expect(src).toMatch(/try \{ materialized = await materializeReminders\(\) \}\s*catch \(err\)/)
  })
  it('the admin PATCH answers 400 for invalid settings', () => {
    expect(read('app/api/admin/reminders/route.ts')).toContain('if (e instanceof ReminderSettingsError) return NextResponse.json({ error: e.message }, { status: 400 })')
  })
  it('reminders never touch the communication balance or a WhatsApp allowance', () => {
    for (const f of ['lib/reminders/dispatch.ts', 'lib/reminders/scheduler.ts', 'lib/reminders/executionGuard.ts', 'lib/reminders/delivery.ts', 'lib/reminders/service.ts']) {
      expect(read(f), f).not.toMatch(/organizerWallets|eventServiceAllowances|reserveWhatsAppFunding|reserveServiceUnits|chargeCommunication|walletTransactions/)
    }
  })
  it('event deletion purges the delivery ledger by slug', () => {
    expect(read('lib/events/eventDeletion.ts')).toContain("{ kind: 'query', label: 'reminderDeliveries', collection: 'reminderDeliveries', field: 'eventId', value: slug }")
  })
})
