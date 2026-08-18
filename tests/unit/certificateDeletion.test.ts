// RD-CERT-DELETE — permanent certificate deletion.
//
// This is the only irreversible operation an organizer can perform on a certificate, so the
// tests are written around what must NOT happen as much as what must:
//
//   • an id from another organizer or another event is refused ON ITS OWN ROW, without
//     aborting the rest of the batch
//   • the reservation claim is released — otherwise re-issuing inside the 15-minute claim TTL
//     returns the DELETED certificate's id and the attendee can never be re-issued
//   • the registration's own photo, the shared template, the job history and the wallet
//     ledger all survive, because none of them belong to the certificate
//   • an R2 failure is REPORTED, never swallowed, and never reported as a failed deletion
//
// The fake Firestore below is deliberately shared with the REAL `deleteGrantsForCertificate`
// and the REAL key builders: mocking those out would leave the two things most likely to
// drift — the grant query and the object-key format — untested.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── In-memory Firestore ──────────────────────────────────────────────────────

type Doc = Record<string, unknown>
const store = new Map<string, Map<string, Doc>>()
const col = (name: string): Map<string, Doc> => {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

let commitFails = false

interface Ref { _c: string; _id: string }
const makeRef = (c: string, id: string) => {
  const ref: Ref & Record<string, unknown> = { _c: c, _id: id }
  ref.get    = async () => snapOf(c, id, ref)
  ref.delete = async () => { col(c).delete(id) }
  ref.set    = async (d: Doc) => { col(c).set(id, { ...d }) }
  ref.update = async (d: Doc) => { col(c).set(id, { ...(col(c).get(id) ?? {}), ...d }) }
  return ref
}
const snapOf = (c: string, id: string, ref: unknown) => ({
  exists: col(c).has(id),
  id,
  ref,
  data: () => col(c).get(id),
})

const makeQuery = (c: string, preds: Array<[string, unknown]>) => ({
  where: (field: string, _op: string, value: unknown) => makeQuery(c, [...preds, [field, value]]),
  count: () => ({
    get: async () => ({ data: () => ({ count: rowsOf(c, preds).length }) }),
  }),
  get: async () => {
    const rows = rowsOf(c, preds)
    return { empty: rows.length === 0, size: rows.length, docs: rows }
  },
})
const rowsOf = (c: string, preds: Array<[string, unknown]>) =>
  [...col(c).entries()]
    .filter(([, d]) => preds.every(([f, v]) => d[f] === v))
    .map(([id]) => snapOf(c, id, makeRef(c, id)))

const adminDbMock = {
  collection: (name: string) => ({
    doc:   (id: string) => makeRef(name, id),
    where: (f: string, op: string, v: unknown) => makeQuery(name, []).where(f, op, v),
    count: () => makeQuery(name, []).count(),
  }),
  doc: (path: string) => {
    const parts = path.split('/')
    return makeRef(parts.slice(0, -1).join('/'), parts[parts.length - 1])
  },
  batch: () => {
    const ops: Array<() => void> = []
    return {
      delete: (ref: Ref) => { ops.push(() => col(ref._c).delete(ref._id)) },
      set:    (ref: Ref, d: Doc) => { ops.push(() => col(ref._c).set(ref._id, { ...d })) },
      commit: async () => {
        if (commitFails) throw new Error('Firestore unavailable')
        ops.forEach(f => f())
      },
    }
  },
  runTransaction: async <T,>(fn: (txn: unknown) => Promise<T>): Promise<T> => fn({
    get:    async (ref: Ref) => snapOf(ref._c, ref._id, ref),
    set:    (ref: Ref, d: Doc) => { col(ref._c).set(ref._id, { ...d }) },
    update: (ref: Ref, d: Doc) => { col(ref._c).set(ref._id, { ...(col(ref._c).get(ref._id) ?? {}), ...d }) },
    delete: (ref: Ref) => { col(ref._c).delete(ref._id) },
  }),
}

// The factory is hoisted above `adminDbMock`'s declaration, so the object cannot be handed
// over directly. A proxy defers every property lookup to call time, by which point the
// module body has run.
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: new Proxy({}, {
    get: (_t, prop: string) => (adminDbMock as unknown as Record<string, unknown>)[prop],
  }),
  adminAuth: {},
}))
vi.mock('@/lib/env', () => ({ ATTENDEE_SESSION_SECRET: 'test-secret-for-grant-hmac' }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: (...a: unknown[]) => { captured.push(a) } }))

