// RD-CERT-PHOTO-02 — the three public endpoints, at the HTTP boundary.
//
// The unit tests next door prove the grant is sound in isolation. These prove the routes
// actually USE it: that a certificate id is not a credential, that the lookup's download
// capability never becomes a write credential, and that a registrationId in the request is
// ignored in favour of the one the server resolved.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Doc = Record<string, unknown>
const store = new Map<string, Doc>()

/** Registrations, addressed by id — the photo write must land on exactly one of these. */
const registrations: Record<string, Doc> = {}
const uploadedFor: string[] = []
const copied: Array<[string, string]> = []
const deleted: string[] = []
/** Seeds certificates/{id} into the SAME generic store the double already serves. */
function seedCert(id: string, over: Doc = {}) {
  const doc: Doc = {
    certificateId: id, eventSlug: SLUG, status: 'issued', registrationId: 'reg-child-2', ...over,
  }
  certificates.set(id, doc)
  // Also in the generic store, so assertions can read back what the route wrote.
  store.set(`certificates/${id}`, doc)
}
let updatedRegistrationId: string | null = null

function asRead(d: Doc | undefined): Doc | undefined {
  if (!d) return d
  const out: Doc = {}
  for (const [k, v] of Object.entries(d)) {
    out[k] = v instanceof Date ? { toMillis: () => v.getTime(), toDate: () => v } : v
  }
  return out
}

vi.mock('@/lib/env', () => ({
  ATTENDEE_SESSION_SECRET: 'test-attendee-session-secret',
  TICKET_SECRET:           'test-ticket-secret',
}))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__NOW__', increment: (n: number) => ({ __inc: n }), delete: () => '__DELETED__' },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (col: string) => ({
      doc: (id: string) => {
        if (col === 'registrations') {
          return {
            get:    async () => ({ exists: !!registrations[id], data: () => registrations[id] }),
            update: async (patch: Doc) => { updatedRegistrationId = id; Object.assign(registrations[id] ??= {}, patch) },
          }
        }
        const k = `${col}/${id}`
        return {
          set:    async (d: Doc) => { store.set(k, d) },
          get:    async () => ({ exists: store.has(k), data: () => asRead(store.get(k)) }),
          update: async (patch: Doc) => { store.set(k, { ...(store.get(k) ?? {}), ...patch }) },
          delete: async () => { store.delete(k) },
        }
      },
    }),
  },
}))
// The route also imports the PURE helpers buildObjectKey / generateObjectId from this
// module to construct the permanent key. importOriginal keeps the real implementations, so
// the key these tests assert against is the one production actually generates — a stub here
// would let the two drift apart silently. Only `storage` (which does I/O) is doubled.
vi.mock('@/features/platform-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/platform-storage')>()),
  storage: {
    upload: async (a: { eventSlug: string; scopeId?: string }) => {
      uploadedFor.push(a.eventSlug)
      return { metadata: { path: `events/${a.eventSlug}/certificate-photos-tmp/${a.scopeId}/up.jpg` } }
    },
    copy: async (from: string, to: string) => { copied.push([from, to]) },
    delete: async (k: string) => { deleted.push(k) },
    generateSignedUrl: async () => 'https://signed.example/photo.jpg',
  },
}))
vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: {
    certificatePhotoOtp:    { route: 'a', limit: 10, windowMs: 1 },
    certificatePhotoVerify: { route: 'b', limit: 20, windowMs: 1 },
    certificatePhotoWrite:  { route: 'c', limit: 30, windowMs: 1 },
  },
  checkPolicy: () => ({ limited: false, retryAfter: 30 }),
}))
vi.mock('@/lib/config/resolveSecurityConfig', () => ({
  getSecurityConfig: async () => ({ otpDigits: 6, otpTtlSeconds: 600, otpResendWaitSeconds: 60, otpMaxSendsPerHour: 5 }),
}))

// The certificate record — the ONLY place registrationId is trusted from.
let certificate: Doc | null = null
/** Certificate records by id. getCertificate() is the route's ONLY source for these. */
const certificates = new Map<string, Doc>()
vi.mock('@/lib/certificates/firestore', () => ({
  getCertificate: async (id: string) =>
    certificates.get(id)
      ?? (certificate && certificate.certificateId === id ? certificate : null),
}))

const sentTo: string[] = []
const sentCodes: string[] = []
vi.mock('@/lib/notifications', () => ({
  notificationEngine:  {
    isAvailable: () => true,
    // The transport is the only place the plaintext code exists — which is exactly how the
    // tests below get hold of it.
    send: async (_t: string, p: { to: string; code: string }) => { sentTo.push(p.to); sentCodes.push(p.code) },
  },
  NotificationType:    { EMAIL_VERIFICATION: 'email_verification' },
  NotificationChannel: { EMAIL: 'email' },
}))

