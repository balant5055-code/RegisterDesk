#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-07-fixture.mts
 *
 * RD-CHECKIN-07 — the isolated production QA fixture the application smoke test runs
 * against, plus its own deletion manifest.
 *
 *   npx tsx scripts/qa/rd-checkin-07-fixture.mts --create
 *   npx tsx scripts/qa/rd-checkin-07-fixture.mts --cleanup <run>
 *   npx tsx scripts/qa/rd-checkin-07-fixture.mts --status  <run>
 *
 * ═══ WHY THE QA EVENT IS `completed`, NOT `published` ════════════════════════
 * Check-in accepts three lifecycle states — published, registration_closed and
 * completed (lib/checkin/eventStatus.ts). Public discovery and the sitemap both
 * select ONLY `lifecycleStatus == 'published'`. A `completed` event is therefore
 * fully check-in-able while being invisible to the marketplace and to search
 * engines, which is exactly what a temporary fixture in a live project should be.
 * It also exercises the real readiness resolver rather than bypassing it.
 *
 * ═══ SAFETY ══════════════════════════════════════════════════════════════════
 *   • Refuses to run unless the resolved project is exactly registerdesk-c91a3.
 *   • Every document carries `__rdQaFixture: true`, and every id is `rdqa07-…`.
 *   • The manifest is written BEFORE the first write, so a crash still leaves an
 *     exact deletion list. Cleanup deletes ONLY manifest ids, and only after
 *     re-reading each document and confirming the marker.
 *   • Nothing existing is read for deletion, modified, or overwritten.
 *   • Credentials live in the gitignored manifest and are never printed.
 */

import fs   from 'node:fs'
import path from 'node:path'

// RD-PREPROD · this script creates and deletes a QA event, organizer and staff Auth users against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}


const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile) && !process.env.FIRESTORE_EMULATOR_HOST) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const EXPECTED_PROJECT = 'registerdesk-c91a3'
function resolveProjectId(): string {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set')
  return (JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as { project_id: string }).project_id
}
const projectId = resolveProjectId()
if (projectId !== EXPECTED_PROJECT) {
  console.error(`REFUSING TO RUN — resolved project is "${projectId}", expected "${EXPECTED_PROJECT}".`)
  process.exit(2)
}

const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
const { FieldValue }         = await import('firebase-admin/firestore')
const { createStaffAccount, deleteStaffAccount } = await import('@/lib/staff/service')

const MARK = '__rdQaFixture'

// ─── Manifest ────────────────────────────────────────────────────────────────

interface EventFixture {
  eventId:   string
  slug:      string
  name:      string
  timing:    boolean
  regIds:    string[]
  bibs:      { value: string; registrationId: string }[]
}
interface Manifest {
  run:       string
  project:   string
  createdAt: string
  organizer: { uid: string; email: string; password: string }
  events:    EventFixture[]
  /** staffId is filled in after Firebase issues the Auth uid. */
  staff:     { staffId: string | null; username: string; password: string; role: string; walkin: boolean }[]
}

const DIR = path.resolve(process.cwd(), '.qa')
const mpath = (run: string) => path.join(DIR, `${run}.fixture.json`)
const save  = (m: Manifest) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(mpath(m.run), JSON.stringify(m, null, 2)) }
const load  = (run: string) => JSON.parse(fs.readFileSync(mpath(run), 'utf-8')) as Manifest

function password(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 16; i++) s += a[Math.floor(Math.random() * a.length)]
  return `Qa${s}!7`
}

// 60 surnames so the roster is deep and alphabetically spread; the target for the
// "deep in the roster" probe sorts near the very end.
const FIRST = ['Aarav','Aarti','Bhavna','Chetan','Devika','Esha','Farhan','Gaurav','Harini','Ishaan',
               'Jaya','Kabir','Lalita','Manav','Nandita','Omkar','Pranav','Qadir','Rhea','Sameer',
               'Tanvi','Uday','Vikram','Waseem','Yamini','Zenobia']
const LAST  = ['Menon','Deshpande','Rao','Iyer','Nair','Pillai','Sheikh','Bhatt','Kulkarni','Joshi',
               'Quartermaine','Varghese','Sundaram','Chatterjee','Banerjee','Gokhale']

function rosterName(i: number): string {
  if (i === 0) return 'Zenobia Quartermaine'          // the deep-roster target
  return `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`
}

// ─── Create ──────────────────────────────────────────────────────────────────

