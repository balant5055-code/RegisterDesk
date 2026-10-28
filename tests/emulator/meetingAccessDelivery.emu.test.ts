// RD-MEETING-ACCESS-01 · online joining details reach ENTITLED attendees — on real Firestore (private
// emulator). The email engine is a recording stub: no provider is contacted, nothing is sent, and
// WhatsApp is stubbed out entirely. Every address is a test address.
//
//   delivered:     confirmation (free, auto-confirmed) · confirmation (paid, after capture)
//                  · approval (single) · approval (bulk) · ticket resend · email-log retry
//                  · online AND hybrid · reveal-after-registration ON and OFF
//   withheld:      pending approval · waitlisted · awaiting payment · refunded
//                  · a registration of ANOTHER event · a physical event
//   validated:     a non-http(s) link is never mailed; an ID-only meeting still is
//   no duplicates: one email per call, no extra message type; a retry of a `deliveryUnknown`
//                  send is refused exactly as before
//   no leaks:      the email log, the registration document and console output never hold
//                  the link, ID or passcode

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

type Sent = { type: string; to: string; meetingAccess?: { joinUrl: string | null; meetingId: string | null; passcode: string | null; platform: string; instructions: string | null } }
const h = vi.hoisted(() => ({ sent: [] as Sent[], whatsapp: 0, uid: 'org-meet' }))

vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => { void fn() } }))
vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'ses' }))
vi.mock('@/lib/registrations/sendWhatsAppConfirmation', () => ({ sendWhatsAppConfirmation: async () => { h.whatsapp++ } }))
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: h.uid, actorUid: h.uid, role: 'owner' }),
}))
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (type: string, p: Sent) => {
        h.sent.push({ type, to: p.to, meetingAccess: p.meetingAccess })
        return { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})

const JOIN = 'https://zoom.us/j/555000111?pwd=QAtoken'
const MID  = '555 000 111'
const PASS = 'QA-PASS-9'

function online(over: Record<string, unknown> = {}) {
  return { platform: 'zoom', platformCustomName: '', meetingUrl: JOIN, meetingId: MID, passcode: PASS, revealAfterRegistration: true, joinInstructions: 'Join 5 minutes early.', ...over }
}

