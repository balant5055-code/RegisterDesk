#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-06-live.ts
 *
 * RD-CHECKIN-06 — live validation of Check-in 2.0 against the REAL Firebase
 * project, run once after `firestore.rules` and `firestore.indexes.json` were
 * deployed to registerdesk-c91a3.
 *
 *   npx tsx scripts/qa/rd-checkin-06-live.ts            # create → verify → clean
 *   npx tsx scripts/qa/rd-checkin-06-live.ts --keep     # leave the fixture behind
 *   npx tsx scripts/qa/rd-checkin-06-live.ts --cleanup-only <RUN>
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * The emulator does not enforce indexes, so every emulator pass is silent about the
 * one thing that can only fail in production: a query whose composite index does not
 * exist comes back FAILED_PRECONDITION. The two queries Check-in 2.0 added — the
 * name-prefix lookup and the collection-group history read — are therefore executed
 * here against the real database. A query that RETURNS is proof the index is READY;
 * "deploy succeeded" only proves it was submitted.
 *
 * Firebase Auth is likewise only real here: nothing local can answer whether the live
 * service accepts an address on the reserved `staff.registerdesk.invalid` domain.
 *
 * ═══ SAFETY ══════════════════════════════════════════════════════════════════
 *   • Refuses to run unless the resolved project is exactly registerdesk-c91a3.
 *   • Every object it creates is named `rdqa06-<epoch>-…`, which cannot collide with
 *     a real slug, uid or username, and the full id list is written to the manifest
 *     BEFORE the first write — so a crash still leaves an exact cleanup list.
 *   • Cleanup deletes ONLY ids from that manifest. It never queries for "test-looking"
 *     data and never touches an existing event, registration, user or staff account.
 *   • It writes raw documents rather than going through the registration transaction,
 *     so no counter, no rollup and no organizer's dashboard is moved by this run.
 *   • The generated staff password is never printed, logged or written to disk.
 */

import fs   from 'node:fs'
import path from 'node:path'

// RD-PREPROD · this script creates, verifies and deletes a QA fixture against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}


const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile) && !process.env.FIRESTORE_EMULATOR_HOST) {
  // split(/\r?\n/) — see the note in scripts/backfill-organizer-daily-stats.ts.
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const EXPECTED_PROJECT = 'registerdesk-c91a3'

// ─── Target guard, BEFORE the Admin SDK is imported ──────────────────────────
// An assertion after `import { adminDb }` would already have connected.
function resolveProjectId(): string {
  if (process.env.FIRESTORE_EMULATOR_HOST) return '(emulator)'
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set')
  return (JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as { project_id: string }).project_id
}

const projectId = resolveProjectId()
if (projectId !== EXPECTED_PROJECT) {
  console.error(`REFUSING TO RUN — resolved project is "${projectId}", expected "${EXPECTED_PROJECT}".`)
  process.exit(2)
}
console.log(`target project: ${projectId}\n`)

const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
const { FieldValue }         = await import('firebase-admin/firestore')
const { appendCheckinHistory, getEventCheckinHistory, getCheckinHistory } =
  await import('@/lib/checkin/history')
const { createStaffAccount, deleteStaffAccount, getStaffAccount } =
  await import('@/lib/staff/service')
const { staffEmailForUsername } = await import('@/lib/staff/types')

// ─── Manifest ────────────────────────────────────────────────────────────────

interface Manifest {
  run:            string
  project:        string
  createdAt:      string
  eventSlug:      string
  organizerUid:   string
  registrationIds: string[]
  /** Filled in after creation — the Auth uid is issued by Firebase. */
  staffId:        string | null
  staffUsername:  string
}

const MANIFEST_DIR = path.resolve(process.cwd(), '.qa')
const manifestPath = (run: string) => path.join(MANIFEST_DIR, `${run}.manifest.json`)

function writeManifest(m: Manifest): void {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true })
  fs.writeFileSync(manifestPath(m.run), JSON.stringify(m, null, 2))
}

// ─── Result bookkeeping ──────────────────────────────────────────────────────

