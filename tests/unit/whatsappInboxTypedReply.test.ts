// WhatsApp Inbox — a PLAIN TYPED reply ("HI", no swipe-reply reference) after a recent registration
// confirmation, end to end through the real code: the confirmation's log row (writeEmailLog, with
// the exact fields sendWhatsAppConfirmation writes) → Meta's status webhook marking it read
// (applyWhatsAppDeliveryStatus) → the Firestore routing lookups → the routing decision.
// UNIT layer: Firestore is an in-memory double; no emulator, no network, nothing sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  store: new Map<string, Map<string, Record<string, unknown>>>(),
  clock: 0,
}))

vi.mock('@/lib/firebase/admin', async () => {
  const { Timestamp } = await import('firebase-admin/firestore')
  const col = (c: string) => { if (!h.store.has(c)) h.store.set(c, new Map()); return h.store.get(c)! }
  // A server timestamp resolves to the test clock, as Firestore would on commit.
  const resolve = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([k, v]) =>
    [k, (k === 'createdAt' || k === 'updatedAt' || k === 'statusUpdatedAt') && !(v instanceof Timestamp) ? Timestamp.fromMillis(h.clock) : v]))
  let auto = 0
  const ref = (c: string, id: string) => ({
    id,
    get: async () => ({ exists: col(c).has(id), id, data: () => col(c).get(id) }),
    set: async (d: Record<string, unknown>) => { col(c).set(id, resolve(d)) },
    update: async (d: Record<string, unknown>) => { col(c).set(id, { ...col(c).get(id), ...resolve(d) }) },
  })
  const query = (c: string, field: string, value: unknown) => ({
    limit: (n: number) => ({
      get: async () => {
        const docs = [...col(c).entries()].filter(([, d]) => d[field] === value).slice(0, n)
          .map(([id, d]) => ({ id, ref: ref(c, id), data: () => d }))
        return { docs, size: docs.length, empty: docs.length === 0 }
      },
    }),
  })
  return {
    adminDb: {
      collection: (c: string) => ({ doc: (id?: string) => ref(c, id ?? `auto${++auto}`), where: (f: string, _op: string, v: unknown) => query(c, f, v) }),
      runTransaction: async (fn: (t: unknown) => unknown) => fn({
        get: (r: { get: () => unknown }) => r.get(),
        update: (r: { update: (d: Record<string, unknown>) => unknown }, d: Record<string, unknown>) => { void r.update(d) },
      }),
    },
    adminAuth: {}, adminApp: {},
  }
})
vi.mock('@/lib/config/resolveFeatureFlags', () => ({ getFeatureFlags: async () => ({ whatsappInbox: true }) }))

import { writeEmailLog } from '@/lib/email-logs/write'
import { applyWhatsAppDeliveryStatus } from '@/lib/email-logs/whatsappStatus'
import { firestoreRoutingLookups } from '@/lib/whatsapp-inbox/persist'
import { resolveInboundRoute } from '@/lib/whatsapp/inboundRouting'

const NOW   = Date.parse('2026-10-26T16:00:00Z')
const OPTS  = { expectedPhoneNumberId: 'PN1', nowMs: NOW }
const TYPED = { phoneNumberId: 'PN1', from: '919876543210', contextWamid: null }   // wa_id; no reply reference

/** Exactly the row sendWhatsAppConfirmation's logComm writes for an accepted confirmation. */
async function confirmationSent(o: { organizerUid?: string; eventSlug?: string; registrationId?: string; phone?: string; wamid?: string; atMs?: number } = {}) {
  h.clock = o.atMs ?? NOW - 60 * 60_000
  const eventSlug = o.eventSlug ?? 'madurai-run'
  return writeEmailLog({
    organizerUid: o.organizerUid ?? 'org-A', eventId: eventSlug, eventSlug, eventName: 'Madurai Run',
    templateKey: 'registration_confirmation', recipientEmail: 'a@example.test', recipientName: 'A',
    subject: 'WhatsApp: Registration confirmation — Madurai Run', status: 'sent', provider: 'meta', channel: 'whatsapp',
    recipientPhone: o.phone ?? '98765 43210',   // stored as the attendee typed it
    costPaise: 0, providerMessageId: o.wamid ?? 'wamid.CONF1', registrationId: o.registrationId ?? 'reg-1',
  })
}

