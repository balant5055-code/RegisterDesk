// WhatsApp Inbox (Phase 1c) — Super Admin authorization, isolation and wiring contracts.
//
// The emulator suite proves the admin API's behaviour against real Firestore. This file
// pins what a later edit could quietly undo:
//   • the gate is resolveSuperAdminUid (NOT resolveAdminUid), fails closed, and leaks nothing;
//   • every admin route passes through that gate before anything else;
//   • the cross-organizer read module is reachable from the admin routes ONLY;
//   • the Super Admin's read state never writes the organizer's, and the unmatched queue is
//     read-only — no reassignment, no re-routing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const T = vi.hoisted(() => ({ superUid: null as string | null, calls: [] as (string | null)[] }))
vi.mock('@/lib/admin/auth', () => ({
  resolveSuperAdminUid: async (header: string | null) => { T.calls.push(header); return T.superUid },
  resolveAdminUid:      async () => { throw new Error('resolveAdminUid must not be used by the WhatsApp Inbox') },
}))

import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { ADMIN_SIDEBAR_NAV, ROUTES } from '@/config/navigation'
import { UNROUTED_REASON_LABELS } from '@/lib/whatsapp-inbox/types'

const ROOT = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Line comments first: a line comment can contain "/*" (e.g. a route glob), which would
// otherwise open a block-comment match and swallow real code.
const code = (p: string) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

function files(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...files(rel, match))
    else if (match(name)) out.push(rel)
  }
  return out
}

const req = (auth?: string) => new Request('http://localhost/api/admin/whatsapp-inbox/conversations', {
  headers: auth ? { authorization: auth } : {},
})