const captured: unknown[][] = []

// ─── Billing configuration doubles (for the free-allowance loophole tests) ────

let freeAllowance = 0
vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({
    certificates: { pricePaise: 500, billingMode: 'wallet', walletBilling: true, freeAllowance },
  }),
}))
vi.mock('@/lib/wallet/resolveWalletConfig', () => ({
  getWalletConfig: async () => ({ allowNegativeBalance: true }),
}))
vi.mock('@/lib/firebase/firestore/wallet', () => ({ txnDeductWallet: () => {} }))

// ─── Object storage double ────────────────────────────────────────────────────

const deletedKeys: string[] = []
const failingKeys = new Set<string>()

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,   // keeps the REAL buildObjectKey, so key format is exercised, not invented
    storage: {
      delete: async (key: string) => {
        if (failingKeys.has(key)) throw new Error(`R2 unavailable for ${key}`)
        deletedKeys.push(key)
      },
    },
  }
})

import { deleteCertificates, MAX_DELETE_BATCH } from '@/lib/certificates/deletion'
import { certificateObjectKey } from '@/lib/certificates/artifact'
import { certificateClaimId } from '@/lib/certificates/id'
import { COLLECTIONS, LEGACY_CERTIFICATE_RECORDS } from '@/lib/certificates/constants'

const EVENT = 'draft-1'
const UID   = 'org-1'
const SLUG  = 'noyyal-marathon-2026'

interface SeedOpts {
  id?:        string
  uid?:       string
  eventId?:   string
  photoKey?:  string | null
  fileKey?:   string | null
  grants?:    Array<{ id: string; photoKey?: string }>
  legacy?:    boolean
  claim?:     boolean
}

function seedCertificate(o: SeedOpts = {}) {
  const id = o.id ?? 'RDC-2026-AB12CD'
  const registrationId = `reg-${id}`
  const certificateType = 'participation'

  col(COLLECTIONS.CERTIFICATES).set(id, {
    certificateId: id,
    eventId:       o.eventId ?? EVENT,
    eventSlug:     SLUG,
    organizerUid:  o.uid ?? UID,
    registrationId,
    certificateType,
    status:        'generated',
    fileKey:       o.fileKey === undefined ? `events/${SLUG}/certificates/${id}.pdf` : o.fileKey,
    ...(o.photoKey ? { attendeePhotoKey: o.photoKey } : {}),
  })

  if (o.claim !== false) {
    col(COLLECTIONS.CLAIMS).set(
      certificateClaimId(o.eventId ?? EVENT, registrationId, certificateType),
      { certificateId: id, registrationId },
    )
  }
  if (o.legacy) {
    col(LEGACY_CERTIFICATE_RECORDS).set(id, { certificateId: id, eventId: o.eventId ?? EVENT, organizerUid: o.uid ?? UID })
  }
  for (const g of o.grants ?? []) {
    col('certificatePhotoGrants').set(g.id, {
      certificateId: id, registrationId, eventSlug: SLUG,
      ...(g.photoKey ? { photoKey: g.photoKey } : {}),
    })
  }
  return { id, registrationId, certificateType }
}

beforeEach(() => {
  store.clear()
  deletedKeys.length = 0
  failingKeys.clear()
  captured.length = 0
  commitFails = false
  freeAllowance = 0
})

// ─── 1 · Authorization ────────────────────────────────────────────────────────