describeEmu('RD-MEETING-ACCESS-01 · joining-details delivery (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let confirm: typeof import('@/lib/registrations/sendConfirmationEmail')
  let approve: typeof import('@/lib/registrations/sendApprovalEmail')
  let resend:  typeof import('@/lib/registrations/resendTicketEmail')
  const cleanup = new Set<string>()
  const errors: string[] = []

  async function seedEvent(slug: string, venue: Record<string, unknown>) {
    const eventDetails = {
      info: { name: `Meet ${slug}`, shortDesc: 'QA' },
      schedule: { startDate: '2099-06-01', startTime: '10:00', endDate: '2099-06-01', endTime: '11:00', timezone: 'Asia/Kolkata' },
      venue,
      communication: { confirmation: { calendarInvite: true } },
    }
    await db.doc(`events/${slug}`).set({ slug, uid: h.uid, eventType: 'custom', lifecycleStatus: 'published', eventDetails })
    cleanup.add(`events/${slug}`)
    return eventDetails
  }
  async function seedReg(id: string, slug: string, over: Record<string, unknown> = {}) {
    await db.doc(`registrations/${id}`).set({
      eventSlug: slug, eventName: `Meet ${slug}`, organizerUid: h.uid, status: 'confirmed', paymentStatus: 'not_required',
      amount: 0, ticketCode: `TK-${id}`, passName: 'General', attendee: { name: 'Asha QA', email: `${id}@qa.invalid` },
      ...over,
    })
    cleanup.add(`registrations/${id}`)
  }
  const last = () => h.sent[h.sent.length - 1]
  const ids  = (suffix: string) => ({ slug: `meet-${suffix}-${P}`, reg: `rmeet-${suffix}-${P}` })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    confirm = await import('@/lib/registrations/sendConfirmationEmail')
    approve = await import('@/lib/registrations/sendApprovalEmail')
    resend  = await import('@/lib/registrations/resendTicketEmail')
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      const orig = console[m].bind(console)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); orig(...a) })
    }
  }, T)
  beforeEach(() => { h.sent = []; h.whatsapp = 0 })
  afterAll(async () => {
    for (const p of cleanup) await db.recursiveDelete(db.doc(p)).catch(() => null)
    const logs = await db.collection('emailLogs').where('organizerUid', '==', h.uid).get()
    for (const d of logs.docs) await d.ref.delete().catch(() => null)
    vi.restoreAllMocks()
  }, T)

  const confirmArgs = (reg: string, slug: string, rawDetails: Record<string, unknown>) => ({
    registrationId: reg, ticketCode: `TK-${reg}`, attendeeName: 'Asha QA', attendeeEmail: `${reg}@qa.invalid`,
    eventName: `Meet ${slug}`, passName: 'General', rawDetails, organizerUid: h.uid, eventSlug: slug,
  })

  // ── Delivered ──────────────────────────────────────────────────────────────

  it('online, reveal ON, free auto-confirmed → the confirmation carries link, ID, passcode, platform, instructions', async () => {
    const { slug, reg } = ids('on')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(h.sent).toHaveLength(1)
    expect(last()).toMatchObject({ type: 'REGISTRATION_CONFIRMATION', to: `${reg}@qa.invalid` })
    expect(last().meetingAccess).toEqual({ platform: 'Zoom', joinUrl: JOIN, meetingId: MID, passcode: PASS, instructions: 'Join 5 minutes early.' })
  }, T)

  it('reveal OFF → still delivered (the ID and passcode are never public)', async () => {
    const { slug, reg } = ids('off')
    const ed = await seedEvent(slug, { type: 'online', online: online({ revealAfterRegistration: false }) })
    await seedReg(reg, slug)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(last().meetingAccess).toMatchObject({ joinUrl: JOIN, meetingId: MID, passcode: PASS })
  }, T)

  it('hybrid → delivered; a custom platform uses the organizer’s own name', async () => {
    const { slug, reg } = ids('hyb')
    const ed = await seedEvent(slug, { type: 'hybrid', physical: { name: 'Hall', city: 'Chennai' }, online: online({ platform: 'custom', platformCustomName: 'Hopin' }) })
    await seedReg(reg, slug)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(last().meetingAccess).toMatchObject({ platform: 'Hopin', joinUrl: JOIN })
  }, T)

  it('paid: awaiting payment → withheld; after capture (paid + confirmed) → delivered', async () => {
    const { slug, reg } = ids('paid')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug, { status: 'confirmed', paymentStatus: 'pending', amount: 50000 })
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(last().meetingAccess).toBeUndefined()
    await db.doc(`registrations/${reg}`).update({ paymentStatus: 'paid' })
    await confirm.sendConfirmationEmail({ ...confirmArgs(reg, slug, ed), amountPaid: 50000 })
    expect(last().meetingAccess).toMatchObject({ joinUrl: JOIN })
  }, T)

  it('approval-required: pending → withheld; once approved the approval email carries them', async () => {
    const { slug, reg } = ids('appr')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug, { status: 'pending' })
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))      // defensive: pending never gets them
    expect(last().meetingAccess).toBeUndefined()
    await db.doc(`registrations/${reg}`).update({ status: 'confirmed' })
    await approve.sendApprovalEmail(reg)
    expect(last()).toMatchObject({ type: 'REGISTRATION_APPROVED' })
    expect(last().meetingAccess).toMatchObject({ joinUrl: JOIN, passcode: PASS })
  }, T)

  it('ticket resend: confirmed → delivered; pending / waitlisted → ticket without them; refunded → refused as before', async () => {
    const { slug } = ids('rs')
    await seedEvent(slug, { type: 'online', online: online() })
    for (const [suffix, over, expected] of [
      ['ok',   { status: 'confirmed' },   'yes'],
      ['pend', { status: 'pending' },     'no'],
      ['wait', { status: 'waitlisted' },  'no'],
    ] as const) {
      const reg = `rmeet-rs-${suffix}-${P}`
      await seedReg(reg, slug, over)
      h.sent = []
      expect(await resend.resendRegistrationTicketEmail(reg)).toEqual({ ok: true })
      expect(last().type).toBe('TICKET_RESENT')
      if (expected === 'yes') expect(last().meetingAccess, suffix).toMatchObject({ joinUrl: JOIN })
      else expect(last().meetingAccess, suffix).toBeUndefined()
    }
    const refunded = `rmeet-rs-ref-${P}`
    await seedReg(refunded, slug, { paymentStatus: 'refunded' })
    h.sent = []
    expect(await resend.resendRegistrationTicketEmail(refunded)).toMatchObject({ ok: false, status: 422 })
    expect(h.sent).toHaveLength(0)
  }, T)

  it('bulk approve: the snapshot is pre-approval, the entitlement is read fresh → delivered', async () => {
    const { slug, reg } = ids('bulk')
    await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug, { status: 'pending' })
    // The route approves via approveRegistration (capacity, counters) before mailing; here the
    // approval itself is simulated and the route's mailer is driven through its module.
    await db.doc(`registrations/${reg}`).update({ status: 'confirmed' })
    const { meetingAccessForRegistration } = await import('@/lib/registrations/meetingAccess')
    const ev = (await db.doc(`events/${slug}`).get()).data()!
    expect(await meetingAccessForRegistration({ registrationId: reg, eventSlug: slug, eventDetails: ev.eventDetails }))
      .toMatchObject({ joinUrl: JOIN })
  }, T)

  it('email-log retry of a failed confirmation carries them; a deliveryUnknown log is still refused', async () => {
    const { slug, reg } = ids('retry')
    await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug)
    const { POST } = await import('@/app/api/organizer/email-logs/[logId]/retry/route')
    const failed = await db.collection('emailLogs').add({ organizerUid: h.uid, registrationId: reg, eventSlug: slug, templateKey: 'registration_submitted', status: 'failed', recipientEmail: `${reg}@qa.invalid` })
    const call = (logId: string) => POST(new Request(`http://localhost/api/organizer/email-logs/${logId}/retry`, { method: 'POST' }) as never, { params: Promise.resolve({ logId }) })
    const res = await call(failed.id)
    expect(res.status).toBe(200)
    expect(h.sent).toHaveLength(1)
    expect(last().meetingAccess).toMatchObject({ joinUrl: JOIN })

    h.sent = []
    const unknown = await db.collection('emailLogs').add({ organizerUid: h.uid, registrationId: reg, eventSlug: slug, templateKey: 'registration_submitted', status: 'failed', deliveryUnknown: true })
    expect((await call(unknown.id)).status).toBe(409)
    expect((await call(failed.id)).status).toBe(409)                     // already retried → not again
    expect(h.sent).toHaveLength(0)
  }, T)

  // ── Withheld ───────────────────────────────────────────────────────────────

  it('a registration of ANOTHER event never receives this event’s details', async () => {
    const { slug, reg } = ids('x')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, `some-other-event-${P}`)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(last().meetingAccess).toBeUndefined()
    // and an unknown registration id gets nothing either
    await confirm.sendConfirmationEmail(confirmArgs(`no-such-reg-${P}`, slug, ed))
    expect(last().meetingAccess).toBeUndefined()
  }, T)

  it('a physical event has no joining details', async () => {
    const { slug, reg } = ids('phys')
    const ed = await seedEvent(slug, { type: 'physical', physical: { name: 'Hall', city: 'Chennai' }, online: online() })
    await seedReg(reg, slug)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(last().meetingAccess).toBeUndefined()
  }, T)

  // ── Missing / invalid details ──────────────────────────────────────────────

  it('a non-http(s) link is never mailed; an ID-only meeting still is; nothing usable → no block', async () => {
    const cases: [string, Record<string, unknown>, unknown][] = [
      ['js',     online({ meetingUrl: 'javascript:alert(1)' }),            { joinUrl: null, meetingId: MID }],
      ['bare',   online({ meetingUrl: 'zoom meeting tbc', meetingId: '' }), undefined],
      ['empty',  online({ meetingUrl: '', meetingId: '', passcode: '' }),   undefined],
      ['idonly', online({ meetingUrl: '' }),                                { joinUrl: null, meetingId: MID, passcode: PASS }],
    ]
    for (const [suffix, on, expected] of cases) {
      const { slug, reg } = ids(`inv-${suffix}`)
      const ed = await seedEvent(slug, { type: 'online', online: on })
      await seedReg(reg, slug)
      await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
      if (expected === undefined) expect(last().meetingAccess, suffix).toBeUndefined()
      else expect(last().meetingAccess, suffix).toMatchObject(expected as object)
    }
  }, T)

  // ── No duplicates, no leaks ────────────────────────────────────────────────

  it('one email per send — the details add no message; WhatsApp is the existing single call', async () => {
    const { slug, reg } = ids('dup')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug)
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    expect(h.sent.map(s => s.type)).toEqual(['REGISTRATION_CONFIRMATION'])
    expect(h.whatsapp).toBe(1)
  }, T)

  it('the email log, the registration document and console output never hold the details', async () => {
    const { slug, reg } = ids('leak')
    const ed = await seedEvent(slug, { type: 'online', online: online() })
    await seedReg(reg, slug)
    errors.length = 0
    await confirm.sendConfirmationEmail(confirmArgs(reg, slug, ed))
    await approve.sendApprovalEmail(reg)
    await resend.resendRegistrationTicketEmail(reg)
    await new Promise(r => setTimeout(r, 300))                           // fire-and-forget log writes
    const logs = await db.collection('emailLogs').where('registrationId', '==', reg).get()
    expect(logs.size).toBeGreaterThan(0)
    const stored = JSON.stringify([...logs.docs.map(d => d.data()), (await db.doc(`registrations/${reg}`).get()).data()])
    for (const secret of [JOIN, MID, PASS, 'QAtoken']) {
      expect(stored, secret).not.toContain(secret)
      expect(errors.join('\n'), secret).not.toContain(secret)
    }
  }, T)
})
