// RD-COMMS-WA-CONSENT — WhatsApp consent for organizer broadcasts: the pure rules and the wiring.
//
//   • STOP/UNSUBSCRIBE/CANCEL/END/QUIT (any case, surrounding whitespace / trailing punctuation)
//     opt out; START/UNSTOP opt back in; EVERY other message — including sentences that contain
//     "stop" — changes nothing (a normal reply is never consent);
//   • one phone identity for inbound and outbound: the shared normaliser, hashed — no raw number;
//   • consent is recorded only from an explicit `true` with a usable number, never inferred;
//   • the registration endpoints accept it strictly; the gate to register does not require it;
//   • selection (create, job build, preview) and the send boundary all enforce it; transactional
//     WhatsApp paths never read it.
// Real-Firestore behaviour (webhook → STOP → broadcast skip, billing) is in
// tests/emulator/whatsappConsent.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
const c = await import('@/lib/whatsapp/broadcastConsent')

describe('inbound opt commands', () => {
  it('STOP and its synonyms, in any case and with whitespace/trailing punctuation, opt out', () => {
    for (const s of ['STOP', 'stop', 'Stop', '  STOP  ', '\nstop\t', 'stop.', 'STOP!', 'UNSUBSCRIBE', 'unsubscribe', 'Cancel', 'END', 'quit', 'Stop All', 'opt out']) {
      expect(c.parseWhatsAppOptCommand(s), JSON.stringify(s)).toMatchObject({ action: 'opt_out' })
    }
  })
  it('START / UNSTOP opt back in (explicit re-opt-in)', () => {
    for (const s of ['START', 'start', ' Start ', 'UNSTOP']) expect(c.parseWhatsAppOptCommand(s), s).toMatchObject({ action: 'opt_in' })
  })
  it('a normal message is NOT a command — never an opt-out, never consent', () => {
    for (const s of ['Hi', 'Thanks!', 'yes', 'OK', 'please stop sending me these', 'Don’t stop the event', 'STOP IT NOW PLEASE', 'stopwatch', 'I want to start running', '', '   ', null, undefined, 42, { body: 'STOP' }]) {
      expect(c.parseWhatsAppOptCommand(s as unknown), JSON.stringify(s)).toBeNull()
    }
  })
})

describe('one WhatsApp identity, inbound and outbound', () => {
  it('the wa_id Meta reports and the number a registration stored resolve to the same key', () => {
    const k = c.whatsappPhoneKey('919800012345')                       // inbound wa_id
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    for (const stored of ['+91 98000 12345', '+919800012345', '98000-12345', '9800012345', '(+91) 98000 12345']) {
      expect(c.whatsappPhoneKey(stored), stored).toBe(k)
    }
    expect(c.whatsappPhoneKey('+447700900123')).not.toBe(k)
  })
  it('no usable number ⇒ no key; the key never contains the number', () => {
    for (const bad of ['', '123', 'abc', null, undefined]) expect(c.whatsappPhoneKey(bad as string), String(bad)).toBeNull()
    expect(c.whatsappPhoneKey('+919800012345')).not.toContain('9800012345')
  })
})

describe('consent is explicit — never inferred', () => {
  it('recorded only from a strict `true` with a usable number — BOUND to that number by its hash', () => {
    const stamped = c.whatsappConsentFields(true, '+91 98000 12345').whatsappBroadcastConsent
    expect(stamped).toMatchObject({ state: 'opted_in', source: 'registration_form', version: c.WHATSAPP_CONSENT_VERSION, phoneHash: c.whatsappPhoneKey('+91 98000 12345') })
    expect(JSON.stringify(stamped)).not.toContain('9800012345')                 // no raw number in the consent
    for (const v of [false, 'true', 1, 'yes', null, undefined, {}]) expect(c.whatsappConsentFields(v, '+91 98000 12345'), String(v)).toEqual({})
    expect(c.whatsappConsentFields(true, '')).toEqual({})
    expect(c.whatsappConsentFields(true, undefined)).toEqual({})
  })
  it('only the recorded opt-in counts — not a phone, the registration, the platform terms or a delivery', () => {
    const phone = '+91 98000 12345'
    expect(c.hasWhatsAppBroadcastConsent({ attendee: { phone }, ...c.whatsappConsentFields(true, phone) })).toBe(true)
    for (const reg of [
      {}, { attendee: { phone: '+919800012345' } }, { termsAccepted: true }, { whatsappStatus: 'delivered' },
      { whatsappBroadcastConsent: { state: 'opted_out' } }, { whatsappBroadcastConsent: true }, null,
    ]) expect(c.hasWhatsAppBroadcastConsent(reg), JSON.stringify(reg)).toBe(false)
  })
})

