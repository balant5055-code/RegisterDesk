// RD-COMMS-P2-E — reminder reliability & controls on REAL Firestore (emulator). The notification
// engine is stubbed (no email leaves the process): every send is counted per recipient.
//
//   • every job re-checks CURRENT state before sending: organizer suspension, event cancelled /
//     archived / taken down / not live, the email switch, the global / per-kind / per-event
//     reminder switches — custom reminders included;
//   • a moved event never gets the reminder computed from its old date; the new date gets one;
//   • refunded, cancelled, pending and unsubscribed attendees are excluded at send time;
//   • > 500 recipients are all reached once, across pages and a time-budget pause;
//   • concurrent dispatchers, a legacy job beside its re-keyed successor and a restarted worker
//     never send anyone the same reminder twice; an attempted recipient is never retried;
//   • a malformed offset / job / timezone is contained and never stops the valid ones;
//   • email never consumes WhatsApp capacity or the communication balance.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const UID = `p2e-org-${P}`

const h = vi.hoisted(() => ({ sends: new Map<string, number>(), emailEnabled: true, delayMs: 0 }))

vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string }) => {
        if (h.delayMs) await new Promise(r => setTimeout(r, h.delayMs))
        h.sends.set(p.to, (h.sends.get(p.to) ?? 0) + 1)
        return { success: true, messageId: `ses-${p.to}` }
      },
    },
  }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => {
    const c = await real.getCommunicationConfig()
    return { ...c, email: { ...c.email, enabled: h.emailEnabled } }
  } }
})

