// RD-CERT-TPL-R2 — the DOCUMENT a template write actually sends to Firestore.
//
// WHY THIS FILE EXISTS, STATED PLAINLY. The route-level suite mocks `createTemplate`, so it
// proved the ROUTE hands down the right fields and proved nothing about what gets written.
// The bug lived in exactly that gap: `createTemplate` spelled out `fileUrl: data.fileUrl`
// unconditionally, so an R2 template — which carries no fileUrl — wrote `undefined`, and
// Firestore rejected the whole document:
//
//   Value for argument "data" is not a valid Firestore document.
//   Cannot use "undefined" as a Firestore value (found in field "fileUrl").
//
// Every browser step had already succeeded: prepare, the signed PUT, the object landing in
// R2. Only the record failed, leaving an orphaned object and a 500.
//
// So the fake Firestore below REJECTS UNDEFINED THE WAY THE REAL ONE DOES. A test that only
// inspected the captured payload would pass against a `set()` that never runs in production;
// this one fails for the same reason production failed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let stored: Doc[] = []
let templates: Doc[] = []

/** The real client's validation, reproduced: any undefined value anywhere fails the write. */
function assertNoUndefined(data: Doc, path = ''): void {
  for (const [k, v] of Object.entries(data)) {
    const here = path ? `${path}.${k}` : k
    if (v === undefined) {
      throw new Error(
        `Value for argument "data" is not a valid Firestore document. ` +
        `Cannot use "undefined" as a Firestore value (found in field "${here}").`,
      )
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object) {
      assertNoUndefined(v as Doc, here)
    }
  }
}

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => ({
      where: function () { return this },
      limit: function () { return this },
      get:   async () => ({ docs: templates.map(t => ({ data: () => t })), empty: templates.length === 0 }),
      doc: (id: string) => ({
        id,
        set: async (data: Doc) => { assertNoUndefined(data); stored.push({ ...data, __id: id }) },
        get: async () => {
          const t = stored.find(s => s.__id === id) ?? templates.find(x => x.templateId === id)
          return { exists: !!t, data: () => t }
        },
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
  },
}))

vi.mock('@/lib/firebase/storage/admin', () => ({ deleteServerFile: async () => {} }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))

const { createTemplate, duplicateCertificateTemplate } = await import('@/lib/certificates/firestore')

const KEY        = 'events/evt-1/certificates/templates/uid-1/tpl-1/R2-TEST.png'
const LEGACY_URL = 'https://firebasestorage.googleapis.com/v0/b/x/o/legacy.pdf?alt=media'

const meta = {
  eventId: 'evt-1', name: 'R2-TEST', fileName: 'R2-TEST.png',
  fileSize: 2048, dimensions: { width: 1000, height: 1000 }, pageCount: null,
}

const written = () => stored[stored.length - 1]

beforeEach(() => { stored = []; templates = [] })

describe('createTemplate — R2 template', () => {
  // The exact payload from the failing production request.
  const r2Input = { ...meta, templateType: 'png' as const, fileKey: KEY }

  it('does not write fileUrl: undefined — the write that failed in production', async () => {
    await expect(createTemplate(r2Input, 'uid-1')).resolves.toBeDefined()
  })

  it('OMITS fileUrl entirely rather than storing null', async () => {
    await createTemplate(r2Input, 'uid-1')

    expect(Object.hasOwn(written(), 'fileUrl')).toBe(false)   // absent, not null, not undefined
    expect(written().fileKey).toBe(KEY)
  })

  it('still persists every other field the record needs', async () => {
    await createTemplate(r2Input, 'uid-1')

    expect(written()).toMatchObject({
      eventId: 'evt-1', organizerUid: 'uid-1', name: 'R2-TEST',
      templateType: 'png', fileName: 'R2-TEST.png', fileSize: 2048, isActive: false,
    })
  })
})

describe('createTemplate — legacy Firebase template', () => {
  const legacyInput = { ...meta, templateType: 'pdf' as const, fileName: 'legacy.pdf', fileUrl: LEGACY_URL }

  it('stores fileUrl and omits fileKey — unchanged behaviour', async () => {
    await createTemplate(legacyInput, 'uid-1')

    expect(written().fileUrl).toBe(LEGACY_URL)
    expect(Object.hasOwn(written(), 'fileKey')).toBe(false)
  })
})

describe('createTemplate — precedence', () => {
  it('writes only fileKey when both are supplied, matching the renderer', async () => {
    await createTemplate({ ...meta, templateType: 'png', fileKey: KEY, fileUrl: LEGACY_URL }, 'uid-1')

    expect(written().fileKey).toBe(KEY)
    expect(Object.hasOwn(written(), 'fileUrl')).toBe(false)
  })

  it('writes neither field rather than undefined when a caller supplies no source', async () => {
    // Not reachable through the route (it 400s first), but it must not be a crash either.
    await expect(createTemplate({ ...meta, templateType: 'png' }, 'uid-1')).resolves.toBeDefined()
    expect(Object.hasOwn(written(), 'fileUrl')).toBe(false)
    expect(Object.hasOwn(written(), 'fileKey')).toBe(false)
  })
})

describe('duplicateCertificateTemplate', () => {
  it('carries fileKey for an R2 template without writing fileUrl: undefined', async () => {
    templates = [{ templateId: 't1', eventId: 'evt-1', organizerUid: 'uid-1', name: 'R2-TEST',
                   templateType: 'png', fileName: 'R2-TEST.png', fileSize: 2048, fileKey: KEY }]

    const copy = await duplicateCertificateTemplate('evt-1', 't1', 'uid-1')

    expect(copy).not.toBeNull()
    expect(written().fileKey).toBe(KEY)                       // shares the object, no re-upload
    expect(Object.hasOwn(written(), 'fileUrl')).toBe(false)
    expect(written().name).toBe('R2-TEST (Copy)')
  })

  it('preserves fileUrl for a legacy template', async () => {
    templates = [{ templateId: 't1', eventId: 'evt-1', organizerUid: 'uid-1', name: 'Legacy',
                   templateType: 'pdf', fileName: 'legacy.pdf', fileSize: 10, fileUrl: LEGACY_URL }]

    await duplicateCertificateTemplate('evt-1', 't1', 'uid-1')

    expect(written().fileUrl).toBe(LEGACY_URL)
    expect(Object.hasOwn(written(), 'fileKey')).toBe(false)
  })
})
