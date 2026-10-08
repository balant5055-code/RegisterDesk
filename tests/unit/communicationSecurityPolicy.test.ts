// RD-COMMS-P2-C — the organizer WhatsApp broadcast template policy (lib/whatsapp/registry.ts), the
// event-name source, the SNS trust helpers and the reminder custom-subject escaping, as pure rules.
// The route / job / webhook behaviour on real Firestore is in tests/emulator/*P2C* suites.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ORGANIZER_BROADCAST_TEMPLATES, isOrganizerBroadcastTemplate, validateBroadcastVariables, BROADCAST_SERVER_VARIABLES,
  resolveWhatsAppTemplateByType, WHATSAPP_TEMPLATE_REGISTRY, type WhatsAppTemplateType,
} from '@/lib/whatsapp/registry'
import { authoritativeEventName } from '@/lib/broadcasts/eventName'
import { isValidSigningCertUrl, snsUrl, allowedSesTopics, snsSignatureAlgorithm } from '@/lib/email/snsSecurity'
import { buildReminderContent } from '@/lib/reminders/templates'

const read = (f: string) => readFileSync(f, 'utf8')

describe('organizer WhatsApp broadcast template allowlist', () => {
  it('the announcement templates are allowed', () => {
    for (const t of ['EVENT_UPDATED', 'KIT_COLLECTION', 'EVENT_LOCATION', 'CERTIFICATE_READY']) expect(isOrganizerBroadcastTemplate(t), t).toBe(true)
  })
  it('platform and transactional templates are NOT', () => {
    for (const t of [
      'WALLET_RECHARGED', 'SETTLEMENT_APPROVED', 'EVENT_APPROVED', 'EVENT_SUBMITTED', 'EVENT_REJECTED', 'LICENSE_PURCHASED', 'CAPACITY_THRESHOLD',
      'REFUND_SUCCESS', 'EVENT_CANCELLED', 'REGISTRATION_CONFIRMATION', 'REGISTRATION_CONFIRMATION_V2', 'REGISTRATION_APPROVED',
      'REGISTRATION_REJECTED', 'REGISTRATION_CANCELLED', 'TICKET_RESENT', 'WAITLIST_JOINED', 'WAITLIST_SPOT_AVAILABLE',
      'not_a_template', '', 'constructor', '__proto__',
    ]) expect(isOrganizerBroadcastTemplate(t), t).toBe(false)
    expect(isOrganizerBroadcastTemplate(undefined)).toBe(false)
    expect(isOrganizerBroadcastTemplate({})).toBe(false)
  })
  it('every allowlisted key is a real registry template', () => {
    for (const t of ORGANIZER_BROADCAST_TEMPLATES) expect(t in WHATSAPP_TEMPLATE_REGISTRY, t).toBe(true)
  })
  it('system / transactional senders still resolve protected templates (the allowlist gates broadcasts only)', () => {
    for (const t of ['WALLET_RECHARGED', 'REFUND_SUCCESS', 'REGISTRATION_CONFIRMATION'] as WhatsAppTemplateType[]) {
      const vars = Object.fromEntries(WHATSAPP_TEMPLATE_REGISTRY[t].requiredVariables.map(k => [k, 'x']))
      expect(resolveWhatsAppTemplateByType(t, '+919876543210', vars).ok, t).toBe(true)
    }
  })
  it('the server enforces it at both boundaries — the create route AND the broadcast job; the picker mirrors it', () => {
    const route = read('app/api/organizer/broadcasts/route.ts')
    expect(route).toContain('if (!isOrganizerBroadcastTemplate(templateType)) {')
    expect(route).toMatch(/TEMPLATE_NOT_ALLOWED[\s\S]{0,160}status: 403/)
    const job = read('lib/broadcasts/whatsappJob.ts')
    expect(job).toContain("if (!isOrganizerBroadcastTemplate(job.templateType)) return { ok: false, error: 'template_not_allowed' }")
    expect(read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')).toContain('.filter(t => isOrganizerBroadcastTemplate(t))')
  })
})

describe('organizer-typed template variables', () => {
  it('a server-filled variable typed by the organizer is IGNORED (cannot spoof attendee / event / ticket / link)', () => {
    const r = validateBroadcastVariables('EVENT_UPDATED', { eventName: 'Another Event', attendeeName: 'X', ticketCode: 'T', certificateUrl: 'https://evil.test' })
    expect(r).toEqual({ ok: true, variables: {} })
    for (const k of ['attendeeName', 'eventName', 'ticketCode', 'certificateUrl']) expect(BROADCAST_SERVER_VARIABLES.has(k)).toBe(true)
  })
  it('keys the template does not use are dropped (no injection into a protected template)', () => {
    const r = validateBroadcastVariables('KIT_COLLECTION', {
      collectionDate: '18 Aug', collectionTime: '10:00–18:00', collectionLocation: 'Expo Gate 3', mapsUrl: 'https://maps.app.goo.gl/x',
      refundAmount: '₹5000', organizerName: 'RegisterDesk', amount: '1',
    })
    expect(r.ok).toBe(true)
    expect(Object.keys((r as { variables: object }).variables).sort()).toEqual(['collectionDate', 'collectionLocation', 'collectionTime', 'mapsUrl'])
  })
  it('a missing required variable is rejected before anything is sent', () => {
    expect(validateBroadcastVariables('EVENT_LOCATION', { eventDate: '20 Aug', eventTime: '5:30', mapsUrl: 'https://m.test/x' })).toMatchObject({ ok: false, variable: 'venue' })
    expect(validateBroadcastVariables('EVENT_LOCATION', { eventDate: '20 Aug', eventTime: '5:30', venue: '   ', mapsUrl: 'https://m.test/x' })).toMatchObject({ ok: false, variable: 'venue' })
  })
  it('the link must be an absolute https:// URL', () => {
    const base = { eventDate: '20 Aug', eventTime: '5:30', venue: 'Stadium' }
    for (const bad of ['javascript:alert(1)', 'http://m.test/x', 'm.test/x', 'data:text/html,x', '//m.test/x']) {
      expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, mapsUrl: bad }), bad).toMatchObject({ ok: false, variable: 'mapsUrl' })
    }
    expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, mapsUrl: 'https://maps.app.goo.gl/abc' }).ok).toBe(true)
  })
  it('values must be single-line and bounded (Meta refuses new lines / tabs / 4+ spaces in a parameter)', () => {
    const base = { eventDate: '20 Aug', eventTime: '5:30', mapsUrl: 'https://m.test/x' }
    expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, venue: 'A\nB' }).ok).toBe(false)
    expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, venue: 'A\tB' }).ok).toBe(false)
    expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, venue: 'A    B' }).ok).toBe(false)
    expect(validateBroadcastVariables('EVENT_LOCATION', { ...base, venue: 'x'.repeat(201) }).ok).toBe(false)
  })
})

