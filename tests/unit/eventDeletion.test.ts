// RD-EVENT-DELETE — permanent deletion of an archived event.
//
// This is the only irreversible operation an organizer can perform, so the manifest is a
// PURE function and the retention policy is asserted here rather than discovered in
// production. The tests are written around what must NOT be destroyed as much as what must.
//
// Two collections are deliberately absent from the manifest, and both are pinned below so
// nobody "completes" the list later:
//   • paymentEvents    — keyed by the RAZORPAY WEBHOOK event id, not a RegisterDesk event. It
//     is the webhook idempotency ledger; deleting it would let captured payments replay.
//   • reportExportJobs — extends the base Job, which has NO event key. The only event
//     reference is an optional nested `filters.event` ("entityId / eventSlug"), absent
//     entirely for organizer-wide exports, so no field identifies exactly one event.
//
// `paymentIntents` is also retained, but for a different reason: it COULD be queried by
// event, and is kept as payment evidence by policy rather than by inability.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── In-memory Firestore + storage, shared by the execution tests ─────────────
const store = new Map<string, Map<string, Record<string, unknown>>>()
const col = (n: string) => { if (!store.has(n)) store.set(n, new Map()); return store.get(n)! }

let batchFails = false
const deletedKeys: string[] = []
const failingKeys = new Set<string>()
let listed: string[] = []

const makeRef = (c: string, id: string) => ({
  _c: c, _id: id,
  get:    async () => ({ exists: col(c).has(id), data: () => col(c).get(id) }),
  delete: async () => { col(c).delete(id) },
})
const makeQuery = (c: string, preds: Array<[string, unknown]>, lim = 1000) => ({
  where: (f: string, _o: string, v: unknown) => makeQuery(c, [...preds, [f, v]], lim),
  limit: (n: number) => makeQuery(c, preds, n),
  get:   async () => {
    const rows = [...col(c).entries()]
      .filter(([, d]) => preds.every(([f, v]) => d[f] === v))
      .slice(0, lim)
      .map(([id]) => ({ id, ref: makeRef(c, id), data: () => col(c).get(id) }))
    return { empty: rows.length === 0, size: rows.length, docs: rows }
  },
})

const adminDbMock = {
  collection: (n: string) => ({
    doc:   (id: string) => makeRef(n, id),
    where: (f: string, o: string, v: unknown) => makeQuery(n, []).where(f, o, v),
    limit: (l: number) => makeQuery(n, [], l),
  }),
  doc: (path: string) => {
    const parts = path.split('/')
    const ref = makeRef(parts.slice(0, -1).join('/'), parts[parts.length - 1])
    return { ...ref, collection: (name: string) => ({ limit: (l: number) => makeQuery(`${path}/${name}`, [], l) }) }
  },
  batch: () => {
    const ops: Array<() => void> = []
    return {
      delete: (r: { _c: string; _id: string }) => { ops.push(() => col(r._c).delete(r._id)) },
      commit: async () => { if (batchFails) throw new Error('Firestore unavailable'); ops.forEach(f => f()) },
    }
  },
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: new Proxy({}, { get: (_t, p: string) => (adminDbMock as unknown as Record<string, unknown>)[p] }),
  adminAuth: {},
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      listEvent: async () => ({ objects: listed.map(path => ({ path })), nextCursor: null }),
      delete: async (key: string) => {
        if (failingKeys.has(key)) throw new Error('R2 unavailable')
        deletedKeys.push(key)
        listed = listed.filter(k => k !== key)
      },
    },
  }
})

import {
  buildDeletionManifest, runEventDeletion, RETAINED_COLLECTIONS,
  encodeProgress, decodeProgress,
} from '@/lib/events/eventDeletion'

const TARGET = { eventSlug: 'test-event-abc123', eventId: 'draft-1', organizerUid: 'org-1' }

beforeEach(() => {
  store.clear(); deletedKeys.length = 0; failingKeys.clear()
  listed = []; batchFails = false
})

// ─── 1 · The retention policy ─────────────────────────────────────────────────

