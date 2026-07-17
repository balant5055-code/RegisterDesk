// Support Workspace aggregation (GA-2 S7). Server-only.
//
// REUSE-only: bounded recent reads + count() aggregations over existing collections,
// and the Operations Center engine registry for the failed-jobs signal. No new
// business logic, no scans; every count is guarded so a missing index yields 0.

import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ENGINES } from '@/lib/admin/operationsCenterService'
import type { SupportOverview, SupportOrganizer, SupportEvent, SupportHealth } from '@/lib/admin/supportTypes'

const JOB_COLLECTIONS = [...new Set(ENGINES.flatMap(e => e.collections))]

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
async function countOf(q: FirebaseFirestore.Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}
function effectiveStatus(s: unknown): string {
  return s === 'suspended' || s === 'banned' ? s : 'active'
}

async function recentOrganizers(): Promise<SupportOrganizer[]> {
  try {
    const snap = await adminDb.collection('users').orderBy('createdAt', 'desc').limit(6).get()
    return snap.docs.map(d => {
      const u = d.data() as Record<string, unknown>
      return { uid: d.id, name: str(u.name) ?? '', email: str(u.email) ?? '', status: effectiveStatus(u.accountStatus), createdAt: tsToISO(u.createdAt) }
    })
  } catch { return [] }
}

async function recentEvents(): Promise<SupportEvent[]> {
  try {
    const snap = await adminDb.collection('events').orderBy('createdAt', 'desc').limit(6).get()
    return snap.docs.map(d => {
      const ev = d.data() as Record<string, unknown>
      return { slug: d.id, name: str(rec(rec(ev.eventDetails).info).name) ?? '(untitled event)', status: str(ev.lifecycleStatus), organizerUid: str(ev.uid) }
    })
  } catch { return [] }
}

async function failedJobs(): Promise<number> {
  let failed = 0
  await Promise.all(JOB_COLLECTIONS.map(async c => { failed += await countOf(adminDb.collection(c).where('status', '==', 'failed')) }))
  return failed
}

export async function getSupportOverview(): Promise<SupportOverview> {
  const now = Timestamp.now()
  const events = adminDb.collection('events')
  const users  = adminDb.collection('users')

  const [
    organizers, evs, jobsFailed,
    approvalsPending, moderationPending, expiredLicenses, suspended, banned, paymentIssues,
  ] = await Promise.all([
    recentOrganizers(),
    recentEvents(),
    failedJobs(),
    countOf(events.where('reviewStatus', '==', 'pending_review')),
    countOf(events.where('moderationStatus', '==', 'under_review')),
    countOf(adminDb.collection('eventLicenses').where('expiresAt', '<', now)),
    countOf(users.where('accountStatus', '==', 'suspended')),
    countOf(users.where('accountStatus', '==', 'banned')),
    countOf(adminDb.collection('failedRefunds').where('status', '==', 'open')),
  ])

  const health: SupportHealth = {
    approvalsPending,
    moderationPending,
    failedJobs: jobsFailed,
    expiredLicenses,
    suspendedOrganizers: suspended + banned,
    paymentIssues,
  }

  return { recentOrganizers: organizers, recentEvents: evs, health }
}
