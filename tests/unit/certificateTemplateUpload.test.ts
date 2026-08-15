// RD-CERT-TPL-R2 — the two-step template upload: prepare (signed PUT) → create (register).
//
// WHAT THIS PINS. The bytes of a 25 MB template cannot pass through a serverless function,
// so the browser PUTs them straight to object storage. That moves a write outside the API,
// and the whole safety of the design rests on three things this file asserts directly:
//
//   1. THE KEY IS SERVER-GENERATED. `prepare` never accepts a key from the client; it mints
//      one containing the authenticated uid and the event from the path, and signs only that.
//   2. THE KEY IS RE-VALIDATED ON REGISTER. `create` accepts a `fileKey` from the client, so
//      it recomputes the expected prefix from the AUTHENTICATED uid — a key naming another
//      organizer's or another event's folder is refused, not stored.
//   3. A RECORD IMPLIES ITS BYTES. The object must exist and its bytes must inspect to the
//      claimed type/size before the Firestore record is written, so a record can never point
//      at an upload that never landed or lie about what it contains.
//
// BACKWARD COMPATIBILITY is asserted alongside: the legacy Firebase `fileUrl` shape must
// still be accepted and still go through its existing SSRF guard, because live events have
// templates that were uploaded that way.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const UID       = 'organizer-uid-1'
const EVENT_ID  = 'evt-1'
const PREFIX    = `events/${EVENT_ID}/certificates/templates/${UID}/`
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // "%PDF-1.7"
const LEGACY_URL = 'https://firebasestorage.googleapis.com/v0/b/x/o/legacy.pdf?alt=media'

let authOutcome: 'ok' | 'denied' = 'ok'
let eventExists = true
let objectExists = true
let inspection: { type: string | null; dimensions: unknown; pageCount: number | null } =
  { type: 'pdf', dimensions: { width: 842, height: 595 }, pageCount: 1 }

const signCalls:    Array<{ path: string; operation: string; mimeType?: string }> = []
const metadataKeys: string[] = []
const downloadKeys: string[] = []
const legacyFetches: string[] = []
const created:      Array<Record<string, unknown>> = []

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOutcome === 'ok'
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))

// Event ownership: the draft only exists under its owner's user document, so a missing doc
// IS the "not your event" answer both routes rely on.
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { doc: () => ({ get: async () => ({ exists: eventExists }) }) },
}))

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,                                   // buildObjectKey stays REAL
    storage: {
      generateSignedUrl: async (o: { path: string; operation: string; mimeType?: string }) => {
        signCalls.push(o)
        return `https://r2.example.com/${o.path}?X-Amz-Signature=deadbeef`
      },
      getMetadata: async (key: string) => {
        metadataKeys.push(key)
        if (!objectExists) throw new Error('NOT_FOUND')
        return { size: PDF_BYTES.length, contentType: 'application/pdf' }
      },
      download: async (key: string) => {
        downloadKeys.push(key)
        return { body: PDF_BYTES, contentType: 'application/pdf' }
      },
    },
  }
})

vi.mock('@/lib/certificates/metadata', () => ({
  inspectTemplate: async () => inspection,
}))

vi.mock('@/lib/certificates/firestore', () => ({
  listTemplates:  async () => [],
  createTemplate: async (data: Record<string, unknown>) => {
    created.push(data)
    return { ...data, templateId: 'tpl-new', organizerUid: UID, isActive: false, createdAt: null, updatedAt: null }
  },
}))

// The legacy path's guard, at the same seam the route already used.
vi.mock('@/lib/certificates/urlGuard', () => ({
  validateEventTemplateUrl: (url: string) =>
    url.startsWith('https://firebasestorage.googleapis.com/') ? { ok: true, url } : { ok: false },
  safeFetchBytes: async (url: string) => { legacyFetches.push(url); return PDF_BYTES },
}))

vi.mock('@/lib/certificates/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/certificates/types')>()
  return { ...actual, serializeCertificateTemplateDoc: (t: unknown) => t }
})