describe('the manifest never touches financial, audit, or shared records', () => {
  const manifest = buildDeletionManifest(TARGET)
  // The collection a document path actually writes to is its SECOND-TO-LAST segment, not its
  // first: `users/{uid}/eventDrafts/{id}` targets `eventDrafts`, not `users`. Taking the
  // first segment reported a violation that did not exist — while, importantly, still
  // catching a real one, since deleting `users/{uid}` would parse as `users` either way.
  const collectionOf = (path: string) => {
    const parts = path.split('/')
    return parts[parts.length - 2] ?? parts[0]
  }
  const touched = manifest.flatMap(s =>
    s.kind === 'query'           ? [s.collection]
    : s.kind === 'doc'           ? [collectionOf(s.path)]
    : s.kind === 'subcollection' ? [collectionOf(s.parentPath), s.name]
    : [])

  it('excludes every retained collection', () => {
    for (const c of RETAINED_COLLECTIONS) {
      expect(touched, `manifest must not touch ${c}`).not.toContain(c)
    }
  })

  it('never deletes paymentEvents — it is the RAZORPAY webhook idempotency ledger', () => {
    // The name collides with "event"; the schema does not. Deleting it would let an
    // already-processed payment webhook replay.
    expect(touched).not.toContain('paymentEvents')
    expect(RETAINED_COLLECTIONS).toContain('paymentEvents')
  })

  it('DOES delete sessionCheckIns — ownership is provable from its schema', () => {
    // Corrected. An earlier revision excluded this on the belief that the row carried only
    // `sessionId`. The belief came from one read site that happens to query by session, not
    // from the type: SessionCheckInDoc carries `eventSlug` + `organizerUid`, and the write is
    // refused unless the session's event and the registration's event agree.
    expect(touched).toContain('sessionCheckIns')
  })

  it('never deletes shared or global resources', () => {
    for (const c of ['globalCertificateTemplates', 'emailSuppressionList', 'platformSettings', 'users']) {
      expect(touched).not.toContain(c)
    }
  })

  it('does not delete the whole users collection when removing the draft', () => {
    const draft = manifest.find(s => s.kind === 'doc' && s.label === 'eventDraft')
    expect(draft).toBeDefined()
    // A full document path, four segments deep — never a collection wipe.
    expect((draft as { path: string }).path).toBe('users/org-1/eventDrafts/draft-1')
  })
})

// ─── 2 · Everything event-owned IS covered ────────────────────────────────────

describe('the manifest covers the audited event-owned data', () => {
  const manifest = buildDeletionManifest(TARGET)
  const labels = manifest.map(s => s.label)

  it('includes the operational collections', () => {
    for (const c of [
      'registrations', 'registrationAuditLogs', 'waitlists', 'speakerApplications',
      'sponsorApplications', 'eventNominations', 'identifierHistory', 'broadcastCampaigns',
      'certificatePhotoGrants', 'raceResultSnapshots', 'emailLogs',
      'certificates', 'certificateRecords', 'certificateJobs', 'certificateClaims',
      'scheduledReminders', 'registrationCounters', 'waitlistCounters', 'bibCounters',
      'identifierConfigs', 'donationCampaigns', 'donationCounters', 'certificateSettings',
      'events/changeLog', 'events/editHistory', 'eventDraft', 'events',
    ]) {
      expect(labels, `missing ${c}`).toContain(c)
    }
  })

  it('scopes certificate data by the DRAFT id, not the slug', () => {
    const certs = manifest.find(s => s.kind === 'query' && s.collection === 'certificates')
    expect(certs).toMatchObject({ field: 'eventId', value: 'draft-1' })
  })

  it('scopes scheduledReminders by the SLUG despite its field being called eventId', () => {
    // The field name is misleading; its own type documents that it stores the event slug.
    // Querying it with the draft id would delete nothing and silently strand every reminder.
    const rem = manifest.find(s => s.kind === 'query' && s.collection === 'scheduledReminders')
    expect(rem).toMatchObject({ field: 'eventId', value: 'test-event-abc123' })
  })

  it('deletes the event document LAST, so an interrupted run stays discoverable', () => {
    const last = manifest[manifest.length - 1]
    expect(last).toMatchObject({ kind: 'doc', path: 'events/test-event-abc123' })
  })

  it('confines storage cleanup to this event prefix', () => {
    const st = manifest.filter(s => s.kind === 'storage')
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ eventSlug: 'test-event-abc123' })
  })
})

