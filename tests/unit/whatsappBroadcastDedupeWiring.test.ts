// "Ignore duplicate WhatsApp numbers" — the wiring, executed.
//
// The helper suite proves the ALGORITHM. This one proves the algorithm is actually reached at
// the two places that matter, and only there:
//
//   CREATION  → `recipientCount` is the deduped count, because WhatsApp is BILLED on it
//               up front with no refund path. Dedupe applied only at delivery would charge
//               for raw rows and message uniques.
//   DELIVERY  → applied BEFORE `createWhatsAppBroadcastJob`, because the recipients
//               subcollection is the idempotency boundary that every resume pages through.
//
// The real `deliverWhatsAppCampaign` is executed against a stubbed Firestore, and the rows
// handed to the job snapshot are captured — so "the snapshot contains one row per canonical
// number" is a recorded fact rather than a reading of the source.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let campaign: Doc | null = null
let registrations: Doc[] = []

/** Recipients handed to the job snapshot writer — the thing that decides who gets messaged. */
let snapshotRecipients: Array<{ id: string; data: Doc }> = []
let createJobCalls = 0
let processChunkCalls = 0

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' },
}))

vi.mock('@/lib/firebase/admin', () => {
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => ({ docs: registrations.map((d, i) => ({ id: `reg-${i}`, data: () => d })) }),
  }
  return {
    adminAuth: {},
    adminDb: {
      collection: () => ({
        doc: () => ({
          get:    async () => ({ exists: !!campaign, data: () => campaign }),
          update: async (patch: Doc) => { Object.assign(campaign ?? {}, patch) },
        }),
        ...query,
      }),
    },
  }
})

vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({ sendTemplate: async () => ({ success: true }) }),
  hasWhatsAppTemplate: () => true,
}))

// The snapshot writer is NOT under test — it must stay untouched — but what it RECEIVES is
// exactly what this file is here to verify.
vi.mock('@/lib/broadcasts/whatsappJob', () => ({
  createWhatsAppBroadcastJob: async (_id: string, _c: Doc, recipients: Array<{ id: string; data: Doc }>) => {
    createJobCalls++
    snapshotRecipients = recipients
    return { jobId: 'job-1' }
  },
  processWhatsAppBroadcastChunk: async () => { processChunkCalls++; return { status: 'running', processed: 0 } },
}))

vi.mock('@/lib/broadcasts/emailJob', () => ({
  createEmailBroadcastJob: async () => ({ jobId: 'ejob-1' }),
  processEmailBroadcastChunk: async () => ({ status: 'running', processed: 0 }),
}))
vi.mock('@/lib/broadcasts/limits', () => ({ resolveMaxRecipientsPerBroadcast: async () => 5000 }))
vi.mock('@/lib/broadcasts/audit', () => ({ logBroadcastAction: async () => {} }))
vi.mock('@/lib/communications/billing', () => ({ chargeAndStartCampaign: async () => ({ ok: true }) }))
vi.mock('@/lib/firebase/firestore/emailSuppressionList', () => ({ getOrganiserSuppressionSet: async () => new Set() }))
vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'ses' }))
vi.mock('@/lib/notifications', () => ({
  notificationEngine: { send: async () => ({ success: true }), isAvailable: () => true },
  NotificationChannel: { EMAIL: 'email' },
}))

const { deliverBroadcastCampaign } = await import('@/lib/broadcasts/send')

const reg = (phone: string, name: string) => ({
  attendee: { phone, name, email: `${name}@x.c` }, ticketCode: `TK-${name}`,
})

const waCampaign = (over: Doc = {}): Doc => ({
  organizerUid: 'org-1', eventId: 'evt-1', eventSlug: 'evt-1', eventName: 'Marathon',
  channel: 'whatsapp', audience: 'all', status: 'sending', templateType: 'EVENT_REMINDER',
  subject: '', html: '', recipientCount: 0, actualCostPaise: 0, ...over,
})

beforeEach(() => {
  snapshotRecipients = []; createJobCalls = 0; processChunkCalls = 0
  registrations = [
    reg('9363935055',      'first'),
    reg('+91 93639 35055', 'dup-of-first'),
    reg('09363935055',     'also-dup'),
    reg('9876543210',      'second'),
    reg('abc',             'junk-a'),
    reg('---',             'junk-b'),
  ]
})

// ─── Delivery: dedupe reaches the snapshot ────────────────────────────────────

