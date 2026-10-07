#!/usr/bin/env node
/**
 * scripts/backfill-organizer-daily-stats.ts
 *
 * RD-DASHBOARD-02 · Backfills `organizerDailyStats` from existing registrations.
 *
 * ═══ WHY A BACKFILL IS REQUIRED, NOT OPTIONAL ════════════════════════════════
 * The rollups only exist from the moment the write path started maintaining them.
 * Without a backfill the dashboard's 90-day trend shows real data for recent days and
 * ZERO for everything before — visually identical to "nobody registered", which is
 * exactly the class of lie this whole change set exists to remove.
 *
 * Until an organizer is backfilled the API reports `historyPartial` and the UI
 * discloses the gap. This script closes it and stamps the coverage marker.
 *
 * ═══ IDEMPOTENT AND RESUMABLE ════════════════════════════════════════════════
 * It RECOMPUTES each day from the registrations themselves and `set`s the absolute
 * value — it never increments. So running it twice produces the same numbers, and a
 * run interrupted halfway can simply be run again. That is the whole reason it does
 * not use FieldValue.increment: an increment-based backfill double-counts on retry,
 * and a partially-applied double-count is not detectable after the fact.
 *
 * Resumability is per-organizer: `--after=<uid>` skips organizers already done, and
 * progress is printed so a long run can be continued.
 *
 * ═══ USAGE ═══════════════════════════════════════════════════════════════════
 * RD-FIN-02 · the TARGET is explicit — there is no implicit default. This project has ONE
 * Firestore (production); a script that silently fell through to `.env.local` whenever the
 * emulator variable was missing could write production by accident.
 *
 *   Emulator (FIRESTORE_EMULATOR_HOST set, project id demo-*):
 *     npx dotenv -e .env.emulator -- npx tsx scripts/backfill-organizer-daily-stats.ts --target=emulator --dry-run
 *     npx dotenv -e .env.emulator -- npx tsx scripts/backfill-organizer-daily-stats.ts --target=emulator
 *   Production (reads .env.local; FIRESTORE_EMULATOR_HOST must NOT be set; the service-account
 *   project id must be confirmed on the command line):
 *     npx tsx scripts/backfill-organizer-daily-stats.ts --target=production --confirm-project=<project_id> --dry-run
 *     npx tsx scripts/backfill-organizer-daily-stats.ts --target=production --confirm-project=<project_id>
 *   Options: --uid=<organizerUid> (one organizer) · --after=<organizerUid> (resume)
 *
 * What it writes (nothing in --dry-run): organizerDailyStats/{uid}__{scope}__{YYYY-MM-DD} rows
 * (scope = '__all__' and each event slug) as ABSOLUTE values, zeroes existing rows for days it did
 * not compute (stale / negative residue), then organizerDailyStats/{uid}__meta (coverage) LAST.
 */

import fs   from 'node:fs'
import path from 'node:path'

// ── target guard (RD-FIN-02) ───────────────────────────────────────────────────
const args    = process.argv.slice(2)
const TARGET  = args.find(a => a.startsWith('--target='))?.slice(9)
const CONFIRM = args.find(a => a.startsWith('--confirm-project='))?.slice(18)
const fail = (m: string): never => { console.error(m); process.exit(1) }
if (TARGET !== 'emulator' && TARGET !== 'production') fail('Pass --target=emulator or --target=production (no implicit target).')
if (TARGET === 'emulator') {
  if (!process.env.FIRESTORE_EMULATOR_HOST) fail('--target=emulator requires FIRESTORE_EMULATOR_HOST.')
  if (!(process.env.GCLOUD_PROJECT ?? 'demo-registerdesk').startsWith('demo-')) fail('Emulator project id must start with demo-.')
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  fail('FIRESTORE_EMULATOR_HOST is set; refusing --target=production.')
}