// ─── 3 · Execution ────────────────────────────────────────────────────────────

describe('running the deletion', () => {
  const seed = () => {
    col('registrations').set('r1', { eventSlug: TARGET.eventSlug })
    col('registrations').set('r2', { eventSlug: TARGET.eventSlug })
    col('registrations').set('other', { eventSlug: 'someone-else' })
    col('certificates').set('c1', { eventId: 'draft-1' })
    col('registrationCounters').set(TARGET.eventSlug, { totalCount: 2 })
    col('events').set(TARGET.eventSlug, { name: 'Test' })
    col('users/org-1/eventDrafts').set('draft-1', { status: 'archived' })
    // Must survive.
    col('platformTransactions').set('ptx_r1', { eventId: 'draft-1', amount: 500 })
    col('walletTransactions').set('w1', { organizerUid: 'org-1' })
    col('paymentEvents').set('evt_razorpay_123', { handled: true })
    col('sessionCheckIns').set('s1', { sessionId: 'sess-1' })
  }

  it('deletes event-owned Firestore data', async () => {
    seed()
    const { summary } = await runEventDeletion(TARGET)
    expect(summary.ok).toBe(true)
    expect(col('registrations').has('r1')).toBe(false)
    expect(col('certificates').has('c1')).toBe(false)
    expect(col('registrationCounters').has(TARGET.eventSlug)).toBe(false)
    expect(col('events').has(TARGET.eventSlug)).toBe(false)
    expect(col('users/org-1/eventDrafts').has('draft-1')).toBe(false)
  })

  it('leaves ANOTHER event\'s registrations alone', async () => {
    seed()
    await runEventDeletion(TARGET)
    expect(col('registrations').has('other')).toBe(true)
  })

  it('retains financial and audit records', async () => {
    seed()
    await runEventDeletion(TARGET)
    expect(col('platformTransactions').has('ptx_r1')).toBe(true)
    expect(col('walletTransactions').has('w1')).toBe(true)
    expect(col('paymentEvents').has('evt_razorpay_123')).toBe(true)
    expect(col('sessionCheckIns').has('s1')).toBe(true)
  })

  it('cleans the R2 event prefix', async () => {
    seed()
    listed = [
      `events/${TARGET.eventSlug}/certificates/a.pdf`,
      `events/${TARGET.eventSlug}/media/b.jpg`,
    ]
    await runEventDeletion(TARGET)
    expect(deletedKeys).toHaveLength(2)
    expect(deletedKeys.every(k => k.startsWith(`events/${TARGET.eventSlug}/`))).toBe(true)
  })

  it('never asks storage for anything outside the event prefix', () => {
    // listEvent(slug) is the only enumeration used, and it is prefix-bound by the platform.
    const src = readFileSync(resolve(process.cwd(), 'lib/events/eventDeletion.ts'), 'utf8')
    expect(src).toMatch(/storage\.listEvent\(step\.eventSlug/)
    expect(src).not.toMatch(/storage\.list\(/)
  })

  it('is idempotent — a second run is a clean no-op', async () => {
    seed()
    const first = await runEventDeletion(TARGET)
    expect(first.summary.ok).toBe(true)
    const second = await runEventDeletion(TARGET)
    expect(second.summary.ok).toBe(true)
    expect(second.summary.failures).toEqual([])
  })

  it('concurrent duplicate deletions both settle safely', async () => {
    seed()
    const [a, b] = await Promise.all([runEventDeletion(TARGET), runEventDeletion(TARGET)])
    expect(a.summary.ok || b.summary.ok).toBe(true)
    expect(col('events').has(TARGET.eventSlug)).toBe(false)
  })

  it('surfaces a Firestore failure instead of reporting success', async () => {
    seed()
    batchFails = true
    const { summary } = await runEventDeletion(TARGET)
    expect(summary.ok).toBe(false)
    expect(summary.failures.length).toBeGreaterThan(0)
  })

  it('surfaces an R2 failure instead of reporting success', async () => {
    seed()
    const key = `events/${TARGET.eventSlug}/certificates/stuck.pdf`
    listed = [key]
    failingKeys.add(key)
    const { summary } = await runEventDeletion(TARGET)
    expect(summary.ok).toBe(false)
    expect(summary.failures).toContain(key)
  })

  it('reports unfinished rather than complete when the page budget runs out', async () => {
    seed()
    const { summary, finished } = await runEventDeletion(TARGET, 1)
    expect(finished).toBe(false)
    expect(summary.ok).toBe(false)
  })

  it('resumes from a checkpoint instead of restarting', async () => {
    seed()
    const manifest = buildDeletionManifest(TARGET)
    // Start past the bulk steps: the earlier collections must be left untouched, proving the
    // cursor is honoured rather than ignored.
    const start = { step: manifest.length - 1, deleted: 7, failures: [] as string[] }
    const { summary } = await runEventDeletion(TARGET, 400, start)
    expect(summary.ok).toBe(true)
    expect(summary.deleted).toBeGreaterThanOrEqual(7)   // prior progress carried forward
    expect(col('registrations').has('r1')).toBe(true)   // earlier steps were NOT re-run
    expect(col('events').has(TARGET.eventSlug)).toBe(false)
  })
})

// ─── 4 · Cursor round-trip ────────────────────────────────────────────────────

describe('progress encoding survives a restart', () => {
  it('round-trips step and count', () => {
    const p = { step: 12, deleted: 3400, failures: [] }
    expect(decodeProgress(encodeProgress(p))).toMatchObject({ step: 12, deleted: 3400 })
  })

  it('a missing or corrupt cursor restarts from the beginning, never mid-way', () => {
    expect(decodeProgress(null)).toMatchObject({ step: 0, deleted: 0 })
    expect(decodeProgress('garbage')).toMatchObject({ step: 0, deleted: 0 })
  })
})

// ─── 5 · The endpoint's gates ─────────────────────────────────────────────────

describe('the DELETE endpoint enforces every rule server-side', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/events/[eventId]/route.ts'), 'utf8')

  it('authenticates and scopes to the events capability', () => {
    expect(src).toMatch(/export async function DELETE/)
    expect(src).toMatch(/authorizeWorkspace\(req, 'events'\)/)
  })

  it('resolves the event under the CALLER\'s workspace — cross-organizer is impossible', () => {
    expect(src).toMatch(/users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}/)
  })

  it('refuses anything that is not archived', () => {
    // Gate is unchanged in strength, but now uses the shared `isArchivedEvent` predicate:
    // the bare `deriveLifecycleStatus(...) !== 'archived'` could not see an event archived
    // before `lifecycleStatus` existed, so it would have refused a legacy archived event
    // that the UI correctly offers for deletion.
    expect(src).toMatch(/if \(!isArchivedEvent\(draft\)\)/)
    expect(src).toMatch(/Only archived events can be permanently deleted/)
  })

  it('is idempotent when the event is already gone', () => {
    expect(src).toMatch(/alreadyDeleted: true/)
  })

  it('never reports success on partial work', () => {
    expect(src).toMatch(/if \(!summary\.ok \|\| !finished\)/)
  })
})

