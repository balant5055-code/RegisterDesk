// MS-BULK-01 · Bulk delete, end to end — REAL Firestore (emulator).
//
// The reported symptom was "the UI says queued and nothing is deleted". The audit found the
// drain was never scheduled: `/api/cron/media-jobs` appeared in no workflow and in no
// vercel.json, so a job created at `pending` stayed there forever.
//
// That is a scheduling defect, not a code defect — but "the delete implementation is fine"
// was an assumption until this file existed. These tests drive the REAL job path
// (`createBulkJob` → `runBulkChunk`) against real Firestore and check that documents
// actually leave, that counters actually move, and that the job actually completes.
//
// Object storage is stubbed: R2 is an external paid service and `removeObjects` is
// explicitly best-effort — the record is marked deleted first, and the reclamation sweep
// collects any orphan. The stub lets the storage-failure case be tested rather than skipped.
//
// ═══ HOW TO RUN ══════════════════════════════════════════════════════════════
//   npm run emu:start        # requires JDK 21+
//   npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const BUDGET_MS = 60_000

/** Stubbed object storage. `vi.hoisted` because a mock factory is lifted above imports. */
const store = vi.hoisted(() => ({ deleted: [] as string[], fail: false }))

vi.mock('@/features/platform-storage', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/features/platform-storage')
  return {
    ...actual,
    storage: {
      delete: async (path: string) => {
        if (store.fail) throw new Error('storage unavailable')
        store.deleted.push(path)
      },
      isReady: () => true,
    },
  }
})

