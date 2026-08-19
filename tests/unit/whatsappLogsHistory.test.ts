// RD-WA-LOGS-03 · message-level WhatsApp history — pagination, filters and isolation.
//
// WHAT THIS PROTECTS. This screen reads `emailLogs`, a collection that grows with every
// message ever sent — one row per recipient per broadcast. The failure mode is not a wrong
// number on screen, it is a query that reads the whole collection: unbounded, or offset-paged
// (which bills every skipped document), or "fetch everything and filter in React". So the
// properties asserted here are about the QUERY, not the rendering:
//
//   1. The server decides the page size. A client asking for 10 000 gets the cap.
//   2. Paging is cursor-based (startAfter a snapshot), never offset.
//   3. Every filter is a WHERE clause, so rows the organizer will not see are never read.
//   4. organizerUid + channel are on the query itself — another workspace's rows are not
//      fetched at all, so they cannot leak even if something downstream is wrong.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Doc = Record<string, unknown>
const UID = 'organizer-1'

let rows: Doc[] = []
let authOk = true
/** Every where() the route applied, so filtering is asserted on the QUERY, not the result. */
let applied: Array<[string, string, unknown]> = []
let appliedLimit: number | null = null
let startedAfter: string | null = null
let cursorDoc: Doc | null = null

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOk
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      const q = {
        where: (f: string, op: string, v: unknown) => { applied.push([f, op, v]); return q },
        orderBy: () => q,
        limit: (n: number) => { appliedLimit = n; return q },
        startAfter: (d: { id: string }) => { startedAfter = d.id; return q },
        get: async () => ({
          empty: rows.length === 0,
          size:  rows.length,
          docs:  rows.map(r => ({ id: r.id as string, data: () => r })),
        }),
        // Cursor resolution reads the single anchor document by id.
        doc: () => ({
          get: async () => ({
            exists: !!cursorDoc,
            id: (cursorDoc?.id as string) ?? 'c',
            data: () => cursorDoc,
          }),
        }),
      }
      return q
    },
  },
}))

const { GET, WA_LOGS_MAX_PAGE, WA_LOGS_DEFAULT_PAGE, BROADCAST_TEMPLATE_KEY } =
  await import('@/app/api/organizer/whatsapp-logs/route')

const row = (over: Doc = {}): Doc => ({
  id: 'log-1', organizerUid: UID, channel: 'whatsapp',
  eventId: 'evt-1', eventSlug: 'noyyal-marathon-2026', eventName: 'Noyyal Marathon',
  templateKey: 'registration_confirmation',
  recipientPhone: '+919000000000', recipientName: 'Arun Kumar', recipientEmail: 'a@x.com',
  status: 'sent', provider: 'meta', registrationId: 'reg-1', costPaise: 0,
  createdAt: { toDate: () => new Date('2026-08-19T15:12:00Z') },
  updatedAt: { toDate: () => new Date('2026-08-19T15:12:00Z') },
  ...over,
})

const call = (qs = '') => GET(new NextRequest(`http://x/api/organizer/whatsapp-logs${qs}`, {
  headers: { Authorization: 'Bearer t' },
}))

type Body = {
  success: boolean
  items?: Array<Record<string, unknown>>
  nextCursor?: string | null
  hasMore?: boolean
  error?: string
}
const body = async (qs = '') => (await call(qs)).json() as Promise<Body>

beforeEach(() => {
  rows = []; authOk = true; applied = []; appliedLimit = null; startedAfter = null; cursorDoc = null
})

// ─── Page size ────────────────────────────────────────────────────────────────