describe('authorization — the id is a lookup key, never authority', () => {
  it('refuses a certificate owned by another organizer', async () => {
    const { id } = seedCertificate({ uid: 'someone-else' })
    const r = await deleteCertificates(EVENT, [id], UID)

    expect(r.results[0].ok).toBe(false)
    expect(r.failed).toBe(1)
    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(true)   // still there
    expect(deletedKeys).toEqual([])                            // and no bytes touched
  })

  it('refuses a certificate belonging to a different event of the SAME organizer', async () => {
    // organizerUid alone would pass here — this is the half that stops an organizer
    // deleting their own certificate through the wrong event's endpoint.
    const { id } = seedCertificate({ eventId: 'draft-OTHER' })
    const r = await deleteCertificates(EVENT, [id], UID)

    expect(r.results[0].ok).toBe(false)
    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(true)
  })

  it('refuses a malformed id without touching storage', async () => {
    const r = await deleteCertificates(EVENT, ['../../etc/passwd'], UID)
    expect(r.results[0].ok).toBe(false)
    expect(r.results[0].error).toMatch(/Invalid/i)
    expect(deletedKeys).toEqual([])
  })

  it('one unauthorized id does not abort the rest of the batch', async () => {
    const mine = seedCertificate({ id: 'RDC-2026-MINE01' })
    const theirs = seedCertificate({ id: 'RDC-2026-THEM01', uid: 'someone-else' })

    const r = await deleteCertificates(EVENT, [theirs.id, mine.id], UID)

    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
    expect(col(COLLECTIONS.CERTIFICATES).has(mine.id)).toBe(false)
    expect(col(COLLECTIONS.CERTIFICATES).has(theirs.id)).toBe(true)
  })
})

// ─── 2 · Individual deletion + the full manifest ──────────────────────────────

describe('deleting one certificate removes everything it owns', () => {
  it('deletes the record, the claim, the legacy twin and the grants', async () => {
    const { id, registrationId, certificateType } = seedCertificate({
      legacy: true,
      grants: [{ id: 'grant-a', photoKey: `events/${SLUG}/certificate-photos-tmp/${'RDC-2026-AB12CD'}/a.jpg` }],
    })

    const r = await deleteCertificates(EVENT, [id], UID)

    expect(r.results[0].ok).toBe(true)
    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(false)
    expect(col(LEGACY_CERTIFICATE_RECORDS).has(id)).toBe(false)
    expect(col(COLLECTIONS.CLAIMS).has(certificateClaimId(EVENT, registrationId, certificateType))).toBe(false)
    expect(col('certificatePhotoGrants').size).toBe(0)
  })

  it('RELEASES THE CLAIM — without it, re-issuing inside the TTL is impossible', async () => {
    const { id, registrationId, certificateType } = seedCertificate()
    const claimKey = certificateClaimId(EVENT, registrationId, certificateType)
    expect(col(COLLECTIONS.CLAIMS).has(claimKey)).toBe(true)

    await deleteCertificates(EVENT, [id], UID)

    // reserveCertificateId would otherwise return owned:false with the DELETED id.
    expect(col(COLLECTIONS.CLAIMS).has(claimKey)).toBe(false)
  })

  it('deletes the canonical PDF at the real derived key', async () => {
    const { id } = seedCertificate()
    await deleteCertificates(EVENT, [id], UID)
    expect(deletedKeys).toContain(certificateObjectKey(SLUG, id))
  })

  it('reclaims the artifact even when fileKey was never written', async () => {
    // Upload succeeded, the pointer write did not — the object is unreferenced. Deriving the
    // key as well as reading it is what stops that object being stranded forever.
    const { id } = seedCertificate({ fileKey: null })
    await deleteCertificates(EVENT, [id], UID)
    expect(deletedKeys).toContain(certificateObjectKey(SLUG, id))
  })

  it('deletes the certificate-owned attendee photo', async () => {
    const photoKey = `events/${SLUG}/certificate-photos/RDC-2026-AB12CD/p.jpg`
    const { id } = seedCertificate({ photoKey })
    await deleteCertificates(EVENT, [id], UID)
    expect(deletedKeys).toContain(photoKey)
  })

  it('deletes TEMPORARY photos harvested from the grants', async () => {
    const tmpA = `events/${SLUG}/certificate-photos-tmp/RDC-2026-AB12CD/a.jpg`
    const tmpB = `events/${SLUG}/certificate-photos-tmp/RDC-2026-AB12CD/b.jpg`
    const { id } = seedCertificate({ grants: [{ id: 'g1', photoKey: tmpA }, { id: 'g2', photoKey: tmpB }] })

    await deleteCertificates(EVENT, [id], UID)

    expect(deletedKeys).toContain(tmpA)
    expect(deletedKeys).toContain(tmpB)
  })

  it('tolerates a grant that never uploaded a photo', async () => {
    const { id } = seedCertificate({ grants: [{ id: 'g-none' }] })
    const r = await deleteCertificates(EVENT, [id], UID)
    expect(r.results[0].ok).toBe(true)
    expect(col('certificatePhotoGrants').size).toBe(0)
  })

  it('deletes a legacy-only record that has no modern twin', async () => {
    col(LEGACY_CERTIFICATE_RECORDS).set('RDC-2026-LEGACY', { eventId: EVENT, organizerUid: UID })
    const r = await deleteCertificates(EVENT, ['RDC-2026-LEGACY'], UID)

    expect(r.results[0].ok).toBe(true)
    expect(col(LEGACY_CERTIFICATE_RECORDS).has('RDC-2026-LEGACY')).toBe(false)
  })

  it('refuses a legacy-only record owned by another organizer', async () => {
    col(LEGACY_CERTIFICATE_RECORDS).set('RDC-2026-LEGACY', { eventId: EVENT, organizerUid: 'someone-else' })
    const r = await deleteCertificates(EVENT, ['RDC-2026-LEGACY'], UID)

    expect(r.results[0].ok).toBe(false)
    expect(col(LEGACY_CERTIFICATE_RECORDS).has('RDC-2026-LEGACY')).toBe(true)
  })
})

