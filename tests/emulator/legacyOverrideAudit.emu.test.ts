// MS-SETTINGS-02 · Legacy override audit and cleanup — REAL Firestore (emulator).
//
// The claim under test is narrow and destructive: this removes six specific keys from live
// organizer documents and nothing else. A mock would prove nothing — what matters is that
// Firestore field-path deletion behaves as intended against real nested map data.
//
// THE assertion throughout: preferences sharing an override object with a legacy limit
// survive the cleanup untouched.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const TIMEOUT_MS = 60_000

describeEmu('MS-SETTINGS-02 · legacy platform-limit cleanup', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let audit: typeof import('@/features/media-studio/services/legacyOverrideAudit')
  let PLATFORM_LIMIT_KEYS: typeof import('@/lib/config/mediaLimitLayers')['PLATFORM_LIMIT_KEYS']

  const UID_A = `ms02-a-${process.pid}`
  const UID_B = `ms02-b-${process.pid}`
  const ALL_UIDS = [UID_A, UID_B]

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    audit = await import('@/features/media-studio/services/legacyOverrideAudit')
    ;({ PLATFORM_LIMIT_KEYS } = await import('@/lib/config/mediaLimitLayers'))
  })

  afterAll(async () => {
    const batch = adminDb.batch()
    for (const uid of ALL_UIDS) batch.delete(adminDb.doc(`mediaSettings/${uid}`))
    await batch.commit()
  })

  /** Writes a settings document with the given per-event override map. */
  async function seed(uid: string, overrides: Record<string, Record<string, unknown>>) {
    await adminDb.doc(`mediaSettings/${uid}`).set({
      organizerUid: uid,
      schemaVersion: 1,
      defaultProfileId: 'balanced',
      generateThumbnail: true, generateMedium: true, keepOriginal: true,
      defaultVisibility: 'SIGNED_URL',
      eventLimitOverrides: overrides,
      updatedAt: new Date(),
    })
  }

  const readOverrides = async (uid: string) =>
    (await adminDb.doc(`mediaSettings/${uid}`).get()).get('eventLimitOverrides') as
      Record<string, Record<string, unknown>> | undefined

  beforeEach(async () => {
    const batch = adminDb.batch()
    for (const uid of ALL_UIDS) batch.delete(adminDb.doc(`mediaSettings/${uid}`))
    await batch.commit()
  })

  // ── Audit ──────────────────────────────────────────────────────────────────

  it('finds a legacy limit override and names the keys', async () => {
    await seed(UID_A, { 'evt-1': { maxPhotosPerEvent: null, maxGalleriesPerEvent: 99 } })

    const result = await audit.auditLegacyOverrides({ limit: 500 })
    const finding = result.findings.find(f => f.organizerUid === UID_A && f.eventId === 'evt-1')

    expect(finding).toBeDefined()
    expect([...finding!.keys].sort()).toEqual(['maxGalleriesPerEvent', 'maxPhotosPerEvent'])
    // `null` is the unlimited self-grant — the worst case, recorded verbatim.
    expect(finding!.storedValues.maxPhotosPerEvent).toBeNull()
    expect(finding!.preservedKeys).toEqual([])
  }, TIMEOUT_MS)

  it('IGNORES an override that holds only preferences', async () => {
    await seed(UID_A, {
      'evt-pref': { defaultVisibility: 'PUBLIC', keepOriginal: false, generateMedium: true },
    })

    const result = await audit.auditLegacyOverrides({ limit: 500 })
    expect(result.findings.find(f => f.organizerUid === UID_A)).toBeUndefined()
  }, TIMEOUT_MS)

  it('separates limits from preferences sharing ONE override object', async () => {
    await seed(UID_A, {
      'evt-mixed': {
        maxUploadFileSizeBytes: 999_999_999,     // legacy limit
        defaultVisibility: 'PUBLIC',             // preference — must survive
        keepOriginal: false,                     // preference — must survive
      },
    })

    const result = await audit.auditLegacyOverrides({ limit: 500 })
    const finding = result.findings.find(f => f.eventId === 'evt-mixed')!

    expect(finding.keys).toEqual(['maxUploadFileSizeBytes'])
    expect([...finding.preservedKeys].sort()).toEqual(['defaultVisibility', 'keepOriginal'])
  }, TIMEOUT_MS)

  it('reports across multiple workspaces and counts events', async () => {
    await seed(UID_A, {
      'a1': { maxPhotosPerEvent: 5000 },
      'a2': { defaultVisibility: 'PUBLIC' },       // not a finding
    })
    await seed(UID_B, { 'b1': { signedUrlExpirySeconds: 86_400 } })

    const result = await audit.auditLegacyOverrides({ limit: 500 })
    const mine = result.findings.filter(f => ALL_UIDS.includes(f.organizerUid))
    expect(mine).toHaveLength(2)
    expect(mine.map(f => f.eventId).sort()).toEqual(['a1', 'b1'])
  }, TIMEOUT_MS)

  it('the audit WRITES NOTHING', async () => {
    await seed(UID_A, { 'evt-1': { maxPhotosPerEvent: null, defaultVisibility: 'PUBLIC' } })
    const before = await readOverrides(UID_A)

    await audit.auditLegacyOverrides({ limit: 500 })

    expect(await readOverrides(UID_A)).toEqual(before)
  }, TIMEOUT_MS)

  // ── Dry run ────────────────────────────────────────────────────────────────

  it('DRY RUN is the default and changes nothing', async () => {
    await seed(UID_A, { 'evt-1': { maxPhotosPerEvent: null } })

    const result = await audit.cleanLegacyOverrides()          // no args
    expect(result.dryRun).toBe(true)
    expect(result.eventsCleaned).toBeGreaterThanOrEqual(1)

    // The report says what WOULD happen; the data is untouched.
    expect((await readOverrides(UID_A))!['evt-1']).toEqual({ maxPhotosPerEvent: null })
  }, TIMEOUT_MS)

  it('a dry run and a real run report the same figures', async () => {
    await seed(UID_A, {
      'evt-1': { maxPhotosPerEvent: null, defaultVisibility: 'PUBLIC' },
      'evt-2': { maxGalleriesPerEvent: 50 },
    })

    const dry  = await audit.cleanLegacyOverrides({ dryRun: true })
    const real = await audit.cleanLegacyOverrides({ dryRun: false })

    // The decision to run must rest on the same evidence the run acts on.
    expect(real.eventsCleaned).toBe(dry.eventsCleaned)
    expect(real.keysRemoved).toBe(dry.keysRemoved)
    expect(real.keysPreserved).toBe(dry.keysPreserved)
  }, TIMEOUT_MS)

  // ── Cleanup ────────────────────────────────────────────────────────────────

  it('THE guarantee: removes limits, preserves preferences in the same object', async () => {
    await seed(UID_A, {
      'evt-mixed': {
        maxPhotosPerEvent: null,
        maxUploadBatchSize: 500,
        defaultVisibility: 'PUBLIC',
        keepOriginal: false,
        defaultCompressionProfileId: 'premium',
      },
    })

    await audit.cleanLegacyOverrides({ dryRun: false })

    const after = (await readOverrides(UID_A))!['evt-mixed']
    expect(after).toEqual({
      defaultVisibility: 'PUBLIC',
      keepOriginal: false,
      defaultCompressionProfileId: 'premium',
    })
    for (const key of PLATFORM_LIMIT_KEYS) expect(after).not.toHaveProperty(key)
  }, TIMEOUT_MS)

  it('removes the whole entry when nothing but limits remains', async () => {
    await seed(UID_A, {
      'evt-all-limits': { maxPhotosPerEvent: null, maxAlbumsPerGallery: 99 },
      'evt-keep':       { defaultVisibility: 'PUBLIC' },
    })

    await audit.cleanLegacyOverrides({ dryRun: false })

    const after = await readOverrides(UID_A)
    // Deleted outright rather than left as an empty object the resolver would still read.
    expect(after).not.toHaveProperty('evt-all-limits')
    expect(after!['evt-keep']).toEqual({ defaultVisibility: 'PUBLIC' })
  }, TIMEOUT_MS)

  it('cleans every one of the six keys', async () => {
    const everyLimit = Object.fromEntries(
      PLATFORM_LIMIT_KEYS.map(k => [k, k === 'maxPhotosPerEvent' ? null : 12_345]),
    )
    await seed(UID_A, { 'evt-all': { ...everyLimit, keepOriginal: false } })

    await audit.cleanLegacyOverrides({ dryRun: false })

    expect((await readOverrides(UID_A))!['evt-all']).toEqual({ keepOriginal: false })
  }, TIMEOUT_MS)

  it('is IDEMPOTENT — a second run finds nothing', async () => {
    await seed(UID_A, { 'evt-1': { maxPhotosPerEvent: null, defaultVisibility: 'PUBLIC' } })

    await audit.cleanLegacyOverrides({ dryRun: false })
    const second = await audit.cleanLegacyOverrides({ dryRun: false })

    const mine = second.findings.filter(f => ALL_UIDS.includes(f.organizerUid))
    expect(mine).toHaveLength(0)
    expect((await readOverrides(UID_A))!['evt-1']).toEqual({ defaultVisibility: 'PUBLIC' })
  }, TIMEOUT_MS)

  it('leaves a preferences-only workspace completely untouched', async () => {
    await seed(UID_B, { 'evt-pref': { defaultVisibility: 'PUBLIC', generateMedium: false } })
    const before = await readOverrides(UID_B)

    await audit.cleanLegacyOverrides({ dryRun: false })

    expect(await readOverrides(UID_B)).toEqual(before)
  }, TIMEOUT_MS)

  // ── Post-cleanup verification ──────────────────────────────────────────────

  it('after cleanup NO event carries an organizer-written platform limit', async () => {
    await seed(UID_A, {
      'e1': { maxPhotosPerEvent: null, defaultVisibility: 'PUBLIC' },
      'e2': { maxUploadFileSizeBytes: 1 },
      'e3': { keepOriginal: false },
    })
    await seed(UID_B, { 'e4': { signedUrlExpirySeconds: 1, maxAlbumsPerGallery: 2 } })

    await audit.cleanLegacyOverrides({ dryRun: false })

    // The verification the sprint asks for, expressed as an assertion rather than a claim.
    const after = await audit.auditLegacyOverrides({ limit: 500 })
    expect(after.findings.filter(f => ALL_UIDS.includes(f.organizerUid))).toHaveLength(0)

    for (const uid of ALL_UIDS) {
      const map = (await readOverrides(uid)) ?? {}
      for (const override of Object.values(map)) {
        for (const key of PLATFORM_LIMIT_KEYS) {
          expect(override).not.toHaveProperty(key)
        }
      }
    }
  }, TIMEOUT_MS)
})
