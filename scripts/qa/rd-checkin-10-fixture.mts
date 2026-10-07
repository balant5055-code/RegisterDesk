#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-10-fixture.mts
 *
 * RD-CHECKIN-10 — the extras the final gate needs on top of
 * scripts/emulator/seed-checkin-qa.mjs: staff credentials (one event and two), a
 * timing-ENABLED event, and a timing tag on one attendee.
 *
 *   npx dotenv-cli -e .env.emulator -- npx tsx scripts/qa/rd-checkin-10-fixture.mts --create
 *   npx dotenv-cli -e .env.emulator -- npx tsx scripts/qa/rd-checkin-10-fixture.mts --cleanup
 *
 * ═══ EMULATOR ONLY ═══════════════════════════════════════════════════════════
 * This phase deliberately runs the application against the Firebase EMULATOR, not
 * production. What Phases 2–5 ask about — a camera, a real disconnect, timing
 * vocabulary, an event chooser — are questions about the APPLICATION, and none of
 * them needs live data. Production index behaviour and the live security model were
 * already settled in RD-CHECKIN-06/07 against the real project, so nothing is lost
 * by keeping this run off production entirely.
 *
 * The script REFUSES to run unless the emulator hosts are set, so it cannot be
 * pointed at the real project by accident.
 */

import fs   from 'node:fs'
import path from 'node:path'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('REFUSING TO RUN — emulator hosts are not set. This fixture is emulator-only.')
  process.exit(2)
}

const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
const { FieldValue }         = await import('firebase-admin/firestore')
const { createStaffAccount, deleteStaffAccount } = await import('@/lib/staff/service')

const MARK = '__rdQaFixture'
const ORG_EMAIL   = 'qa.checkin@registerdesk.test'
const EVENT_A     = { id: 'qa-checkin-event', slug: 'meridian-city-half' }   // timing OFF
const EVENT_B     = { id: 'qa-checkin-other', slug: 'meridian-trail-10k' }   // timing ON
const TIMING_TAG  = 'CHIP-7788'

interface Manifest {
  createdAt: string
  organizerUid: string
  staff: { staffId: string | null; username: string; password: string; events: string[] }[]
  identifierConfigs: string[]
  timedRegistrationIds: string[]
  taggedRegistrationId: string | null
}

const MPATH = path.resolve(process.cwd(), '.qa', 'rd-checkin-10.fixture.json')
const save = (m: Manifest) => {
  fs.mkdirSync(path.dirname(MPATH), { recursive: true })
  fs.writeFileSync(MPATH, JSON.stringify(m, null, 2))
}

