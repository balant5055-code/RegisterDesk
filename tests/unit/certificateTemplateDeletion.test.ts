// RD-CERT-TPL-R2 — deleting a template reclaims its stored object.
//
// WHY THIS NEEDS PINNING. The legacy design had the BROWSER delete the Firebase object after
// the API returned its `fileUrl`. An R2 object cannot be deleted that way — the browser holds
// no credential for the bucket — so deletion moved server-side. Without this file, an R2
// migration would silently turn every template delete into a storage leak: the record
// disappears, the object stays, and nothing surfaces it.
//
// The three properties asserted:
//   1. An R2 template's object is deleted by the SERVER, and the response says so.
//   2. A LEGACY template still returns its fileUrl for the client to clean up, and no R2
//      delete is attempted for it.
//   3. A key another surviving template still references is NOT deleted — duplicateTemplate
//      copies `fileKey` rather than re-uploading, so shared keys genuinely occur, and
//      deleting one would break the copy.
//
// Storage cleanup is best-effort by contract (it runs AFTER the record is committed), so a
// failing delete must not throw out of deleteTemplate — also asserted.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Tpl = Record<string, unknown>

let templates: Tpl[] = []
let deleteOutcome: 'ok' | 'throw' = 'ok'

const r2Deletes:       string[] = []
const firebaseDeletes: string[] = []
const capturedErrors:  string[] = []

// A fake Firestore just large enough for deleteTemplate: a templates collection that answers
// the two equality filters listTemplates uses, plus a settings doc.
function makeDb() {
  const snapOf = (docs: Tpl[]) => ({ docs: docs.map(d => ({ data: () => d })), empty: docs.length === 0 })
  const query = (filters: Array<[string, unknown]>) => ({
    where: (f: string, _op: string, v: unknown) => query([...filters, [f, v]]),
    limit: () => query(filters),
    get: async () => snapOf(templates.filter(t => filters.every(([f, v]) => t[f] === v))),
  })
  return {
    collection: (name: string) => ({
      ...query([]),
      doc: (id: string) => ({
        id,
        get: async () => {
          if (name === 'certificateSettings') return { exists: false, data: () => ({}) }
          const t = templates.find(x => x.templateId === id)
          return { exists: !!t, data: () => t }
        },
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
    // The delete really removes the doc: `remaining` is re-read AFTER the transaction, and
    // the "still referenced by a duplicate" rule is only meaningful if the deleted template
    // is genuinely gone from that list.
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => fn({
      get:    async (ref: { get: () => Promise<unknown> }) => ref.get(),
      delete: (ref: { id: string }) => { templates = templates.filter(t => t.templateId !== ref.id) },
      update: () => {}, set: () => {},
    }),
  }
}

vi.mock('@/lib/firebase/admin', () => ({ adminDb: makeDb(), adminAuth: {} }))

vi.mock('@/lib/firebase/storage/admin', () => ({
  deleteServerFile: async (p: string) => { firebaseDeletes.push(p) },
}))

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      delete: async (key: string) => {
        if (deleteOutcome === 'throw') throw new Error('R2 unavailable')
        r2Deletes.push(key)
      },
    },
  }
})

vi.mock('@/lib/monitoring/sentry', () => ({
  captureError: (e: unknown) => { capturedErrors.push(e instanceof Error ? e.message : String(e)) },
}))

const { deleteTemplate } = await import('@/lib/certificates/firestore')

const KEY        = 'events/evt-1/certificates/templates/uid-1/t1/design.pdf'
const LEGACY_URL = 'https://firebasestorage.googleapis.com/v0/b/proj.appspot.com/o/certificates%2Ftemplates%2Fuid-1%2Fevt-1%2Fold.pdf?alt=media'

const tpl = (over: Tpl): Tpl => ({
  templateId: 't1', eventId: 'evt-1', organizerUid: 'uid-1',
  name: 'Finisher', templateType: 'pdf', fileName: 'design.pdf', fileSize: 8, ...over,
})

beforeEach(() => {
  templates = []
  deleteOutcome = 'ok'
  r2Deletes.length = 0; firebaseDeletes.length = 0; capturedErrors.length = 0
})

describe('deleteTemplate — storage reclamation', () => {
  it('deletes the R2 object server-side and reports the key it removed', async () => {
    templates = [tpl({ fileKey: KEY })]

    const res = await deleteTemplate('evt-1', 't1', 'uid-1')

    expect(r2Deletes).toEqual([KEY])
    expect(res.deletedKey).toBe(KEY)
    expect(res.fileUrl).toBeNull()            // nothing for the client to clean up
    expect(firebaseDeletes).toEqual([])
  })

  it('leaves the LEGACY path exactly as it was: fileUrl returned, no R2 delete', async () => {
    templates = [tpl({ fileUrl: LEGACY_URL })]

    const res = await deleteTemplate('evt-1', 't1', 'uid-1')

    expect(res.fileUrl).toBe(LEGACY_URL)
    expect(res.deletedKey).toBeNull()
    expect(r2Deletes).toEqual([])
  })

  it('does NOT delete a key a surviving DUPLICATE still points at', async () => {
    // duplicateTemplate copies fileKey rather than re-uploading, so this is reachable.
    templates = [
      tpl({ templateId: 't1', fileKey: KEY }),
      tpl({ templateId: 't2', fileKey: KEY, name: 'Finisher (Copy)' }),
    ]

    const res = await deleteTemplate('evt-1', 't1', 'uid-1')

    expect(r2Deletes).toEqual([])              // the copy would have lost its artwork
    expect(res.deletedKey).toBeNull()
    expect(res.fileKey).toBe(KEY)              // still reported, so the caller sees the truth
  })

  it('survives a storage failure — the record is already gone, so it must not throw', async () => {
    templates = [tpl({ fileKey: KEY })]
    deleteOutcome = 'throw'

    const res = await deleteTemplate('evt-1', 't1', 'uid-1')

    expect(res.deletedKey).toBeNull()          // honest: nothing was reclaimed
    expect(capturedErrors).toHaveLength(1)     // and it is reported rather than swallowed
  })

  it('refuses to delete a template belonging to another organizer', async () => {
    templates = [tpl({ fileKey: KEY, organizerUid: 'someone-else' })]

    await expect(deleteTemplate('evt-1', 't1', 'uid-1')).rejects.toMatchObject({ code: 'forbidden' })
    expect(r2Deletes).toEqual([])
  })
})
