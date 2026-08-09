// RD-EMAIL-PROVIDER — the ADMIN-ONLY write endpoint.
//
// PATCH /api/admin/events/[slug]/email-provider is the ONLY path that may write
// events/{slug}.emailProvider. These tests pin the four things that make that safe:
//
//   • non-admins get 403 and write nothing
//   • the body is an enum or a 400 — never a credential, URL or arbitrary provider
//   • a missing event is a 404, not an accidental document creation
//   • the write is a single-FIELD update(), never a document-replacing set()
//
// Firebase Admin and the admin auth resolver are stubbed, so this runs in the `node`
// environment with no emulator and no credentials.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Stubs ─────────────────────────────────────────────────────────────────────
const state = {
  adminUid: null as string | null,
  exists:   true,
  data:     {} as Record<string, unknown>,
}
const updateSpy = vi.fn(async () => undefined)
const setSpy    = vi.fn(async () => undefined)
const auditSpy  = vi.fn(async () => undefined)
const docSpy    = vi.fn()

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        docSpy(name, id)
        return {
          get:    async () => ({ exists: state.exists, data: () => (state.exists ? state.data : undefined) }),
          update: updateSpy,
          set:    setSpy,
        }
      },
    }),
  },
}))

vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid: async () => state.adminUid,
}))

vi.mock('@/lib/admin/audit', () => ({
  logAdminAction: (...args: unknown[]) => { auditSpy(...(args as [])); return Promise.resolve() },
}))

import { PATCH } from '@/app/api/admin/events/[slug]/email-provider/route'

const ctx = (slug = 'marathon-2026') => ({ params: Promise.resolve({ slug }) })

function req(body: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/admin/events/marathon-2026/email-provider', {
    method:  'PATCH',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body:    raw ?? JSON.stringify(body),
  })
}

beforeEach(() => {
  state.adminUid = 'admin-1'
  state.exists   = true
  state.data     = {}
  updateSpy.mockClear(); setSpy.mockClear(); auditSpy.mockClear(); docSpy.mockClear()
})

// ─── E/F · Accepts exactly the two providers ──────────────────────────────────

describe('E/F · an admin can select either provider', () => {
  it('accepts "ses" and writes it', async () => {
    const res = await PATCH(req({ emailProvider: 'ses' }), ctx())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ slug: 'marathon-2026', emailProvider: 'ses' })
    expect(updateSpy).toHaveBeenCalledWith({ emailProvider: 'ses' })
  })

  it('accepts "resend" and writes it', async () => {
    const res = await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ emailProvider: 'resend' })
  })

  it('writes ONLY that one field — nothing else in the event is touched', async () => {
    await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(Object.keys(updateSpy.mock.calls[0][0] as object)).toEqual(['emailProvider'])
  })

  it('uses update(), never set() — a set() here would destroy the event document', async () => {
    await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('writes to the events collection, scoped to the requested slug only', async () => {
    await PATCH(req({ emailProvider: 'resend' }), ctx('some-other-event'))
    expect(docSpy).toHaveBeenCalledWith('events', 'some-other-event')
    expect(docSpy).toHaveBeenCalledTimes(1)
  })

  it('audits the transition, reporting a legacy event honestly as coming from ses', async () => {
    state.data = {}                                    // no stored value
    await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
      action:     'event.email_provider_changed',
      entityType: 'event',
      entityId:   'marathon-2026',
      metadata:   { from: 'ses', to: 'resend' },
    }))
  })
})

// ─── G · Rejects everything else ──────────────────────────────────────────────

describe('G · the body is an enum or a 400', () => {
  it.each([
    ['an unknown provider',   { emailProvider: 'sendgrid' }],
    ['an empty string',       { emailProvider: '' }],
    ['wrong case',            { emailProvider: 'RESEND' }],
    ['padded whitespace',     { emailProvider: ' resend ' }],
    ['a missing key',         {}],
    ['null',                  { emailProvider: null }],
    ['a number',              { emailProvider: 1 }],
    ['a boolean',             { emailProvider: true }],
    ['an array',              { emailProvider: ['resend'] }],
    ['an object',             { emailProvider: { name: 'resend' } }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await PATCH(req(body), ctx())
    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('rejects a credential-shaped payload without ever reading it', async () => {
    // Provider secrets are server-side only; the API surface must give a caller no way
    // to supply one, not even to have it ignored.
    const res = await PATCH(req({ emailProvider: 'resend', apiKey: 're_live_secret' }), ctx())
    expect(res.status).toBe(200)                              // the enum is still valid…
    expect(updateSpy).toHaveBeenCalledWith({ emailProvider: 'resend' })   // …and apiKey is dropped
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await PATCH(req(null, '{not json'), ctx())
    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

// ─── H · Authorization ────────────────────────────────────────────────────────

describe('H · only an admin may write', () => {
  it('a non-admin gets 403 and writes nothing', async () => {
    state.adminUid = null
    const res = await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('authorization is checked BEFORE the event is read', async () => {
    state.adminUid = null
    await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(docSpy).not.toHaveBeenCalled()
  })

  it('a non-admin with a perfectly valid body is still refused', async () => {
    state.adminUid = null
    const res = await PATCH(req({ emailProvider: 'ses' }), ctx())
    expect(res.status).toBe(403)
    expect(auditSpy).not.toHaveBeenCalled()
  })
})

// ─── Missing event ────────────────────────────────────────────────────────────

describe('a missing event is a 404, never an implicit create', () => {
  it('returns 404 and does not write', async () => {
    state.exists = false
    const res = await PATCH(req({ emailProvider: 'resend' }), ctx())
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(setSpy).not.toHaveBeenCalled()
  })
})