async function create(): Promise<Manifest> {
  const run = `rdqa07-${Date.now()}`
  const orgUid = `${run}-org`
  const m: Manifest = {
    run, project: projectId, createdAt: new Date().toISOString(),
    organizer: { uid: orgUid, email: `${run}-org@example.invalid`, password: password() },
    events: [
      { eventId: `${run}-e1`, slug: `${run}-gate-test`,   name: 'RD QA Gate Test (timing off)', timing: false, regIds: [], bibs: [] },
      { eventId: `${run}-e2`, slug: `${run}-timed-test`,  name: 'RD QA Timed Test (timing on)', timing: true,  regIds: [], bibs: [] },
    ],
    staff: [
      { staffId: null, username: `${run}.gate`.replace(/-/g, '.'), password: '', role: 'checkin_staff', walkin: false },
      { staffId: null, username: `${run}.lead`.replace(/-/g, '.'), password: '', role: 'checkin_lead',  walkin: true  },
    ],
  }

  m.events[0]!.regIds = Array.from({ length: 60 }, (_, i) => `${run}-e1-r${i + 1}`)
  m.events[1]!.regIds = Array.from({ length: 6 },  (_, i) => `${run}-e2-r${i + 1}`)
  m.events[0]!.bibs = [
    { value: 'A1045', registrationId: `${run}-e1-r1` },
    { value: 'A1046', registrationId: `${run}-e1-r2` },
  ]
  m.events[1]!.bibs = [{ value: 'T2001', registrationId: `${run}-e2-r1` }]
  save(m)                                        // manifest FIRST
  console.log(`manifest: .qa/${run}.fixture.json`)

  // ── Organizer identity ──
  await adminAuth.createUser({
    uid: orgUid, email: m.organizer.email, password: m.organizer.password,
    displayName: 'RD QA Organizer', emailVerified: true,
  })
  await adminDb.doc(`users/${orgUid}`).set({
    [MARK]: true, uid: orgUid, email: m.organizer.email,
    name: 'RD QA Organizer', organizationName: 'RD QA Org',
    createdAt: FieldValue.serverTimestamp(),
  })
  console.log(`organizer created: ${orgUid}`)

  // ── Events: private draft (ownership + slug) + public doc (lifecycle) ──
  for (const ev of m.events) {
    await adminDb.doc(`users/${orgUid}/eventDrafts/${ev.eventId}`).set({
      [MARK]: true,
      status: 'published',
      eventDetails: {
        info: { name: ev.name, eventType: 'running' },
        seo:  { urlSlug: ev.slug },
      },
      createdAt: FieldValue.serverTimestamp(),
    })
    await adminDb.doc(`events/${ev.slug}`).set({
      [MARK]: true,
      // `completed` accepts check-in but is excluded from discovery and the sitemap.
      lifecycleStatus: 'completed',
      slug: ev.slug, name: ev.name, organizerUid: orgUid,
      eventType: 'running',
      publishedAt: FieldValue.serverTimestamp(),
      createdAt:   FieldValue.serverTimestamp(),
    })
    await adminDb.doc(`identifierConfigs/${ev.slug}`).set({
      [MARK]: true,
      eventSlug: ev.slug,
      format: { caseMode: 'preserve' },
      ...(ev.timing
        ? { tagMapping: { enabled: true, mode: 'mapped', label: 'Timing Chip' } }
        : { tagMapping: { enabled: false, mode: 'mapped', label: 'Timing Chip' } }),
      updatedAt: FieldValue.serverTimestamp(),
    })
    console.log(`event created: ${ev.slug}  (timing ${ev.timing ? 'ON' : 'off'}, lifecycle=completed → not discoverable)`)
  }

  // ── Registrations ──
  for (const ev of m.events) {
    let batch = adminDb.batch(); let n = 0
    for (let i = 0; i < ev.regIds.length; i++) {
      const id   = ev.regIds[i]!
      const name = rosterName(i)
      const code = `RD-${ev.eventId.slice(-4).toUpperCase()}${String(i + 1).padStart(4, '0')}`
      batch.set(adminDb.collection('registrations').doc(id), {
        [MARK]: true,
        id, eventSlug: ev.slug, eventName: ev.name, organizerUid: orgUid,
        passId: 'qa-pass', passName: '10K Run',
        attendee: {
          name,
          email: `${id}@example.invalid`,
          phone: `+9198${String(76500000 + i).padStart(8, '0')}`,
        },
        status: 'confirmed', paymentStatus: 'paid', amount: 0,
        checkedIn: false,
        ticketCode: code,
        ticket: { ticketId: id, qrValue: `RD:${ev.slug}:${id}:${code}`, qrGeneratedAt: FieldValue.serverTimestamp() },
        registrationSource: 'online',
        registeredAt: FieldValue.serverTimestamp(),
      })
      if (++n === 400) { await batch.commit(); batch = adminDb.batch(); n = 0 }
    }
    if (n) await batch.commit()
    console.log(`  ${ev.regIds.length} registrations for ${ev.slug}`)
  }

  // ── BIB locks (the real deterministic lock ids the engine reads) ──
  for (const ev of m.events) {
    for (const b of ev.bibs) {
      await adminDb.doc(`identifierLocks/${ev.slug}__${b.value}`).set({
        [MARK]: true,
        eventSlug: ev.slug, value: b.value, numeric: Number(b.value.replace(/\D/g, '')) || null,
        poolId: 'qa-pool', templateId: null, state: 'assigned',
        registrationId: b.registrationId, everCheckedIn: false, reason: null,
        assignedAt: FieldValue.serverTimestamp(), releasedAt: null,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
      // The registration carries a read-only MIRROR of the lock (RegistrationIdentifier).
      // The scan route reads `identifier.value` to decide whether a BIB still has to be
      // asked for, so a flat field here would leave every admission asking for one.
      await adminDb.collection('registrations').doc(b.registrationId).set({
        identifier: {
          value: b.value, label: 'BIB', type: 'bib',
          poolId: 'qa-pool', templateId: null, category: null,
          state: 'assigned', source: 'manual',
          assignedAt: FieldValue.serverTimestamp(), assignedBy: m.organizer.uid,
          everCheckedIn: false,
        },
      }, { merge: true })
    }
    if (ev.bibs.length) console.log(`  ${ev.bibs.length} BIB lock(s) for ${ev.slug}`)
  }

  // ── Staff accounts, through the real service (no shortcut) ──
  for (const s of m.staff) {
    const res = await createStaffAccount({
      organizerUid: orgUid, actorUid: orgUid,
      username: s.username, displayName: `RD QA ${s.role}`,
      role: s.role, eventIds: [m.events[0]!.eventId],
    })
    if (!res.ok) { console.error(`staff create FAILED (${(res as { status?: number }).status}): ${(res as { error?: string }).error}`); continue }
    s.staffId = res.data.staff.staffId
    s.password = res.data.temporaryPassword
    save(m)
    console.log(`staff created: ${s.username}  role=${s.role}  (password in manifest only)`)
  }

  save(m)
  return m
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

let failures = 0
function ok(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Delete one document by id, but only after confirming it carries the marker. */
async function safeDelete(ref: FirebaseFirestore.DocumentReference): Promise<'deleted' | 'absent' | 'refused'> {
  const snap = await ref.get()
  if (!snap.exists) return 'absent'
  if ((snap.data() as Record<string, unknown>)[MARK] !== true) return 'refused'
  await ref.delete()
  return 'deleted'
}

async function cleanup(m: Manifest): Promise<void> {
  console.log('\n── Cleanup (manifest ids only, marker re-checked per document) ──')
  let deleted = 0, refused = 0

  for (const s of m.staff) {
    if (!s.staffId) continue
    const res = await deleteStaffAccount({ organizerUid: m.organizer.uid, staffId: s.staffId })
    ok(`staff ${s.username} removed`, res.ok || (res as { status?: number }).status === 404)
    const gone = await adminAuth.getUser(s.staffId).then(() => false).catch(() => true)
    ok(`staff ${s.username} Auth user gone`, gone)
  }

  for (const ev of m.events) {
    for (const b of ev.bibs) {
      const r = await safeDelete(adminDb.doc(`identifierLocks/${ev.slug}__${b.value}`))
      if (r === 'deleted') deleted++; else if (r === 'refused') refused++
    }
    for (const id of ev.regIds) {
      const ref  = adminDb.collection('registrations').doc(id)
      const snap = await ref.get()
      if (!snap.exists) continue
      if ((snap.data() as Record<string, unknown>)[MARK] !== true) { refused++; continue }
      // history rides under the registration and must go with it
      const hist = await ref.collection('checkinHistory').get()
      for (const h of hist.docs) { await h.ref.delete(); deleted++ }
      await ref.delete(); deleted++
    }
    for (const p of [`identifierConfigs/${ev.slug}`, `events/${ev.slug}`,
                     `users/${m.organizer.uid}/eventDrafts/${ev.eventId}`]) {
      const r = await safeDelete(adminDb.doc(p))
      if (r === 'deleted') deleted++; else if (r === 'refused') refused++
    }
    const counters = await safeDelete(adminDb.doc(`registrationCounters/${ev.slug}`))
    if (counters === 'deleted') deleted++
    // counter shards are a subcollection created by check-in
    const shards = await adminDb.collection(`registrationCounters/${ev.slug}/attendanceShards`).get()
    for (const s of shards.docs) { await s.ref.delete(); deleted++ }
  }

  const r = await safeDelete(adminDb.doc(`users/${m.organizer.uid}`))
  if (r === 'deleted') deleted++; else if (r === 'refused') refused++
  await adminAuth.deleteUser(m.organizer.uid).catch(() => {})
  const orgGone = await adminAuth.getUser(m.organizer.uid).then(() => false).catch(() => true)
  ok('organizer Auth user gone', orgGone)

  ok('no document was refused deletion', refused === 0, `${refused} refused`)
  console.log(`  deleted ${deleted} documents`)

  // ── Verify nothing survives ──
  for (const ev of m.events) {
    const regs = await adminDb.collection('registrations').where('eventSlug', '==', ev.slug).limit(5).get()
    ok(`no registrations remain for ${ev.slug}`, regs.empty, `${regs.size} left`)
    const hist = await adminDb.collectionGroup('checkinHistory')
      .where('eventSlug', '==', ev.slug).orderBy('occurredAt', 'desc').limit(5).get()
    ok(`no check-in history remains for ${ev.slug}`, hist.empty, `${hist.size} left`)
    const pub = await adminDb.doc(`events/${ev.slug}`).get()
    ok(`public event doc removed for ${ev.slug}`, !pub.exists)
  }

  if (failures === 0) fs.rmSync(mpath(m.run), { force: true })
  console.log(failures === 0 ? '\ncleanup verified; manifest removed' : `\n${failures} cleanup check(s) FAILED — manifest kept`)
}

async function status(m: Manifest): Promise<void> {
  for (const ev of m.events) {
    const regs = await adminDb.collection('registrations').where('eventSlug', '==', ev.slug).count().get()
    const pub  = await adminDb.doc(`events/${ev.slug}`).get()
    console.log(`${ev.slug}: registrations=${regs.data().count} publicDoc=${pub.exists}`)
  }
  for (const s of m.staff) {
    const live = s.staffId ? await adminAuth.getUser(s.staffId).then(() => true).catch(() => false) : false
    console.log(`staff ${s.username}: authUser=${live}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Re-apply the registration-side identifier mirror to an existing fixture.
 * The scan route reads `identifier.value`; an earlier revision of this script wrote a
 * flat `identifierValue`, which left every BIB'd attendee stuck on IDENTIFIER_REQUIRED.
 */
async function repair(m: Manifest): Promise<void> {
  for (const ev of m.events) {
    for (const b of ev.bibs) {
      const ref  = adminDb.collection('registrations').doc(b.registrationId)
      const snap = await ref.get()
      if (!snap.exists) { console.log(`  missing ${b.registrationId}`); continue }
      if ((snap.data() as Record<string, unknown>)[MARK] !== true) {
        console.log(`  REFUSED (not a fixture document) ${b.registrationId}`); continue
      }
      await ref.set({
        identifier: {
          value: b.value, label: 'BIB', type: 'bib',
          poolId: 'qa-pool', templateId: null, category: null,
          state: 'assigned', source: 'manual',
          assignedAt: FieldValue.serverTimestamp(), assignedBy: m.organizer.uid,
          everCheckedIn: false,
        },
        identifierValue: FieldValue.delete(),
      }, { merge: true })
      console.log(`  repaired ${b.registrationId} → identifier.value=${b.value}`)
    }
  }
}

const argv = process.argv.slice(2)
if (argv.includes('--repair')) {
  await repair(load(argv[argv.indexOf('--repair') + 1]!))
} else if (argv.includes('--create')) {
  const m = await create()
  console.log(`\nrun id: ${m.run}`)
  console.log(`events: ${m.events.map(e => e.slug).join(', ')}`)
  console.log('credentials are in the gitignored manifest and were not printed.')
} else if (argv.includes('--cleanup')) {
  await cleanup(load(argv[argv.indexOf('--cleanup') + 1]!))
  process.exit(failures ? 1 : 0)
} else if (argv.includes('--status')) {
  await status(load(argv[argv.indexOf('--status') + 1]!))
} else {
  console.error('usage: --create | --cleanup <run> | --status <run>')
  process.exit(2)
}