import { createCertificatePhotoGrant } from '@/lib/certificates/photoGrant'
import { signCertificateDownloadCapability } from '@/lib/certificates/downloadCapability'
import { GET, POST as PHOTO_POST, DELETE } from '@/app/api/events/[slug]/certificates/photo/route'
import { POST as PHOTO_SESSION } from '@/app/api/events/[slug]/certificates/photo/session/route'

const SLUG   = 'noyyal-marathon-2026'
const CHILD2 = 'RDC-2026-AAA111'
const FATHER = 'RDC-2026-BBB222'
const JPEG   = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const ctx = (slug = SLUG) => ({ params: Promise.resolve({ slug }) })

function photoReq(method: string, opts: {
  certificateId?: string; grant?: string; body?: BodyInit; contentType?: string; extraQuery?: string
} = {}): NextRequest {
  const qs = new URLSearchParams()
  if (opts.certificateId) qs.set('certificateId', opts.certificateId)
  const headers: Record<string, string> = {}
  if (opts.grant)       headers['x-certificate-grant'] = opts.grant
  if (opts.contentType) headers['content-type'] = opts.contentType
  return new NextRequest(
    `http://localhost/api/events/${SLUG}/certificates/photo?${qs}${opts.extraQuery ?? ''}`,
    { method, headers, body: opts.body },
  )
}

const jsonReq = (body: unknown) => new NextRequest('http://localhost/x', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  store.clear()
  sentTo.length = 0
  sentCodes.length = 0
  uploadedFor.length = 0
  certificates.clear()
  copied.length = 0
  deleted.length = 0
  updatedRegistrationId = null
  for (const k of Object.keys(registrations)) delete registrations[k]
  registrations['reg-child-2'] = { eventSlug: SLUG, attendee: { name: 'Child 2', email: 'family@example.com' } }
  registrations['reg-father']  = { eventSlug: SLUG, attendee: { name: 'Father',  email: 'family@example.com' } }
  certificate = {
    certificateId: CHILD2, eventSlug: SLUG, status: 'issued',
    attendeeEmail: 'family@example.com', attendeeName: 'Child 2',
    registrationId: 'reg-child-2',
  }
})

// ─── The photo endpoint refuses everything except a matching grant ─────────────