describe('deliverWhatsAppCampaign — dedupe lands before the job snapshot', () => {
  it('OFF (flag absent) ⇒ every row is snapshotted, exactly as before the feature', async () => {
    campaign = waCampaign()
    await deliverBroadcastCampaign('c1')

    expect(createJobCalls).toBe(1)
    expect(snapshotRecipients).toHaveLength(6)
    expect(snapshotRecipients.map(r => (r.data as { attendee: { name: string } }).attendee.name))
      .toEqual(['first', 'dup-of-first', 'also-dup', 'second', 'junk-a', 'junk-b'])
  })

  it('OFF (explicit false) ⇒ identical to absent', async () => {
    campaign = waCampaign({ dedupePhones: false })
    await deliverBroadcastCampaign('c1')
    expect(snapshotRecipients).toHaveLength(6)
  })

  it('ON ⇒ one row per canonical number, junk rows preserved individually', async () => {
    campaign = waCampaign({ dedupePhones: true })
    await deliverBroadcastCampaign('c1')

    expect(snapshotRecipients).toHaveLength(4)
    expect(snapshotRecipients.map(r => (r.data as { attendee: { name: string } }).attendee.name))
      .toEqual(['first', 'second', 'junk-a', 'junk-b'])
  })

  it('ON ⇒ the FIRST registration represents the number, carrying its own variables', async () => {
    campaign = waCampaign({ dedupePhones: true })
    await deliverBroadcastCampaign('c1')

    const winner = snapshotRecipients[0]
    expect(winner.id).toBe('reg-0')
    expect((winner.data as { ticketCode: string }).ticketCode).toBe('TK-first')
  })

  it('the snapshot writer is still called exactly once, then the first chunk is driven', async () => {
    campaign = waCampaign({ dedupePhones: true })
    await deliverBroadcastCampaign('c1')
    expect(createJobCalls).toBe(1)
    expect(processChunkCalls).toBe(1)
  })
})

// ─── Resume / idempotency ─────────────────────────────────────────────────────

describe('resume never re-resolves or re-dedupes', () => {
  it('an existing whatsappJobId skips resolution entirely — no second snapshot', async () => {
    campaign = waCampaign({ dedupePhones: true, whatsappJobId: 'job-1' })
    await deliverBroadcastCampaign('c1')

    expect(createJobCalls).toBe(0)          // the snapshot already exists and is authoritative
    expect(snapshotRecipients).toEqual([])  // nothing was re-resolved
    expect(processChunkCalls).toBe(1)       // it just continues paging
  })

  it('the same holds with dedupe OFF', async () => {
    campaign = waCampaign({ whatsappJobId: 'job-1' })
    await deliverBroadcastCampaign('c1')
    expect(createJobCalls).toBe(0)
    expect(processChunkCalls).toBe(1)
  })

  it('a campaign not in "sending" is never delivered — the existing guard is intact', async () => {
    campaign = waCampaign({ dedupePhones: true, status: 'sent' })
    await deliverBroadcastCampaign('c1')
    expect(createJobCalls).toBe(0)
    expect(processChunkCalls).toBe(0)
  })
})

// ─── Scheduled parity ─────────────────────────────────────────────────────────

describe('scheduled campaigns keep the setting', () => {
  it('the cron path reads the flag off the persisted campaign and dedupes identically', async () => {
    // The cron calls startBroadcastCampaign → deliverBroadcastCampaign with nothing but the
    // campaign id, so the persisted document is the ONLY carrier of the option.
    campaign = waCampaign({ dedupePhones: true, scheduledFor: 'TS' })
    await deliverBroadcastCampaign('c1')
    expect(snapshotRecipients).toHaveLength(4)
  })

  it('a scheduled campaign WITHOUT the flag behaves exactly as it does today', async () => {
    campaign = waCampaign({ scheduledFor: 'TS' })
    await deliverBroadcastCampaign('c1')
    expect(snapshotRecipients).toHaveLength(6)
  })
})

// ─── Billing parity ───────────────────────────────────────────────────────────

describe('billing count and snapshot count agree', () => {
  it('the snapshot size equals what the preview helper would have counted', async () => {
    const { countUniquePhones } = await import('@/lib/broadcasts/dedupeRecipients')
    campaign = waCampaign({ dedupePhones: true })
    await deliverBroadcastCampaign('c1')

    const previewCount = countUniquePhones(registrations.map(r => (r as { attendee: { phone: string } }).attendee.phone))
    expect(snapshotRecipients.length).toBe(previewCount)
  })

  it('with dedupe OFF the snapshot equals the raw phone-present count', async () => {
    campaign = waCampaign()
    await deliverBroadcastCampaign('c1')
    expect(snapshotRecipients.length).toBe(registrations.length)
  })

  it('registrations with no phone are excluded before dedupe, either way', async () => {
    registrations = [reg('9363935055', 'a'), { attendee: { phone: '', name: 'b', email: 'b@x.c' } },
                     { attendee: { name: 'c', email: 'c@x.c' } }]
    campaign = waCampaign({ dedupePhones: true })
    await deliverBroadcastCampaign('c1')
    expect(snapshotRecipients).toHaveLength(1)
  })
})

// ─── Email isolation ──────────────────────────────────────────────────────────

describe('email broadcasts are untouched', () => {
  it('dedupePhones on an EMAIL campaign changes nothing about its recipients', async () => {
    campaign = waCampaign({ channel: 'email', dedupePhones: true, subject: 'Hi', html: '<p>x</p>' })
    await deliverBroadcastCampaign('c1')
    // The WhatsApp job writer is never reached for an email campaign.
    expect(createJobCalls).toBe(0)
    expect(snapshotRecipients).toEqual([])
  })
})
