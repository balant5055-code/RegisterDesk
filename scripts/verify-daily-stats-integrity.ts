#!/usr/bin/env node
/**
 * scripts/verify-daily-stats-integrity.ts
 *
 * READ-ONLY reconciliation of organizerDailyStats against the authoritative
 * registration records, for EVERY organizer.
 *
 *   npx tsx scripts/verify-daily-stats-integrity.ts
 *   npx tsx scripts/verify-daily-stats-integrity.ts --json
 *
 * ═══ WHY A SEPARATE VERIFIER ═════════════════════════════════════════════════
 * The backfill reports what it WROTE. That is not the same as proving the result is
 * correct: a run can write 241 rows and still be wrong if a registration was skipped, an
 * event attributed to the wrong slug, or a workspace row that does not equal its parts.
 *
 * So the check is computed from the OTHER side — counted straight off `registrations` —
 * and compared. A verifier that shares the backfill's arithmetic would agree with it about
 * a mistake, which is worth nothing.
 *
 * ═══ IT WRITES NOTHING ═══════════════════════════════════════════════════════
 * Every call is a get/count/aggregate. Exits non-zero on any mismatch so it can gate a
 * deploy or a follow-up run.
 *
 * ═══ WHAT COUNTS AS A LEGITIMATE DIFFERENCE ══════════════════════════════════
 * Two, both reported explicitly rather than absorbed:
 *   • a registration with NO registeredAt cannot be attributed to a day, so the backfill
 *     skips it by design — it is counted here as `noDate` and excluded from the expected
 *     total rather than being allowed to look like a loss.
 *   • a registration with NO eventSlug contributes to the workspace row and to no event
 *     row. Attributing it to a guessed event would be worse than leaving it unattributed.
 */

import fs   from 'node:fs'
import path from 'node:path'

