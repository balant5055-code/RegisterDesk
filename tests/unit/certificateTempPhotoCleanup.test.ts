// RD-CERT-PHOTO-03 — expiry cleanup for temporary certificate photos.
//
// Storage is the REAL StorageService driven by an in-memory PROVIDER. Only Firestore and the
// byte store are faked, because the assertions that matter are about bytes actually
// disappearing from a store and about which keys are eligible at all — a stubbed
// StorageService would prove neither.
//
// WHY A PROVIDER RATHER THAN A DIRECTORY. StorageService takes a `StorageProvider` in its
// constructor and every policy that matters here — key construction via paths.ts, asset-type
// validation, the safe-key guard — lives ABOVE the provider, so injecting a byte store
// exercises all of it unchanged. A Map is as real a store as a temp directory for these
// assertions, and it keeps the test free of any filesystem-backed development provider.
//
// The invariant under test is ordering: the grant document is the ONLY pointer to the
// object, so the object must go first. If deletion fails and we dropped the grant anyway,
// the bytes would be unreachable forever — nothing enumerates the storage prefix.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const SLUG = 'photo-qa-marathon-2026'
const CERT = 'RDC-2026-AAAAAA'
const OTHER_CERT = 'RDC-2026-BBBBBB'

// ─── Firestore double ────────────────────────────────────────────────────────
// Only what the sweep uses: a where/orderBy/limit query over one collection, plus
// per-document delete. Query semantics (expiresAt <= now, ascending) are implemented
// honestly so "unexpired grants are never returned" is a real assertion.
const docs = new Map<string, Record<string, unknown>>()

const makeSnap = (id: string, data: Record<string, unknown>) => ({
  id,
  data: () => data,
  ref: { delete: async () => { docs.delete(id); return undefined } },
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => {
      if (name !== 'certificatePhotoGrants') throw new Error(`unexpected collection: ${name}`)
      const build = (cutoff?: Date, limit = 1000) => ({
        where: (_f: string, _op: string, v: Date) => build(v, limit),
        orderBy: () => build(cutoff, limit),
        limit: (n: number) => build(cutoff, n),
        get: async () => {
          const rows = [...docs.entries()]
            .filter(([, d]) => {
              const e = d.expiresAt as Date | undefined
              return e instanceof Date && cutoff instanceof Date && e.getTime() <= cutoff.getTime()
            })
            .sort((a, b) => (a[1].expiresAt as Date).getTime() - (b[1].expiresAt as Date).getTime())
            .slice(0, limit)
          return { empty: rows.length === 0, docs: rows.map(([id, d]) => makeSnap(id, d)) }
        },
      })
      return build()
    },
  },
}))

// ─── Byte store double ───────────────────────────────────────────────────────
// An in-memory StorageProvider. Hoisted so the module factory below can close over it and
// the test body can clear it between cases.
const objects = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  const { StorageError } = actual

  const provider = {
    id: 'in-memory', name: 'In-memory (test)',
    isConfigured: () => true,
    upload: async (input: { key: string; body: Uint8Array; mimeType: string }) => {
      objects.set(input.key, input.body)
      return {
        path: input.key, size: input.body.byteLength, mimeType: input.mimeType,
        updatedAt: null, checksum: null,
      }
    },
    download: async (key: string) => {
      const body = objects.get(key)
      if (!body) throw new StorageError('NOT_FOUND', `No such object: ${key}`)
      return {
        body,
        metadata: { path: key, size: body.byteLength, mimeType: 'image/png', updatedAt: null, checksum: null },
      }
    },
    // Idempotent by contract — deleting a missing key succeeds.
    delete: async (key: string) => { objects.delete(key) },
    copy: async (from: string, to: string) => {
      const body = objects.get(from)
      if (!body) throw new StorageError('NOT_FOUND', `No such object: ${from}`)
      objects.set(to, body)
    },
    move: async (from: string, to: string) => {
      const body = objects.get(from)
      if (!body) throw new StorageError('NOT_FOUND', `No such object: ${from}`)
      objects.set(to, body); objects.delete(from)
    },
    exists: async (key: string) => objects.has(key),
    list: async ({ prefix = '' }: { prefix?: string }) => ({
      objects: [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, b]) => ({ path: k, size: b.byteLength, mimeType: 'image/png', updatedAt: null, checksum: null })),
      nextToken: null,
    }),
    generateSignedUrl: async ({ key }: { key: string }) => `memory://${key}`,
    getMetadata: async (key: string) => {
      const body = objects.get(key)
      if (!body) throw new StorageError('NOT_FOUND', `No such object: ${key}`)
      return { path: key, size: body.byteLength, mimeType: 'image/png', updatedAt: null, checksum: null }
    },
    publicUrl: () => null,
  }

  // The REAL service — validation, key building and the safe-key guard all still run.
  return { ...actual, storage: new actual.StorageService(provider as never) }
})