// ─── 3 · What must survive ────────────────────────────────────────────────────

describe('deletion never reaches beyond the certificate', () => {
  it('leaves the registration and its OWN photo alone', async () => {
    col('registrations').set('reg-RDC-2026-AB12CD', {
      attendeePhotoKey: `events/${SLUG}/attendee-photos/reg-1.jpg`,
    })
    const { id } = seedCertificate({ photoKey: `events/${SLUG}/certificate-photos/x/p.jpg` })

    await deleteCertificates(EVENT, [id], UID)

    const reg = col('registrations').get('reg-RDC-2026-AB12CD')!
    expect(reg.attendeePhotoKey).toBe(`events/${SLUG}/attendee-photos/reg-1.jpg`)
    expect(deletedKeys).not.toContain(reg.attendeePhotoKey)
  })

  it('leaves the shared template, job history and wallet ledger intact', async () => {
    col(COLLECTIONS.TEMPLATES).set('tpl-1', { fileKey: `events/${SLUG}/certificates/templates/t.png` })
    col(COLLECTIONS.JOBS).set('job-1', { counts: { total: 5, succeeded: 5 } })
    col(COLLECTIONS.EMAIL_JOBS).set('ej-1', { certificateIds: ['RDC-2026-AB12CD'] })
    col(COLLECTIONS.ZIP_JOBS).set('zj-1', { certificateIds: ['RDC-2026-AB12CD'] })
    col('walletTransactions').set('certificate_RDC-2026-AB12CD', { amountPaise: 500 })

    const { id } = seedCertificate()
    await deleteCertificates(EVENT, [id], UID)

    expect(col(COLLECTIONS.TEMPLATES).has('tpl-1')).toBe(true)
    expect(col(COLLECTIONS.JOBS).get('job-1')).toEqual({ counts: { total: 5, succeeded: 5 } })
    expect(col(COLLECTIONS.EMAIL_JOBS).get('ej-1')).toEqual({ certificateIds: ['RDC-2026-AB12CD'] })
    expect(col(COLLECTIONS.ZIP_JOBS).get('zj-1')).toEqual({ certificateIds: ['RDC-2026-AB12CD'] })
    expect(col('walletTransactions').has('certificate_RDC-2026-AB12CD')).toBe(true)
    // and no template object was ever handed to storage
    expect(deletedKeys.some(k => k.includes('/templates/'))).toBe(false)
  })
})