describe('consent is BOUND to the number that consented (phone binding)', () => {
  const A = '+91 98000 12345', B = '+91 98000 67890'
  const consentFor = (phone: string) => c.whatsappConsentFields(true, phone)
  it('matching current number ⇒ eligible (any formatting of the same number)', () => {
    expect(c.whatsappConsentStatus({ attendee: { phone: A }, ...consentFor(A) })).toBe('ok')
    expect(c.whatsappConsentStatus({ attendee: { phone: '919800012345' }, ...consentFor(A) })).toBe('ok')
  })
  it('the number changed after the opt-in ⇒ NOT eligible — the new number never inherits consent', () => {
    expect(c.whatsappConsentStatus({ attendee: { phone: B }, ...consentFor(A) })).toBe('phone_changed')
    expect(c.whatsappConsentStatus({ attendee: {}, ...consentFor(A) })).toBe('phone_changed')          // number removed
    expect(c.hasWhatsAppBroadcastConsent({ attendee: { phone: B }, ...consentFor(A) })).toBe(false)
  })
  it('an explicit opt-in for the NEW number binds to it', () => {
    expect(c.whatsappConsentStatus({ attendee: { phone: B }, ...consentFor(B) })).toBe('ok')
  })
  it('an opt-in WITHOUT a phoneHash (pre-binding) fails closed — never assumed to belong to the current number', () => {
    for (const legacy of [{ state: 'opted_in' }, { state: 'opted_in', phoneHash: '' }, { state: 'opted_in', phoneHash: null }]) {
      expect(c.whatsappConsentStatus({ attendee: { phone: A }, whatsappBroadcastConsent: legacy }), JSON.stringify(legacy)).toBe('no_consent')
    }
  })
  it('a hash is only ever derived on the server from the phone of the write — a supplied hash for another number does not match', () => {
    const forged = { attendee: { phone: B }, whatsappBroadcastConsent: { state: 'opted_in', phoneHash: 'deadbeef'.repeat(8) } }
    expect(c.whatsappConsentStatus(forged)).toBe('phone_changed')
    expect(read('lib/whatsapp/broadcastConsent.ts')).toContain("const phoneHash = whatsappPhoneKey(typeof phone === 'string' ? phone : '')")
    for (const f of ['app/api/registrations/submit/route.ts', 'app/api/registrations/create-order/route.ts']) expect(read(f), f).not.toMatch(/phoneHash/)
  })
  it('the send boundary also requires the number being messaged to be the consenting number', () => {
    const src = read('lib/whatsapp/broadcastConsent.ts')
    expect(src).toContain('const status = whatsappConsentStatus(reg.data())')
    expect(src).toMatch(/if \(key !== \(reg\.data\(\)[^\n]*whatsappBroadcastConsent\.phoneHash\) return 'phone_changed'/)
  })
})

describe('registration capture', () => {
  it('both endpoints accept the opt-in only as a strict boolean; settlement stamps it from the server snapshot', () => {
    expect(read('app/api/registrations/submit/route.ts')).toContain('whatsappBroadcastOptIn: body.whatsappBroadcastOptIn === true,')
    expect(read('app/api/registrations/create-order/route.ts')).toContain('...(body.whatsappBroadcastOptIn === true ? { whatsappBroadcastOptIn: true } : {}),')
    expect(read('lib/firebase/firestore/registrations.ts')).toContain('...whatsappConsentFields(input.whatsappBroadcastOptIn, input.attendee.phone),')
    expect(read('lib/payments/settleCapturedRegistration.ts')).toContain('...whatsappConsentFields(intent.whatsappBroadcastOptIn, intent.attendee?.phone),')
  })
  it('the box is optional, unticked by default, shown only for WhatsApp-enabled events, and not part of the register gate', () => {
    const client = read('app/events/[slug]/register/RegisterClient.tsx')
    expect(client).toContain('useState<ConsentState>({ info: false, terms: false, refund: false, whatsapp: false })')
    expect(client).toContain('...(whatsappUpdatesAvailable && consent.whatsapp ? { whatsappBroadcastOptIn: true } : {}),')
    expect(read('app/events/[slug]/register/page.tsx')).toContain('whatsappUpdatesAvailable={rawPricing?.whatsappEnabled === true}')
    const panels = read('app/events/[slug]/register/CheckoutPanels.tsx')
    expect(panels).toMatch(/return c\.info && c\.terms && \(!refundPolicyUrl\?\.trim\(\) \|\| c\.refund\)/)   // gate unchanged
    expect(panels).toContain('Yes, I would like to receive WhatsApp updates about this event from the organiser. I can reply STOP at any time to opt out.')
    expect(panels).toContain('checked={consent.whatsapp === true}')   // unticked unless the attendee ticks it
  })
})

describe('enforcement wiring', () => {
  it('every recipient-SELECTION point applies the consent filter (create, job build, preview)', () => {
    expect(read('app/api/organizer/broadcasts/route.ts')).toContain('const consent = await filterWhatsAppBroadcastRecipients(withPhone)')
    expect(read('lib/broadcasts/send.ts')).toContain('const { eligible: consenting } = await filterWhatsAppBroadcastRecipients(withPhone)')
    expect(read('app/api/organizer/broadcasts/count/route.ts')).toContain('await filterWhatsAppBroadcastRecipients(withPhone)')
  })
  it('the SEND BOUNDARY re-reads consent before the attempt marker and before Meta; skips are final and not failures', () => {
    const job = read('lib/broadcasts/whatsappJob.ts')
    const check = job.indexOf('consentBlock = await whatsappBroadcastSendBlock(item.registrationId, item.phone)')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(job.indexOf('await recipientRef.update({ pendingAttemptAt: FieldValue.serverTimestamp() })'))
    expect(check).toBeLessThan(job.indexOf('await ctx.provider.sendTemplate(message)'))
    expect(job).toContain("catch { return { ok: false, error: 'WhatsApp consent could not be checked; not sent' } }")
    expect(job).toContain('if (item.skipped) return { ok: true, skipped: true }')
    expect(job).toContain('await finalizeBroadcast(campaignRef, campaignId, c, accepted, recipients.length - accepted - skipped, recipients, skipped)')
  })
  it('STOP is applied by the webhook after the durable receipt; a failure asks Meta to redeliver; routing untouched', () => {
    const wh = read('app/api/webhooks/whatsapp/route.ts')
    expect(wh.indexOf('await applyInboundOptCommands(inbound)')).toBeGreaterThan(wh.indexOf('await recordInboundMessages(inbound)'))
    expect(wh).toMatch(/applyInboundOptCommands\(inbound\)[\s\S]{0,400}catch \(err\) \{\s*inboundFailed\+\+/)
    expect(wh).toContain('if (rec.created.length) after(() => routeInboundBatch(rec.created))')
  })
  it('TRANSACTIONAL WhatsApp never reads broadcast consent', () => {
    for (const f of ['lib/registrations/sendWhatsAppConfirmation.ts', 'lib/certificates/whatsapp.ts', 'lib/whatsapp/funding.ts', 'lib/communications/billing.ts', 'lib/whatsapp/acceptance.ts']) {
      expect(read(f), f).not.toMatch(/broadcastConsent|whatsappBroadcastOptOuts|whatsappBroadcastSendBlock|hasWhatsAppBroadcastConsent/)
    }
  })
  it('no raw phone number is written by the consent module', () => {
    const src = read('lib/whatsapp/broadcastConsent.ts')
    expect(src).not.toMatch(/phone:\s*(m\.from|raw|phone)\b/)
    expect(src).toMatch(/createHash\('sha256'\)\.update\(`wa:\$\{v\.normalizedPhone\}`\)/)
  })
})
