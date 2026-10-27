// WhatsApp Inbox fix — the recipient key, the outbound-evidence lookup, and the Super Admin
// access audit. UNIT layer: Firestore is a recording double; no emulator, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  writes:   [] as { col: string; id: string; data: Record<string, unknown>; op: string }[],
  queries:  [] as { col: string; field: string; value: unknown; limit: number }[],
  queryDocs: [] as { id: string; data: Record<string, unknown> }[],
  commitError: null as null | { code?: number; message: string },
}))

vi.mock('@/lib/firebase/admin', () => {
  const docRef = (col: string, id: string) => ({
    id,
    set: async (data: Record<string, unknown>) => { h.writes.push({ col, id, data, op: 'set' }) },
  })
  let auto = 0
  const collection = (col: string) => ({
    doc: (id?: string) => docRef(col, id ?? `auto${++auto}`),
    where: (field: string, _op: string, value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          h.queries.push({ col, field, value, limit: n })
          const docs = h.queryDocs.slice(0, n).map(d => ({ id: d.id, data: () => d.data }))
          return { docs, size: docs.length }
        },
      }),
    }),
  })
  return {
    adminDb: {
      collection,
      batch: () => {
        const staged: { col: string; id: string; data: Record<string, unknown> }[] = []
        return {
          create: (ref: { id: string; __col?: string }, data: Record<string, unknown>) => { staged.push({ col: 'adminAuditLogs', id: ref.id, data }) },
          commit: async () => {
            if (h.commitError) throw h.commitError
            for (const s of staged) h.writes.push({ ...s, op: 'create' })
          },
        }
      },
    },
    adminAuth: {}, adminApp: {},
  }
})
vi.mock('@/lib/config/resolveFeatureFlags', () => ({ getFeatureFlags: async () => ({ whatsappInbox: true }) }))

import { recipientPhoneKeyFields } from '@/lib/whatsapp/recipientKey'
import { whatsappPhoneKey } from '@/lib/whatsapp/broadcastConsent'
import { writeEmailLog } from '@/lib/email-logs/write'
import { firestoreRoutingLookups, OUTBOUND_EVIDENCE_LIMIT } from '@/lib/whatsapp-inbox/persist'
import { auditInboxAccess, inboxAuditDocId } from '@/lib/whatsapp-inbox/adminAudit'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, isFinancialAuditEntry } from '@/lib/admin/auditConstants'

beforeEach(() => {
  h.writes = []
  h.queries = []
  h.queryDocs = []
  h.commitError = null
})

// ─── Recipient key ────────────────────────────────────────────────────────────

describe('recipientPhoneKeyFields', () => {
  it('every way a number is stored or sent resolves to ONE key — the STOP/START key', () => {
    const k = recipientPhoneKeyFields('whatsapp', '98765 43210').recipientPhoneKey
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    for (const raw of ['+91 98765-43210', '919876543210', '09876543210', '(+91) 98765 43210']) {
      expect(recipientPhoneKeyFields('whatsapp', raw).recipientPhoneKey, raw).toBe(k)
    }
    expect(k).toBe(whatsappPhoneKey('919876543210'))
  })

  it('never stamps non-WhatsApp rows, empty or invalid numbers, and never contains the number', () => {
    expect(recipientPhoneKeyFields('email', '9876543210')).toEqual({})
    expect(recipientPhoneKeyFields('whatsapp', '')).toEqual({})
    expect(recipientPhoneKeyFields('whatsapp', 'abc')).toEqual({})
    expect(recipientPhoneKeyFields('whatsapp', undefined)).toEqual({})
    expect(JSON.stringify(recipientPhoneKeyFields('whatsapp', '9876543210'))).not.toContain('9876543210')
  })
})

describe('writeEmailLog stamps the key on WhatsApp rows only', () => {
  const base = { organizerUid: 'org', eventId: 'ev', eventSlug: 'ev', eventName: 'E', templateKey: 't', recipientEmail: '', recipientName: 'A', subject: 's', status: 'sent' as const, provider: 'meta' }

  it('a WhatsApp row carries recipientPhoneKey', async () => {
    await writeEmailLog({ ...base, channel: 'whatsapp', recipientPhone: '98765 43210', registrationId: 'r1' })
    expect(h.writes[0].data.recipientPhoneKey).toBe(whatsappPhoneKey('919876543210'))
  })

  it('an email row does not', async () => {
    await writeEmailLog({ ...base, channel: 'email', recipientEmail: 'a@example.com' })
    expect(h.writes[0].data).not.toHaveProperty('recipientPhoneKey')
  })
})

// ─── Evidence lookup ──────────────────────────────────────────────────────────

