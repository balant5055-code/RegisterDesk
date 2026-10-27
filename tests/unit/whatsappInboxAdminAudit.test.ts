// WhatsApp Inbox fix — the Super Admin detail routes audit SUCCESSFUL access only. UNIT layer:
// the gate, the reads and the audit writer are doubles (the writer itself is pinned in
// whatsappInboxRoutingFix.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ─── Route wiring ─────────────────────────────────────────────────────────────

describe('Super Admin detail routes audit successful access only', () => {
  const g = vi.hoisted(() => ({ admin: 'admin1' as string | null, found: true, audits: [] as unknown[] }))

  beforeEach(() => { g.admin = 'admin1'; g.found = true; g.audits = [] })

  vi.mock('@/lib/whatsapp-inbox/adminAuthz', () => ({
    authorizeSuperAdminInbox: async () => g.admin
      ? { ok: true, adminUid: g.admin }
      : { ok: false, response: NextResponse.json({ success: false, error: 'Super Admin access is required.' }, { status: 403 }) },
  }))
  vi.mock('@/lib/whatsapp-inbox/adminRead', () => ({
    getAdminConversation: async () => g.found
      ? { status: 'ok', conversation: { id: 'c1', organizerUid: 'org', eventId: 'ev' }, messages: [], olderCursor: null }
      : { status: 'not_found' },
    markAdminConversationRead: async () => g.found ? 'ok' : 'not_found',
    getUnmatched: async () => g.found ? { status: 'ok', item: { id: 'u1', reason: 'no_candidates' }, evidence: {} } : { status: 'not_found' },
  }))
  vi.mock('@/lib/whatsapp-inbox/adminAudit', () => ({
    auditInboxAccess: async (a: unknown) => { g.audits.push(a); return 'recorded' },
  }))

  const req = (path: string, method = 'GET') => new NextRequest(`https://rd.test${path}`, { method, headers: { authorization: 'Bearer t' } })
  const p = <T,>(v: T) => ({ params: Promise.resolve(v) })

  it('conversation view → audited with ids only', async () => {
    const { GET } = await import('@/app/api/admin/whatsapp-inbox/conversations/[conversationId]/route')
    expect((await GET(req('/x'), p({ conversationId: 'c1' }))).status).toBe(200)
    expect(g.audits).toEqual([{ adminUid: 'admin1', action: 'whatsapp_inbox.conversation_viewed', entityType: 'whatsapp_conversation', entityId: 'c1', metadata: { organizerUid: 'org', eventId: 'ev' } }])
  })

  it('mark-read and unmatched view → audited', async () => {
    const read = await import('@/app/api/admin/whatsapp-inbox/conversations/[conversationId]/read/route')
    const um   = await import('@/app/api/admin/whatsapp-inbox/unmatched/[inboundId]/route')
    expect((await read.POST(req('/x', 'POST'), p({ conversationId: 'c1' }))).status).toBe(200)
    expect((await um.GET(req('/x'), p({ inboundId: 'u1' }))).status).toBe(200)
    expect(g.audits).toMatchObject([
      { action: 'whatsapp_inbox.conversation_marked_read', entityId: 'c1' },
      { action: 'whatsapp_inbox.unmatched_viewed', entityId: 'u1', metadata: { reason: 'no_candidates' } },
    ])
  })

  it('a refused caller or a missing item writes no audit row', async () => {
    const { GET } = await import('@/app/api/admin/whatsapp-inbox/conversations/[conversationId]/route')
    g.admin = null
    expect((await GET(req('/x'), p({ conversationId: 'c1' }))).status).toBe(403)
    g.admin = 'admin1'; g.found = false
    expect((await GET(req('/x'), p({ conversationId: 'nope' }))).status).toBe(404)
    expect(g.audits).toEqual([])
  })
})
