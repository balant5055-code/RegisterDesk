// RD-IMPORT-EMAIL-AUDIT · READ-ONLY report of registrations whose stored attendee email is not
// in its normalised form (trimmed + lower-cased).
//
//   npx tsx scripts/report-mixed-case-emails.ts            # report only — WRITES NOTHING
//   npx tsx scripts/report-mixed-case-emails.ts --json     # same, machine-readable
//
// ═══ WHY ═════════════════════════════════════════════════════════════════════
// Every current registration writer stores `attendee.email` lower-cased, and duplicate checks
// (registrationClaims ids, the import's existing-registration read) compare normalised values.
// A registration written with a mixed-case email by an OLDER writer would not be matched by an
// exact-value lookup of its normalised email, so a later import or online registration with the
// same address could slip past the duplicate check. This script only MEASURES that population.
//
// It never normalises, backfills or edits anything: reads are `count()` and `select()`-ed
// pages only, and no email address is printed — just counts per event, per writer and per
// creation month, and whether a normalised twin exists in the same event.

import { adminDb } from '@/lib/firebase/admin'

const JSON_OUT = process.argv.includes('--json')

/** Which project was read — the project id only, never any other part of the credential. */
function targetProject(): string {
  if (process.env.FIRESTORE_EMULATOR_HOST) return `emulator:${process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'}`
  try {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?? '', 'base64').toString('utf-8')) as { project_id?: string }
    return sa.project_id ?? 'unknown'
  } catch { return 'unknown' }
}
const PAGE     = 1000

interface Hit { slug: string; source: string; month: string; kind: 'case' | 'whitespace' | 'both'; status: string }

const monthOf = (v: unknown): string => {
  const d = v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate() : null
  return d ? d.toISOString().slice(0, 7) : 'unknown'
}

async function main() {
  const total = (await adminDb.collection('registrations').count().get()).data().count

  const hits: Hit[] = []
  // eventSlug|normalisedEmail → registrations holding that address in any form (for twins).
  const byAddress = new Map<string, number>()
  const hitKeys: string[] = []
  let scanned = 0, noEmail = 0
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null

  for (;;) {
    let q = adminDb.collection('registrations')
      .select('attendee.email', 'eventSlug', 'registrationSource', 'status', 'createdAt')
      .orderBy('__name__').limit(PAGE)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    for (const doc of snap.docs) {
      scanned++
      const d = doc.data() as { attendee?: { email?: unknown }; eventSlug?: unknown; registrationSource?: unknown; status?: unknown; createdAt?: unknown }
      const email = typeof d.attendee?.email === 'string' ? d.attendee.email : ''
      if (!email) { noEmail++; continue }
      const slug = typeof d.eventSlug === 'string' ? d.eventSlug : '(none)'
      const norm = email.trim().toLowerCase()
      const key  = `${slug}|${norm}`
      byAddress.set(key, (byAddress.get(key) ?? 0) + 1)
      if (email === norm) continue
      const cased = email.trim() !== norm
      const spaced = email !== email.trim()
      hits.push({
        slug,
        source: typeof d.registrationSource === 'string' ? d.registrationSource : '(unset)',
        month:  monthOf(d.createdAt),
        kind:   cased && spaced ? 'both' : cased ? 'case' : 'whitespace',
        status: typeof d.status === 'string' ? d.status : '(unset)',
      })
      hitKeys.push(key)
    }
    last = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE) break
  }

  const tally = (f: (h: Hit) => string) => {
    const m: Record<string, number> = {}
    for (const h of hits) m[f(h)] = (m[f(h)] ?? 0) + 1
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]))
  }
  // A twin = another registration of the SAME event holding the same address in any case.
  const withTwin = hitKeys.filter(k => (byAddress.get(k) ?? 0) > 1).length

  const report = {
    target: targetProject(),
    totalRegistrations: total,
    scanned,
    withoutEmail: noEmail,
    notNormalised: hits.length,
    byKind:     tally(h => h.kind),
    withSameEventTwin: withTwin,
    byEvent:    tally(h => h.slug),
    bySource:   tally(h => h.source),
    byStatus:   tally(h => h.status),
    byMonth:    tally(h => h.month),
  }
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return }
  console.log('Registrations with a non-normalised attendee email (READ-ONLY — nothing was written)')
  console.log(report)
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