describe('the UI offers permanent deletion only for archived events', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/events/[eventId]/EventActionsPanel.tsx'), 'utf8')

  it('gates the action on the archived lifecycle', () => {
    expect(src).toMatch(/const canDeleteForever = ls === 'archived'/)
    expect(src).toMatch(/canDeleteForever && <ActionBtn/)
  })

  it('uses the shared confirmation copy rather than its own string', () => {
    // The wording now lives in one module so the detail page and the Archived card menu
    // cannot drift — an inline literal here would be the drift.
    expect(src).toMatch(/description=\{PERMANENT_DELETE_DESCRIPTION\}/)
    expect(src).not.toContain('This permanently deletes the archived event and its')
  })

  it('offers Cancel and Delete Permanently', () => {
    expect(src).toMatch(/confirmLabel=\{PERMANENT_DELETE_TITLE\}/)
    // ConfirmModal's dismiss control is the shared Cancel affordance.
    expect(src).toMatch(/onClose=\{\(\) => setModal\('none'\)\}/)
  })

  it('derives success from the payload, never from the HTTP status alone', () => {
    expect(src).toMatch(/if \(res\.ok && json\.success\)/)
  })

  it('prevents duplicate submission while deleting', () => {
    expect(src).toMatch(/loading=\{loading\}/)
  })

  it('leaves the events list rather than refreshing a deleted event', () => {
    expect(src).toMatch(/router\.push\('\/dashboard\/events'\)/)
  })
})