// ─── 4 · Bulk, duplicates, idempotency ────────────────────────────────────────

describe('bulk deletion', () => {
  it('deletes every selected certificate', async () => {
    const ids = ['RDC-2026-AAA111', 'RDC-2026-BBB222', 'RDC-2026-CCC333']
    ids.forEach(id => seedCertificate({ id }))

    const r = await deleteCertificates(EVENT, ids, UID)

    expect(r.succeeded).toBe(3)
    expect(r.failed).toBe(0)
    expect(col(COLLECTIONS.CERTIFICATES).size).toBe(0)
  })

  it('collapses duplicate ids to ONE attempt', async () => {
    const { id } = seedCertificate()
    const r = await deleteCertificates(EVENT, [id, id, id], UID)

    // Three results would report two spurious "already deleted" rows for one certificate.
    expect(r.results).toHaveLength(1)
    expect(r.succeeded).toBe(1)
  })

  it('is idempotent — deleting an already-deleted certificate succeeds', async () => {
    const { id } = seedCertificate()
    await deleteCertificates(EVENT, [id], UID)

    const again = await deleteCertificates(EVENT, [id], UID)
    expect(again.results[0].ok).toBe(true)
    expect(again.results[0].alreadyDeleted).toBe(true)
    expect(again.failed).toBe(0)
  })

  it('a concurrent duplicate delete cannot double-report a failure', async () => {
    const { id } = seedCertificate()
    const [a, b] = await Promise.all([
      deleteCertificates(EVENT, [id], UID),
      deleteCertificates(EVENT, [id], UID),
    ])
    expect(a.results[0].ok).toBe(true)
    expect(b.results[0].ok).toBe(true)
    expect(a.failed + b.failed).toBe(0)
  })

  it('caps the batch so a request cannot be silently truncated', () => {
    expect(MAX_DELETE_BATCH).toBeGreaterThan(0)
    expect(MAX_DELETE_BATCH).toBeLessThanOrEqual(500)
  })
})

// ─── 5 · Partial failure ──────────────────────────────────────────────────────

describe('partial failure is reported, never swallowed', () => {
  it('a failed R2 delete is returned as an orphaned key — and still deletes the record', async () => {
    const { id } = seedCertificate()
    failingKeys.add(certificateObjectKey(SLUG, id))

    const r = await deleteCertificates(EVENT, [id], UID)

    expect(r.results[0].ok).toBe(true)                       // the certificate IS deleted
    expect(r.results[0].orphanedKeys).toEqual([certificateObjectKey(SLUG, id)])
    expect(r.orphanedKeys).toBe(1)
    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(false)
    expect(captured.length).toBeGreaterThan(0)               // recorded server-side too
  })

  it('one unreachable object does not block the others', async () => {
    const photoKey = `events/${SLUG}/certificate-photos/x/p.jpg`
    const { id } = seedCertificate({ photoKey })
    failingKeys.add(certificateObjectKey(SLUG, id))

    await deleteCertificates(EVENT, [id], UID)

    expect(deletedKeys).toContain(photoKey)
  })

  it('a Firestore failure deletes NOTHING and reports the item as failed', async () => {
    const { id } = seedCertificate()
    commitFails = true

    const r = await deleteCertificates(EVENT, [id], UID)

    expect(r.results[0].ok).toBe(false)
    expect(r.failed).toBe(1)
    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(true)
    // The record survived, so a retry is a clean re-run rather than a half-deleted state.
    expect(deletedKeys).toEqual([])
  })

  it('a fully-failed batch never reports success', async () => {
    const a = seedCertificate({ id: 'RDC-2026-XXX111', uid: 'other' })
    const b = seedCertificate({ id: 'RDC-2026-YYY222', uid: 'other' })

    const r = await deleteCertificates(EVENT, [a.id, b.id], UID)

    expect(r.succeeded).toBe(0)
    expect(r.failed).toBe(2)
  })
})