describe('the event name comes from the event document', () => {
  it('eventDetails.info.name, then the stored name, then the slug — never a client value', () => {
    expect(authoritativeEventName({ eventDetails: { info: { name: 'City Marathon 2026' } }, eventName: 'X' }, 'slug')).toBe('City Marathon 2026')
    expect(authoritativeEventName({ eventName: 'Stored' }, 'slug')).toBe('Stored')
    expect(authoritativeEventName(null, 'my-event')).toBe('my-event')
  })
  it('the create route no longer reads eventName from the request body', () => {
    const route = read('app/api/organizer/broadcasts/route.ts')
    expect(route).not.toMatch(/const \{[^}]*\beventName\b[^}]*\} =\s*\n?\s*body as/)
    expect(route).toContain('eventName:      authoritativeEventName(liveData, eventSlug),')
  })
})

describe('SNS trust helpers', () => {
  it('certificate URL: https, an sns.<region>.amazonaws.com host and the SNS .pem path only', () => {
    expect(isValidSigningCertUrl('https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123abc.pem')).toBe(true)
    for (const bad of [
      'http://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123abc.pem',
      'https://sns.ap-south-1.amazonaws.com.evil.test/SimpleNotificationService-0123abc.pem',
      'https://evil.test/SimpleNotificationService-0123abc.pem',
      'https://sns.ap-south-1.amazonaws.com/x/SimpleNotificationService-0123abc.pem',
      'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123abc.pem?a=1',
      'https://user:pw@sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123abc.pem',
      'https://sns.ap-south-1.amazonaws.com:8443/SimpleNotificationService-0123abc.pem',
      'not a url', '',
    ]) expect(isValidSigningCertUrl(bad), bad).toBe(false)
    expect(snsUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')).not.toBeNull()
    expect(snsUrl('https://evil.test/?Action=ConfirmSubscription')).toBeNull()
  })
  it('topic allowlist: only well-formed TopicArns; empty ⇒ fail closed', () => {
    expect([...allowedSesTopics('arn:aws:sns:ap-south-1:123456789012:ses, junk ,arn:aws:sns:us-east-1:123456789012:b')])
      .toEqual(['arn:aws:sns:ap-south-1:123456789012:ses', 'arn:aws:sns:us-east-1:123456789012:b'])
    expect(allowedSesTopics('').size).toBe(0)
    expect(allowedSesTopics(undefined).size).toBe(0)
  })
  it('signature version: exactly "1" or "2"', () => {
    expect(snsSignatureAlgorithm('1')).toBe('RSA-SHA1')
    expect(snsSignatureAlgorithm('2')).toBe('RSA-SHA256')
    for (const v of [undefined, null, '', '3', 1, 2]) expect(snsSignatureAlgorithm(v)).toBeNull()
  })
})

describe('reminder custom subject is DATA, not markup', () => {
  const build = (customSubject: string) => buildReminderContent({
    kind: 'custom', eventName: 'City Run', customSubject, customMessage: 'See you soon', attendeeName: 'A', eventUrl: 'https://registerdesk.in/events/x',
  } as never)

  it('a normal subject works unchanged', () => {
    const r = build('Bib collection opens tomorrow')
    expect(r.subject).toBe('Bib collection opens tomorrow')
    expect(r.html).toContain('Bib collection opens tomorrow')
  })
  it('an HTML / script payload is escaped text in the body — no element reaches the email', () => {
    const payload = 'Reminder<a href="javascript:alert(1)">Open ticket</a><form action="https://evil.test"><input name=pw></form><img src=x onerror=alert(1)><script>alert(1)</script>'
    const r = build(payload)
    expect(r.html).not.toMatch(/<a href="javascript:|<form|<input|<img|<script/i)
    expect(r.html).toContain('&lt;script&gt;')
  })
  it('the subject header value is a single line (no CR/LF header injection)', () => {
    const r = build('Hello\r\nBcc: victim@example.test')
    expect(r.subject).not.toMatch(/[\r\n]/)
  })
})
