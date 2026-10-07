#!/usr/bin/env node
/**
 * scripts/diagnose-trend-pipeline.ts
 *
 * READ-ONLY trace of the Registration Trend pipeline for one event.
 *
 *   npx tsx scripts/diagnose-trend-pipeline.ts --event="Vanathukkul"
 *   npx tsx scripts/diagnose-trend-pipeline.ts --slug=<eventSlug>
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * "The chart is empty but the event has 2,295 registrations" has at least six possible
 * causes, and guessing between them is how a data bug gets 'fixed' by inventing numbers:
 *
 *   1. the event has no slug            → nothing is keyed to it
 *   2. registrations lack registeredAt  → nothing to attribute
 *   3. registrations carry a DIFFERENT eventSlug than the draft
 *   4. organizerDailyStats rows missing → backfill never ran      ← the expected one
 *   5. rows exist but under the WRONG scope key (workspace vs event)
 *   6. rows exist and the UI fails to render them
 *
 * This walks every step against the real records and prints which one it is.
 *
 * ═══ IT WRITES NOTHING ═══════════════════════════════════════════════════════
 * Every call here is a get/count/aggregate. Diagnosing production must never mutate it,
 * and a tool that can only read is one that cannot be misused under pressure.
 */

import fs   from 'node:fs'
import path from 'node:path'