// ─── 6 · Metrics ──────────────────────────────────────────────────────────────
//
// Every certificate metric in the product is DERIVED from a live query — there is no stored
// certificate counter anywhere (Overview counts the loaded list, event analytics queries the
// collection, the stats route queries the legacy one). So the only thing deletion has to get
// right is removing the documents those queries read.

describe('metrics fall out of the deletion, with no counter to maintain', () => {
  it('the live certificates count drops by exactly the number deleted', async () => {
    ['RDC-2026-AAA111', 'RDC-2026-BBB222', 'RDC-2026-CCC333'].forEach(id => seedCertificate({ id }))
    const before = rowsOf(COLLECTIONS.CERTIFICATES, [['eventId', EVENT]]).length
    expect(before).toBe(3)

    await deleteCertificates(EVENT, ['RDC-2026-AAA111', 'RDC-2026-BBB222'], UID)

    expect(rowsOf(COLLECTIONS.CERTIFICATES, [['eventId', EVENT]]).length).toBe(1)
  })

  it('the legacy-collection count used by the stats route drops too', async () => {
    const { id } = seedCertificate({ legacy: true })
    expect(rowsOf(LEGACY_CERTIFICATE_RECORDS, [['eventId', EVENT]]).length).toBe(1)

    await deleteCertificates(EVENT, [id], UID)

    expect(rowsOf(LEGACY_CERTIFICATE_RECORDS, [['eventId', EVENT]]).length).toBe(0)
  })

  it('invents no certificate counter — nothing is incremented or decremented', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/certificates/deletion.ts'), 'utf8')
    expect(src).not.toMatch(/FieldValue\.increment/)
    expect(src).not.toMatch(/certificatesGenerated|certificateCount|totalCertificates/)
  })
})

// ─── 7 · Template deletion is a separate, untouched path ──────────────────────