async function create(): Promise<void> {
  const org = await adminAuth.getUserByEmail(ORG_EMAIL)
  const m: Manifest = {
    createdAt: new Date().toISOString(),
    organizerUid: org.uid,
    staff: [
      { staffId: null, username: 'rd10.gate.one', password: '', events: [EVENT_A.id] },
      { staffId: null, username: 'rd10.gate.both', password: '', events: [EVENT_A.id, EVENT_B.id] },
    ],
    identifierConfigs: [EVENT_A.slug, EVENT_B.slug],
    timedRegistrationIds: [],
    taggedRegistrationId: null,
  }
  save(m)                                             // manifest BEFORE any write

  // ── Timing: OFF on A, ON on B. Both configs are written so the negative case is
  //    an explicit `enabled: false` rather than an absent document.
  for (const [slug, on] of [[EVENT_A.slug, false], [EVENT_B.slug, true]] as const) {
    await adminDb.doc(`identifierConfigs/${slug}`).set({
      [MARK]: true,
      eventSlug: slug,
      format: { caseMode: 'preserve' },
      tagMapping: { enabled: on, mode: 'mapped', label: 'Timing Chip' },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    console.log(`identifierConfigs/${slug}: timing ${on ? 'ON' : 'off'}`)
  }

  // ── The base seed puts all 40 attendees on event A, so the timing event needs a
  //    few of its own before a timing card can be shown at all. Four is enough to
  //    search, admit and re-admit; this is a gate test, not a scale test.
  const TIMED = [
    { n: 'Farida Sheikh',  bib: 'T-3001' },
    { n: 'Girish Kamath',  bib: 'T-3002' },
    { n: 'Hema Subbu',     bib: 'T-3003' },
    { n: 'Irfan Qureshi',  bib: 'T-3004' },
  ]
  const batch = adminDb.batch()
  TIMED.forEach((t, i) => {
    const id   = `rd10-timed-r${i + 1}`
    const code = `RD-TRL-${String(i + 1).padStart(5, '0')}`
    m.timedRegistrationIds.push(id)
    batch.set(adminDb.collection('registrations').doc(id), {
      [MARK]: true,
      id, eventSlug: EVENT_B.slug, eventName: 'Meridian Trail 10K', organizerUid: org.uid,
      passId: 'qa-pass', passName: '10K Trail',
      attendee: { name: t.n, email: `${id}@example.invalid`, phone: `+9198${String(77700000 + i).padStart(8, '0')}` },
      status: 'confirmed', paymentStatus: 'paid', amount: 0, checkedIn: false,
      ticketCode: code,
      ticket: { ticketId: id, qrValue: `RD:${EVENT_B.slug}:${id}:${code}`, qrGeneratedAt: FieldValue.serverTimestamp() },
      // Identifier mirror — this event issues them, so an attendee without one is
      // sent to the BIB prompt rather than admitted (learned in RD-CHECKIN-07).
      identifier: {
        value: t.bib, label: 'BIB', type: 'bib', poolId: 'qa-pool', templateId: null,
        category: null, state: 'assigned', source: 'manual',
        assignedAt: FieldValue.serverTimestamp(), assignedBy: org.uid, everCheckedIn: false,
      },
      registeredAt: FieldValue.serverTimestamp(),
    })
  })
  await batch.commit()
  save(m)
  console.log(`${TIMED.length} registrations seeded on ${EVENT_B.slug}`)

  // One of them carries a timing tag, so the positive UI prints a real value rather
  // than "Not assigned" — both states are worth seeing.
  const tagged = adminDb.collection('registrations').doc(m.timedRegistrationIds[0]!)
  await tagged.set({
    timingTag: { tag: TIMING_TAG, state: 'assigned', assignedAt: FieldValue.serverTimestamp() },
  }, { merge: true })
  m.taggedRegistrationId = m.timedRegistrationIds[0]!
  save(m)
  console.log(`timing tag ${TIMING_TAG} → ${m.taggedRegistrationId} (${TIMED[0]!.n})`)

  // ── Staff credentials, through the real service.
  for (const s of m.staff) {
    const res = await createStaffAccount({
      organizerUid: org.uid, actorUid: org.uid,
      username: s.username, displayName: `RD10 ${s.username}`,
      role: 'checkin_staff', eventIds: s.events,
    })
    if (!res.ok) { console.error(`staff ${s.username} FAILED: ${(res as { error?: string }).error}`); continue }
    s.staffId = res.data.staff.staffId
    s.password = res.data.temporaryPassword
    save(m)
    console.log(`staff ${s.username}: ${s.events.length} event(s)`)
  }

  save(m)
  console.log('\nmanifest: .qa/rd-checkin-10.fixture.json')
}

async function cleanup(): Promise<void> {
  if (!fs.existsSync(MPATH)) { console.log('no manifest — nothing to clean'); return }
  const m = JSON.parse(fs.readFileSync(MPATH, 'utf-8')) as Manifest
  let failures = 0
  const ok = (n: string, p: boolean, d = '') => {
    if (!p) failures++
    console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
  }

  for (const s of m.staff) {
    if (!s.staffId) continue
    const res = await deleteStaffAccount({ organizerUid: m.organizerUid, staffId: s.staffId })
    ok(`staff ${s.username} removed`, res.ok || (res as { status?: number }).status === 404)
    ok(`staff ${s.username} Auth user gone`,
      await adminAuth.getUser(s.staffId).then(() => false).catch(() => true))
    const lock = await adminDb.collection('staffUsernames').doc(s.username).get()
    ok(`username lock ${s.username} released`, !lock.exists)
    const prof = await adminDb.collection('staffAccounts').doc(s.staffId).get()
    ok(`staff profile ${s.username} gone`, !prof.exists)
  }

  // Configs are marked, so only ours are removed — by id, never by query.
  for (const slug of m.identifierConfigs) {
    const ref  = adminDb.doc(`identifierConfigs/${slug}`)
    const snap = await ref.get()
    if (!snap.exists) continue
    if ((snap.data() as Record<string, unknown>)[MARK] !== true) {
      ok(`refused to delete unmarked identifierConfigs/${slug}`, false, 'LEFT UNTOUCHED'); continue
    }
    await ref.delete()
    ok(`identifierConfigs/${slug} removed`, true)
  }

  for (const id of m.timedRegistrationIds ?? []) {
    const ref = adminDb.collection('registrations').doc(id)
    const snap = await ref.get()
    if (!snap.exists) continue
    if ((snap.data() as Record<string, unknown>)[MARK] !== true) { ok(`refused to delete unmarked ${id}`, false, 'LEFT UNTOUCHED'); continue }
    const hist = await ref.collection('checkinHistory').get()
    for (const h of hist.docs) await h.ref.delete()
    await ref.delete()
  }
  ok('seeded timing registrations removed', true, `${(m.timedRegistrationIds ?? []).length} ids`)

  if (m.taggedRegistrationId && !(m.timedRegistrationIds ?? []).includes(m.taggedRegistrationId)) {
    await adminDb.collection('registrations').doc(m.taggedRegistrationId)
      .set({ timingTag: FieldValue.delete() }, { merge: true })
    const after = await adminDb.collection('registrations').doc(m.taggedRegistrationId).get()
    ok('timing tag removed from the attendee',
      (after.data() as { timingTag?: unknown } | undefined)?.timingTag === undefined)
  }

  const left = await adminDb.collection('staffAccounts')
    .where('organizerUid', '==', m.organizerUid).get()
  ok('no RD-CHECKIN-10 staff accounts remain', left.empty, `${left.size} left`)

  if (failures === 0) fs.rmSync(MPATH, { force: true })
  console.log(failures === 0 ? '\ncleanup verified; manifest removed' : `\n${failures} check(s) FAILED — manifest kept`)
  process.exit(failures ? 1 : 0)
}

const argv = process.argv.slice(2)
if (argv.includes('--create'))       await create()
else if (argv.includes('--cleanup')) await cleanup()
else { console.error('usage: --create | --cleanup'); process.exit(2) }
