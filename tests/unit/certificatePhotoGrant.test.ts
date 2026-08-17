// RD-CERT-PHOTO-02 — the grant, and the OTP that mints it.
//
// This is the ONLY mechanism that turns a guessable public identifier (an email, a mobile
// number, a bib, a certificate id) into permission to WRITE. Every test here is a negative
// one, because the failure mode is not "the photo doesn't appear" — it is "a stranger
// attached a photograph to someone else's certificate".

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Firestore double ─────────────────────────────────────────────────────────
type Doc = Record<string, unknown>
const store = new Map<string, Doc>()
let deletedIds: string[] = []

vi.mock('@/lib/env', () => ({ ATTENDEE_SESSION_SECRET: 'test-attendee-session-secret' }))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__NOW__', increment: (n: number) => ({ __inc: n }) },
}))
/** Firestore hands back Timestamps for the Dates it was given — the production code reads
 *  `.toMillis()`, so a double that returned raw Dates would test the wrong thing. */
function asRead(d: Doc | undefined): Doc | undefined {
  if (!d) return d
  const out: Doc = {}
  for (const [k, v] of Object.entries(d)) {
    out[k] = v instanceof Date ? { toMillis: () => v.getTime(), toDate: () => v } : v
  }
  return out
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (col: string) => ({
      doc: (id: string) => {
        const k = `${col}/${id}`
        return {
          set:    async (d: Doc) => { store.set(k, d) },
          get:    async () => ({ exists: store.has(k), data: () => asRead(store.get(k)) }),
          update: async (patch: Doc) => {
            const cur = store.get(k) ?? {}
            for (const [f, v] of Object.entries(patch)) {
              const inc = (v as { __inc?: number })?.__inc
              cur[f] = typeof inc === 'number' ? ((cur[f] as number) ?? 0) + inc : v
            }
            store.set(k, cur)
          },
          delete: async () => { deletedIds.push(id); store.delete(k) },
        }
      },
    }),
  },
}))

// getSecurityConfig is policy, not crypto — pinned so the assertions are deterministic.
vi.mock('@/lib/config/resolveSecurityConfig', () => ({
  getSecurityConfig: async () => ({
    otpDigits: 6, otpTtlSeconds: 600, otpResendWaitSeconds: 60, otpMaxSendsPerHour: 5,
  }),
}))

import {
  createCertificatePhotoGrant, verifyCertificatePhotoGrant, revokeCertificatePhotoGrant,
  GRANT_TTL_MS,
} from '@/lib/certificates/photoGrant'

const CERT  = 'RDC-2026-AAA111'
const OTHER = 'RDC-2026-BBB222'
const SLUG  = 'noyyal-marathon-2026'

/** Child 2's certificate → Child 2's registration. The father shares the email. */
const CHILD2 = { certificateId: CERT, registrationId: 'reg-child-2', eventSlug: SLUG }

beforeEach(() => { store.clear(); deletedIds = [] })

// ─── The grant ────────────────────────────────────────────────────────────────

describe('a grant authorizes exactly ONE certificate', () => {
  it('verifies for the certificate and event it was minted for', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    const g = await verifyCertificatePhotoGrant(token, CERT, SLUG)
    expect(g).toEqual(CHILD2)
  })

  it('REFUSES another certificate — the family case', async () => {
    // Father, Child 1 and Child 2 share one email and one mobile number. A grant obtained
    // for Child 2 must not reach any of the others.
    const token = await createCertificatePhotoGrant(CHILD2)
    expect(await verifyCertificatePhotoGrant(token, OTHER, SLUG)).toBeNull()
  })

  it('REFUSES the same certificate reached through another event', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    expect(await verifyCertificatePhotoGrant(token, CERT, 'another-event')).toBeNull()
  })

  it('resolves the registration SERVER-SIDE — the token itself carries no id', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    // The browser holds this string. If it contained the registration id, the brief's
    // "must not be able to modify its contents" would rest on obscurity alone.
    expect(token).not.toContain('reg-child-2')
    expect(Buffer.from(token, 'base64').toString('utf8')).not.toContain('reg-child-2')
    expect(token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/)
  })
})