const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile) && !process.env.FIRESTORE_EMULATOR_HOST) {
  // split(/\r?\n/), NOT split('\n'). On a CRLF checkout every line keeps a trailing \r, and
  // `.` does not match a carriage return — so the regex below failed on EVERY line and the
  // loader silently set nothing.
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const args      = process.argv.slice(2)
const nameQuery = args.find(a => a.startsWith('--event='))?.slice(8)?.toLowerCase()
const slugArg   = args.find(a => a.startsWith('--slug='))?.slice(7)

async function main() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app')
  const { getFirestore }                 = await import('firebase-admin/firestore')
  const { dayKey, dayKeyRange, dailyStatsDocId, ALL_EVENTS, DAILY_STATS_COLLECTION } =
    await import('@/lib/dashboard/dailyStats')

  if (getApps().length === 0) {
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' })
    } else {
      const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
      if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set.')
      initializeApp({ credential: cert(JSON.parse(Buffer.from(key, 'base64').toString('utf-8'))) })
    }
  }
  const db = getFirestore()
  const target = process.env.FIRESTORE_EMULATOR_HOST ? 'EMULATOR' : 'PRODUCTION'
  console.log(`\n═══ Trend pipeline trace · ${target} · READ-ONLY ═══\n`)

  // ── STEP 1 · find the event draft ────────────────────────────────────────
  const organizers = await db.collection('users').where('role', '==', 'organizer').get()
  console.log(`STEP 1 · organizers with role='organizer': ${organizers.size}`)

  let found: { uid: string; draftId: string; name: string; slug: string | null; status: string } | null = null
  for (const org of organizers.docs) {
    const drafts = await db.collection(`users/${org.id}/eventDrafts`).get()
    for (const d of drafts.docs) {
      const data = d.data() as Record<string, unknown>
      const det  = (data.eventDetails as Record<string, unknown>) ?? {}
      const info = (det.info as Record<string, unknown>) ?? {}
      const seo  = (det.seo  as Record<string, unknown>) ?? {}
      const name = typeof info.name === 'string' ? info.name : ''
      const slug = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
      const hit = slugArg ? slug === slugArg : (nameQuery ? name.toLowerCase().includes(nameQuery) : false)
      if (hit) {
        found = { uid: org.id, draftId: d.id, name, slug, status: String(data.status ?? '') }
        break
      }
    }
    if (found) break
  }

  if (!found) {
    console.error(`\n  NOT FOUND. No event matched ${slugArg ? `slug=${slugArg}` : `name~="${nameQuery}"`}.`)
    console.error('  Pass --event=<part of the name> or --slug=<eventSlug>.\n')
    process.exit(1)
  }
  console.log(`  event      : ${found.name}`)
  console.log(`  organizer  : ${found.uid}`)
  console.log(`  draftId    : ${found.draftId}`)
  console.log(`  slug       : ${found.slug ?? '(none — unpublished)'}`)
  console.log(`  status     : ${found.status}`)
  if (!found.slug) { console.error('\n  CAUSE 1: no slug — nothing can be keyed to this event.\n'); process.exit(1) }

  // ── STEP 2 · the counter (what the KPI shows) ────────────────────────────
  const counterSnap = await db.doc(`registrationCounters/${found.slug}`).get()
  const counter     = counterSnap.exists ? (counterSnap.data() as Record<string, unknown>) : null
  console.log(`\nSTEP 2 · registrationCounters/${found.slug}`)
  console.log(`  totalCount   : ${counter?.totalCount ?? '(no counter doc)'}`)
  console.log(`  revenuePaise : ${counter?.revenuePaise ?? '(absent)'}`)

  // ── STEP 3 · the registrations themselves ────────────────────────────────
  const regsCol = db.collection('registrations')
  const confirmed = await regsCol.where('eventSlug', '==', found.slug).where('status', '==', 'confirmed').count().get()
  const anyStatus = await regsCol.where('eventSlug', '==', found.slug).count().get()
  const byOrg     = await regsCol.where('organizerUid', '==', found.uid).count().get()
  console.log(`\nSTEP 3 · registrations`)
  console.log(`  eventSlug='${found.slug}' (any status) : ${anyStatus.data().count}`)
  console.log(`  …of which confirmed                    : ${confirmed.data().count}`)
  console.log(`  organizerUid='${found.uid}' (all events): ${byOrg.data().count}`)

  if (anyStatus.data().count === 0) {
    console.error('\n  CAUSE 3: no registration carries this eventSlug. The draft slug and the')
    console.error('  registration slug disagree — the backfill would attribute nothing.\n')
  }

  // registeredAt coverage — sampled, since a full scan is expensive and unnecessary.
  const sample = await regsCol.where('eventSlug', '==', found.slug).limit(200).get()
  let withDate = 0, earliest: number | null = null, latest: number | null = null
  for (const d of sample.docs) {
    const r  = d.data() as Record<string, unknown>
    const ts = r.registeredAt as { toMillis?: () => number } | undefined
    const ms = typeof ts?.toMillis === 'function' ? ts.toMillis() : null
    if (ms === null) continue
    withDate++
    if (earliest === null || ms < earliest) earliest = ms
    if (latest   === null || ms > latest)   latest   = ms
  }
  console.log(`  sample of ${sample.size}: ${withDate} have registeredAt`)
  if (earliest) console.log(`  sampled range : ${dayKey(earliest)} → ${dayKey(latest!)}`)
  if (sample.size > 0 && withDate === 0) {
    console.error('\n  CAUSE 2: no registeredAt — there is nothing to attribute to a day.\n')
  }

  // ── STEP 4 · the rollups the chart actually reads ────────────────────────
  const days = dayKeyRange(Date.now(), 90)
  const evRefs = days.map(d => db.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(found!.uid, found!.slug!, d)))
  const wsRefs = days.map(d => db.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(found!.uid, ALL_EVENTS, d)))
  const [evSnaps, wsSnaps] = await Promise.all([db.getAll(...evRefs), db.getAll(...wsRefs)])
  const sum = (snaps: FirebaseFirestore.DocumentSnapshot[]) =>
    snaps.reduce((n, s) => n + (s.exists ? Number((s.data() as Record<string, unknown>).confirmed ?? 0) : 0), 0)
  const present = (snaps: FirebaseFirestore.DocumentSnapshot[]) => snaps.filter(s => s.exists).length

  console.log(`\nSTEP 4 · organizerDailyStats (last 90 days)`)
  console.log(`  EVENT scope  '${found.slug}' : ${present(evSnaps)}/90 rows, Σconfirmed=${sum(evSnaps)}`)
  console.log(`  WORKSPACE    '${ALL_EVENTS}' : ${present(wsSnaps)}/90 rows, Σconfirmed=${sum(wsSnaps)}`)

  const metaSnap = await db.collection(DAILY_STATS_COLLECTION).doc(`${found.uid}__meta`).get()
  console.log(`  coverage marker : ${metaSnap.exists ? JSON.stringify((metaSnap.data() as Record<string, unknown>).since) : '(none)'}`)

  // ── VERDICT ──────────────────────────────────────────────────────────────
  console.log('\n═══ VERDICT ═══')
  if (present(evSnaps) === 0 && confirmed.data().count > 0) {
    console.log('  CAUSE 4 — the rollups do not exist for this event.')
    console.log('  The registrations DO exist and carry registeredAt, so the daily history is')
    console.log('  RECONSTRUCTIBLE. Remedy: run scripts/backfill-organizer-daily-stats.ts')
    console.log(`  (target this organizer with --uid=${found.uid}).`)
  } else if (present(evSnaps) === 0 && present(wsSnaps) > 0) {
    console.log('  CAUSE 5 — workspace rows exist but event rows do not: the rollups predate')
    console.log('  the event dimension. Re-run the backfill; it writes BOTH scopes.')
  } else if (present(evSnaps) > 0) {
    console.log(`  Rollups ARE present (Σ90d = ${sum(evSnaps)}). If the chart is still empty the`)
    console.log('  fault is downstream: scope propagation or rendering, not the data.')
  } else {
    console.log('  No registrations and no rollups — the chart is correctly empty.')
  }
  console.log('')
}

main().catch(err => { console.error(err); process.exit(1) })