beforeEach(() => { h.store = new Map(); h.clock = 0 })

describe('a typed reply after a recent registration confirmation', () => {
  it('routes to the confirmation\'s organizer + event, with its registration (status still "sent")', async () => {
    await confirmationSent()
    const d = await resolveInboundRoute(TYPED, OPTS, firestoreRoutingLookups)
    expect(d).toMatchObject({
      outcome: 'routed', method: 'outbound_recipient', organizerUid: 'org-A', eventId: 'madurai-run',
      eventName: 'Madurai Run', registrationIds: ['reg-1'], context: 'none',
    })
  })

  it('still routes after Meta\'s status webhook marked the confirmation READ (the usual case before a reply)', async () => {
    await confirmationSent()
    h.clock = NOW - 30 * 60_000
    const updated = await applyWhatsAppDeliveryStatus({ wamid: 'wamid.CONF1', status: 'read', timestampMs: h.clock } as never)
    expect(updated).toBe(1)
    const row = [...h.store.get('emailLogs')!.values()][0]
    expect(row).toMatchObject({ status: 'delivered', waStatus: 'read' })
    expect(await resolveInboundRoute(TYPED, OPTS, firestoreRoutingLookups)).toMatchObject({ outcome: 'routed', method: 'outbound_recipient', organizerUid: 'org-A' })
  })

  it('a different number is not routed to that confirmation', async () => {
    await confirmationSent()
    expect(await resolveInboundRoute({ ...TYPED, from: '919000000001' }, OPTS, firestoreRoutingLookups))
      .toMatchObject({ outcome: 'unmatched', reason: 'no_candidates' })
  })

  it('confirmations from TWO organizers to the same number → unmatched, never guessed (workspace isolation)', async () => {
    await confirmationSent()
    await confirmationSent({ organizerUid: 'org-B', eventSlug: 'chennai-run', registrationId: 'reg-2', wamid: 'wamid.CONF2', phone: '+91 98765-43210' })
    expect(await resolveInboundRoute(TYPED, OPTS, firestoreRoutingLookups)).toMatchObject({ outcome: 'unmatched', reason: 'ambiguous_organizer' })
  })

  it('a confirmation older than the evidence window is not evidence', async () => {
    await confirmationSent({ atMs: NOW - 31 * 24 * 60 * 60_000 })
    expect(await resolveInboundRoute(TYPED, OPTS, firestoreRoutingLookups)).toMatchObject({ outcome: 'unmatched', reason: 'no_candidates' })
  })

  it('a row written before the fix (no recipientPhoneKey) is not matched — no backfill, no guess', async () => {
    await confirmationSent()
    const logs = h.store.get('emailLogs')!
    for (const [id, d] of logs) { const rest = { ...d }; delete rest.recipientPhoneKey; logs.set(id, rest) }
    expect(await resolveInboundRoute(TYPED, OPTS, firestoreRoutingLookups)).toMatchObject({ outcome: 'unmatched', reason: 'no_candidates' })
  })

  it('a swipe-reply to the confirmation routes by its reference (context), as before', async () => {
    await confirmationSent()
    expect(await resolveInboundRoute({ ...TYPED, contextWamid: 'wamid.CONF1' }, OPTS, firestoreRoutingLookups))
      .toMatchObject({ outcome: 'routed', method: 'context', organizerUid: 'org-A', registrationIds: ['reg-1'] })
  })

  it('the accepted-confirmation writer (acceptance transaction) stamps the same key as writeEmailLog', () => {
    expect(readFileSync('lib/whatsapp/acceptance.ts', 'utf8')).toMatch(/\.\.\.recipientPhoneKeyFields\(input\.log\.channel, input\.log\.recipientPhone\)/)
  })
})