describe('the server owns the page size', () => {
  it('defaults to WA_LOGS_DEFAULT_PAGE', async () => {
    rows = [row()]
    await call()
    // limit+1 is fetched to detect a further page without a second query.
    expect(appliedLimit).toBe(WA_LOGS_DEFAULT_PAGE + 1)
  })

  it('CLAMPS an oversized client limit — an arbitrary number is never trusted', async () => {
    rows = [row()]
    await call('?limit=10000')
    expect(appliedLimit).toBe(WA_LOGS_MAX_PAGE + 1)
  })

  it('rejects a nonsense limit rather than issuing an unbounded query', async () => {
    rows = [row()]
    await call('?limit=abc')
    expect(appliedLimit).toBe(WA_LOGS_DEFAULT_PAGE + 1)
    await call('?limit=-5')
    expect(appliedLimit).toBe(2)   // clamped to a minimum of 1 (+1 look-ahead)
  })

  it('returns at most `limit` items even when more are fetched', async () => {
    rows = Array.from({ length: 12 }, (_, i) => row({ id: `l${i}` }))
    const b = await body('?limit=5')
    expect(b.items).toHaveLength(5)
  })

  it('NEVER issues a query without a limit', async () => {
    rows = [row()]
    await call()
    expect(appliedLimit).not.toBeNull()
    expect(appliedLimit).toBeLessThanOrEqual(WA_LOGS_MAX_PAGE + 1)
  })
})

// ─── Cursor pagination ────────────────────────────────────────────────────────

describe('paging is cursor-based, never offset', () => {
  it('returns nextCursor + hasMore when a further page exists', async () => {
    rows = Array.from({ length: 6 }, (_, i) => row({ id: `l${i}` }))
    const b = await body('?limit=5')
    expect(b.hasMore).toBe(true)
    expect(b.nextCursor).toBe('l4')          // last row of the returned page
  })

  it('reports the end of the data honestly', async () => {
    rows = [row({ id: 'only' })]
    const b = await body('?limit=5')
    expect(b.hasMore).toBe(false)
    expect(b.nextCursor).toBeNull()
  })

  it('startAfter()s the cursor document — no offset skipping', async () => {
    cursorDoc = row({ id: 'l4' })
    rows = [row({ id: 'l5' })]
    await call('?limit=5&cursor=l4')
    expect(startedAfter).toBe('l4')
  })

  it('REFUSES a cursor belonging to another workspace', async () => {
    cursorDoc = row({ id: 'other', organizerUid: 'someone-else' })
    rows = [row()]
    await call('?cursor=other')
    // The foreign cursor is ignored rather than honoured: paging restarts, it does not
    // become a way to read from another organizer's position in the collection.
    expect(startedAfter).toBeNull()
  })
})

// ─── Filters are WHERE clauses ────────────────────────────────────────────────

describe('every filter is applied server-side', () => {
  const has = (f: string, v: unknown) => applied.some(([ff, , vv]) => ff === f && vv === v)

  it('always scopes to this organizer AND the whatsapp channel', async () => {
    rows = [row()]
    await call()
    expect(has('organizerUid', UID)).toBe(true)
    expect(has('channel', 'whatsapp')).toBe(true)
  })

  it('status', async () => {
    rows = [row()]
    await call('?status=failed')
    expect(has('status', 'failed')).toBe(true)
  })

  it('event', async () => {
    rows = [row()]
    await call('?eventSlug=noyyal-marathon-2026')
    expect(has('eventSlug', 'noyyal-marathon-2026')).toBe(true)
  })

  it('template', async () => {
    rows = [row()]
    await call('?templateKey=registration_confirmation')
    expect(has('templateKey', 'registration_confirmation')).toBe(true)
  })

  it('campaign', async () => {
    rows = [row()]
    await call('?campaignId=camp-1')
    expect(has('campaignId', 'camp-1')).toBe(true)
  })

  it('type=broadcast is an indexed equality on templateKey', async () => {
    rows = [row()]
    await call('?type=broadcast')
    expect(has('templateKey', BROADCAST_TEMPLATE_KEY)).toBe(true)
  })

  it('date range is applied as createdAt bounds', async () => {
    rows = [row()]
    await call('?dateFrom=2026-08-01&dateTo=2026-08-19')
    const ops = applied.filter(([f]) => f === 'createdAt').map(([, op]) => op)
    expect(ops).toContain('>=')
    expect(ops).toContain('<=')
  })

  it('type=transactional EXCLUDES broadcast rows (server-side refinement)', async () => {
    // Firestore cannot express "not broadcast" alongside a createdAt ordering, so the route
    // refines within a bounded scan. What matters is that the client never receives the rows.
    rows = [
      row({ id: 'a', templateKey: 'registration_confirmation' }),
      row({ id: 'b', templateKey: BROADCAST_TEMPLATE_KEY }),
      row({ id: 'c', templateKey: 'certificate_ready' }),
    ]
    const b = await body('?type=transactional&limit=10')
    expect(b.items?.map(i => i.id)).toEqual(['a', 'c'])
  })
})