describeEmu('MS-BULK-01 · bulk delete executes', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createBulkJob: typeof import('@/features/media-studio/jobs/bulkAssetJob')['createBulkJob']
  let runBulkChunk: typeof import('@/features/media-studio/jobs/bulkAssetJob')['runBulkChunk']
  let bulkJobId: typeof import('@/features/media-studio/utils/bulkOps')['bulkJobId']
  let getJob: typeof import('@/lib/jobs/kernel')['getJob']

  const UID     = 'emu-bulk-organizer'
  const EVENT   = 'evt_bulk'
  const SLUG    = 'evt-bulk'
  const GALLERY = 'gal_bulk'

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ createBulkJob, runBulkChunk } = await import('@/features/media-studio/jobs/bulkAssetJob'))
    ;({ bulkJobId } = await import('@/features/media-studio/utils/bulkOps'))
    ;({ getJob } = await import('@/lib/jobs/kernel'))
  })

  /** Writes N ready assets plus the gallery whose counter the job reads for its total. */
  async function seed(count: number) {
    const batch = adminDb.batch()
    batch.set(adminDb.doc(`mediaGalleries/${GALLERY}`), {
      galleryId: GALLERY, organizerUid: UID, eventId: EVENT, eventSlug: SLUG,
      // Required by getOwnedGallery — a document without it is treated as foreign.
      schemaVersion: 1,
      name: 'Bulk test', slug: 'bulk-test', preset: 'custom', description: null,
      assetCount: count, albumCount: 0, bytesStored: 0, status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    })
    for (let i = 0; i < count; i++) {
      const assetId = `asset_bulk_${i}`
      batch.set(adminDb.doc(`mediaAssets/${assetId}`), {
        assetId, organizerUid: UID, eventId: EVENT, eventSlug: SLUG,
        schemaVersion: 1,
        galleryId: GALLERY, albumId: null, status: 'ready',
        checksum: String(i).padStart(64, '0'),
        originalFilename: `IMG_${i}.jpg`, mimeType: 'image/jpeg',
        width: 100, height: 100, bytesStored: 1_000, bytesOriginalSource: 1_000,
        visibility: 'PRIVATE', uploadedBy: UID,
        renditions: [{ rendition: 'original', path: `p/${assetId}/original.jpg`, bytes: 1_000 }],
        createdAt: new Date(), updatedAt: new Date(), uploadedAt: new Date(),
      })
    }
    await batch.commit()
  }

  async function wipe() {
    for (const col of ['mediaAssets', 'mediaGalleries', 'mediaJobs']) {
      for (;;) {
        const snap = await adminDb.collection(col).limit(300).get()
        if (snap.empty) break
        const b = adminDb.batch()
        snap.docs.forEach(d => b.delete(d.ref))
        await b.commit()
      }
    }
  }

  beforeEach(async () => {
    store.deleted = []
    store.fail = false
    await wipe()
  })

  const readyCount = async () => {
    const snap = await adminDb.collection('mediaAssets')
      .where('organizerUid', '==', UID).where('status', '==', 'ready').get()
    return snap.size
  }

  /** Drains until the job is no longer active, exactly as the cron does on each tick. */
  async function drain(jobId: string, maxTicks = 20) {
    for (let i = 0; i < maxTicks; i++) {
      const job = await getJob('mediaJobs', jobId)
      if (!job || (job.status !== 'pending' && job.status !== 'processing')) return job
      await runBulkChunk(jobId, 10_000)
    }
    return getJob('mediaJobs', jobId)
  }

  // ── The reported case ──────────────────────────────────────────────────────

  it('deletes 10 photos: documents leave, counters move, the job completes', async () => {
    await seed(10)
    expect(await readyCount()).toBe(10)

    const outcome = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // ── State transition 1: created, and QUEUED. This is where it sat forever. ──
    expect(outcome.job.status).toBe('pending')
    expect(outcome.job.counts.total).toBe(10)
    expect(outcome.job.counts.processed).toBe(0)

    const jobId = bulkJobId(GALLERY, null, 'delete')

    // ── State transition 2 → 3: the cron tick the schedule now provides ──
    const final = await drain(jobId)

    expect(final?.status).toBe('completed')
    expect(final?.counts.processed).toBe(10)
    expect(final?.counts.succeeded).toBe(10)
    expect(final?.counts.failed).toBe(0)

    // Firestore: nothing `ready` remains.
    expect(await readyCount()).toBe(0)

    // Storage: one object per rendition was asked to be removed.
    expect(store.deleted).toHaveLength(10)
  }, BUDGET_MS)

  it('the gallery counter falls to zero, so the page reflects the delete', async () => {
    await seed(10)
    const outcome = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    if (!outcome.ok) throw new Error('job not created')
    await drain(bulkJobId(GALLERY, null, 'delete'))

    const gallery = (await adminDb.doc(`mediaGalleries/${GALLERY}`).get()).data()
    expect(gallery?.assetCount).toBe(0)
  }, BUDGET_MS)

  // ── The questions the audit asked ──────────────────────────────────────────

  it('a job with NO tick stays pending and deletes nothing — the reported symptom', async () => {
    await seed(5)
    const outcome = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    if (!outcome.ok) throw new Error('job not created')

    // No drain. This is production before the schedule was registered.
    const job = await getJob('mediaJobs', bulkJobId(GALLERY, null, 'delete'))
    expect(job?.status).toBe('pending')
    expect(job?.counts.processed).toBe(0)
    expect(await readyCount()).toBe(5)          // every photo still there
    expect(store.deleted).toHaveLength(0)
  }, BUDGET_MS)

  it('storage failure does NOT abort the batch — the record still goes', async () => {
    // `removeObjects` is best-effort by design: the document is marked deleted first and the
    // reclamation sweep collects the orphaned object.
    await seed(6)
    store.fail = true

    const outcome = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    if (!outcome.ok) throw new Error('job not created')
    const final = await drain(bulkJobId(GALLERY, null, 'delete'))

    expect(final?.status).toBe('completed')
    expect(final?.counts.succeeded).toBe(6)
    expect(await readyCount()).toBe(0)          // Firestore deletion succeeded regardless
    expect(store.deleted).toHaveLength(0)       // storage refused every object
  }, BUDGET_MS)

  it('re-running a completed batch is a no-op, not a second delete', async () => {
    await seed(4)
    const first = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    if (!first.ok) throw new Error('job not created')
    await drain(bulkJobId(GALLERY, null, 'delete'))
    expect(await readyCount()).toBe(0)

    const removedFirst = store.deleted.length
    await runBulkChunk(bulkJobId(GALLERY, null, 'delete'), 5_000)
    expect(store.deleted).toHaveLength(removedFirst)
  }, BUDGET_MS)

  it('a batch over an EMPTY gallery completes rather than hanging', async () => {
    await seed(0)
    const outcome = await createBulkJob({
      organizerUid: UID, createdBy: UID, action: 'delete', galleryId: GALLERY,
      albumId: null, toGalleryId: null, toAlbumId: null, visibility: null,
    })
    if (!outcome.ok) throw new Error('job not created')
    const final = await drain(bulkJobId(GALLERY, null, 'delete'))
    expect(final?.status).toBe('completed')
    expect(final?.counts.processed).toBe(0)
  }, BUDGET_MS)
})