const { POST: PREPARE } = await import('@/app/api/organizer/events/[eventId]/certificates/templates/prepare/route')
const { POST: CREATE }  = await import('@/app/api/organizer/events/[eventId]/certificates/templates/route')

const params = Promise.resolve({ eventId: EVENT_ID })

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authOutcome = 'ok'
  eventExists = true
  objectExists = true
  inspection = { type: 'pdf', dimensions: { width: 842, height: 595 }, pageCount: 1 }
  signCalls.length = 0; metadataKeys.length = 0; downloadKeys.length = 0
  legacyFetches.length = 0; created.length = 0
})

// ─── prepare ─────────────────────────────────────────────────────────────────────

describe('POST .../templates/prepare', () => {
  it('signs a WRITE url for a server-generated key scoped to this organizer and event', async () => {
    const res = await PREPARE(post('http://x/prepare', { fileName: 'design.pdf', templateType: 'pdf' }), { params })
    const body = await res.json() as { uploadUrl: string; fileKey: string; mimeType: string; maxBytes: number }

    expect(res.status).toBe(200)
    expect(body.fileKey.startsWith(PREFIX)).toBe(true)
    expect(body.fileKey.endsWith('/design.pdf')).toBe(true)
    expect(body.mimeType).toBe('application/pdf')
    expect(body.maxBytes).toBeGreaterThan(0)

    expect(signCalls).toHaveLength(1)
    expect(signCalls[0].operation).toBe('write')
    expect(signCalls[0].path).toBe(body.fileKey)          // only the minted key is signed
  })

  it('IGNORES a client-supplied fileKey — the client never names the object it writes', async () => {
    const res = await PREPARE(
      post('http://x/prepare', {
        fileName: 'design.pdf', templateType: 'pdf',
        fileKey: 'events/other-event/certificates/templates/attacker/x/evil.pdf',
      }),
      { params },
    )
    const body = await res.json() as { fileKey: string }

    expect(body.fileKey.startsWith(PREFIX)).toBe(true)
    expect(signCalls[0].path.startsWith(PREFIX)).toBe(true)
  })

  it('mints a distinct key per call, so a re-upload cannot overwrite the live template', async () => {
    const a = await (await PREPARE(post('http://x/prepare', { fileName: 'd.pdf', templateType: 'pdf' }), { params })).json() as { fileKey: string }
    const b = await (await PREPARE(post('http://x/prepare', { fileName: 'd.pdf', templateType: 'pdf' }), { params })).json() as { fileKey: string }
    expect(a.fileKey).not.toBe(b.fileKey)
  })

  it('rejects an unsupported templateType before signing anything', async () => {
    const res = await PREPARE(post('http://x/prepare', { fileName: 'x.svg', templateType: 'svg' }), { params })
    expect(res.status).toBe(400)
    expect(signCalls).toEqual([])
  })

  it('signs nothing for a caller without certificate access', async () => {
    authOutcome = 'denied'
    const res = await PREPARE(post('http://x/prepare', { fileName: 'd.pdf', templateType: 'pdf' }), { params })
    expect(res.status).toBe(403)
    expect(signCalls).toEqual([])
  })

  it('signs nothing for an event the caller does not own', async () => {
    eventExists = false
    const res = await PREPARE(post('http://x/prepare', { fileName: 'd.pdf', templateType: 'pdf' }), { params })
    expect(res.status).toBe(404)
    expect(signCalls).toEqual([])
  })
})

// ─── create (fileKey) ────────────────────────────────────────────────────────────

