#!/usr/bin/env node
// RD-BIB-01 · backfill `registrations.hasIdentifier`.
//
// ═══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
// The identifier plan can only say "600 numbers will be issued" when Firestore can
// COUNT the registrations that still need one. That count is
// `where(hasIdentifier, ==, false)`, and a registration written before RD-BIB-01
// carries no such field — it matches neither `true` nor `false`.
//
// The read model already handles that honestly: it compares true + false against the
// roster total and reports UNKNOWN when they disagree, naming how many rows it could
// not account for. So the product is correct WITHOUT this script; running it is what
// turns "cannot verify yet" into an exact number for an existing event.
//
// ═══ WHAT IT WILL NOT DO ═════════════════════════════════════════════════════
// It never runs automatically — there is no cron, no route and no import of this file
// anywhere in the application. It touches exactly ONE field, derived from data that is
// already on the same document, and it writes nothing else:
//
//   • no identifier value is read for a decision other than "is it present"
//   • no identifierLock is read, written, created or deleted
//   • no counter is advanced
//   • no timing tag is touched
//   • no payment, refund, status or check-in field is touched
//   • no history entry is written (this changes no identity, only its countability)
//
// It is idempotent: a second run finds nothing to do, because rows already carrying
// the field are filtered out by the same predicate that decides the value.
//
// ═══ USAGE ═══════════════════════════════════════════════════════════════════
//   node scripts/migrations/backfill-has-identifier.mjs --event <slug>            # DRY RUN
//   node scripts/migrations/backfill-has-identifier.mjs --event <slug> --apply
//   node scripts/migrations/backfill-has-identifier.mjs --all                     # DRY RUN, every event
//
// Dry run is the default and prints exactly what an --apply would change.
// Against the emulator, set FIRESTORE_EMULATOR_HOST first.

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const APPLY = has('--apply')
const EVENT = valueOf('--event')
const ALL   = has('--all')
const PAGE  = 400

if (!EVENT && !ALL) {
  console.error('Usage: --event <slug> [--apply]   |   --all [--apply]')
  process.exit(1)
}

// RD-PREPROD · outside the emulator this uses AMBIENT Google credentials, so the target project
// was whatever the machine's default login pointed at. Now: --apply against a real project requires
// --confirm-project=<id>, and that id is passed to the SDK, so the write can only reach the project
// the operator named. Dry runs without it still work (read-only) but say which project they read.
const CONFIRM = args.find(a => a.startsWith('--confirm-project='))?.slice('--confirm-project='.length) ?? null
if (!process.env.FIRESTORE_EMULATOR_HOST && APPLY && !CONFIRM) {
  console.error('FATAL: --apply against a real project requires --confirm-project=<project_id>. Nothing was written.')
  process.exit(1)
}

if (!getApps().length) {
  initializeApp(
    process.env.FIRESTORE_EMULATOR_HOST
      ? { projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' }
      : { credential: applicationDefault(), ...(CONFIRM ? { projectId: CONFIRM } : {}) },
  )
}
const db = getFirestore()

/**
 * The value the field must hold, derived from the mirrors that are already on the
 * document. Canonical first, legacy second — the same precedence
 * `lib/registrations/identity.resolveIdentifierValue` uses, so the backfill can never
 * disagree with what the rest of the product displays.
 */
function derive(data) {
  const canonical = data?.identifier?.value
  if (typeof canonical === 'string' && canonical.trim() !== '') return true
  const legacy = data?.bibNumber
  if (typeof legacy === 'string' && legacy.trim() !== '') return true
  return false
}

async function backfillEvent(slug) {
  let cursor = null
  let seen = 0, already = 0, toTrue = 0, toFalse = 0, written = 0

  for (;;) {
    let q = db.collection('registrations')
      .where('eventSlug', '==', slug)
      .orderBy('__name__')
      .limit(PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break

    const batch = db.batch()
    let inBatch = 0
    for (const doc of snap.docs) {
      seen++
      const data = doc.data()
      const want = derive(data)
      if (typeof data.hasIdentifier === 'boolean') {
        // Already covered. Left alone even if it disagrees: a mismatch is a fact worth
        // seeing, not something a backfill should quietly overwrite.
        already++
        if (data.hasIdentifier !== want) {
          console.warn(`  ! ${doc.id}: field says ${data.hasIdentifier}, mirrors say ${want} — NOT changed`)
        }
        continue
      }
      if (want) toTrue++; else toFalse++
      if (APPLY) { batch.update(doc.ref, { hasIdentifier: want }); inBatch++ }
    }
    if (APPLY && inBatch > 0) { await batch.commit(); written += inBatch }

    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE) break
  }

  console.log(
    `${slug}: ${seen} registrations · ${already} already covered · ` +
    `would set true=${toTrue} false=${toFalse}` + (APPLY ? ` · WROTE ${written}` : ' · DRY RUN, nothing written'),
  )
  return { seen, already, toTrue, toFalse, written }
}

const slugs = EVENT ? [EVENT] : await (async () => {
  const seen = new Set()
  let cursor = null
  for (;;) {
    let q = db.collection('registrations').select('eventSlug').orderBy('__name__').limit(1000)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break
    for (const d of snap.docs) { const s = d.get('eventSlug'); if (typeof s === 'string') seen.add(s) }
    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < 1000) break
  }
  return [...seen].sort()
})()

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} · ${slugs.length} event(s)`)
const totals = { seen: 0, already: 0, toTrue: 0, toFalse: 0, written: 0 }
for (const slug of slugs) {
  const r = await backfillEvent(slug)
  for (const k of Object.keys(totals)) totals[k] += r[k]
}
console.log('TOTAL', JSON.stringify(totals))
if (!APPLY) console.log('Nothing was written. Re-run with --apply to commit.')