describe('firestoreRoutingLookups.outboundByPhone', () => {
  const at = (ms: number) => ({ toMillis: () => ms })

  it('is ONE bounded equality read on the hashed key (no composite index needed)', async () => {
    h.queryDocs = [{ id: 'wa_1', data: { channel: 'whatsapp', status: 'sent', organizerUid: 'o', eventId: 'e', eventName: 'E', registrationId: 'r', createdAt: at(1_000), recipientPhone: '9876543210' } }]
    const out = await firestoreRoutingLookups.outboundByPhone!('919876543210')
    expect(h.queries).toEqual([{ col: 'emailLogs', field: 'recipientPhoneKey', value: whatsappPhoneKey('919876543210'), limit: OUTBOUND_EVIDENCE_LIMIT + 1 }])
    expect(out).toEqual({ truncated: false, rows: [{ id: 'wa_1', channel: 'whatsapp', status: 'sent', organizerUid: 'o', eventId: 'e', eventName: 'E', registrationId: 'r', sentAtMs: 1_000 }] })
  })

  it('reports truncation when the bound is reached', async () => {
    h.queryDocs = Array.from({ length: OUTBOUND_EVIDENCE_LIMIT + 1 }, (_, i) => ({ id: `wa_${i}`, data: { channel: 'whatsapp', createdAt: at(i) } }))
    const out = await firestoreRoutingLookups.outboundByPhone!('919876543210')
    expect(out.truncated).toBe(true)
    expect(out.rows).toHaveLength(OUTBOUND_EVIDENCE_LIMIT)
  })

  it('an unusable number reads nothing', async () => {
    expect(await firestoreRoutingLookups.outboundByPhone!('')).toEqual({ rows: [], truncated: false })
    expect(h.queries).toEqual([])
  })
})

// ─── Super Admin access audit ─────────────────────────────────────────────────

describe('auditInboxAccess', () => {
  const HOUR = 60 * 60 * 1_000
  const T = Date.UTC(2026, 9, 26, 10, 5)

  it('the audit actions and entity types are registered and are not financial', () => {
    for (const a of ['whatsapp_inbox.conversation_viewed', 'whatsapp_inbox.conversation_marked_read', 'whatsapp_inbox.unmatched_viewed']) {
      expect(AUDIT_ACTIONS).toContain(a)
      expect(isFinancialAuditEntry({ action: a, entityType: 'whatsapp_conversation' })).toBe(false)
    }
    expect(AUDIT_ENTITY_TYPES).toContain('whatsapp_conversation')
    expect(AUDIT_ENTITY_TYPES).toContain('whatsapp_inbound')
  })

  it('one row per admin, action, item and hour', () => {
    const id = inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_viewed', 'c1', T)
    expect(inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_viewed', 'c1', T + 10 * 60 * 1_000)).toBe(id)
    for (const other of [
      inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_viewed', 'c1', T + HOUR),
      inboxAuditDocId('admin2', 'whatsapp_inbox.conversation_viewed', 'c1', T),
      inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_marked_read', 'c1', T),
      inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_viewed', 'c2', T),
    ]) expect(other).not.toBe(id)
  })

  it('writes an append-only row with ids only, as a Super Admin', async () => {
    const r = await auditInboxAccess({
      adminUid: 'admin1', action: 'whatsapp_inbox.conversation_viewed', entityType: 'whatsapp_conversation',
      entityId: 'org__ev__919876543210', metadata: { organizerUid: 'org', eventId: 'ev' }, nowMs: T,
    })
    expect(r).toBe('recorded')
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toMatchObject({ op: 'create', id: inboxAuditDocId('admin1', 'whatsapp_inbox.conversation_viewed', 'org__ev__919876543210', T) })
    expect(h.writes[0].data).toMatchObject({
      adminUid: 'admin1', actorRole: 'super_admin', action: 'whatsapp_inbox.conversation_viewed',
      entityType: 'whatsapp_conversation', metadata: { organizerUid: 'org', eventId: 'ev' },
    })
  })

  it('a repeat within the hour is ALREADY_EXISTS → "already", nothing thrown', async () => {
    h.commitError = { code: 6, message: 'already exists' }
    expect(await auditInboxAccess({ adminUid: 'a', action: 'whatsapp_inbox.unmatched_viewed', entityType: 'whatsapp_inbound', entityId: 'x' })).toBe('already')
  })

  it('an audit-store failure never blocks the read and logs ids only', async () => {
    h.commitError = { code: 14, message: 'unavailable' }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await auditInboxAccess({ adminUid: 'a', action: 'whatsapp_inbox.unmatched_viewed', entityType: 'whatsapp_inbound', entityId: 'x' })).toBe('failed')
    expect(String(err.mock.calls[0]?.[0])).toContain('whatsapp_inbox.unmatched_viewed')
    err.mockRestore()
  })
})
