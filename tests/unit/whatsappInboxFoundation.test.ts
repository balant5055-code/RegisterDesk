// WhatsApp Inbox (Phase 1a) — wiring contracts and pure helpers.
//
// The emulator suite proves behaviour; this file pins the WIRING that behaviour depends on
// and that a later edit could silently undo: signature verification still gates every
// write, the status path is untouched, the rules deny client access, the indexes and the
// recovery cron exist, and the notification is gated to exactly the Inbox's audience.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { conversationIdFor, maskPhone, previewFor, MAX_PREVIEW_LENGTH } from '@/lib/whatsapp-inbox/types'
import { CATEGORY_META, canSeeCategory } from '@/lib/notifications/inbox/catalog'
import { ROLE_PERMISSIONS } from '@/lib/team/types'
import { BUSINESS_CONFIG_DEFAULTS, FEATURE_FLAG_KEYS } from '@/lib/config/businessConfig'

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('pure helpers', () => {
  it('conversationIdFor is deterministic and refuses a path separator', () => {
    expect(conversationIdFor('uidA', 'my-event', '919876543210')).toBe('uidA__my-event__919876543210')
    expect(() => conversationIdFor('uid/A', 'e', '1')).toThrow()
    expect(() => conversationIdFor('uidA', '', '1')).toThrow()
  })

  it('previewFor labels non-text and caps length', () => {
    expect(previewFor({ type: 'text', text: 'hi  there\nfriend', media: null })).toBe('hi there friend')
    expect(previewFor({ type: 'image', text: null, media: { id: 'm', caption: 'bib' } })).toBe('Photo: bib')
    expect(previewFor({ type: 'sticker', text: null, media: { id: 'm' } })).toBe('Sticker')
    expect(previewFor({ type: 'text', text: 'x'.repeat(500), media: null })).toHaveLength(MAX_PREVIEW_LENGTH)
  })

  it('maskPhone never reveals more than the last four digits', () => {
    expect(maskPhone('919876543210')).toBe('••••3210')
    expect(maskPhone('12')).toBe('••••')
  })
})

describe('webhook route wiring', () => {
  const src = read('app/api/webhooks/whatsapp/route.ts')
  const post = src.slice(src.indexOf('export async function POST'))

  it('verifies the signature before parsing or writing anything', () => {
    const sig   = post.indexOf("return new NextResponse('Invalid signature', { status: 401 })")
    const parse = post.indexOf('JSON.parse(raw)')
    const write = post.indexOf('recordInboundMessages(')
    expect(sig).toBeGreaterThan(0)
    expect(parse).toBeGreaterThan(sig)
    expect(write).toBeGreaterThan(sig)
  })

  it('persists receipts before acknowledging, routes in after()', () => {
    expect(post).toMatch(/await recordInboundMessages\(inbound\)/)
    expect(post).toMatch(/after\(\(\) => routeInboundBatch\(rec\.created\)\)/)
    expect(post).toMatch(/status: 500/)
  })

  it('keeps the delivery-status path intact', () => {
    expect(post).toContain('parseWhatsAppStatusEvents(payload)')
    expect(post).toContain('await applyWhatsAppDeliveryStatus(event).catch(() => 0)')
  })

  it('never logs message content', () => {
    expect(post).not.toMatch(/console\.\w+\([^)]*\.text/)
    expect(read('lib/whatsapp-inbox/persist.ts')).not.toMatch(/console\.\w+\([^)]*(rx\.text|\.fromRaw|decision\.phone)/)
  })
})