const captured: string[] = []
vi.mock('@/lib/monitoring/sentry', () => ({
  captureError: (e: unknown) => { captured.push(typeof e === 'string' ? e : String(e)) },
  captureFinancialError: () => {}, captureWebhookError: () => {}, flushMonitoring: async () => {},
}))

let loaded = false
let storage: typeof import('@/features/platform-storage')['storage']
let sweepExpiredCertificatePhotos: typeof import('@/lib/certificates/tempPhotoCleanup')['sweepExpiredCertificatePhotos']
let isTempCertificatePhotoKey: typeof import('@/lib/certificates/tempPhotoCleanup')['isTempCertificatePhotoKey']

const past   = () => new Date(Date.now() - 60_000)
const future = () => new Date(Date.now() + 60 * 60_000)
const BYTES  = new TextEncoder().encode('photo-bytes')

/** Uploads through the SAME service the route uses, so the key is built identically. */
async function uploadTemp(certificateId: string): Promise<string> {
  const r = await storage.upload({
    type: 'event-certificate-photo-tmp', eventSlug: SLUG, scopeId: certificateId,
    body: BYTES, mimeType: 'image/png', uploadedBy: `certificate:${certificateId}`,
  })
  return r.metadata.path
}

function grant(id: string, o: Partial<Record<string, unknown>> = {}) {
  docs.set(id, {
    purpose: 'certificate_photo', certificateId: CERT, registrationId: 'reg-1',
    eventSlug: SLUG, expiresAt: past(), ...o,
  })
}

beforeEach(async () => {
  docs.clear(); captured.length = 0; objects.clear()
  if (!loaded) {
    ;({ storage } = await import('@/features/platform-storage'))
    ;({ sweepExpiredCertificatePhotos, isTempCertificatePhotoKey } =
      await import('@/lib/certificates/tempPhotoCleanup'))
    loaded = true
  }
})


// ─── Namespace guard — what may be deleted at all ────────────────────────────

describe('isTempCertificatePhotoKey — only our own namespace', () => {
  it('accepts a key built by the upload path', async () => {
    const key = await uploadTemp(CERT)
    expect(isTempCertificatePhotoKey(key, SLUG, CERT)).toBe(true)
  })

  it('REFUSES every neighbouring asset type', () => {
    for (const k of [
      `events/${SLUG}/attendee-photos/abc.png`,          // portal PERMANENT photo
      `events/${SLUG}/certificates/generated.pdf`,        // generated certificate PDF
      `certificates/templates/uid/evt/template.png`,      // template asset
      `events/${SLUG}/photos/original/x.jpg`,
      `events/${SLUG}/reports/r.csv`,
    ]) {
      expect(isTempCertificatePhotoKey(k, SLUG, CERT), k).toBe(false)
    }
  })

  it('REFUSES another certificate’s temporary photo', async () => {
    const other = await uploadTemp(OTHER_CERT)
    expect(isTempCertificatePhotoKey(other, SLUG, CERT)).toBe(false)   // ← cross-certificate
    expect(isTempCertificatePhotoKey(other, SLUG, OTHER_CERT)).toBe(true)
  })

  it('REFUSES the bare prefix, traversal and empty input', () => {
    expect(isTempCertificatePhotoKey(`events/${SLUG}/certificate-photos-tmp/${CERT}/`, SLUG, CERT)).toBe(false)
    expect(isTempCertificatePhotoKey(`events/${SLUG}/certificate-photos-tmp/${CERT}/../../x`, SLUG, 'evil/..')).toBe(false)
    expect(isTempCertificatePhotoKey('', SLUG, CERT)).toBe(false)
  })
})

// ─── The sweep ───────────────────────────────────────────────────────────────