// ─── 6 · The collections the ownership audit recovered ────────────────────────
//
// The first manifest was built from `where('eventSlug')` CALL SITES, so collections whose
// event key is read in only one narrow place — or read by a different key entirely — fell
// through. Sweeping the TYPE DEFINITIONS found 13 more. These pin each one's key, prove the
// scoping is per-event, and pin the two that verification rejected.

const SESSION_BY_SLUG = ['eventSessions', 'eventTracks', 'eventHalls', 'eventSpeakers', 'sessionCheckIns']
const JOBS_BY_EVENT_ID = [
  'certificateZipJobs', 'registrationImportJobs', 'registrationBulkJobs',
  'printGenerationJobs', 'printPackageJobs', 'printTemplates',
  'emailBroadcastJobs', 'whatsappBroadcastJobs',
]

describe('recovered event-owned collections are in the manifest with the right key', () => {
  const manifest = buildDeletionManifest(TARGET)
  const stepFor = (c: string) => manifest.find(s => s.kind === 'query' && s.collection === c)

  it.each(SESSION_BY_SLUG)('%s is scoped by eventSlug', (c) => {
    expect(stepFor(c), `${c} missing from manifest`).toMatchObject({
      field: 'eventSlug', value: TARGET.eventSlug,
    })
  })

  it.each(JOBS_BY_EVENT_ID)('%s is scoped by eventId (the draft id)', (c) => {
    expect(stepFor(c), `${c} missing from manifest`).toMatchObject({
      field: 'eventId', value: TARGET.eventId,
    })
  })

  it('still deletes the event document last, after the additions', () => {
    expect(manifest[manifest.length - 1]).toMatchObject({ kind: 'doc', path: `events/${TARGET.eventSlug}` })
  })

  it('storage still runs before the anchors and only for this event', () => {
    const st = manifest.findIndex(s => s.kind === 'storage')
    const anchor = manifest.length - 1
    expect(st).toBeGreaterThan(-1)
    expect(st).toBeLessThan(anchor)
    expect(manifest.filter(s => s.kind === 'storage')).toHaveLength(1)
  })
})

describe('the recovered collections delete ONLY the target event', () => {
  const seedBoth = () => {
    for (const c of SESSION_BY_SLUG) {
      col(c).set('mine',   { eventSlug: TARGET.eventSlug })
      col(c).set('theirs', { eventSlug: 'another-event' })
    }
    for (const c of JOBS_BY_EVENT_ID) {
      col(c).set('mine',   { eventId: TARGET.eventId })
      col(c).set('theirs', { eventId: 'another-draft' })
    }
    col('events').set(TARGET.eventSlug, { name: 'Test' })
    col('users/org-1/eventDrafts').set('draft-1', { status: 'archived' })
  }

  it('removes this event\'s rows from every recovered collection', async () => {
    seedBoth()
    const { summary } = await runEventDeletion(TARGET)
    expect(summary.ok).toBe(true)
    for (const c of [...SESSION_BY_SLUG, ...JOBS_BY_EVENT_ID]) {
      expect(col(c).has('mine'), `${c} row was not deleted`).toBe(false)
    }
  })

  it('leaves ANOTHER event\'s rows untouched in every one of them', async () => {
    seedBoth()
    await runEventDeletion(TARGET)
    for (const c of [...SESSION_BY_SLUG, ...JOBS_BY_EVENT_ID]) {
      expect(col(c).has('theirs'), `${c} leaked into another event`).toBe(true)
    }
  })

  it('is idempotent across the recovered collections', async () => {
    seedBoth()
    await runEventDeletion(TARGET)
    const second = await runEventDeletion(TARGET)
    expect(second.summary.ok).toBe(true)
    expect(second.summary.failures).toEqual([])
  })

  it('resumes without re-running the recovered steps already completed', async () => {
    seedBoth()
    const manifest = buildDeletionManifest(TARGET)
    const start = { step: manifest.length - 1, deleted: 0, failures: [] as string[] }
    const { summary } = await runEventDeletion(TARGET, 400, start)
    expect(summary.ok).toBe(true)
    // Skipped steps were genuinely skipped — the cursor is honoured, not ignored.
    expect(col('eventSessions').has('mine')).toBe(true)
    expect(col('printTemplates').has('mine')).toBe(true)
    expect(col('events').has(TARGET.eventSlug)).toBe(false)
  })
})