// ─── Rows the organizer must be able to act on ────────────────────────────────

describe('failed and broadcast messages are visible and traceable', () => {
  it('a failed broadcast row surfaces its Meta reason and campaign', async () => {
    rows = [row({
      id: 'f1', status: 'failed', templateKey: BROADCAST_TEMPLATE_KEY, campaignId: 'camp-9',
      error: 'WhatsApp template is missing or not approved',
      providerResponse: 'HTTP 404 · code 132001 · Template name does not exist',
    })]
    const b = await body()
    const it0 = b.items?.[0] as Record<string, unknown>
    expect(it0.status).toBe('failed')
    expect(it0.error).toBe('WhatsApp template is missing or not approved')
    expect(it0.campaignId).toBe('camp-9')
    expect(it0.errorCode).toBe(132001)
  })

  it('a transactional row carries no campaign, which is how the two are told apart', async () => {
    rows = [row({ templateKey: 'registration_confirmation' })]
    const b = await body()
    expect((b.items?.[0] as Record<string, unknown>).campaignId).toBeNull()
  })

  it('retry eligibility is unchanged — still failed/wallet-skipped registration rows only', async () => {
    rows = [
      row({ id: 'r1', status: 'failed', templateKey: 'registration_confirmation' }),
      row({ id: 'r2', status: 'failed', templateKey: BROADCAST_TEMPLATE_KEY }),
      row({ id: 'r3', status: 'sent' }),
    ]
    const b = await body()
    expect(b.items?.map(i => i.retryAvailable)).toEqual([true, false, false])
  })
})

// ─── Isolation + empty ────────────────────────────────────────────────────────

describe('security and edge states', () => {
  it('an unauthorized caller is refused', async () => {
    authOk = false
    rows = [row()]
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('the organizer scope is a WHERE clause, not a post-read filter', async () => {
    rows = [row()]
    await call()
    // If this were applied after reading, another workspace's documents would have been
    // fetched (and billed) before being discarded.
    expect(applied[0][0]).toBe('organizerUid')
    expect(applied[0][2]).toBe(UID)
  })

  it('an empty result is a clean empty page, not an error', async () => {
    rows = []
    const b = await body()
    expect(b.success).toBe(true)
    expect(b.items).toEqual([])
    expect(b.hasMore).toBe(false)
    expect(b.nextCursor).toBeNull()
  })
})

// ─── The client must not be able to reintroduce a full read ───────────────────

describe('the client cannot download everything', () => {

  const src = readFileSync(
    resolve(process.cwd(), 'app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx'),
    'utf8',
  )

  it('sends every filter to the server rather than narrowing locally', () => {
    for (const f of ['status', 'type', 'eventSlug', 'dateFrom', 'dateTo']) {
      expect(src, f).toContain(`params.set('${f}'`)
    }
  })

  it('asks for more only via the server cursor', () => {
    expect(src).toContain("params.set('cursor'")
    expect(src).toContain('void load(nextCursor)')
  })

  it('never sends a limit of its own', () => {
    expect(src).not.toMatch(/params\.set\('limit'/)
  })

  it('appends a cursor page instead of refetching everything', () => {
    expect(src).toContain('setLogs(prev => (cursor ? [...prev, ...page] : page))')
  })
})