const results: { phase: string; name: string; ok: boolean; detail: string }[] = []
function check(phase: string, name: string, ok: boolean, detail = ''): void {
  results.push({ phase, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/** A missing/still-building composite index surfaces as FAILED_PRECONDITION (code 9). */
function isMissingIndex(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string }
  return e?.code === 9 || e?.code === 'failed-precondition' ||
         /FAILED_PRECONDITION|requires an index/i.test(e?.message ?? '')
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const NAMES = ['Aarav Menon', 'Aarti Deshpande', 'Bhavna Rao', 'Chetan Iyer', 'Zoya Khan']

async function createFixture(run: string): Promise<Manifest> {
  const m: Manifest = {
    run,
    project:         projectId,
    createdAt:       new Date().toISOString(),
    eventSlug:       run,
    organizerUid:    `${run}-org`,
    registrationIds: NAMES.map((_, i) => `${run}-r${i + 1}`),
    staffId:         null,
    staffUsername:   run.replace(/-/g, '.'),
  }
  writeManifest(m)                              // manifest FIRST, then any write
  console.log(`manifest: .qa/${run}.manifest.json`)

  const batch = adminDb.batch()
  m.registrationIds.forEach((id, i) => {
    batch.set(adminDb.collection('registrations').doc(id), {
      // Marked in the document itself as well as the id, so anyone who finds one of
      // these in the console knows immediately what it is and that it is disposable.
      __rdQaFixture: 'RD-CHECKIN-06',
      eventSlug:     m.eventSlug,
      organizerUid:  m.organizerUid,
      status:        'confirmed',
      paymentStatus: 'paid',
      amount:        0,
      checkedIn:     false,
      attendee:      { name: `RD CHECKIN QA ${NAMES[i]}`, email: `${run}-r${i + 1}@example.invalid`, phone: '' },
      registeredAt:  FieldValue.serverTimestamp(),
    })
  })
  await batch.commit()
  console.log(`created ${m.registrationIds.length} fixture registrations under eventSlug "${m.eventSlug}"\n`)
  return m
}

async function cleanup(m: Manifest): Promise<void> {
  console.log('\n── Phase J — scoped cleanup (manifest ids only) ──')
  let deleted = 0

  if (m.staffId) {
    const res = await deleteStaffAccount({ organizerUid: m.organizerUid, staffId: m.staffId })
    check('J', 'staff account + username lock + grant removed', res.ok,
      res.ok ? m.staffId : `status ${(res as { status?: number }).status}`)
    const gone = await getStaffAccount(m.staffId)
    check('J', 'staff profile is gone', gone === null)
    const authGone = await adminAuth.getUser(m.staffId).then(() => false).catch(() => true)
    check('J', 'staff Auth user is gone', authGone)
    const lock = await adminDb.collection('staffUsernames').doc(m.staffUsername).get()
    check('J', 'username lock released', !lock.exists)
  }

  for (const id of m.registrationIds) {
    const ref  = adminDb.collection('registrations').doc(id)
    const snap = await ref.get()
    if (!snap.exists) continue
    // Refuse to delete anything that is not ours, even though the id came from the
    // manifest — the id is a claim, the marker is the proof.
    if ((snap.data() as { __rdQaFixture?: string }).__rdQaFixture !== 'RD-CHECKIN-06') {
      check('J', `refused to delete unmarked doc ${id}`, false, 'LEFT UNTOUCHED')
      continue
    }
    const hist = await ref.collection('checkinHistory').get()
    for (const h of hist.docs) { await h.ref.delete(); deleted++ }
    await ref.delete()
    deleted++
  }
  check('J', 'fixture registrations + history entries removed', true, `${deleted} documents`)

  const left = await adminDb.collection('registrations').where('eventSlug', '==', m.eventSlug).get()
  check('J', 'no fixture registration remains for the QA slug', left.empty, `${left.size} left`)

  // orderBy('occurredAt') is NOT decoration here. A collection-group query with only
  // an equality has no composite to serve it, and Firestore does not auto-create
  // single-field indexes at COLLECTION_GROUP scope — so the bare query fails with
  // FAILED_PRECONDITION in production while passing silently against the emulator.
  // Ordering it puts the query back on the composite this phase deployed.
  const orphan = await adminDb.collectionGroup('checkinHistory')
    .where('eventSlug', '==', m.eventSlug)
    .orderBy('occurredAt', 'desc').limit(10).get()
  check('J', 'no orphaned history entry remains', orphan.empty, `${orphan.size} left`)

  fs.rmSync(manifestPath(m.run), { force: true })
}

// ─── Phases ──────────────────────────────────────────────────────────────────

async function phaseE(m: Manifest): Promise<void> {
  console.log('── Phase E — real name search against the deployed composite index ──')
  const PREFIX_HIGH = ''
  const prefix = 'RD CHECKIN QA A'
  try {
    const snap = await adminDb.collection('registrations')
      .where('eventSlug', '==', m.eventSlug)
      .orderBy('attendee.name')
      .startAt(prefix).endAt(prefix + PREFIX_HIGH)
      .limit(25).get()
    const names = snap.docs.map(d => (d.data() as { attendee: { name: string } }).attendee.name)
    check('E', 'eventSlug + attendee.name index is READY (query executed)', true,
      `${snap.size} hit(s)`)
    check('E', 'prefix match returns only the matching names', snap.size === 2 &&
      names.every(n => n.startsWith(prefix)), names.join(', '))

    const none = await adminDb.collection('registrations')
      .where('eventSlug', '==', m.eventSlug)
      .orderBy('attendee.name')
      .startAt('RD CHECKIN QA Zzz').endAt('RD CHECKIN QA Zzz' + PREFIX_HIGH)
      .limit(25).get()
    check('E', 'a non-matching prefix returns empty, not an error', none.empty)

    const scoped = await adminDb.collection('registrations')
      .where('eventSlug', '==', `${m.eventSlug}-other`)
      .orderBy('attendee.name')
      .startAt(prefix).endAt(prefix + PREFIX_HIGH).limit(25).get()
    check('E', 'the query is event-scoped (other slug sees nothing)', scoped.empty)
  } catch (err) {
    check('E', 'eventSlug + attendee.name index is READY', false,
      isMissingIndex(err) ? 'FAILED_PRECONDITION — index NOT ready' : String(err))
  }
}

async function phaseF(m: Manifest): Promise<void> {
  console.log('\n── Phase F — real checkinHistory collection-group query ──')
  const base = {
    eventSlug:    m.eventSlug,
    organizerUid: m.organizerUid,
    operatorUid:  `${m.run}-op`,
    workspaceUid: m.organizerUid,
    method:       'manual' as const,
  }
  // A realistic ledger: an admission, a duplicate attempt is NOT logged by design,
  // then an undo, then a re-admission.
  await appendCheckinHistory({ ...base, registrationId: m.registrationIds[0]!, action: 'CHECK_IN' })
  await appendCheckinHistory({ ...base, registrationId: m.registrationIds[1]!, action: 'CHECK_IN' })
  await appendCheckinHistory({ ...base, registrationId: m.registrationIds[0]!, action: 'CHECK_IN_UNDO', reason: 'gate correction' })
  await appendCheckinHistory({ ...base, registrationId: m.registrationIds[0]!, action: 'CHECK_IN' })

  try {
    const page = await getEventCheckinHistory(m.eventSlug, { limit: 3 })
    check('F', 'collection-group index is READY (query executed)', true, `${page.entries.length} entries`)
    check('F', 'newest first', page.entries.length === 3 &&
      page.entries[0]!.action === 'CHECK_IN' && page.entries[1]!.action === 'CHECK_IN_UNDO',
      page.entries.map(e => e.action).join(' , '))
    check('F', 'page hands back a cursor for the older page', page.nextBefore !== null)

    const next = await getEventCheckinHistory(m.eventSlug, {
      limit: 3, before: page.nextBefore ? new Date(page.nextBefore) : null,
    })
    check('F', 'pagination returns the remaining entry without overlap', next.entries.length === 1 &&
      !next.entries.some(e => page.entries.some(p => p.id === e.id)),
      `${next.entries.length} entry`)

    const all = await getEventCheckinHistory(m.eventSlug, { limit: 50 })
    check('F', 'ledger holds all four appended actions', all.entries.length === 4,
      all.entries.map(e => e.action).join(' → '))
    check('F', 'every entry is scoped to the QA event', all.entries.every(e => e.eventSlug === m.eventSlug))

    const per = await getCheckinHistory(m.registrationIds[0]!)
    check('F', 'per-registration timeline is oldest-first', per.length === 3 &&
      per[0]!.action === 'CHECK_IN' && per[1]!.action === 'CHECK_IN_UNDO' && per[2]!.action === 'CHECK_IN')
  } catch (err) {
    check('F', 'collection-group index is READY', false,
      isMissingIndex(err) ? 'FAILED_PRECONDITION — index NOT ready' : String(err))
  }
}

async function phaseG(m: Manifest): Promise<void> {
  console.log('\n── Phase G — real Firebase Auth on the reserved .invalid domain ──')
  const email = staffEmailForUsername(m.staffUsername)
  console.log(`  creating one staff credential at ${email}`)
  const res = await createStaffAccount({
    organizerUid: m.organizerUid,
    actorUid:     m.organizerUid,
    username:     m.staffUsername,
    displayName:  'RD CHECKIN QA Gate Operator',
    role:         'checkin_staff',
    eventIds:     [m.eventSlug],
  })

  if (!res.ok) {
    const status = (res as { status?: number }).status
    const msg    = (res as { error?: string }).error ?? ''
    check('G', 'Firebase Auth accepts the staff.registerdesk.invalid domain', false,
      `create failed (${status}): ${msg}`)
    return
  }

  m.staffId = res.data.staff.staffId
  writeManifest(m)                              // record the Auth uid before going on
  check('G', 'Firebase Auth accepts the staff.registerdesk.invalid domain', true, 'account created')
  check('G', 'generated password satisfies the live Auth password policy', true,
    `${res.data.temporaryPassword.length} chars (value not logged)`)

  const user = await adminAuth.getUser(m.staffId)
  check('G', 'Auth user email matches the reserved namespace', user.email === email, user.email ?? '—')
  check('G', 'emailVerified is set so sign-in is not gated on a mail we cannot send',
    user.emailVerified === true)

  const profile = await getStaffAccount(m.staffId)
  check('G', 'staff profile written', profile !== null)
  // `mustChangePassword` is a boolean policy flag, not a credential — the assertion is
  // that nothing stores or derives the secret itself.
  const credentialKeys = profile === null ? [] : Object.keys(profile)
    .filter(k => /password|secret|hash|salt/i.test(k) && k !== 'mustChangePassword')
  check('G', 'profile stores no password, hash or salt', profile !== null && credentialKeys.length === 0,
    credentialKeys.length ? credentialKeys.join(',') : Object.keys(profile ?? {}).join(','))
  check('G', 'event assignment is non-empty and scoped', profile !== null &&
    Array.isArray(profile.eventIds) && profile.eventIds.length === 1 &&
    profile.eventIds[0] === m.eventSlug)

  const lock = await adminDb.collection('staffUsernames').doc(m.staffUsername).get()
  check('G', 'username uniqueness lock exists', lock.exists)

  const dupe = await createStaffAccount({
    organizerUid: m.organizerUid, actorUid: m.organizerUid,
    username: m.staffUsername, displayName: 'RD CHECKIN QA Duplicate',
    role: 'checkin_staff', eventIds: [m.eventSlug],
  })
  check('G', 'a second account cannot take the same username', !dupe.ok,
    dupe.ok ? 'DUPLICATE CREATED' : `refused (${(dupe as { status?: number }).status})`)

  // The member-row id is sha256('staff:<organizerUid>:<staffId>') — found by query
  // rather than recomputed here, so this checks the grant the service actually wrote.
  const member = await adminDb.collection('teamMembers')
    .where('organizerUid', '==', m.organizerUid).limit(5).get()
  const row = member.docs[0]?.data() as { permissions?: string[]; eventIds?: string[] } | undefined
  check('G', 'workspace grant row issued for the staff account', member.size === 1,
    row ? `permissions=${JSON.stringify(row.permissions)}` : 'missing')
  check('G', 'grant carries gate permissions only (least privilege)',
    !!row?.permissions && row.permissions.every(p => p === 'checkin'),
    row ? JSON.stringify(row.permissions) : '—')
  check('G', 'grant is restricted to the assigned event',
    Array.isArray(row?.eventIds) && row!.eventIds!.length === 1 && row!.eventIds![0] === m.eventSlug,
    row ? JSON.stringify(row.eventIds) : '—')
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2)
const keep      = args.includes('--keep')
const cleanOnly = args.indexOf('--cleanup-only')

if (cleanOnly >= 0) {
  const run = args[cleanOnly + 1]
  if (!run) { console.error('--cleanup-only needs a run id'); process.exit(2) }
  const m = JSON.parse(fs.readFileSync(manifestPath(run), 'utf-8')) as Manifest
  await cleanup(m)
  process.exit(results.some(r => !r.ok) ? 1 : 0)
}

const run = `rdqa06-${Date.now()}`
const m   = await createFixture(run)

try {
  await phaseE(m)
  await phaseF(m)
  await phaseG(m)
} finally {
  if (!keep) await cleanup(m)
  else console.log(`\nfixture KEPT — clean with: npx tsx scripts/qa/rd-checkin-06-live.ts --cleanup-only ${run}`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} checks passed ═══`)
if (failed.length) {
  console.log('FAILURES:')
  failed.forEach(f => console.log(`  [${f.phase}] ${f.name} — ${f.detail}`))
}
process.exit(failed.length ? 1 : 0)
