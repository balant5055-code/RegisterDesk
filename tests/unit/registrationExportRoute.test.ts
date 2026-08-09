// RD-REGISTRATIONS-DATA-AND-EXPORT — the export ROUTE.
//
// Exercises the real handler with Firebase Admin and the workspace authorizer stubbed,
// so CSV bytes, the XLSX package and the filter behaviour are asserted end-to-end without
// an emulator. Complements registrationExportColumns.test.ts, which pins the definition.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Stubs ─────────────────────────────────────────────────────────────────────
const state = {
  authorized:  true,
  workspaceUid: 'org-1',
  draftExists: true,
  docs:        [] as Array<{ id: string; data: Record<string, unknown> }>,
}
/** Every `.where()` the handler pushed to Firestore, so query-level filters are visible. */
const wheres: Array<[string, string, unknown]> = []

function makeQuery() {
  const q: Record<string, unknown> = {}
  q.where = (f: string, op: string, v: unknown) => { wheres.push([f, op, v]); return q }
  q.orderBy = () => q
  q.limit = () => q
  q.startAfter = () => ({ ...q, __after: true, get: async () => ({ empty: true, docs: [] }) })
  q.get = async () => ({
    empty: state.docs.length === 0,
    docs:  state.docs.map(d => ({ id: d.id, data: () => d.data })),
  })
  return q
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    doc: () => ({
      get: async () => ({
        exists: state.draftExists,
        data: () => ({
          eventDetails: { seo: { urlSlug: 'noyyal-marathon-2026' } },
          registrationForm: {
            sections: [{ fields: [
              { id: 'f_diet', label: 'Dietary Preference' },
              { id: 'f_club', label: 'Running Club' },
            ] }],
          },
        }),
      }),
    }),
    collection: () => makeQuery(),
  },
}))

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspaceDownload: async () => state.authorized
    ? { ok: true,  workspaceUid: state.workspaceUid, status: 200, error: '' }
    : { ok: false, workspaceUid: '', status: 403, error: 'Missing required permission: registrations.' },
}))

import { GET } from '@/app/api/organizer/events/[eventId]/registrations/export/route'

const PAID = {
  id: 'reg-1', eventSlug: 'noyyal-marathon-2026', eventName: 'Noyyal Marathon 2026',
  passName: '42K', status: 'confirmed', paymentStatus: 'paid',
  amount: 149000, originalAmount: 199000, discountAmount: 50000, couponCode: 'EARLYBIRD',
  paymentId: 'pay_QxKf82hAsdLm01', razorpayOrderId: 'order_QxKf7wVv11Aa22',
  refundId: 'rfnd_A1', refundAmount: 149000,
  ticketCode: 'NYM-4K72-QH19', checkedIn: true, checkedInBy: 'op-9', checkedInSource: 'qr',
  emailStatus: 'sent',
  attendee: {
    name: 'அருண் Prakash', email: 'arun@example.test', phone: '+919812345678',
    formResponses: { f_diet: 'Vegetarian', f_club: 'Kovai Runners' },
  },
}
const FREE = {
  id: 'reg-2', eventSlug: 'noyyal-marathon-2026', passName: 'Volunteer',
  status: 'confirmed', paymentStatus: 'not_required', amount: 0,
  ticketCode: 'NYM-0001-AAAA',
  attendee: { name: 'Priya R', email: 'priya@example.test' },
  // NOTE: no `checkedIn` key at all — the paid path never writes it. The "not checked in"
  // filter must still find this row.
}

const ctx = () => ({ params: Promise.resolve({ eventId: 'draft-abc123' }) })
const url = (qs = '') => new NextRequest(`http://localhost/api/organizer/events/draft-abc123/registrations/export${qs}`)

beforeEach(() => {
  state.authorized = true
  state.draftExists = true
  state.docs = [{ id: 'reg-1', data: PAID }, { id: 'reg-2', data: FREE }]
  wheres.length = 0
})

// ─── CSV ──────────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('is served as CSV with a .csv filename', async () => {
    const res = await GET(url(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    expect(res.headers.get('Content-Disposition')).toContain('.csv')
  })

  it('leads with a UTF-8 BOM so Excel renders Tamil and ₹ correctly', async () => {
    // Asserted on the raw BYTES: Response.text() performs a WHATWG utf-8 decode, which
    // strips a leading BOM, so a text-level assertion here would always fail even when
    // the file Excel receives is correct.
    const buf = Buffer.from(await (await GET(url(), ctx())).arrayBuffer())
    expect([buf[0], buf[1], buf[2]]).toEqual([0xEF, 0xBB, 0xBF])
  })

  it('preserves Unicode attendee data', async () => {
    const text = await (await GET(url(), ctx())).text()
    expect(text).toContain('அருண் Prakash')
  })

  it('contains the canonical financial headers that were previously absent', async () => {
    const header = (await (await GET(url(), ctx())).text()).split('\r\n')[0]
    for (const h of [
      'Payment ID', 'Razorpay Order ID', 'Amount', 'Original Amount',
      'Discount Amount', 'Coupon Code', 'Refund Status', 'Refund Amount', 'Refund ID',
    ]) expect(header, `missing header: ${h}`).toContain(h)
  })

  it('contains the actual payment and order identifiers', async () => {
    const text = await (await GET(url(), ctx())).text()
    expect(text).toContain('pay_QxKf82hAsdLm01')
    expect(text).toContain('order_QxKf7wVv11Aa22')
  })

  it('writes money as rupee numbers, not paise and not ₹-formatted text', async () => {
    const text = await (await GET(url(), ctx())).text()
    expect(text).toContain('1490')       // 149000 paise
    expect(text).not.toContain('149000')
  })

  it('contains coupon, discount and refund values', async () => {
    const text = await (await GET(url(), ctx())).text()
    expect(text).toContain('EARLYBIRD')
    expect(text).toContain('rfnd_A1')
    expect(text).toContain('Refunded')
  })

  it('contains ALL custom form fields, including ones the old regexes dropped', async () => {
    const text = await (await GET(url(), ctx())).text()
    expect(text).toContain('Dietary Preference')
    expect(text).toContain('Running Club')
    expect(text).toContain('Vegetarian')
    expect(text).toContain('Kovai Runners')
  })

  it('leaves a free registration\'s payment cells empty rather than zeroed', async () => {
    state.docs = [{ id: 'reg-2', data: FREE }]
    const rows = (await (await GET(url(), ctx())).text()).split('\r\n')
    expect(rows[1]).toContain('Priya R')
    expect(rows[1]).not.toContain('pay_')
    expect(rows[1]).not.toContain('₹')
  })
})

