// RD-WA-LOGS-01 · Email Logs must shed WhatsApp rows WITHOUT losing legacy email rows.
//
// ═══ THE TRAP THIS FILE EXISTS TO PREVENT ════════════════════════════════════
// The obvious implementation is `where('channel','!=','whatsapp')`. It is wrong in a way that
// is invisible in a fresh test database: Firestore inequality filters EXCLUDE documents that
// do not have the field at all, and most historical email rows were written before `channel`
// existed. That query would silently empty the organizer's entire email history while looking
// perfectly correct.
//
// So the filter is in memory, and this asserts BOTH halves: WhatsApp rows are gone, and rows
// with a missing `channel` — the legacy shape — survive.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Doc = Record<string, unknown>

const UID = 'organizer-1'
let rows: Doc[] = []
const appliedFilters: Array<[string, string, unknown]> = []

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: UID }),
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      const q = {
        where: (f: string, op: string, v: unknown) => { appliedFilters.push([f, op, v]); return q },
        orderBy: () => q,
        limit: () => q,
        get: async () => ({ docs: rows.map(r => ({ id: r.id as string, data: () => r })) }),
      }
      return q
    },
  },
}))

const { GET } = await import('@/app/api/organizer/email-logs/route')

const req = () => new NextRequest('http://x/api/organizer/email-logs', {
  headers: { Authorization: 'Bearer t' },
})

const row = (id: string, over: Doc = {}): Doc => ({
  id, organizerUid: UID, eventId: 'evt-1', eventSlug: 'evt-1', eventName: 'Marathon',
  templateKey: 'registration_submitted', recipientEmail: 'a@b.c', recipientName: 'A',
  subject: 'Your ticket', status: 'sent', provider: 'ses', registrationId: 'reg-1',
  createdAt: { toDate: () => new Date('2026-08-16T08:00:00Z') },
  updatedAt: { toDate: () => new Date('2026-08-16T08:00:00Z') },
  ...over,
})

beforeEach(() => { rows = []; appliedFilters.length = 0 })

describe('Email Logs channel filtering', () => {
  it('LEGACY rows with NO channel field are still returned — the whole point', async () => {
    rows = [row('legacy-1'), row('legacy-2')]

    const body = await (await GET(req())).json() as { logs: { id: string }[] }
    expect(body.logs.map(l => l.id)).toEqual(['legacy-1', 'legacy-2'])
  })

  it('explicitly-tagged email rows are returned', async () => {
    rows = [row('email-1', { channel: 'email' })]

    const body = await (await GET(req())).json() as { logs: { id: string }[] }
    expect(body.logs.map(l => l.id)).toEqual(['email-1'])
  })

  it('WhatsApp rows are excluded', async () => {
    rows = [row('wa-1', { channel: 'whatsapp' }), row('email-1', { channel: 'email' })]

    const body = await (await GET(req())).json() as { logs: { id: string }[] }
    expect(body.logs.map(l => l.id)).toEqual(['email-1'])
  })

  it('a mixed page keeps both legacy and tagged email rows, drops only WhatsApp', async () => {
    rows = [
      row('legacy-1'),
      row('wa-1',    { channel: 'whatsapp' }),
      row('email-1', { channel: 'email' }),
      row('wa-2',    { channel: 'whatsapp' }),
    ]

    const body = await (await GET(req())).json() as { logs: { id: string }[]; total: number }
    expect(body.logs.map(l => l.id)).toEqual(['legacy-1', 'email-1'])
    expect(body.total).toBe(2)
  })

  it('NEVER issues a Firestore inequality on channel', async () => {
    rows = [row('legacy-1')]
    await GET(req())

    // The positive assertion: no `!=` (or any operator) was applied to `channel` at all.
    expect(appliedFilters.filter(([field]) => field === 'channel')).toEqual([])
  })
})