describe('POST .../templates — fileKey (R2)', () => {
  const KEY = `${PREFIX}tpl-1/design.pdf`

  it('registers the R2 object: fileKey persisted, fileUrl NOT required and NOT written', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Finisher', templateType: 'pdf', fileName: 'design.pdf', fileKey: KEY,
    }), { params })

    expect(res.status).toBe(201)
    expect(created).toHaveLength(1)
    expect(created[0].fileKey).toBe(KEY)
    expect(created[0]).not.toHaveProperty('fileUrl')      // no empty string, no null placeholder
    expect(created[0].fileSize).toBe(PDF_BYTES.length)
    expect(legacyFetches).toEqual([])                     // Firebase never consulted
  })

  it('re-reads the stored bytes and inspects them, so the record cannot lie about its type', async () => {
    inspection = { type: 'png', dimensions: { width: 10, height: 10 }, pageCount: null }

    const res = await CREATE(post('http://x/templates', {
      name: 'Finisher', templateType: 'pdf', fileName: 'design.pdf', fileKey: KEY,
    }), { params })

    expect(res.status).toBe(400)
    expect(downloadKeys).toEqual([KEY])                   // the CLAIM was checked against bytes
    expect(created).toEqual([])
  })

  it('refuses a key belonging to ANOTHER ORGANIZER, and stores nothing', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Stolen', templateType: 'pdf', fileName: 'design.pdf',
      fileKey: `events/${EVENT_ID}/certificates/templates/attacker-uid/t/design.pdf`,
    }), { params })

    expect(res.status).toBe(403)
    expect(created).toEqual([])
    expect(downloadKeys).toEqual([])                      // not even read
  })

  it('refuses a key belonging to ANOTHER EVENT of the same organizer', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Wrong event', templateType: 'pdf', fileName: 'design.pdf',
      fileKey: `events/other-event/certificates/templates/${UID}/t/design.pdf`,
    }), { params })

    expect(res.status).toBe(403)
    expect(created).toEqual([])
  })

  it('refuses a traversal key that would escape the event folder', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Traversal', templateType: 'pdf', fileName: 'design.pdf',
      fileKey: `events/${EVENT_ID}/certificates/templates/${UID}/../../../../secrets/design.pdf`
        .replace(`/${UID}/`, '/'),
    }), { params })

    expect(res.status).toBe(403)
    expect(created).toEqual([])
  })

  it('refuses to record a template whose object never landed in storage', async () => {
    objectExists = false

    const res = await CREATE(post('http://x/templates', {
      name: 'Abandoned', templateType: 'pdf', fileName: 'design.pdf', fileKey: KEY,
    }), { params })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/upload again/i) })
    expect(created).toEqual([])                           // no record without bytes
  })

  it('rejects an unauthenticated caller before touching storage', async () => {
    authOutcome = 'denied'
    const res = await CREATE(post('http://x/templates', {
      name: 'X', templateType: 'pdf', fileName: 'design.pdf', fileKey: KEY,
    }), { params })

    expect(res.status).toBe(403)
    expect(metadataKeys).toEqual([])
    expect(created).toEqual([])
  })
})

// ─── create (legacy fileUrl) ─────────────────────────────────────────────────────

describe('POST .../templates — legacy fileUrl (backward compatibility)', () => {
  it('still accepts the Firebase shape and stores fileUrl, not fileKey', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Legacy', templateType: 'pdf', fileName: 'design.pdf', fileUrl: LEGACY_URL,
    }), { params })

    expect(res.status).toBe(201)
    expect(created).toHaveLength(1)
    expect(created[0].fileUrl).toBe(LEGACY_URL)
    expect(created[0]).not.toHaveProperty('fileKey')
    expect(legacyFetches).toEqual([LEGACY_URL])
    expect(downloadKeys).toEqual([])                      // R2 never consulted
  })

  it('keeps the existing SSRF guard: an off-domain fileUrl is refused', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'SSRF', templateType: 'pdf', fileName: 'design.pdf',
      fileUrl: 'https://169.254.169.254/latest/meta-data/',
    }), { params })

    expect(res.status).toBe(400)
    expect(created).toEqual([])
    expect(legacyFetches).toEqual([])
  })

  it('rejects a body carrying neither source', async () => {
    const res = await CREATE(post('http://x/templates', {
      name: 'Nothing', templateType: 'pdf', fileName: 'design.pdf',
    }), { params })

    expect(res.status).toBe(400)
    expect(created).toEqual([])
  })
})