describe('forgery and replay', () => {
  it('refuses a token whose id was tampered with', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    const [id, sig] = token.split('.')
    const flipped = (id[0] === 'a' ? 'b' : 'a') + id.slice(1)
    expect(await verifyCertificatePhotoGrant(`${flipped}.${sig}`, CERT, SLUG)).toBeNull()
  })

  it('refuses a token whose signature was tampered with', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    const [id, sig] = token.split('.')
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(await verifyCertificatePhotoGrant(`${id}.${flipped}`, CERT, SLUG)).toBeNull()
  })

  it.each([
    ['empty',        ''],
    ['no signature', 'a'.repeat(64)],
    ['not hex',      `${'z'.repeat(64)}.${'z'.repeat(64)}`],
    ['a plausible download capability', '1893456000000.' + 'a'.repeat(64)],
  ])('refuses %s', async (_l, token) => {
    expect(await verifyCertificatePhotoGrant(token, CERT, SLUG)).toBeNull()
  })

  it('refuses an unsigned id that exists in the store', async () => {
    // Knowing a grant id is not enough; the HMAC is checked before any read.
    await createCertificatePhotoGrant(CHILD2)
    const id = [...store.keys()][0].split('/')[1]
    expect(await verifyCertificatePhotoGrant(id, CERT, SLUG)).toBeNull()
  })

  it('refuses a stored record whose purpose is not certificate_photo', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    const k = [...store.keys()][0]
    store.set(k, { ...store.get(k)!, purpose: 'attendee_session' })
    expect(await verifyCertificatePhotoGrant(token, CERT, SLUG)).toBeNull()
  })
})

describe('lifetime', () => {
  it('expires', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    const k = [...store.keys()][0]
    store.set(k, { ...store.get(k)!, expiresAt: { toMillis: () => Date.now() - 1 } })
    expect(await verifyCertificatePhotoGrant(token, CERT, SLUG)).toBeNull()
  })

  it('is short-lived by construction, not by convention', () => {
    // A 30-day attendee session would be the wrong tool; this is minutes, not weeks.
    expect(GRANT_TTL_MS).toBeLessThanOrEqual(60 * 60_000)
  })

  it('can be revoked before it expires', async () => {
    const token = await createCertificatePhotoGrant(CHILD2)
    await revokeCertificatePhotoGrant(token)
    expect(await verifyCertificatePhotoGrant(token, CERT, SLUG)).toBeNull()
  })

  it('revoking a forged token is a no-op, not a crash', async () => {
    await expect(revokeCertificatePhotoGrant('garbage')).resolves.toBeUndefined()
  })
})

describe('two family members hold two independent grants', () => {
  it('neither can act on the other', async () => {
    const father = await createCertificatePhotoGrant({ certificateId: OTHER, registrationId: 'reg-father', eventSlug: SLUG })
    const child  = await createCertificatePhotoGrant(CHILD2)

    expect((await verifyCertificatePhotoGrant(father, OTHER, SLUG))?.registrationId).toBe('reg-father')
    expect((await verifyCertificatePhotoGrant(child,  CERT,  SLUG))?.registrationId).toBe('reg-child-2')
    expect(await verifyCertificatePhotoGrant(father, CERT,  SLUG)).toBeNull()
    expect(await verifyCertificatePhotoGrant(child,  OTHER, SLUG)).toBeNull()
  })
})

// RD-CERT-PHOTO-03 — the OTP describes that lived here are gone with the flow itself.
// The grant is now minted by POST /photo/session after the attendee confirms which
// certificate is theirs; that issuer, and the fact it never writes a registration, are
// covered in certificatePhotoRoute.test.ts. Everything above — scope, forgery, replay,
// lifetime and family independence — is unchanged and still the security core.