describe('firestore rules and indexes', () => {
  const rules = read('firestore.rules')

  it.each(['whatsappInbound/{docId}', 'whatsappConversations/{conversationId}', 'messages/{messageId}'])(
    'explicit deny on %s', path => {
      const at = rules.indexOf(`match /${path}`)
      expect(at).toBeGreaterThan(0)
      expect(rules.slice(at, at + 120)).toMatch(/allow read, write: if false;/)
    },
  )

  it('declares every composite index the inbox queries need', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as { indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[] }
    const keys = new Set(idx.indexes.map(i => `${i.collectionGroup}|${i.fields.map(f => `${f.fieldPath}:${f.order}`).join(',')}`))
    // EVERY composite query shape the inbox issues. The emulator does not enforce indexes, so
    // a missing entry here is a production-only FAILED_PRECONDITION — this list is the guard.
    // Equality-only queries (count(), wamid/phone lookups) and single-field orders need none.
    for (const k of [
      // organizer list — lib/whatsapp-inbox/read.ts listConversations (eventId? × unread?)
      'whatsappConversations|organizerUid:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|organizerUid:ASCENDING,eventId:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|organizerUid:ASCENDING,unread:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|organizerUid:ASCENDING,eventId:ASCENDING,unread:ASCENDING,lastMessageAt:DESCENDING',
      // Super Admin list — lib/whatsapp-inbox/adminRead.ts (organizerUid? × eventId? × adminUnread?)
      'whatsappConversations|eventId:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|adminUnread:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|organizerUid:ASCENDING,adminUnread:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|eventId:ASCENDING,adminUnread:ASCENDING,lastMessageAt:DESCENDING',
      'whatsappConversations|organizerUid:ASCENDING,eventId:ASCENDING,adminUnread:ASCENDING,lastMessageAt:DESCENDING',
      // recovery sweep (asc) + unmatched queue (desc, ± reason)
      'whatsappInbound|state:ASCENDING,receivedAt:ASCENDING',
      'whatsappInbound|state:ASCENDING,receivedAt:DESCENDING',
      'whatsappInbound|state:ASCENDING,routing.reason:ASCENDING,receivedAt:DESCENDING',
    ]) expect(keys.has(k), k).toBe(true)
  })
})

describe('recovery cron', () => {
  it('is fail-closed, instrumented, and scheduled once (GitHub Actions only)', () => {
    const route = read('app/api/cron/whatsapp-inbound/route.ts')
    expect(route).toMatch(/if \(!isAuthorizedCron\(req\)\) return cronUnauthorized\(\)/)
    expect(route).toContain("withCronMetrics('whatsapp-inbound', handle)")
    expect(read('.github/workflows/cron-runners.yml')).toContain('/api/cron/whatsapp-inbound')
    expect(read('vercel.json')).not.toContain('whatsapp-inbound')
  })
})

describe('notification audience + feature flag', () => {
  it("'message' notifications are visible exactly to holders of `broadcasts`", () => {
    expect(CATEGORY_META.message.visibility).toBe('broadcasts')
    const seeing = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => canSeeCategory('message', p)).map(([r]) => r).sort()
    expect(seeing).toEqual(['admin', 'owner'])
  })

  it('whatsappInbox is a real flag and defaults OFF', () => {
    expect(FEATURE_FLAG_KEYS).toContain('whatsappInbox')
    expect(BUSINESS_CONFIG_DEFAULTS.featureFlags.whatsappInbox).toBe(false)
  })

  it('routing gates the notification on the flag and never puts message text in it', () => {
    const src = read('lib/whatsapp-inbox/persist.ts')
    const call = src.slice(src.indexOf('prepareNotification({'), src.indexOf('dedupeId:     `whatsapp_'))
    expect(src).toContain('const notifyOn = await inboxNotificationsEnabled()')
    expect(src).toMatch(/if \(!notifyOn\) return false/)
    expect(call).not.toMatch(/rx\.text|preview/)
  })

  it('the notification is written INSIDE the routing transaction (no post-commit loss window)', () => {
    const src = read('lib/whatsapp-inbox/persist.ts')
    expect(src).not.toMatch(/\bwriteNotification\b/)
    expect(src).toContain('txn.set(n.ref, n.data)')
    // Both routed branches that raise unread call it with the transaction.
    expect(src).toContain('notified: becameUnread && notifyInTxn(txn,')
    expect(src).toContain('return { notified: notifyInTxn(txn, nameFromRegistration) }')
  })

  it('the recovery sweep pages with a cursor — one attempt per stuck receipt per run', () => {
    const src = read('lib/whatsapp-inbox/persist.ts')
    const sweep = src.slice(src.indexOf('export async function sweepReceivedInbound'))
    expect(sweep).toContain('if (after) q = q.startAfter(after)')
    expect(sweep).toContain('after = snap.docs[snap.docs.length - 1]')
    const cron = read('app/api/cron/whatsapp-inbound/route.ts')
    expect(cron.match(/sweepReceivedInbound\(/g)?.length).toBe(1)
    expect(cron).not.toMatch(/while \(/)
  })
})

describe('outbound WhatsApp is untouched by Phase 1a', () => {
  it.each([
    'lib/registrations/sendWhatsAppConfirmation.ts',
    'lib/whatsapp/provider.ts',
    'lib/whatsapp/payload.ts',
    'lib/email-logs/whatsappStatus.ts',
  ])('%s does not reference the inbox', p => {
    expect(read(p)).not.toMatch(/whatsapp-inbox|whatsappInbox|webhookInbound/)
  })
})