const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile) && !process.env.FIRESTORE_EMULATOR_HOST) {
  // split(/\r?\n/) — see the note in scripts/backfill-organizer-daily-stats.ts.
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

const AS_JSON = process.argv.includes('--json')

interface EventRow  { slug: string; confirmed: number; rollup: number; ok: boolean }
interface OrgReport {
  uid: string
  email: string
  registrations: number
  confirmed: number
  noDate: number
  noSlug: number
  eventsWithRegistrations: number
  rollupRows: number
  eventScopeTotal: number
  workspaceTotal: number
  expectedWorkspace: number
  expectedEventScope: number
  earliest: string | null
  latest: string | null
  coverageSince: string | null
  events: EventRow[]
  verdict: 'OK' | 'MISMATCH' | 'NO_REGISTRATIONS'
  problems: string[]
}

async function main() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app')
  const { getFirestore }                 = await import('firebase-admin/firestore')
  const { dayKey, dailyStatsDocId, DAILY_STATS_COLLECTION, ALL_EVENTS } =
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

  const orgSnap = await db.collection('users').where('role', '==', 'organizer').get()
  if (orgSnap.empty) { console.error('NO ORGANIZERS MATCHED — discovery is users.role == "organizer".'); process.exit(1) }

  const reports: OrgReport[] = []

  for (const org of orgSnap.docs) {
    const uid   = org.id
    const email = String((org.data() as Record<string, unknown>).email ?? '')
    const problems: string[] = []

    // ── Side A · the authoritative records ──────────────────────────────────
    // Paged, projected to the four fields that matter, so a large workspace does not
    // pull whole registration documents into memory.
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    let registrations = 0, confirmed = 0, noDate = 0, noSlug = 0
    let earliest: string | null = null, latest: string | null = null
    const confirmedBySlug = new Map<string, number>()

    for (;;) {
      let q = db.collection('registrations')
        .where('organizerUid', '==', uid)
        .orderBy('__name__')
        .select('status', 'eventSlug', 'registeredAt')
        .limit(1000)
      if (cursor) q = q.startAfter(cursor)
      const page = await q.get()
      if (page.empty) break

      for (const doc of page.docs) {
        registrations++
        const d  = doc.data() as Record<string, unknown>
        const ts = d.registeredAt as { toMillis?: () => number } | undefined
        const ms = typeof ts?.toMillis === 'function' ? ts.toMillis() : null
        const isConfirmed = d.status === 'confirmed'
        const slug = typeof d.eventSlug === 'string' && d.eventSlug ? d.eventSlug : null

        if (ms === null) { noDate++; continue }          // unattributable — skipped by design
        const day = dayKey(ms)
        if (!earliest || day < earliest) earliest = day
        if (!latest   || day > latest)   latest   = day

        if (!isConfirmed) continue
        confirmed++
        if (!slug) { noSlug++; continue }                // workspace only, never guessed
        confirmedBySlug.set(slug, (confirmedBySlug.get(slug) ?? 0) + 1)
      }

      cursor = page.docs[page.docs.length - 1]
      if (page.size < 1000) break
    }

    // ── Side B · what the rollups actually say ──────────────────────────────
    const rollupSnap = await db.collection(DAILY_STATS_COLLECTION).where('organizerUid', '==', uid).get()
    let rollupRows = 0, workspaceTotal = 0, eventScopeTotal = 0
    const rollupBySlug = new Map<string, number>()

    for (const doc of rollupSnap.docs) {
      if (doc.id.endsWith('__meta')) continue
      rollupRows++
      const d = doc.data() as Record<string, unknown>
      const scope = typeof d.eventId === 'string' ? d.eventId : ''
      const n = typeof d.confirmed === 'number' ? d.confirmed : 0
      if (scope === ALL_EVENTS) { workspaceTotal += n; continue }
      eventScopeTotal += n
      rollupBySlug.set(scope, (rollupBySlug.get(scope) ?? 0) + n)
    }

    const metaSnap = await db.collection(DAILY_STATS_COLLECTION).doc(`${uid}__meta`).get()
    const coverageSince = metaSnap.exists
      ? (typeof (metaSnap.data() as Record<string, unknown>).since === 'string'
          ? String((metaSnap.data() as Record<string, unknown>).since) : null)
      : null

    // ── Reconcile ───────────────────────────────────────────────────────────
    // Expected WORKSPACE = every confirmed registration that has a date.
    // Expected EVENT-SCOPE = those that also carry a slug.
    const expectedWorkspace  = confirmed
    const expectedEventScope = confirmed - noSlug

    if (workspaceTotal !== expectedWorkspace) {
      problems.push(`workspace rollup ${workspaceTotal} ≠ confirmed ${expectedWorkspace}`)
    }
    if (eventScopeTotal !== expectedEventScope) {
      problems.push(`event-scope rollup ${eventScopeTotal} ≠ confirmed-with-slug ${expectedEventScope}`)
    }

    const events: EventRow[] = [...confirmedBySlug.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, c]) => {
        const r  = rollupBySlug.get(slug) ?? 0
        const ok = r === c
        if (!ok) problems.push(`event '${slug}': rollup ${r} ≠ confirmed ${c}`)
        return { slug, confirmed: c, rollup: r, ok }
      })
    // A rollup row for an event with NO confirmed registrations is also a mismatch —
    // it would mean the reconstruction attributed something to the wrong event.
    for (const [slug, r] of rollupBySlug) {
      if (!confirmedBySlug.has(slug) && r !== 0) {
        problems.push(`event '${slug}': rollup ${r} but no confirmed registrations`)
        events.push({ slug, confirmed: 0, rollup: r, ok: false })
      }
    }
    if (coverageSince && earliest && coverageSince > earliest) {
      problems.push(`coverage since ${coverageSince} is later than earliest registration ${earliest}`)
    }

    reports.push({
      uid, email, registrations, confirmed, noDate, noSlug,
      eventsWithRegistrations: confirmedBySlug.size,
      rollupRows, eventScopeTotal, workspaceTotal,
      expectedWorkspace, expectedEventScope,
      earliest, latest, coverageSince, events,
      verdict: registrations === 0 ? 'NO_REGISTRATIONS' : (problems.length === 0 ? 'OK' : 'MISMATCH'),
      problems,
    })
    void dailyStatsDocId
  }

  if (AS_JSON) { console.log(JSON.stringify(reports, null, 2)); }
  else {
    console.log(`\n═══ organizerDailyStats integrity · ${orgSnap.size} organizer(s) ═══\n`)
    const pad = (s: string | number, n: number) => String(s).padEnd(n)
    const num = (s: string | number, n: number) => String(s).padStart(n)
    console.log(pad('ORGANIZER', 30) + num('REGS', 7) + num('CONF', 7) + num('EVENTS', 8) +
                num('ROWS', 6) + num('EVT Σ', 8) + num('WS Σ', 8) + '  ' + pad('COVERAGE', 25) + 'VERDICT')
    console.log('─'.repeat(122))
    for (const r of reports) {
      console.log(
        pad(r.email || r.uid, 30) + num(r.registrations, 7) + num(r.confirmed, 7) +
        num(r.eventsWithRegistrations, 8) + num(r.rollupRows, 6) +
        num(r.eventScopeTotal, 8) + num(r.workspaceTotal, 8) + '  ' +
        pad(r.earliest ? `${r.earliest} → ${r.latest}` : '—', 25) + r.verdict,
      )
      for (const e of r.events) {
        console.log(`    ${e.ok ? '✓' : '✗'} ${pad(e.slug, 42)} confirmed ${num(e.confirmed, 6)}   rollup ${num(e.rollup, 6)}`)
      }
      if (r.noDate > 0) console.log(`      note: ${r.noDate} registration(s) have no registeredAt — unattributable, skipped by design`)
      if (r.noSlug > 0) console.log(`      note: ${r.noSlug} confirmed registration(s) have no eventSlug — workspace row only`)
      for (const p of r.problems) console.log(`      MISMATCH: ${p}`)
    }
  }

  const bad = reports.filter(r => r.verdict === 'MISMATCH')
  console.log(
    `\nOK: ${reports.filter(r => r.verdict === 'OK').length}` +
    `  ·  no registrations: ${reports.filter(r => r.verdict === 'NO_REGISTRATIONS').length}` +
    `  ·  MISMATCH: ${bad.length}\n`,
  )
  if (bad.length > 0) {
    console.error('INTEGRITY FAILED for: ' + bad.map(b => b.email || b.uid).join(', '))
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