describe('template deletion and certificate deletion do not overlap', () => {
  const src = readFileSync(resolve(process.cwd(), 'lib/certificates/deletion.ts'), 'utf8')

  it('certificate deletion never touches the templates collection', () => {
    expect(src).not.toMatch(/COLLECTIONS\.TEMPLATES/)
    expect(src).not.toMatch(/deleteTemplate/)
  })

  it('template deletion never touches the certificates collection', () => {
    // Generated PDFs are immutable artifacts stored under their own key, so removing a
    // template source cannot invalidate a certificate that was already issued.
    // Normalised first: the repo checks out CRLF, so a bare `\n}\n` boundary never matches
    // and the slice silently runs to the end of the file — which would sweep in every OTHER
    // function and make this assertion fail against unrelated code.
    const tpl = readFileSync(resolve(process.cwd(), 'lib/certificates/firestore.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    const fn  = tpl.slice(tpl.indexOf('export async function deleteTemplate'))
    const end = fn.indexOf('\n}\n')
    expect(end).toBeGreaterThan(0)
    const body = fn.slice(0, end)
    expect(body).not.toMatch(/COLLECTIONS\.CERTIFICATES/)
    expect(body).not.toMatch(/certificatesCol\(/)
  })

  it('an existing certificate keeps its own artifact key independent of any template', async () => {
    col(COLLECTIONS.TEMPLATES).set('tpl-1', { fileKey: `events/${SLUG}/certificates/templates/t.png` })
    const { id } = seedCertificate()

    // The certificate's key is a pure function of (slug, id) — no template is involved.
    expect(certificateObjectKey(SLUG, id)).not.toContain('templates')
    expect(col(COLLECTIONS.CERTIFICATES).get(id)!.fileKey).not.toContain('templates')
  })
})

// ─── 8 · Free-allowance loophole ──────────────────────────────────────────────
//
// Free allowance used to be measured by counting live certificates, which is a measure of
// what EXISTS rather than what was CONSUMED. Deleting a certificate handed the allowance
// back, so issue → delete → issue minted unlimited free certificates.

describe('deletion does not return consumed free allowance', () => {
  it('the issuance ledger survives deletion of the certificate it records', async () => {
    const { id } = seedCertificate()
    col('certificateIssuanceLedger').set(id, { eventId: EVENT, organizerUid: UID, certificateId: id })

    await deleteCertificates(EVENT, [id], UID)

    expect(col(COLLECTIONS.CERTIFICATES).has(id)).toBe(false)
    expect(col('certificateIssuanceLedger').has(id)).toBe(true)
    expect(rowsOf('certificateIssuanceLedger', [['eventId', EVENT]]).length).toBe(1)
  })

  it('the deletion service never deletes from the ledger collection', () => {
    // Comment-stripped: the module header NAMES this collection in its "not deleted" list,
    // which is documentation of the rule, not a use of it.
    const src = readFileSync(resolve(process.cwd(), 'lib/certificates/deletion.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/certificateIssuanceLedger/)
  })

  it('an issue → delete → issue loop is CHARGED, not free', async () => {
    const { chargeCertificate } = await import('@/lib/certificates/billing')
    freeAllowance = 2

    // Two certificates consume the whole allowance.
    seedCertificate({ id: 'RDC-2026-FRE001' })
    expect(await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-FRE001', eventId: EVENT }))
      .toEqual({ charged: false, reason: 'free_allowance' })

    seedCertificate({ id: 'RDC-2026-FRE002' })
    expect(await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-FRE002', eventId: EVENT }))
      .toEqual({ charged: false, reason: 'free_allowance' })

    // Delete both — the live count returns to zero, which is exactly what used to reset it.
    await deleteCertificates(EVENT, ['RDC-2026-FRE001', 'RDC-2026-FRE002'], UID)
    expect(rowsOf(COLLECTIONS.CERTIFICATES, [['eventId', EVENT]]).length).toBe(0)

    // The ledger still remembers two, so the third certificate is billed.
    seedCertificate({ id: 'RDC-2026-FRE003' })
    const third = await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-FRE003', eventId: EVENT })
    expect(third).toEqual({ charged: true, costPaise: 500 })
  })

  it('a replay of the same certificate consumes ONE unit, not two', async () => {
    const { chargeCertificate } = await import('@/lib/certificates/billing')
    freeAllowance = 1
    seedCertificate({ id: 'RDC-2026-RPL001' })

    const a = await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-RPL001', eventId: EVENT })
    const b = await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-RPL001', eventId: EVENT })

    // Deterministic ledger id ⇒ the retry overwrites the same document.
    expect(a).toEqual({ charged: false, reason: 'free_allowance' })
    expect(b).toEqual({ charged: false, reason: 'free_allowance' })
    expect(rowsOf('certificateIssuanceLedger', [['eventId', EVENT]]).length).toBe(1)
  })

  it('pre-ledger history still counts — raising the allowance grants nothing retroactively', async () => {
    const { chargeCertificate } = await import('@/lib/certificates/billing')
    // Two certificates already exist from a period when the allowance was 0, so the ledger
    // never saw them. A ledger-only reading would hand out free units for them.
    seedCertificate({ id: 'RDC-2026-OLD001' })
    seedCertificate({ id: 'RDC-2026-OLD002' })
    freeAllowance = 2

    seedCertificate({ id: 'RDC-2026-NEW003' })
    const r = await chargeCertificate({ organizerUid: UID, certificateId: 'RDC-2026-NEW003', eventId: EVENT })
    expect(r).toEqual({ charged: true, costPaise: 500 })
  })
})
