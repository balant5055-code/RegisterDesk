#!/usr/bin/env node
/**
 * scripts/snapshot-daily-stats.ts — READ-ONLY fingerprint of organizerDailyStats.
 *
 *   npx tsx scripts/snapshot-daily-stats.ts > before.txt
 *   …run the backfill again…
 *   npx tsx scripts/snapshot-daily-stats.ts > after.txt
 *   diff before.txt after.txt      # must be empty
 *
 * Idempotency is a claim about the DATA, not about the script's log line. Printing every
 * row's numeric payload — sorted, with `updatedAt` deliberately excluded because a re-run
 * legitimately restamps it — turns "safe to run twice" into something a diff can settle.
 */

import fs   from 'node:fs'
import path from 'node:path'

const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile) && !process.env.FIRESTORE_EMULATOR_HOST) {
  // split(/\r?\n/) — see scripts/backfill-organizer-daily-stats.ts.
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
}

async function main() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app')
  const { getFirestore }                 = await import('firebase-admin/firestore')
  const { DAILY_STATS_COLLECTION }       = await import('@/lib/dashboard/dailyStats')

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

  const snap = await db.collection(DAILY_STATS_COLLECTION).get()
  const lines = snap.docs.map(d => {
    const x = d.data() as Record<string, unknown>
    const n = (k: string) => (typeof x[k] === 'number' ? x[k] : 0)
    // `updatedAt` and `backfilledAt` are EXCLUDED: a re-run restamps them by design, and
    // including them would make an idempotent run look like a changed one.
    return d.id.endsWith('__meta')
      ? `${d.id}\tsince=${String(x.since ?? '')}`
      : `${d.id}\tconfirmed=${n('confirmed')}\tcancelled=${n('cancelled')}\trevenuePaise=${n('revenuePaise')}\tcheckedIn=${n('checkedIn')}\teventId=${String(x.eventId ?? '')}`
  }).sort()

  console.log(`# organizerDailyStats fingerprint · ${lines.length} document(s)`)
  for (const l of lines) console.log(l)
}

main().catch(err => { console.error(err); process.exit(1) })
