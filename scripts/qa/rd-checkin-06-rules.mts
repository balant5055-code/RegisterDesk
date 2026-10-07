#!/usr/bin/env node
/**
 * scripts/qa/rd-checkin-06-rules.mts
 *
 * RD-CHECKIN-06 Phase I — adversarial client-SDK probes against the rules that were
 * just released to registerdesk-c91a3.
 *
 *   npx tsx scripts/qa/rd-checkin-06-rules.mts
 *
 * ═══ WHY SIGNED IN ═══════════════════════════════════════════════════════════
 * Probing anonymously would prove almost nothing: most of this database already
 * refuses an unauthenticated caller, so every probe would "pass" whether or not the
 * new deny blocks exist. The run therefore mints ONE temporary Auth user, signs the
 * client SDK in as it, and attacks from there — an authenticated, ordinary caller,
 * which is the threat these blocks were written for. The user is deleted at the end.
 *
 * It changes no rule. A probe that succeeds is reported as a FAILURE, never fixed by
 * relaxing anything.
 */

import fs   from 'node:fs'
import path from 'node:path'

// RD-PREPROD · this script creates and deletes a temporary Auth user against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}


const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const EXPECTED_PROJECT = 'registerdesk-c91a3'
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('REFUSING TO RUN — emulator host is set; this phase must hit the real project.')
  process.exit(2)
}
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
if (projectId !== EXPECTED_PROJECT) {
  console.error(`REFUSING TO RUN — client project is "${projectId}", expected "${EXPECTED_PROJECT}".`)
  process.exit(2)
}
console.log(`target project: ${projectId}\n`)

const { adminAuth } = await import('@/lib/firebase/admin')
const { initializeApp }   = await import('firebase/app')
const { getAuth, signInWithCustomToken, signOut } = await import('firebase/auth')
const {
  getFirestore, collection, collectionGroup, query, limit, getDocs,
  doc, setDoc, addDoc,
} = await import('firebase/firestore')

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function isDenied(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === 'permission-denied' || /permission|insufficient/i.test(e?.message ?? '')
}

// ─── One temporary caller ────────────────────────────────────────────────────

const uid = `rdqa06-probe-${Date.now()}`
await adminAuth.createUser({ uid, email: `${uid}@example.invalid`, emailVerified: false })
console.log(`temporary probe identity created: ${uid}`)
const token = await adminAuth.createCustomToken(uid)

const app  = initializeApp({
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
}, 'rd-checkin-06-probe')
const auth = getAuth(app)
const db   = getFirestore(app)

try {
  const cred = await signInWithCustomToken(auth, token)
  check('probe is a genuinely signed-in caller', cred.user.uid === uid, `uid ${cred.user.uid}`)

  console.log('\n── reads that must be refused ──')
  const readTargets: [string, () => Promise<unknown>][] = [
    ['checkinHistory (collection group)', () => getDocs(query(collectionGroup(db, 'checkinHistory'), limit(1)))],
    ['staffAccounts',        () => getDocs(query(collection(db, 'staffAccounts'), limit(1)))],
    ['staffUsernames',       () => getDocs(query(collection(db, 'staffUsernames'), limit(1)))],
    ['identifierLocks',      () => getDocs(query(collection(db, 'identifierLocks'), limit(1)))],
    ['identifierConfigs',    () => getDocs(query(collection(db, 'identifierConfigs'), limit(1)))],
    ['identifierTagLocks',   () => getDocs(query(collection(db, 'identifierTagLocks'), limit(1)))],
    ['organizerDailyStats',  () => getDocs(query(collection(db, 'organizerDailyStats'), limit(1)))],
    ['registrationCounters', () => getDocs(query(collection(db, 'registrationCounters'), limit(1)))],
    ['teamMembers',          () => getDocs(query(collection(db, 'teamMembers'), limit(1)))],
  ]
  for (const [name, run] of readTargets) {
    try { await run(); check(`read ${name} is refused`, false, 'READ SUCCEEDED — rule does not hold') }
    catch (err) { check(`read ${name} is refused`, isDenied(err), isDenied(err) ? 'permission-denied' : String(err).slice(0, 120)) }
  }

  console.log('\n── writes that must be refused ──')
  const writeTargets: [string, () => Promise<unknown>][] = [
    ['staffAccounts/<new>',  () => setDoc(doc(db, 'staffAccounts', `${uid}-x`), { role: 'checkin_lead' })],
    ['staffUsernames/<new>', () => setDoc(doc(db, 'staffUsernames', `${uid}-x`), { staffId: uid })],
    ['a forged checkinHistory entry',
      () => addDoc(collection(db, 'registrations', `${uid}-x`, 'checkinHistory'), { action: 'CHECK_IN' })],
    ['identifierTagLocks/<new>', () => setDoc(doc(db, 'identifierTagLocks', `${uid}-x`), { tag: 'x' })],
    ['organizerDailyStats/<new>', () => setDoc(doc(db, 'organizerDailyStats', `${uid}-x`), { count: 99 })],
  ]
  for (const [name, run] of writeTargets) {
    try { await run(); check(`write ${name} is refused`, false, 'WRITE SUCCEEDED — rule does not hold') }
    catch (err) { check(`write ${name} is refused`, isDenied(err), isDenied(err) ? 'permission-denied' : String(err).slice(0, 120)) }
  }
} finally {
  await signOut(auth).catch(() => {})
  await adminAuth.deleteUser(uid)
  const gone = await adminAuth.getUser(uid).then(() => false).catch(() => true)
  console.log(`\ntemporary probe identity removed: ${gone ? 'confirmed gone' : 'STILL PRESENT'}`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n═══ ${results.length - failed.length}/${results.length} probes refused as required ═══`)
failed.forEach(f => console.log(`  FAILED: ${f.name} — ${f.detail}`))
process.exit(failed.length ? 1 : 0)
