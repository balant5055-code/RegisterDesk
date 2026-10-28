// RD-MEETING-ACCESS-01 · the pure rules and the email markup. Delivery on real Firestore is in
// tests/emulator/meetingAccessDelivery.emu.test.ts; the public page never carrying the details is
// in tests/unit/customEventPublicPage.test.ts and tests/unit/eventPageMetadata.test.ts.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { resolveMeetingAccess, isEntitledToMeetingAccess, safeJoinUrl } from '@/lib/registrations/meetingAccess'
import { registrationTemplate } from '@/lib/email/templates/registration'
import { ticketTemplate } from '@/lib/email/templates/ticket'
import type { RegistrationEmailParams } from '@/lib/email/provider'

const ed = (type: string, online: Record<string, unknown> | null) => ({ venue: { type, online } })
const ON = { platform: 'google_meet', platformCustomName: '', meetingUrl: 'https://meet.google.com/abc-defg-hij', meetingId: '', passcode: '', joinInstructions: '' }

describe('resolveMeetingAccess', () => {
  it('online / hybrid with a usable link or ID → details; physical / no online config → null', () => {
    expect(resolveMeetingAccess(ed('online', ON))).toEqual({ platform: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij', meetingId: null, passcode: null, instructions: null })
    expect(resolveMeetingAccess(ed('hybrid', ON))?.joinUrl).toBe('https://meet.google.com/abc-defg-hij')
    expect(resolveMeetingAccess(ed('physical', ON))).toBeNull()
    expect(resolveMeetingAccess(ed('online', null))).toBeNull()
    expect(resolveMeetingAccess(null)).toBeNull()
  })

  it('only http(s) links survive', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.invalid', 'meet me at noon', '', '   ', 42, null])
      expect(safeJoinUrl(bad), String(bad)).toBeNull()
    expect(safeJoinUrl(' https://zoom.us/j/1 ')).toBe('https://zoom.us/j/1')
    expect(resolveMeetingAccess(ed('online', { ...ON, meetingUrl: 'javascript:alert(1)' }))).toBeNull()
    expect(resolveMeetingAccess(ed('online', { ...ON, meetingUrl: 'javascript:alert(1)', meetingId: '1 2 3' }))).toMatchObject({ joinUrl: null, meetingId: '1 2 3' })
  })
})

describe('isEntitledToMeetingAccess — server-side, from the registration document', () => {
  const ok = { eventSlug: 'ev', status: 'confirmed', paymentStatus: 'paid' }
  it('confirmed + this event + paid / not required / legacy-absent → yes', () => {
    expect(isEntitledToMeetingAccess(ok, 'ev')).toBe(true)
    expect(isEntitledToMeetingAccess({ ...ok, paymentStatus: 'not_required' }, 'ev')).toBe(true)
    expect(isEntitledToMeetingAccess({ eventSlug: 'ev', status: 'confirmed' }, 'ev')).toBe(true)
  })
  it('anything else → no', () => {
    for (const status of ['pending', 'waitlisted', 'rejected', 'cancelled', undefined])
      expect(isEntitledToMeetingAccess({ ...ok, status }, 'ev'), String(status)).toBe(false)
    for (const paymentStatus of ['pending', 'refund_pending', 'refunded'])
      expect(isEntitledToMeetingAccess({ ...ok, paymentStatus }, 'ev'), paymentStatus).toBe(false)
    expect(isEntitledToMeetingAccess({ ...ok, eventSlug: 'other' }, 'ev')).toBe(false)
    expect(isEntitledToMeetingAccess(null, 'ev')).toBe(false)
    expect(isEntitledToMeetingAccess(ok, '')).toBe(false)
  })
})

describe('email markup', () => {
  const base: RegistrationEmailParams = {
    to: 'a@qa.invalid', attendeeName: 'Asha', eventName: 'Launch', eventDate: 'Sat, 1 May 2099',
    ticketCode: 'TK1', passName: 'General', registrationId: 'r1',
    ticketPageUrl: 'https://rd.invalid/tickets/r1', pdfDownloadUrl: 'https://rd.invalid/pdf',
  }
  const access = {
    platform: 'Zoom <b>', joinUrl: 'https://zoom.us/j/1?pwd=a&b="x"', meetingId: '111 222', passcode: '<script>p</script>',
    instructions: 'Line one\nLine <two>',
  }

  for (const [name, render] of [['confirmation / approval', registrationTemplate], ['ticket resend', ticketTemplate]] as const) {
    it(`${name}: no block without details — the email is unchanged`, () => {
      const html = render(base).html
      expect(html).not.toContain('How to join online')
    })

    it(`${name}: the block shows link, ID, passcode, instructions — every value escaped`, () => {
      const html = render({ ...base, meetingAccess: access }).html
      expect(html).toContain('How to join online')
      expect(html).toContain('href="https://zoom.us/j/1?pwd=a&amp;b=&quot;x&quot;"')
      expect(html).toContain('111 222')
      expect(html).toContain('&lt;script&gt;p&lt;/script&gt;')
      expect(html).not.toContain('<script>p</script>')
      expect(html).toContain('Zoom &lt;b&gt;')
      expect(html).toContain('Line &lt;two&gt;')
    })
  }

  it('an ID-only meeting renders no link row', () => {
    const html = registrationTemplate({ ...base, meetingAccess: { ...access, joinUrl: null } }).html
    expect(html).not.toContain('>Link<')
    expect(html).toContain('Meeting ID')
  })
})