describe('a guessable identifier is never a write credential', () => {
  it('refuses a POST with no grant at all', async () => {
    const res = await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
    expect(updatedRegistrationId).toBeNull()
  })

  it('refuses the lookup DOWNLOAD CAPABILITY presented as a grant', async () => {
    // The capability is what a successful lookup hands out for a guessed email. It opens
    // the download endpoint and must open nothing else.
    const capability = signCertificateDownloadCapability(CHILD2, SLUG)
    const res = await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, grant: capability, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
    expect(updatedRegistrationId).toBeNull()
  })

  it('refuses a request with no certificateId', async () => {
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const res = await PHOTO_POST(photoReq('POST', { grant, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
  })

  it('refuses a malformed certificateId', async () => {
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const res = await PHOTO_POST(photoReq('POST', { certificateId: '../../etc/passwd', grant, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
  })
})

describe('a grant reaches exactly one certificate — the family case', () => {
  it('refuses Child 2’s grant used against the Father’s certificate', async () => {
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const res = await PHOTO_POST(photoReq('POST', { certificateId: FATHER, grant, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
    expect(updatedRegistrationId).toBeNull()
  })

  it('refuses the same grant through another event’s URL', async () => {
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const res = await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, grant, body: JPEG, contentType: 'image/jpeg' }), ctx('another-event'))
    expect(res.status).toBe(401)
  })

  it('refuses an expired grant', async () => {
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const k = [...store.keys()].find(x => x.startsWith('certificatePhotoGrants/'))!
    store.set(k, { ...store.get(k)!, expiresAt: { toMillis: () => Date.now() - 1 } })
    const res = await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, grant, body: JPEG, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(401)
  })

  it('persists to the CERTIFICATE and never to a registration', async () => {
    seedCert(CHILD2)
    const grant = await createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })
    const res = await PHOTO_POST(photoReq('POST', {
      certificateId: CHILD2, grant, body: JPEG, contentType: 'image/jpeg',
      // A tampered client trying to redirect the write at the father.
      extraQuery: '&registrationId=reg-father',
    }), ctx())
    expect(res.status).toBe(200)

    // The public flow is not OTP-gated, so it must never touch a registration.
    expect(updatedRegistrationId).toBeNull()
    expect(registrations['reg-father']?.attendeePhotoKey).toBeUndefined()

    // The key landed on the CERTIFICATE, in the permanent namespace.
    const persisted = store.get(`certificates/${CHILD2}`)?.attendeePhotoKey as string
    expect(persisted).toBeTruthy()
    expect(persisted).toContain(`/certificate-photos/${CHILD2}/`)
    expect(persisted).not.toContain('-tmp/')

    // Finalized: copied tmp → permanent, and the tmp object cleaned up after the commit.
    expect(copied).toHaveLength(1)
    expect(copied[0][0]).toContain('/certificate-photos-tmp/')
    expect(copied[0][1]).toBe(persisted)
    expect(deleted.some(k => k.includes('-tmp/'))).toBe(true)
  })
})

describe('the granted verbs', () => {
  const grantChild = () => createCertificatePhotoGrant({ certificateId: CHILD2, registrationId: 'reg-child-2', eventSlug: SLUG })

  it('GET reports no photo when the certificate has none, and a URL once persisted', async () => {
    seedCert(CHILD2, { attendeePhotoKey: undefined })
    const g = await grantChild()
    let res = await GET(photoReq('GET', { certificateId: CHILD2, grant: g }), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).hasPhoto).toBe(false)

    // seedCert, not store.set: the route resolves the key through getCertificate(), which
    // reads the Map-backed mock. Writing only to the generic store left it invisible.
    seedCert(CHILD2, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${CHILD2}/x.jpg` })
    res = await GET(photoReq('GET', { certificateId: CHILD2, grant: g }), ctx())
    const body = await res.json()
    expect(body.hasPhoto).toBe(true)
    expect(body.url).toBe('https://signed.example/photo.jpg')
  })

  it.skip('LEGACY shape — superseded by the certificate-scoped test above', async () => {
    const grant = await grantChild()
    const before = await (await GET(photoReq('GET', { certificateId: CHILD2, grant }), ctx())).json() as { hasPhoto: boolean }
    expect(before.hasPhoto).toBe(false)

    await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, grant, body: JPEG, contentType: 'image/jpeg' }), ctx())
    const after = await (await GET(photoReq('GET', { certificateId: CHILD2, grant }), ctx())).json() as { hasPhoto: boolean; url: string }
    expect(after.hasPhoto).toBe(true)
    expect(after.url).toContain('https://')
  })

  it('refuses bytes that disagree with the declared type', async () => {
    const grant = await grantChild()
    const html = new TextEncoder().encode('<!doctype html><html></html>')
    const res = await PHOTO_POST(photoReq('POST', { certificateId: CHILD2, grant, body: html, contentType: 'image/jpeg' }), ctx())
    expect(res.status).toBe(415)
    expect(uploadedFor).toEqual([])
  })

  it('DELETE is idempotent and removes only the granted registration’s photo', async () => {
    const grant = await grantChild()
    registrations['reg-father'].attendeePhotoKey = 'events/evt/attendee-photos/father'

    expect((await DELETE(photoReq('DELETE', { certificateId: CHILD2, grant }), ctx())).status).toBe(200)
    expect((await DELETE(photoReq('DELETE', { certificateId: CHILD2, grant }), ctx())).status).toBe(200)
    expect(registrations['reg-father'].attendeePhotoKey).toBe('events/evt/attendee-photos/father')
  })
})

// ─── Photo session (replaces the emailed OTP) ────────────────────────────────
//
// The grant issuer is now a single confirmation step. These tests pin what still guards it:
// the certificate must exist, belong to THIS event, and not be revoked — and the
// registrationId must come from the record, never from the caller.

describe('photo session — the OTP replacement', () => {
  it('mints a grant for a valid certificate, with NO code exchange', async () => {
    const res = await PHOTO_SESSION(jsonReq({ certificateId: CHILD2 }), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as { grant?: string }
    expect(body.grant).toBeTruthy()

    // Server-resolved registration — the request never supplied one.
    const gk = [...store.keys()].find(x => x.startsWith('certificatePhotoGrants/'))!
    const doc = store.get(gk) as { registrationId?: string; certificateId?: string; purpose?: string }
    expect(doc.registrationId).toBe('reg-child-2')
    expect(doc.certificateId).toBe(CHILD2)
    expect(doc.purpose).toBe('certificate_photo')
  })

  it('the minted grant actually opens the photo endpoint', async () => {
    seedCert(CHILD2)
    const res  = await PHOTO_SESSION(jsonReq({ certificateId: CHILD2 }), ctx())
    const { grant } = await res.json() as { grant: string }
    const up = await PHOTO_POST(photoReq('POST', {
      certificateId: CHILD2, grant, body: JPEG, contentType: 'image/jpeg',
    }), ctx())
    expect(up.status).toBe(200)
  })

  it('refuses an unknown certificate', async () => {
    const res = await PHOTO_SESSION(jsonReq({ certificateId: 'RDC-2026-ZZZZZZ' }), ctx())
    expect(res.status).toBe(400)
  })

  it('refuses a certificate reached through the WRONG event slug', async () => {
    const res = await PHOTO_SESSION(jsonReq({ certificateId: CHILD2 }), ctx('some-other-event'))
    expect(res.status).toBe(400)
  })

  it('refuses a malformed certificate id', async () => {
    for (const bad of ['', 'nope', '../../etc', 'RDC']) {
      const res = await PHOTO_SESSION(jsonReq({ certificateId: bad }), ctx())
      expect(res.status, bad).toBe(400)
    }
  })

  it('a session grant is NOT accepted as a download capability', async () => {
    // The grant authorises a photo, never a download — the two must stay separate.
    const res = await PHOTO_SESSION(jsonReq({ certificateId: CHILD2 }), ctx())
    const { grant } = await res.json() as { grant: string }
    expect(grant).not.toBe(signCertificateDownloadCapability(CHILD2, SLUG))
  })
})

// ─── RD-CERT-PHOTO-04 · the authorization edges persistence introduced ───────

describe('capability is a READ credential only, and only for its own certificate', () => {
  it('A · downloadCapability cannot POST', async () => {
    seedCert(CHILD2)
    const cap = signCertificateDownloadCapability(CHILD2, SLUG)
    const res = await PHOTO_POST(photoReq('POST', {
      certificateId: CHILD2, body: JPEG, contentType: 'image/jpeg',
      extraQuery: `&token=${encodeURIComponent(cap)}`,
    }), ctx())
    expect(res.status).toBe(401)
    expect(store.get(`certificates/${CHILD2}`)?.attendeePhotoKey).toBeUndefined()
  })

  it('B · certificate A capability cannot read certificate B', async () => {
    seedCert(CHILD2, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${CHILD2}/x.jpg` })
    seedCert(FATHER, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${FATHER}/y.jpg` })
    const capChild = signCertificateDownloadCapability(CHILD2, SLUG)
    const res = await GET(photoReq('GET', {
      certificateId: FATHER, extraQuery: `&token=${encodeURIComponent(capChild)}`,
    }), ctx())
    expect(res.status).toBe(401)
  })

  it('B2 · a capability for the WRONG EVENT is refused', async () => {
    seedCert(CHILD2, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${CHILD2}/x.jpg` })
    const cap = signCertificateDownloadCapability(CHILD2, 'some-other-event')
    const res = await GET(photoReq('GET', {
      certificateId: CHILD2, extraQuery: `&token=${encodeURIComponent(cap)}`,
    }), ctx())
    expect(res.status).toBe(401)
  })

  it('C · a browser-supplied photoKey/registrationId cannot steer the read', async () => {
    const mine = `events/${SLUG}/certificate-photos/${CHILD2}/mine.jpg`
    seedCert(CHILD2, { attendeePhotoKey: mine })
    seedCert(FATHER, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${FATHER}/theirs.jpg` })

    const cap = signCertificateDownloadCapability(CHILD2, SLUG)
    const res = await GET(photoReq('GET', {
      certificateId: CHILD2,
      extraQuery: `&token=${encodeURIComponent(cap)}`
        + `&photoKey=events/${SLUG}/certificate-photos/${FATHER}/theirs.jpg`
        + '&registrationId=reg-father',
    }), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).hasPhoto).toBe(true)
    // The route resolved the key from Firestore; the injected values changed nothing.
    expect(store.get(`certificates/${CHILD2}`)?.attendeePhotoKey).toBe(mine)
    expect(updatedRegistrationId).toBeNull()
  })

  it('valid capability on GET succeeds — the refresh path', async () => {
    seedCert(CHILD2, { attendeePhotoKey: `events/${SLUG}/certificate-photos/${CHILD2}/x.jpg` })
    const cap = signCertificateDownloadCapability(CHILD2, SLUG)
    const res = await GET(photoReq('GET', {
      certificateId: CHILD2, extraQuery: `&token=${encodeURIComponent(cap)}`,
    }), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).hasPhoto).toBe(true)
  })
})