describeEmu('RD-COMMS-P2-E · reminder reliability (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let dispatch: typeof import('@/lib/reminders/dispatch')
  let scheduler: typeof import('@/lib/reminders/scheduler')
  let service: typeof import('@/lib/reminders/service')
  let config: typeof import('@/lib/reminders/config')
  let anchor: typeof import('@/lib/reminders/anchor')
  const trees = new Set<string>()
  let n = 0

  /** Event-local date + HH:MM for an instant `msFromNow` ahead, in `tz` (minute-floored). */
  function local(msFromNow: number, tz: string) {
    const at = new Date(Date.now() + msFromNow)
    const startDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
    const startTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
    return { startDate, startTime }
  }

  type Reg = { status?: string; paymentStatus?: string; email?: string }
  async function event(opts: { regs?: Reg[]; count?: number; tz?: unknown; startInMs?: number; extra?: Record<string, unknown> } = {}) {
    const k = ++n, slug = `p2e-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventReminderPrefs/${slug}`)
    const tz = opts.tz === undefined ? 'Asia/Kolkata' : opts.tz
    const when = local(opts.startInMs ?? 30 * 60_000, typeof tz === 'string' && anchor.reminderTimezone({ schedule: { timezone: tz } }) ? tz : 'Asia/Kolkata')
    await adminDb.doc(`events/${slug}`).set({
      uid: UID, slug, lifecycleStatus: 'published',
      eventDetails: { info: { name: `Reminder ${k}` }, schedule: { ...when, ...(tz === null ? {} : { timezone: tz }) } },
      pricing: {}, ...opts.extra,
    })
    const regs: Reg[] = opts.regs ?? Array.from({ length: opts.count ?? 3 }, () => ({}))
    const emails: string[] = []
    for (let i = 0; i < regs.length; i += 400) {
      const batch = adminDb.batch()
      regs.slice(i, i + 400).forEach((r, j) => {
        const idx = i + j, id = `p2e-r-${slug}-${String(idx).padStart(5, '0')}`
        const email = r.email ?? `p2e-${k}-${idx}-${P}@example.test`
        trees.add(`registrations/${id}`); emails.push(email)
        batch.set(adminDb.doc(`registrations/${id}`), {
          organizerUid: UID, eventSlug: slug, status: r.status ?? 'confirmed',
          ...(r.paymentStatus ? { paymentStatus: r.paymentStatus } : {}), attendee: { name: `A${idx}`, email },
        })
      })
      await batch.commit()
    }
    return { slug, emails }
  }
  const job = async (id: string) => (await adminDb.doc(`scheduledReminders/${id}`).get()).data() as Record<string, unknown>
  const custom = (eventId: string | null, extra: Partial<{ subject: string; message: string; audience: 'attendees' | 'organizer' }> = {}) =>
    service.createCustomReminder({ organizerUid: UID, audience: extra.audience ?? 'attendees', eventId, subject: extra.subject ?? `S${++n}`, message: extra.message ?? 'Hello', sendAtMs: Date.now() - 1000 })
  const settings = async (s: Record<string, unknown> | null) => {
    if (s) await adminDb.doc('system/reminderSettings').set(s)
    else await adminDb.doc('system/reminderSettings').delete()
    await config.getReminderSettings({ fresh: true })     // refresh the scheduler's cached copy too
  }
  const run = (budgetMs?: number) => dispatch.dispatchDueReminders(50, budgetMs)
  const sentTo = (emails: string[]) => emails.map(e => h.sends.get(e) ?? 0)

  async function wipe() {
    for (const c of ['scheduledReminders', 'reminderDeliveries', 'emailLogs', 'emailSuppressionList']) {
      for (const d of (await adminDb.collection(c).where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    }
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', email: `owner-${P}@example.test`, name: 'Owner' })
    await adminDb.doc(`organizerWallets/${UID}`).set({ balancePaise: 1_000, currency: 'INR' })
    await adminDb.doc('system/reminderScheduler').delete().catch(() => null)
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    dispatch  = await import('@/lib/reminders/dispatch')
    scheduler = await import('@/lib/reminders/scheduler')
    service   = await import('@/lib/reminders/service')
    config    = await import('@/lib/reminders/config')
    anchor    = await import('@/lib/reminders/anchor')
  }, T)
  beforeEach(async () => { h.sends.clear(); h.emailEnabled = true; h.delayMs = 0; await wipe(); await settings(null) }, T)
  afterAll(async () => {
    await wipe(); await settings(null)
    await adminDb.doc(`users/${UID}`).delete().catch(() => null); await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null)
  }, T)

  it('an auto reminder reaches each ELIGIBLE attendee once (refunded / cancelled / pending excluded) — and email is free', async () => {
    const ev = await event({ regs: [{}, {}, {}, { paymentStatus: 'refunded' }, { status: 'cancelled' }, { status: 'pending' }, { paymentStatus: 'refund_pending' }] })
    await adminDb.doc(`eventServiceAllowances/p2e-d-${P}`).set({ organizerUid: UID, whatsapp: { purchased: 10, consumed: 0 } })
    trees.add(`eventServiceAllowances/p2e-d-${P}`)
    expect((await scheduler.materializeReminders()).created).toBe(1)
    const jobs = (await adminDb.collection('scheduledReminders').where('eventId', '==', ev.slug).get()).docs
    expect(jobs.map(d => d.id)).toEqual([expect.stringMatching(new RegExp(`^rem_${ev.slug}_event_starting_soon_\\d+$`))])

    await run()
    expect(sentTo(ev.emails)).toEqual([1, 1, 1, 0, 0, 0, 1])    // refund still pending = still an attendee
    const j = await job(jobs[0].id)
    expect(j).toMatchObject({ status: 'sent', counts: { recipients: 4, sent: 4, failed: 0, skipped: 0 } })
    expect((await adminDb.doc(`organizerWallets/${UID}`).get()).data()!.balancePaise).toBe(1_000)
    expect((await adminDb.doc(`eventServiceAllowances/p2e-d-${P}`).get()).data()!.whatsapp).toEqual({ purchased: 10, consumed: 0 })
    expect((await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).empty).toBe(true)
  }, T)

  it('an already-created reminder re-checks CURRENT state — every block is terminal and sends nothing', async () => {
    const cases: [string, (slug: string) => Promise<void>, string][] = [
      ['organizer suspended',  async () => { await adminDb.doc(`users/${UID}`).set({ accountStatus: 'suspended' }, { merge: true }) }, 'organizer_suspended'],
      ['event cancelled',      async s => { await adminDb.doc(`events/${s}`).update({ lifecycleStatus: 'cancelled' }) }, 'event_cancelled'],
      ['event archived',       async s => { await adminDb.doc(`events/${s}`).update({ archivedAt: Timestamp.now() }) }, 'event_not_live'],
      ['event taken down',     async s => { await adminDb.doc(`events/${s}`).update({ moderationStatus: 'taken_down' }) }, 'event_unavailable'],
      ['event pending review', async s => { await adminDb.doc(`events/${s}`).update({ lifecycleStatus: 'pending_review' }) }, 'event_not_live'],
      ['changes requested',    async s => { await adminDb.doc(`events/${s}`).update({ lifecycleStatus: 'changes_requested' }) }, 'event_not_live'],
      ['event deleted',        async s => { await adminDb.doc(`events/${s}`).delete() }, 'event_unavailable'],
      ['owner changed',        async s => { await adminDb.doc(`events/${s}`).update({ uid: 'someone-else' }) }, 'event_unavailable'],
      ['reminders switched off globally', async () => { await adminDb.doc('system/reminderSettings').set({ enabled: false }) }, 'reminders_disabled'],
      ['platform email switched off',     async () => { h.emailEnabled = false }, 'email_disabled'],
    ]
    for (const [label, change, reason] of cases) {
      await wipe(); await settings(null); h.sends.clear(); h.emailEnabled = true
      const ev = await event()
      const id = await custom(ev.slug)                 // custom reminders obey the same gate
      await change(ev.slug)
      await run()
      expect(sentTo(ev.emails), label).toEqual([0, 0, 0])
      expect(await job(id), label).toMatchObject({ status: 'skipped', error: reason })
      await run()                                       // terminal: never picked up again
      expect(sentTo(ev.emails), `${label} (rerun)`).toEqual([0, 0, 0])
    }
  }, T)

  it('auto reminders honour the per-kind switch and the per-event opt-out set AFTER the job was created', async () => {
    for (const [label, change, reason] of [
      ['kind off',  async () => { await adminDb.doc('system/reminderSettings').set({ kinds: { event_starting_soon: false } }) }, 'kind_disabled'],
      ['event off', async (s: string) => { await config.setEventRemindersEnabled(s, UID, false) }, 'event_reminders_off'],
    ] as const) {
      await wipe(); await settings(null); h.sends.clear()
      const ev = await event()
      await scheduler.materializeReminders()
      const [doc] = (await adminDb.collection('scheduledReminders').where('eventId', '==', ev.slug).get()).docs
      await change(ev.slug)
      await run()
      expect(sentTo(ev.emails), label).toEqual([0, 0, 0])
      expect(await job(doc.id), label).toMatchObject({ status: 'skipped', error: reason })
    }
  }, T)

  it('a MOVED event never gets the stale reminder; the new time gets exactly one', async () => {
    const ev = await event({ startInMs: 30 * 60_000 })
    await scheduler.materializeReminders()
    const [stale] = (await adminDb.collection('scheduledReminders').where('eventId', '==', ev.slug).get()).docs
    await adminDb.doc(`events/${ev.slug}`).update({ 'eventDetails.schedule': { ...local(50 * 60_000, 'Asia/Kolkata'), timezone: 'Asia/Kolkata' } })

    await run()
    expect(sentTo(ev.emails)).toEqual([0, 0, 0])
    expect(await job(stale.id)).toMatchObject({ status: 'skipped', error: 'event_rescheduled' })

    expect((await scheduler.materializeReminders()).created).toBe(1)      // a fresh job for the new anchor
    await scheduler.materializeReminders()                                // idempotent
    const all = (await adminDb.collection('scheduledReminders').where('eventId', '==', ev.slug).get()).docs
    expect(all).toHaveLength(2)
    await run(); await run()
    expect(sentTo(ev.emails)).toEqual([1, 1, 1])
  }, T)

  it('a legacy (pre-P2-E) job blocks its re-keyed successor, and even both together send once each', async () => {
    const ev = await event()
    const ed = (await adminDb.doc(`events/${ev.slug}`).get()).data()!.eventDetails
    const A = anchor.reminderAnchor('event_starting_soon', ed, {})!
    const legacyId = anchor.legacyAutoReminderId(ev.slug, 'event_starting_soon')
    const base = { eventId: ev.slug, eventName: 'R', organizerUid: UID, kind: 'event_starting_soon', audience: 'attendees', channel: 'email', status: 'scheduled', source: 'auto', subject: null, message: null, counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, costPaise: 0, createdBy: 'system', error: null }
    await adminDb.doc(`scheduledReminders/${legacyId}`).set({ ...base, sendAt: Timestamp.fromMillis(Math.max(A - 3600_000, Date.now() - 1000)) })
    expect((await scheduler.materializeReminders()).created).toBe(0)      // the legacy job already covers this anchor

    // Force the worst case anyway: a successor exists beside it.
    await adminDb.doc(`scheduledReminders/${anchor.autoReminderId(ev.slug, 'event_starting_soon', A)}`).set({ ...base, anchorMs: A, sendAt: Timestamp.fromMillis(Date.now() - 1000) })
    await run()
    expect(sentTo(ev.emails)).toEqual([1, 1, 1])
    const states = (await adminDb.collection('scheduledReminders').where('eventId', '==', ev.slug).get()).docs.map(d => [d.data().status, d.data().error])
    expect(states).toEqual(expect.arrayContaining([['sent', null], ['skipped', 'no_eligible_recipients']]))
  }, T)

  it('more than 500 recipients: all reached exactly once across pages — with cross-page duplicates — and across a time-budget pause', async () => {
    const regs: Reg[] = Array.from({ length: 520 }, () => ({}))
    const ev = await event({ regs })
    // Duplicates of page-1 addresses on page 2 (higher doc ids): a second registration, same person.
    const dupes = [ev.emails[0], ev.emails[1], ev.emails[2]]
    const batch = adminDb.batch()
    dupes.forEach((email, i) => {
      const id = `p2e-r-${ev.slug}-99${i}`
      trees.add(`registrations/${id}`)
      batch.set(adminDb.doc(`registrations/${id}`), { organizerUid: UID, eventSlug: ev.slug, status: 'confirmed', attendee: { name: 'Dup', email } })
    })
    await batch.commit()
    const id = await custom(ev.slug)

    h.delayMs = 150
    const first = await run(3_000)
    expect(first.continued).toBe(1)
    const paused = await job(id)
    expect(paused.status).toBe('scheduled')
    expect(typeof paused.cursor).toBe('string')
    h.delayMs = 0
    for (let i = 0; i < 4 && (await job(id)).status === 'scheduled'; i++) await run()

    expect(sentTo(ev.emails).every(c => c === 1)).toBe(true)
    expect(h.sends.size).toBe(520)
    expect(await job(id)).toMatchObject({ status: 'sent', counts: { sent: 520, failed: 0, skipped: 3 } })
  }, T)

  it('concurrent dispatchers and an identical double-submit never send twice', async () => {
    const ev = await event({ count: 40 })
    const a = await custom(ev.slug, { subject: 'Same', message: 'Same body' })
    const b = await service.createCustomReminder({ organizerUid: UID, audience: 'attendees', eventId: ev.slug, subject: 'Same', message: 'Same body', sendAtMs: Date.now() - 1000 })
    expect(b).toBe(a)                                         // the same minute ⇒ the same job
    await Promise.all([run(), run(), run()])
    expect(sentTo(ev.emails).every(c => c === 1)).toBe(true)
  }, T)

  it('a restarted worker resumes WITHOUT re-sending anyone attempted; retryCount 0 and legacy jobs fail instead', async () => {
    const delivery = await import('@/lib/reminders/delivery')
    const stale = Timestamp.fromMillis(Date.now() - 20 * 60_000)

    const ev = await event({ count: 5 })
    const id = await custom(ev.slug)
    await adminDb.doc(`scheduledReminders/${id}`).update({ status: 'sending', deliveryLedger: true, updatedAt: stale })
    const key = `job|${id}`
    await adminDb.doc(`reminderDeliveries/${delivery.reminderDeliveryId(key, ev.emails[0])}`).set({ organizerUid: UID, status: 'pending' })   // died mid-send
    await adminDb.doc(`reminderDeliveries/${delivery.reminderDeliveryId(key, ev.emails[1])}`).set({ organizerUid: UID, status: 'sent' })
    const out = await run()
    expect(out.reclaimed).toBe(1)
    expect(sentTo(ev.emails)).toEqual([0, 0, 1, 1, 1])
    expect(await job(id)).toMatchObject({ status: 'sent', resumes: 1, counts: { sent: 3, skipped: 2 } })

    for (const [label, patch, s] of [
      ['retryCount 0',          { deliveryLedger: true }, { retryCount: 0 }],
      ['legacy (no ledger) job', {},                       null],
    ] as const) {
      h.sends.clear()
      const ev2 = await event({ count: 2 })
      const id2 = await custom(ev2.slug)
      await settings(s as Record<string, unknown> | null)
      await adminDb.doc(`scheduledReminders/${id2}`).update({ status: 'sending', updatedAt: stale, ...patch })
      await run()
      expect(sentTo(ev2.emails), label).toEqual([0, 0])
      expect(await job(id2), label).toMatchObject({ status: 'failed', error: 'stale_sending_reclaimed' })
    }
  }, T)

  it('malformed offsets, jobs and timezones are contained — valid reminders still go out', async () => {
    await settings({ offsetHours: { event_starting_soon: Number.NaN, event_tomorrow: Infinity, event_today: 'x', registration_closing: -3 } })
    const ok = await event()
    const badTz = await event({ tz: 'Mars/Olympus' })
    const ny = await event({ tz: 'America/New_York' })
    await scheduler.materializeReminders()                       // does not throw on the NaN/Infinity/'x'/-3 offsets
    const soon = async (slug: string) => (await adminDb.collection('scheduledReminders').where('eventId', '==', slug).get()).docs
      .filter(d => d.data().kind === 'event_starting_soon')
    expect((await soon(ok.slug)).length).toBe(1)                 // NaN offset ⇒ the kind's default (1h)
    expect((await soon(ny.slug)).length).toBe(1)
    expect((await adminDb.collection('scheduledReminders').where('eventId', '==', badTz.slug).get()).empty).toBe(true)   // bad zone ⇒ none
    const nyJob = (await soon(ny.slug))[0].data()
    const nySched = (await adminDb.doc(`events/${ny.slug}`).get()).data()!.eventDetails.schedule
    const [y, m, d] = nySched.startDate.split('-').map(Number), [hh, mm] = nySched.startTime.split(':').map(Number)
    const nyOffsetH = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')!.value.replace('GMT', '') || 0)
    expect(nyJob.anchorMs).toBe(Date.UTC(y, m - 1, d, hh - nyOffsetH, mm))
    expect(nyJob.timezone).toBe('America/New_York')

    // A legacy job for the bad-timezone event is not sent; malformed jobs fail alone.
    await adminDb.doc(`scheduledReminders/rem_${badTz.slug}_event_starting_soon`).set({ eventId: badTz.slug, organizerUid: UID, kind: 'event_starting_soon', audience: 'attendees', channel: 'email', status: 'scheduled', source: 'auto', eventName: 'X', counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, sendAt: Timestamp.fromMillis(Date.now() - 5000) })
    await adminDb.doc(`scheduledReminders/p2e-bad1-${P}`).set({ organizerUid: UID, kind: 'nonsense', audience: 'attendees', channel: 'email', status: 'scheduled', sendAt: Timestamp.fromMillis(Date.now() - 5000) })
    await adminDb.doc(`scheduledReminders/p2e-bad2-${P}`).set({ organizerUid: UID, kind: 'custom', audience: 'attendees', eventId: null, channel: 'email', status: 'scheduled', counts: 'garbage', sendAt: Timestamp.fromMillis(Date.now() - 5000) })
    await run(); await run()
    expect(sentTo(ok.emails)).toEqual([1, 1, 1])
    expect(sentTo(ny.emails)).toEqual([1, 1, 1])
    expect(sentTo(badTz.emails)).toEqual([0, 0, 0])
    expect(await job(`rem_${badTz.slug}_event_starting_soon`)).toMatchObject({ status: 'skipped', error: 'event_rescheduled' })
    expect(await job(`p2e-bad1-${P}`)).toMatchObject({ status: 'skipped', error: 'invalid_reminder' })
    expect(await job(`p2e-bad2-${P}`)).toMatchObject({ status: 'skipped', error: 'invalid_reminder' })
  }, T)

  it('an attendee who unsubscribed from this organizer is not reminded; the organizer-audience reminder still reaches the organizer', async () => {
    const { addToSuppressionList } = await import('@/lib/firebase/firestore/emailSuppressionList')
    const ev = await event()
    await addToSuppressionList(ev.emails[1], UID)
    const id = await custom(ev.slug)
    const own = await custom(null, { audience: 'organizer' })
    await run()
    expect(sentTo(ev.emails)).toEqual([1, 0, 1])
    expect(await job(id)).toMatchObject({ status: 'sent', counts: { sent: 2, skipped: 1 } })
    expect(h.sends.get(`owner-${P}@example.test`)).toBe(1)
    expect(await job(own)).toMatchObject({ status: 'sent' })
  }, T)
})
