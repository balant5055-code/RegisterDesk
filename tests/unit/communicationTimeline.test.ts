// RD-PLATFORM-COMMS-01 Phase 4F — the pure emailLog → TimelineEntry mapper: canonical status
// mapping, timestamp extraction, latency, and best-effort registry linking (never fabricated).

import { describe, it, expect } from 'vitest'
import { emailLogToTimelineEntry } from '@/lib/communications/timeline/map'
import type { EmailLog } from '@/lib/email-logs/types'

const base: EmailLog = {
  id: 'log1', organizerUid: 'u1', eventId: 'e1', eventSlug: 's', eventName: 'Ev',
  templateKey: 'welcome', recipientEmail: 'a@b.com', recipientName: 'A', subject: 'Hi',
  status: 'sent', provider: 'ses', registrationId: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:05.000Z',
}

describe('emailLogToTimelineEntry', () => {
  it('maps email sent → sent with queued + sent timestamps', () => {
    const t = emailLogToTimelineEntry(base)
    expect(t.status).toBe('sent')
    expect(t.channel).toBe('email')
    expect(t.queuedAt).toBe(base.createdAt)
    expect(t.sentAt).toBe(base.createdAt)
    expect(t.provider).toBe('ses')
  })

  it('maps WhatsApp read → opened and delivered timestamp flows through', () => {
    const t = emailLogToTimelineEntry({ ...base, channel: 'whatsapp', status: 'delivered', waStatus: 'read', deliveredAt: '2026-01-01T00:00:03.000Z', readAt: '2026-01-01T00:00:09.000Z' })
    expect(t.status).toBe('opened')
    expect(t.channel).toBe('whatsapp')
    expect(t.deliveredAt).toBe('2026-01-01T00:00:03.000Z')
    expect(t.openedAt).toBe('2026-01-01T00:00:09.000Z')
  })

  it('maps skipped → cancelled', () => {
    expect(emailLogToTimelineEntry({ ...base, status: 'skipped' }).status).toBe('cancelled')
  })

  it('computes latency from queued → completed', () => {
    const t = emailLogToTimelineEntry({ ...base, status: 'delivered', deliveredAt: '2026-01-01T00:00:02.500Z' })
    expect(t.latencyMs).toBe(2500)
  })

  it('links notification best-effort from templateKey (never fabricated)', () => {
    expect(emailLogToTimelineEntry(base).notificationId).toBe('ACCOUNT_WELCOME')   // 'welcome' → welcome template
    expect(emailLogToTimelineEntry({ ...base, templateKey: 'no-such-template' }).notificationId).toBeNull()
  })

  it('extracts an error code from a provider response', () => {
    const t = emailLogToTimelineEntry({ ...base, status: 'failed', providerResponse: 'HTTP 400 · code 132000 · bad', error: 'send failed' })
    expect(t.status).toBe('failed')
    expect(t.errorCode).toBe('132000')
    expect(t.errorMessage).toBe('send failed')
  })
})