// ─── XLSX ─────────────────────────────────────────────────────────────────────

describe('XLSX export', () => {
  it('is served as a real .xlsx package', async () => {
    const res = await GET(url('?format=xlsx'), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml.sheet')
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx')
  })

  it('produces a valid ZIP container (PK signature + workbook parts)', async () => {
    const buf = Buffer.from(await (await GET(url('?format=xlsx'), ctx())).arrayBuffer())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    const all = buf.toString('latin1')
    expect(all).toContain('xl/workbook.xml')
    expect(all).toContain('xl/worksheets/sheet1.xml')
  })

  it('keeps amounts NUMERIC (no inline-string type on the money cell)', async () => {
    const xml = Buffer.from(await (await GET(url('?format=xlsx'), ctx())).arrayBuffer()).toString('latin1')
    // A numeric cell is written as <v>1490</v> with no t="inlineStr" attribute.
    expect(xml).toContain('<v>1490</v>')
  })

  it('preserves Unicode in the sheet', async () => {
    const buf = Buffer.from(await (await GET(url('?format=xlsx'), ctx())).arrayBuffer())
    expect(buf.toString('utf8')).toContain('அருண் Prakash')
  })

  it('carries the same canonical columns as the CSV', async () => {
    const xml = Buffer.from(await (await GET(url('?format=xlsx'), ctx())).arrayBuffer()).toString('utf8')
    for (const h of ['Payment ID', 'Razorpay Order ID', 'Dietary Preference', 'Refund ID']) {
      expect(xml, `missing column: ${h}`).toContain(h)
    }
  })
})

// ─── Filters ──────────────────────────────────────────────────────────────────

describe('filters narrow the exported set', () => {
  it('pushes status / payment / pass to Firestore', async () => {
    await GET(url('?status=confirmed&payment=paid&passId=p1'), ctx())
    expect(wheres).toEqual(expect.arrayContaining([
      ['status', '==', 'confirmed'],
      ['paymentStatus', '==', 'paid'],
      ['passId', '==', 'p1'],
    ]))
  })

  it('scopes every query to the caller and the resolved event', async () => {
    await GET(url(), ctx())
    expect(wheres).toEqual(expect.arrayContaining([
      ['organizerUid', '==', 'org-1'],
      ['eventSlug', '==', 'noyyal-marathon-2026'],
    ]))
  })

  it('q now excludes non-matching rows (it was previously ignored entirely)', async () => {
    const text = await (await GET(url('?q=Priya'), ctx())).text()
    expect(text).toContain('Priya R')
    expect(text).not.toContain('அருண் Prakash')
  })

  it('q matches on payment id, so a reconciliation lookup exports one row', async () => {
    const text = await (await GET(url('?q=pay_QxKf82hAsdLm01'), ctx())).text()
    expect(text).toContain('reg-1')
    expect(text).not.toContain('Priya R')
  })

  it('checkin=yes is a server-side equality filter', async () => {
    await GET(url('?checkin=yes'), ctx())
    expect(wheres).toEqual(expect.arrayContaining([['checkedIn', '==', true]]))
  })

  it('checkin=no keeps a record that has NO checkedIn field at all', async () => {
    // The regression this guards: `where('checkedIn','==',false)` drops documents missing
    // the field — which is every registration created by the paid Razorpay path.
    const text = await (await GET(url('?checkin=no'), ctx())).text()
    expect(text).toContain('Priya R')          // never checked in, field absent
    expect(text).not.toContain('அருண் Prakash') // checkedIn: true
    expect(wheres.find(w => w[0] === 'checkedIn')).toBeUndefined()
  })
})

// ─── Security ─────────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('an unauthorized caller gets 403 and no data', async () => {
    state.authorized = false
    const res = await GET(url(), ctx())
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('pay_')
  })

  it('the same guard protects XLSX', async () => {
    state.authorized = false
    expect((await GET(url('?format=xlsx'), ctx())).status).toBe(403)
  })

  it('another organizer\'s eventId 404s — the draft read IS the ownership check', async () => {
    state.draftExists = false
    const res = await GET(url(), ctx())
    expect(res.status).toBe(404)
    expect(wheres).toHaveLength(0)       // no registration query ever ran
  })
})