// ─── 7 · The retention boundary, restated over the wider manifest ─────────────

describe('the retention boundary holds after the additions', () => {
  const manifest = buildDeletionManifest(TARGET)
  const collectionOf2 = (p: string) => { const x = p.split('/'); return x[x.length - 2] ?? x[0] }
  const touched = manifest.flatMap(s =>
    s.kind === 'query'           ? [s.collection]
    : s.kind === 'doc'           ? [collectionOf2(s.path)]
    : s.kind === 'subcollection' ? [collectionOf2(s.parentPath), s.name]
    : [])

  it('retains paymentEvents (Razorpay webhook idempotency)', () => {
    expect(touched).not.toContain('paymentEvents')
  })

  it('retains paymentIntents — payment evidence, despite carrying eventSlug', () => {
    // It WOULD be queryable by event. It is retained on policy, not on inability.
    expect(touched).not.toContain('paymentIntents')
  })

  it('retains every financial and audit collection', () => {
    for (const c of [
      'platformTransactions', 'walletTransactions', 'settlementRequests', 'settlementReleases',
      'walletClawbacks', 'organizerRevenueWallets', 'eventLicenses', 'licenseOrders',
      'donations', 'donationPayments', 'donationReceipts', 'adminAuditLogs',
    ]) expect(touched, `${c} must be retained`).not.toContain(c)
  })

  it('retains CRM data — a contact legitimately spans events', () => {
    expect(touched).not.toContain('crmContacts')
    expect(touched).not.toContain('crmActivities')
  })

  it('retains reportExportJobs — no field identifies exactly one event', () => {
    // ReportExportJob extends Job (no event key); only an optional nested `filters.event`,
    // absent entirely for organizer-wide exports.
    expect(touched).not.toContain('reportExportJobs')
  })

  it('never touches shared or global collections', () => {
    for (const c of ['globalCertificateTemplates', 'emailSuppressionList', 'platformSettings', 'users']) {
      expect(touched).not.toContain(c)
    }
  })
})

describe('speaker photos are not deleted by key', () => {
  it('no manifest step deletes a photoUrl', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/events/eventDeletion.ts'), 'utf8')
    expect(src).not.toMatch(/photoUrl.*storage\.delete|storage\.delete\(.*photoUrl/)
  })

  it('only the event prefix sweep can remove a speaker photo', async () => {
    col('events').set(TARGET.eventSlug, { name: 'T' })
    col('eventSpeakers').set('sp1', {
      eventSlug: TARGET.eventSlug,
      photoUrl:  'https://cdn.example.com/outside/speaker.jpg',   // outside the prefix
    })
    listed = [`events/${TARGET.eventSlug}/media/inside.jpg`]
    await runEventDeletion(TARGET)
    expect(deletedKeys).toEqual([`events/${TARGET.eventSlug}/media/inside.jpg`])
    expect(deletedKeys.some(k => k.includes('cdn.example.com'))).toBe(false)
  })
})

// ─── 8 · The Archived TAB's card menu ─────────────────────────────────────────
//
// THE DEFECT THIS PINS. Permanent deletion was wired into the event DETAIL page
// (EventActionsPanel) only. The Archived tab's card renders a completely separate "…" menu
// in EventsClient, which never offered the action — so on the surface where an operator
// actually manages archived events, the feature was invisible. Backend and endpoint were
// fine; the integration was missing.