describe('authorizeSuperAdminInbox', () => {
  beforeEach(() => { T.superUid = null; T.calls = [] })

  it('no token → 401, and the resolver is never asked', async () => {
    const r = await authorizeSuperAdminInbox(req())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(401)
    expect(await r.response.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(T.calls).toEqual([])
  })

  it('a valid token that is not a Super Admin (e.g. an organizer, or a claim-only admin) → 403, no data', async () => {
    const r = await authorizeSuperAdminInbox(req('Bearer organizer-token'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(403)
    expect(await r.response.json()).toEqual({ success: false, error: 'Super Admin access is required.' })
    expect(r.response.headers.get('cache-control')).toBe('no-store')
    expect(T.calls).toEqual(['Bearer organizer-token'])
  })

  it('a Super Admin passes with their uid', async () => {
    T.superUid = 'super-1'
    expect(await authorizeSuperAdminInbox(req('Bearer ok'))).toEqual({ ok: true, adminUid: 'super-1' })
  })

  it('uses resolveSuperAdminUid and is NOT tied to the organizer feature flag', () => {
    const src = code('lib/whatsapp-inbox/adminAuthz.ts')
    expect(src).toContain('resolveSuperAdminUid')
    expect(src).not.toMatch(/resolveAdminUid|getFeatureFlags|authorizeWorkspace/)
  })
})

describe('admin routes', () => {
  const routes = files('app/api/admin/whatsapp-inbox', n => n === 'route.ts').sort()

  it('are exactly the seven Phase 1c routes', () => {
    expect(routes).toEqual([
      'app/api/admin/whatsapp-inbox/conversations/[conversationId]/read/route.ts',
      'app/api/admin/whatsapp-inbox/conversations/[conversationId]/route.ts',
      'app/api/admin/whatsapp-inbox/conversations/route.ts',
      'app/api/admin/whatsapp-inbox/facets/route.ts',
      'app/api/admin/whatsapp-inbox/summary/route.ts',
      'app/api/admin/whatsapp-inbox/unmatched/[inboundId]/route.ts',
      'app/api/admin/whatsapp-inbox/unmatched/route.ts',
    ])
  })

  it.each(routes)('%s gates on the Super Admin before doing anything', r => {
    const src  = code(r)
    const body = src.slice(src.search(/export async function (GET|POST)/))
    const gate = body.indexOf('await authorizeSuperAdminInbox(req)')
    expect(gate).toBeGreaterThan(0)
    expect(body.indexOf('if (!gate.ok) return gate.response')).toBeGreaterThan(gate)
    expect(src).not.toMatch(/resolveAdminUid|authorizeInbox\(|authorizeWorkspace/)
    // Nothing before the gate touches data.
    expect(body.slice(0, gate)).not.toMatch(/adminDb|listAdmin|getAdmin|getUnmatched|listUnmatched|adminInbox/)
  })

  it('the unmatched list refuses an unknown reason instead of querying with it', () => {
    expect(code('app/api/admin/whatsapp-inbox/unmatched/route.ts')).toMatch(/hasOwnProperty\.call\(UNROUTED_REASON_LABELS, rawReason\)[\s\S]*status: 400/)
  })

  it('every routing reason has a label (the reason filter is exhaustive)', () => {
    expect(Object.keys(UNROUTED_REASON_LABELS).sort()).toEqual([
      'ambiguous_event', 'ambiguous_organizer', 'context_conflict', 'context_incomplete',
      'context_organizer_notification', 'context_phone_mismatch', 'foreign_number',
      'invalid_phone', 'no_candidates', 'processing_failed',
    ])
  })
})

describe('organizer isolation', () => {
  it('the cross-organizer read module is imported by the admin routes ONLY', () => {
    const importers = [...files('app', n => /\.tsx?$/.test(n)), ...files('lib', n => /\.tsx?$/.test(n)), ...files('components', n => /\.tsx?$/.test(n))]
      .filter(f => /whatsapp-inbox\/adminRead['"]/.test(read(f)))
    expect(importers.length).toBeGreaterThan(0)
    for (const f of importers) expect(f.startsWith('app/api/admin/whatsapp-inbox/'), f).toBe(true)
  })

  it('organizer inbox routes never reach the admin module or the admin gate', () => {
    for (const f of files('app/api/organizer/whatsapp-inbox', n => n === 'route.ts')) {
      expect(read(f), f).not.toMatch(/adminRead|adminAuthz|resolveSuperAdminUid/)
    }
  })
})

describe('data integrity', () => {
  const admin = code('lib/whatsapp-inbox/adminRead.ts')

  it("Super Admin mark-read writes only the admin's read state", () => {
    const fn = admin.slice(admin.indexOf('export async function markAdminConversationRead'), admin.indexOf('export async function adminInboxSummary'))
    expect(fn).toContain('adminUnreadCount: 0, adminUnread: false')
    expect(fn).not.toMatch(/\bunreadCount:|\bunread:|lastReadAt:|lastReadByUid:/)
  })

  it("the organizer's mark-read never touches the admin's state", () => {
    const org = code('lib/whatsapp-inbox/read.ts')
    const fn = org.slice(org.indexOf('export async function markConversationRead'))
    expect(fn).not.toMatch(/adminUnread/)
  })

  it('routing raises BOTH read states for every new inbound message', () => {
    const persist = code('lib/whatsapp-inbox/persist.ts')
    expect(persist.match(/adminUnread:\s+true/g)?.length).toBe(2)          // existing + new conversation
    expect(persist).toContain('adminUnreadCount: FieldValue.increment(1)')
  })

  it('the unmatched queue is read-only — no write to a receipt, no re-route, no reassignment', () => {
    expect(admin).not.toMatch(/routeInboundMessage|resolveInboundRoute|recordInboundMessages/)
    const inboundWrites = admin.match(/collection\(WHATSAPP_INBOUND\)[^\n]*\.(set|update|delete|create)\(/g)
    expect(inboundWrites).toBeNull()
    expect(admin).not.toMatch(/txn\.(set|create|delete)\(/)
    expect(admin.match(/txn\.update\(/g)?.length).toBe(1)                   // the admin read state only
  })

  it("other people's phone numbers in routing evidence are masked", () => {
    expect(admin).toContain('recipientPhone:  str(log.recipientPhone) ? maskPhone(String(log.recipientPhone)) : null')
    expect(admin).toContain('phone:         str(r.attendee?.phone) ? maskPhone(String(r.attendee.phone)) : null')
  })
})

describe('admin UI', () => {
  const ui = code('app/(admin)/admin/whatsapp-inbox/PageClient.tsx')

  it('has no reply composer and makes no write but the admin mark-read', () => {
    expect(ui).not.toMatch(/ComingSoonComposer|<textarea|sendText|sendTemplate/)
    expect(ui.match(/method: '(POST|PUT|PATCH|DELETE)'/g)).toEqual(["method: 'POST'"])
    expect(ui).toMatch(/\/api\/admin\/whatsapp-inbox\/conversations\/\$\{encodeURIComponent\(id\)\}\/read`, \{ method: 'POST' \}/)
    expect(ui).toContain('Coming Soon')
  })

  it('stops polling once the caller is refused', () => {
    expect(ui).toContain('if (forbidden) return')
    expect(ui).toContain('}, [loadSummary, forbidden])')
  })

  it('calls admin APIs only', () => {
    const apis = [...ui.matchAll(/['`](\/api\/[^'`?$]+)/g)].map(m => m[1])
    expect(apis.length).toBeGreaterThan(0)
    for (const a of apis) expect(a.startsWith('/api/admin/whatsapp-inbox/'), a).toBe(true)
  })

  it('reuses the shared inbox parts rather than copying them', () => {
    expect(ui).toContain("from '@/components/whatsapp-inbox/InboxParts'")
    expect(ui).not.toMatch(/function (ConversationRow|Thread|MessageBody)\(/)
  })

  it('is in the admin sidebar (and so the ⌘K palette)', () => {
    expect(ROUTES.ADMIN_WHATSAPP_INBOX).toBe('/admin/whatsapp-inbox')
    expect(ADMIN_SIDEBAR_NAV.flatMap(g => g.items).some(i => i.href === '/admin/whatsapp-inbox')).toBe(true)
  })
})
