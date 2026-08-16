// RD-WA-LOGS-01 · the WhatsApp Logs list endpoint, and what it must never leak.
//
// WhatsApp rows share the `emailLogs` collection with email, discriminated by `channel`.
// Two properties carry the risk and are asserted head-on:
//
//   1. EQUALITY IS SAFE, INEQUALITY IS NOT. `channel == 'whatsapp'` is complete because every
//      WhatsApp writer sets the field. The email route may NOT use `!=` to exclude them:
//      Firestore inequality drops documents MISSING the field, and most legacy email rows
//      have no `channel` at all — the query would hide the entire email history. That is why
//      the email side filters in memory, pinned in whatsappLogsEmailUnaffected.test.ts.
//   2. DIAGNOSTICS ARE SANITISED. This page is the one surface that shows provider text to a
//      user, so a credential-shaped substring must be redacted at the boundary rather than
//      trusted not to exist upstream.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Doc = Record<string, unknown>

const UID = 'organizer-1'
let rows: Doc[] = []
let authOk = true
const appliedFilters: Array<[string, unknown]> = []

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOk
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))

// A fake Firestore that RECORDS the filters, so "queried by channel equality" is a positive
// assertion about the query rather than an inference from the returned rows.
vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      const q = {
        where: (f: string, _op: string, v: unknown) => { appliedFilters.push([f, v]); return q },
        orderBy: () => q,
        limit: () => q,
        get: async () => ({ docs: rows.map(r => ({ id: r.id as string, data: () => r })) }),
      }
      return q
    },
  },
}))

const { GET } = await import('@/app/api/organizer/whatsapp-logs/route')

const req = (qs = '') => new NextRequest(`http://x/api/organizer/whatsapp-logs${qs}`, {
  headers: { Authorization: 'Bearer t' },
})

const waRow = (over: Doc = {}): Doc => ({
  id: 'log-1', organizerUid: UID, channel: 'whatsapp',
  eventId: 'evt-1', eventSlug: 'evt-1', eventName: 'VANATHUKKUL NOYYAL MARATHON',
  templateKey: 'registration_confirmation',
  recipientPhone: '+919080452223', recipientName: 'Balaganapathy NT',
  status: 'failed', provider: 'meta', registrationId: 'reg-1', costPaise: 0,
  providerResponse: 'HTTP 404 · code 132001 · (#132001) Template name does not exist in the translation',
  error: 'WhatsApp template is missing or not approved',
  createdAt: { toDate: () => new Date('2026-08-16T08:32:00Z') },
  updatedAt: { toDate: () => new Date('2026-08-16T08:32:00Z') },
  ...over,
})

beforeEach(() => { rows = []; authOk = true; appliedFilters.length = 0 })

describe('scoping', () => {
  it('queries by organizer AND channel equality — never an inequality', async () => {
    rows = [waRow()]
    await GET(req())

    expect(appliedFilters).toContainEqual(['organizerUid', UID])
    expect(appliedFilters).toContainEqual(['channel', 'whatsapp'])
  })

  it('refuses an unauthorized caller', async () => {
    authOk = false
    expect((await GET(req())).status).toBe(403)
  })

  it('passes through status and template filters', async () => {
    await GET(req('?status=failed&templateKey=registration_confirmation'))
    expect(appliedFilters).toContainEqual(['status', 'failed'])
    expect(appliedFilters).toContainEqual(['templateKey', 'registration_confirmation'])
  })
})

describe('projection — the fields the email route strips', () => {
  it('returns phone, cost, provider diagnostics and delivery state', async () => {
    rows = [waRow({ costPaise: 35, waStatus: 'failed', providerMessageId: 'wamid.X' })]

    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }
    const log = body.logs[0]

    expect(log.recipientPhone).toBe('+919080452223')
    expect(log.costPaise).toBe(35)
    expect(log.waStatus).toBe('failed')
    expect(log.providerMessageId).toBe('wamid.X')
    expect(log.registrationId).toBe('reg-1')
  })

  it('parses the Meta error code and HTTP status out of the stored diagnostics', async () => {
    rows = [waRow()]
    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }

    expect(body.logs[0].errorCode).toBe(132001)
    expect(body.logs[0].httpStatus).toBe(404)
    expect(body.logs[0].error).toBe('WhatsApp template is missing or not approved')
  })

  it('resolves the template name and locale from the registry, not from the row', async () => {
    rows = [waRow()]
    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }

    expect(body.logs[0].templateName).toBe('registration_confirmation')
    // The locale fix that made these sends work at all.
    expect(body.logs[0].templateLanguage).toBe('en')
  })
})

describe('retryAvailable', () => {
  it('is true only for a failed registration_confirmation with a registration', async () => {
    rows = [waRow()]
    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }
    expect(body.logs[0].retryAvailable).toBe(true)
  })

  it.each([
    ['already sent',      { status: 'sent' }],
    ['delivered',         { status: 'delivered' }],
    ['skipped',           { status: 'skipped' }],
    ['queued (in flight)',{ status: 'queued' }],
    ['other template',    { templateKey: 'broadcast' }],
    ['no registration',   { registrationId: '' }],
  ])('is false for %s', async (_label, over) => {
    rows = [waRow(over)]
    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }
    expect(body.logs[0].retryAvailable).toBe(false)
  })
})

describe('secret safety', () => {
  it('redacts credential-shaped text from providerResponse', async () => {
    rows = [waRow({
      providerResponse: 'HTTP 401 · code 190 · request failed Authorization: Bearer EAAGm0PX4ZCpsBO1234567890abcdefg',
    })]

    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }
    const resp = String(body.logs[0].providerResponse)

    expect(resp).not.toMatch(/EAAGm0PX4ZCpsBO/)
    expect(resp).not.toMatch(/Bearer\s+\S+/)
    expect(resp).toContain('[redacted]')
    // ...while keeping the part that actually helps the organizer.
    expect(resp).toContain('code 190')
  })

  it('never emits a raw access_token or app_secret value', async () => {
    rows = [waRow({ providerResponse: 'code 1 · access_token=SECRETVALUE123 app_secret: OTHERSECRET456' })]

    const raw = JSON.stringify(await (await GET(req())).json())
    expect(raw).not.toContain('SECRETVALUE123')
    expect(raw).not.toContain('OTHERSECRET456')
  })

  it('clamps an oversized diagnostic rather than streaming a payload dump', async () => {
    rows = [waRow({ providerResponse: `code 1 · ${'x'.repeat(5000)}` })]
    const body = await (await GET(req())).json() as { logs: Record<string, unknown>[] }
    expect(String(body.logs[0].providerResponse).length).toBeLessThanOrEqual(301)
  })
})