describe('the Archived tab card menu offers permanent deletion', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/events/EventsClient.tsx'), 'utf8')

  it('gates the action on ARCHIVED specifically', () => {
    expect(src).toMatch(/const canDeleteForever = ls === 'archived'/)
    expect(src).toMatch(/\{canDeleteForever && \(/)
  })

  it('does NOT reuse isReadOnly — completed and cancelled are read-only but not deletable', () => {
    // isReadOnly covers archived|completed|cancelled. Gating on it would offer permanent
    // deletion for two states the server refuses with 409.
    expect(src).toMatch(/const isReadOnly\s+= ls === 'archived' \|\| ls === 'completed' \|\| ls === 'cancelled'/)
    expect(src).not.toMatch(/isReadOnly && \([\s\S]{0,200}Delete Permanently/)
  })

  it('renders the label and a deleting state', () => {
    expect(src).toMatch(/Delete Permanently/)
    expect(src).toMatch(/deleting \? 'Deleting…' : 'Delete Permanently'/)
  })

  it('calls the EXISTING endpoint — no second deletion route', () => {
    expect(src).toMatch(/fetch\(`\/api\/organizer\/events\/\$\{event\.draftId\}`, \{\s*method:\s*'DELETE'/)
    // The draft-delete path is a different, pre-existing flow and must stay separate.
    expect(src).not.toMatch(/eventDeletion|buildDeletionManifest/)
  })

  it('confirms through the SHARED dialog with the SHARED copy', () => {
    expect(src).toMatch(/PERMANENT_DELETE_TITLE/)
    expect(src).toMatch(/message:\s+PERMANENT_DELETE_DESCRIPTION/)
    expect(src).toMatch(/tone:\s+'danger'/)
  })

  it('cancelling the confirmation deletes nothing', () => {
    // `confirm()` resolves false on Cancel; the handler must return before any fetch.
    const fn = src.slice(src.indexOf('async function handlePermanentDelete'), src.indexOf('// Event was returned by an admin'))
    expect(fn).toMatch(/if \(!ok\) return/)
    expect(fn.indexOf('if (!ok) return')).toBeLessThan(fn.indexOf('fetch('))
  })

  it('derives success from the payload, not the HTTP status alone', () => {
    expect(src).toMatch(/if \(!res\.ok \|\| !json\.success\)/)
  })

  it('prevents duplicate submission', () => {
    const fn = src.slice(src.indexOf('async function handlePermanentDelete'), src.indexOf('// Event was returned by an admin'))
    expect(fn).toMatch(/if \(deleting\) return/)
  })

  it('uses the existing destructive token, not an arbitrary colour', () => {
    expect(src).toMatch(/text-red-600 hover:bg-red-50/)
  })

  it('leaves Archive unavailable for an already-archived event', () => {
    // Archive is rendered under !isReadOnly, and archived IS read-only — so it cannot show.
    const menu = src.slice(src.indexOf('{menuOpen && ('), src.indexOf('{isDraft && onDelete && ('))
    expect(menu).toMatch(/\{!isReadOnly && \([\s\S]*?Archive/)
  })

  it('keeps Edit / Duplicate / Manage behaviour unchanged', () => {
    expect(src).toMatch(/isDraft \? 'Continue Setup' : 'Edit'/)
    expect(src).toMatch(/<Copy className="size-3\.5" \/> Duplicate/)
    expect(src).toMatch(/isReadOnly \? 'View' : isDraft \? 'Continue Setup' : 'Manage'/)
  })
})

describe('both delete surfaces share one contract', () => {
  const list   = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/events/EventsClient.tsx'), 'utf8')
  const detail = readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/events/[eventId]/EventActionsPanel.tsx'), 'utf8')

  it('neither hard-codes the confirmation sentence', () => {
    for (const [name, src] of [['list', list], ['detail', detail]] as const) {
      expect(src, name).not.toContain('This permanently deletes the archived event and its')
      expect(src, name).toMatch(/PERMANENT_DELETE_DESCRIPTION/)
    }
  })

  it('both gate on archived only', () => {
    for (const src of [list, detail]) expect(src).toMatch(/canDeleteForever = ls === 'archived'/)
  })

  it('both target the same endpoint', () => {
    for (const src of [list, detail]) expect(src).toMatch(/\/api\/organizer\/events\/\$\{event\.draftId\}`, \{\s*method:\s*'DELETE'/)
  })
})