// ── env (production only) ──────────────────────────────────────────────────────
const envFile = path.resolve(process.cwd(), '.env.local')
if (TARGET === 'production' && fs.existsSync(envFile)) {
  // split(/\r?\n/), NOT split('\n'). On a CRLF checkout every line keeps a trailing \r, and
  // `.` does not match a carriage return — so the regex below failed on EVERY line, the
  // loader silently set nothing, and this script could not reach production at all from a
  // Windows checkout. It failed with "FIREBASE_SERVICE_ACCOUNT_KEY is not set" against a
  // .env.local that plainly contains it — which is why the historical backfill had never
  // actually been run against real data.
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

// RD-PREPROD · re-check AFTER .env.local was loaded: a production run must never be redirected to an
// emulator by a variable that only appeared in the file (the guard above ran before it was read).
if (TARGET === 'production' && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  fail('An emulator host variable is set (after loading .env.local); refusing --target=production.')
}

const DRY_RUN = args.includes('--dry-run')
const ONLY    = args.find(a => a.startsWith('--uid='))?.slice(6)
const AFTER   = args.find(a => a.startsWith('--after='))?.slice(8)

async function main() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app')
  const { getFirestore, FieldValue }     = await import('firebase-admin/firestore')
  const { dayKey, dailyStatsDocId, DAILY_STATS_COLLECTION, ALL_EVENTS } = await import('@/lib/dashboard/dailyStats')
  // RD-FIN-02 B5 · the SAME ticket-revenue basis the live counter and rollups use.
  const { registrationRevenueBasisPaise } = await import('@/lib/registrations/revenueBasis')

  if (getApps().length === 0) {
    if (TARGET === 'emulator') {
      initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' })
    } else {
      const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
      if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set.')
      const sa = JSON.parse(Buffer.from(key, 'base64').toString('utf-8')) as { project_id?: string }
      if (!sa.project_id || CONFIRM !== sa.project_id) fail(`--confirm-project=${sa.project_id ?? '<unknown>'} is required for a production run.`)
      initializeApp({ credential: cert(sa as Parameters<typeof cert>[0]) })
    }
  }
  const db = getFirestore()

  // ── Which organizers ────────────────────────────────────────────────────────
  let uids: string[]
  if (ONLY) {
    uids = [ONLY]
  } else {
    // The canonical organizer predicate, so this can never disagree with the admin
    // console about who is an organizer.
    const snap = await db.collection('users').where('role', '==', 'organizer').get()
    uids = snap.docs.map(d => d.id).sort()
    if (AFTER) uids = uids.filter(u => u > AFTER)
  }

  // ═══ ZERO ORGANIZERS IS A FAILURE, NOT A RESULT ═══════════════════════════
  // Discovery is `users.role == 'organizer'`. An organizer whose profile document is
  // missing, unmigrated, or stores the role under another name matches NOTHING — and the
  // run then printed "Done. 0/0 organizer(s) processed", which reads as success. The
  // operator walks away believing history was rebuilt while every trend stays empty.
  //
  // Observed for real on a workspace whose /users doc had not been written yet.
  if (uids.length === 0) {
    console.error([
      '',
      'NO ORGANIZERS MATCHED.',
      "  Discovery is: users where role == 'organizer'.",
      '  Nothing was backfilled. This is almost always a missing or unmigrated',
      '  /users/{uid} profile — not an empty platform.',
      '  Target one directly with --uid=<organizerUid> to confirm.',
      '',
    ].join('\n'))
    process.exit(1)
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Backfilling ${uids.length} organizer(s)…`)

  let done = 0
  for (const uid of uids) {
    // Per-organizer accumulator. Recomputed from scratch, never merged with what is
    // already stored, so the result is the same on every run. Keyed "{scope}|{day}" so ONE pass produces both the per-event rows and the
    // workspace roll-up, exactly matching what the live write path maintains.
    const byKey = new Map<string, { confirmed: number; cancelled: number; revenuePaise: number; checkedIn: number }>()
    const bumpScope = (scope: string, day: string, field: 'confirmed' | 'cancelled' | 'revenuePaise' | 'checkedIn', by: number) => {
      const k = `${scope}|${day}`
      const row = byKey.get(k) ?? { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 }
      row[field] += by
      byKey.set(k, row)
    }
    /** Writes the event row AND the workspace row, mirroring stageDailyStatsIncrement. */
    const bump = (day: string, field: 'confirmed' | 'cancelled' | 'revenuePaise' | 'checkedIn', by: number, slug: string | null) => {
      bumpScope(ALL_EVENTS, day, field, by)
      if (slug) bumpScope(slug, day, field, by)
    }

    // Page the organizer's registrations by document id. A cursor on __name__ needs no
    // composite index and is stable under concurrent writes.
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    let scanned = 0
    let earliest: string | null = null

    for (;;) {
      let q = db.collection('registrations')
        .where('organizerUid', '==', uid)
        .orderBy('__name__')
        .limit(1000)
      if (cursor) q = q.startAfter(cursor)

      const page: FirebaseFirestore.QuerySnapshot = await q.get()
      if (page.empty) break

      for (const doc of page.docs) {
        const r = doc.data() as Record<string, unknown>
        const regAt = toMillis(r.registeredAt)
        if (regAt === null) continue          // cannot attribute — skipped, never guessed

        const day    = dayKey(regAt)
        const amount = registrationRevenueBasisPaise(r)   // RD-FIN-02 B5 · ticket basis, not the gross charge
        const status = typeof r.status === 'string' ? r.status : ''

        if (!earliest || day < earliest) earliest = day

        // Mirrors lib/dashboard/dailyStats attribution EXACTLY:
        //   confirmed  → counted on its creation day
        //   cancelled  → the creation day keeps no confirmed/revenue; the cancellation
        //                is recorded on the day it happened
        const slug = typeof r.eventSlug === 'string' && r.eventSlug ? r.eventSlug : null

        if (status === 'confirmed') {
          bump(day, 'confirmed', 1, slug)
          bump(day, 'revenuePaise', amount, slug)
        } else if (status === 'cancelled') {
          const cancelAt = toMillis(r.updatedAt) ?? regAt
          bump(dayKey(cancelAt), 'cancelled', 1, slug)
        }

        const checkedAt = toMillis(r.checkedInAt)
        if (checkedAt !== null) bump(dayKey(checkedAt), 'checkedIn', 1, slug)
      }

      scanned += page.size
      cursor = page.docs[page.docs.length - 1]
      if (page.size < 1000) break
    }

    // RD-FIN-02 · rows that EXIST for this organizer but are not recomputed (a day whose registrations
    // were all cancelled, or the negative residue of paid registrations that were reversed on cancel
    // but never confirmed into the rollup before RD-FIN-01) are zeroed — an absolute rebuild must not
    // leave them standing. organizerUid equality only (automatic single-field index).
    const computed = new Set([...byKey.keys()].map(k => { const [s, d] = k.split('|'); return dailyStatsDocId(uid, s, d) }))
    const existing = await db.collection(DAILY_STATS_COLLECTION).where('organizerUid', '==', uid).select().get()
    const stale = existing.docs.filter(d => d.id !== `${uid}__meta` && !computed.has(d.id))
    const sumAll = (f: 'confirmed' | 'revenuePaise') => [...byKey].filter(([k]) => k.startsWith(`${ALL_EVENTS}|`)).reduce((s, [, r]) => s + r[f], 0)

    if (byKey.size === 0 && stale.length === 0) {
      console.log(`  ${uid}: no registrations — nothing to backfill`)
      done++
      continue
    }

    if (DRY_RUN) {
      console.log(`  ${uid}: ${scanned} registration(s) → ${byKey.size} scope-day row(s), ${stale.length} stale row(s) to zero, Σconfirmed=${sumAll('confirmed')} Σrevenue=${sumAll('revenuePaise')} paise, earliest ${earliest}`)
      done++
      continue
    }

    // ABSOLUTE writes, batched. `set` without merge on the numeric fields makes the
    // run idempotent; a re-run overwrites with the same recomputed values.
    let batch = db.batch()
    let ops = 0
    for (const [k, row] of byKey) {
      const [scope, day] = k.split('|')
      const ref = db.collection(DAILY_STATS_COLLECTION).doc(dailyStatsDocId(uid, scope, day))
      batch.set(ref, {
        organizerUid: uid, eventId: scope, day,
        confirmed: row.confirmed, cancelled: row.cancelled,
        revenuePaise: row.revenuePaise, checkedIn: row.checkedIn,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0 }
    }
    for (const s of stale) {
      batch.set(s.ref, { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0 }
    }
    if (ops > 0) await batch.commit()

    // Coverage marker LAST, so an interrupted run never claims coverage it lacks.
    await db.collection(DAILY_STATS_COLLECTION).doc(`${uid}__meta`).set({
      organizerUid: uid, since: earliest, backfilledAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    done++
    console.log(`  ${uid}: ${scanned} registration(s) → ${byKey.size} scope-day row(s) written, ${stale.length} stale zeroed, Σconfirmed=${sumAll('confirmed')} Σrevenue=${sumAll('revenuePaise')}, coverage from ${earliest}  [${done}/${uids.length}]`)
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Done. ${done}/${uids.length} organizer(s) processed.`)
}

function toMillis(v: unknown): number | null {
  if (!v) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const ts = v as { toMillis?: () => number }
  if (typeof ts.toMillis === 'function') {
    try { const ms = ts.toMillis(); return Number.isFinite(ms) ? ms : null } catch { return null }
  }
  return null
}

main().catch(err => { console.error(err); process.exit(1) })