describe('sweepExpiredCertificatePhotos', () => {
  it('1 · expired grant WITH photo → object deleted and grant deleted', async () => {
    const key = await uploadTemp(CERT)
    grant('g1', { photoKey: key })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.processed).toBe(1)
    expect(r.deleted).toBe(1)
    expect(r.grants).toBe(1)
    expect(await storage.exists(key)).toBe(false)
    expect(docs.has('g1')).toBe(false)
  })

  it('2 · expired grant WITHOUT photo → grant deleted, nothing else touched', async () => {
    const survivor = await uploadTemp(OTHER_CERT)
    grant('g2')                                  // no photoKey — "continue without photo"

    const r = await sweepExpiredCertificatePhotos()
    expect(r.grants).toBe(1)
    expect(r.deleted).toBe(0)
    expect(docs.has('g2')).toBe(false)
    expect(await storage.exists(survivor)).toBe(true)
  })

  it('3 · UNEXPIRED grant is untouched', async () => {
    const key = await uploadTemp(CERT)
    grant('g3', { photoKey: key, expiresAt: future() })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.processed).toBe(0)
    expect(docs.has('g3')).toBe(true)
    expect(await storage.exists(key)).toBe(true)   // ← in-flight photo survives
  })

  it('4 · object deletion FAILS → grant and photoKey retained for retry', async () => {
    const key = await uploadTemp(CERT)
    grant('g4', { photoKey: key })
    const spy = vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('provider down'))

    const r = await sweepExpiredCertificatePhotos()
    expect(r.failed).toBe(1)
    expect(r.grants).toBe(0)
    expect(docs.has('g4')).toBe(true)                         // pointer preserved
    expect((docs.get('g4') as { photoKey: string }).photoKey).toBe(key)
    expect(await storage.exists(key)).toBe(true)
    spy.mockRestore()
  })

  it('5 · object already MISSING → treated as success, grant removed', async () => {
    const key = await uploadTemp(CERT)
    await storage.delete(key)                                  // gone before the sweep
    grant('g5', { photoKey: key })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.deleted).toBe(1)
    expect(r.grants).toBe(1)
    expect(docs.has('g5')).toBe(false)
  })

  it('6 · malformed / non-temp photoKey → object NOT deleted, grant retained, reported', async () => {
    const foreign = `events/${SLUG}/attendee-photos/permanent.png`
    await storage.upload({
      type: 'event-attendee-photo', eventSlug: SLUG, body: BYTES,
      mimeType: 'image/png', uploadedBy: 'portal',
    })
    grant('g6', { photoKey: foreign })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.skipped).toBe(1)
    expect(r.deleted).toBe(0)
    expect(docs.has('g6')).toBe(true)
    expect(captured.some(c => c.includes('certificate_temp_photo_key_unexpected'))).toBe(true)
  })

  it('7 · a grant for certificate A cannot delete certificate B’s photo', async () => {
    const keyB = await uploadTemp(OTHER_CERT)
    // A grant that claims certificate A but names B's object — the exact confusion attack.
    grant('g7', { certificateId: CERT, photoKey: keyB })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.skipped).toBe(1)
    expect(r.deleted).toBe(0)
    expect(await storage.exists(keyB)).toBe(true)              // ← B survives
    expect(docs.has('g7')).toBe(true)
  })

  it('8 · multiple expired grants are processed independently', async () => {
    const a = await uploadTemp(CERT)
    const b = await uploadTemp(OTHER_CERT)
    grant('gA', { photoKey: a })
    grant('gB', { certificateId: OTHER_CERT, photoKey: b })
    grant('gC')                                                // no photo
    grant('gD', { photoKey: `events/${SLUG}/attendee-photos/x.png` })   // malformed

    const r = await sweepExpiredCertificatePhotos()
    expect(r.processed).toBe(4)
    expect(r.deleted).toBe(2)
    expect(r.grants).toBe(3)      // two with photos + one without
    expect(r.skipped).toBe(1)     // the malformed one
    expect(await storage.exists(a)).toBe(false)
    expect(await storage.exists(b)).toBe(false)
    expect(docs.has('gD')).toBe(true)
  })

  it('9 · batch is bounded and a short page terminates the drain', async () => {
    for (let i = 0; i < 5; i++) grant(`gx${i}`)
    const r = await sweepExpiredCertificatePhotos({ batchSize: 2 })
    expect(r.processed).toBe(2)                                // never the whole collection
    expect(docs.size).toBe(3)
  })

  it('10 · a grant with the wrong purpose is never acted on', async () => {
    const key = await uploadTemp(CERT)
    grant('g10', { photoKey: key, purpose: 'something_else' })

    const r = await sweepExpiredCertificatePhotos()
    expect(r.skipped).toBe(1)
    expect(await storage.exists(key)).toBe(true)
    expect(docs.has('g10')).toBe(true)
  })

  it('11 · deletes through the storage ABSTRACTION, not a direct SDK call', async () => {
    const key = await uploadTemp(CERT)
    grant('g11', { photoKey: key })
    const spy = vi.spyOn(storage, 'delete')

    await sweepExpiredCertificatePhotos()
    expect(spy).toHaveBeenCalledWith(key)                      // StorageService, provider-agnostic
    spy.mockRestore()
  })
})
