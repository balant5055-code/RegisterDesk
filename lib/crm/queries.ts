// CRM read/query layer (server-only). All queries are organizer-scoped. Search and
// the boolean filters are applied in memory over an indexed, capped recency scan —
// this keeps the index footprint to just (organizerUid, lastSeenAt desc).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  CRM_CONTACTS, CRM_ACTIVITIES, CRM_SCAN_CAP,
  type CrmContactDoc, type CrmContactView, type CrmActivityDoc, type CrmActivityView,
  type CrmAnalytics, type CrmScope, type CrmActivityType,
} from '@/lib/crm/types'

export type ContactFilter = 'all' | 'donors' | 'repeat' | 'checked_in' | 'not_checked_in'
const DONATION_TYPES: CrmActivityType[] = ['donation_created', 'donation_refunded']

function toView(d: CrmContactDoc): CrmContactView {
  return {
    contactId: d.contactId, email: d.email, phone: d.phone ?? null, name: d.name ?? '',
    firstSeenAt: d.firstSeenAt ?? 0, lastSeenAt: d.lastSeenAt ?? 0,
    totalRegistrations: d.totalRegistrations ?? 0, totalCheckIns: d.totalCheckIns ?? 0,
    totalDonations: d.totalDonations ?? 0, totalDonationAmountPaise: d.totalDonationAmountPaise ?? 0,
    lastEvent: d.lastEvent ?? null, lastDonation: d.lastDonation ?? null,
    tags: Array.isArray(d.tags) ? d.tags : [], notes: d.notes ?? '',
  }
}

async function scanContacts(uid: string): Promise<{ docs: CrmContactView[]; truncated: boolean }> {
  const snap = await adminDb.collection(CRM_CONTACTS)
    .where('organizerUid', '==', uid)
    .orderBy('lastSeenAt', 'desc')
    .limit(CRM_SCAN_CAP + 1)
    .get()
  const truncated = snap.docs.length > CRM_SCAN_CAP
  const docs = (truncated ? snap.docs.slice(0, CRM_SCAN_CAP) : snap.docs).map(d => toView(d.data() as CrmContactDoc))
  return { docs, truncated }
}

export const CRM_PAGE_SIZE = 100   // contacts returned per page (Load More)

export interface ListResult {
  contacts:   CrmContactView[]
  total:      number               // total matches within the scanned window
  truncated:  boolean              // scan hit CRM_SCAN_CAP — older contacts not included
  nextCursor: string | null        // pass back as ?cursor= for the next page; null = no more
}

// Applies finance scope + filter + tag + search to the scanned recency window.
// Order is preserved (lastSeenAt desc), so a contactId cursor paginates stably.
function applyContactFilters(
  rows: CrmContactView[],
  opts: { search?: string; filter?: ContactFilter; tag?: string; scope: CrmScope },
): CrmContactView[] {
  let out = rows
  // Finance scope sees donors only.
  if (opts.scope === 'donations') out = out.filter(c => c.totalDonations > 0)

  switch (opts.filter) {
    case 'donors':          out = out.filter(c => c.totalDonations > 0); break
    case 'repeat':          out = out.filter(c => c.totalRegistrations >= 2); break
    case 'checked_in':      out = out.filter(c => c.totalCheckIns > 0); break
    case 'not_checked_in':  out = out.filter(c => c.totalRegistrations > 0 && c.totalCheckIns === 0); break
    default: break
  }
  if (opts.tag) out = out.filter(c => c.tags.includes(opts.tag!))

  const q = (opts.search ?? '').trim().toLowerCase()
  if (q) out = out.filter(c =>
    c.name.toLowerCase().includes(q) || c.email.includes(q) || (c.phone ?? '').includes(q))

  return out
}

export async function listContacts(
  uid: string,
  opts: { search?: string; filter?: ContactFilter; tag?: string; scope: CrmScope; cursor?: string; limit?: number },
): Promise<ListResult> {
  const { docs, truncated } = await scanContacts(uid)
  const rows = applyContactFilters(docs, opts)
  const total = rows.length

  const pageSize = opts.limit && opts.limit > 0 && opts.limit <= 200 ? opts.limit : CRM_PAGE_SIZE

  // Cursor = contactId of the last row from the previous page. The scan is
  // deterministic for the same query, so we re-derive the position and slice the
  // next page. If the cursor is absent from the current result set (query
  // changed), start from the top.
  let startIdx = 0
  if (opts.cursor) {
    const i = rows.findIndex(c => c.contactId === opts.cursor)
    startIdx = i >= 0 ? i + 1 : 0
  }

  const page = rows.slice(startIdx, startIdx + pageSize)
  const hasMore = startIdx + pageSize < total
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].contactId : null

  return { contacts: page, total, truncated, nextCursor }
}

export async function getContact(
  uid: string, contactId: string, scope: CrmScope,
): Promise<{ contact: CrmContactView; timeline: CrmActivityView[] } | null> {
  const snap = await adminDb.collection(CRM_CONTACTS).doc(contactId).get()
  if (!snap.exists) return null
  const d = snap.data() as CrmContactDoc
  if (d.organizerUid !== uid) return null                       // cross-workspace guard
  if (scope === 'donations' && (d.totalDonations ?? 0) === 0) return null

  const actSnap = await adminDb.collection(CRM_ACTIVITIES)
    .where('contactId', '==', contactId)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get()
  let timeline: CrmActivityView[] = actSnap.docs.map(a => {
    const x = a.data() as CrmActivityDoc
    return { type: x.type, entityId: x.entityId, metadata: x.metadata ?? {}, createdAt: x.createdAt ?? 0 }
  })
  if (scope === 'donations') timeline = timeline.filter(t => DONATION_TYPES.includes(t.type))

  return { contact: toView(d), timeline }
}

export interface UpdateContactInput { notes?: string; tags?: string[] }

export async function updateContact(uid: string, contactId: string, input: UpdateContactInput): Promise<boolean> {
  const ref = adminDb.collection(CRM_CONTACTS).doc(contactId)
  const snap = await ref.get()
  if (!snap.exists || (snap.data() as CrmContactDoc).organizerUid !== uid) return false

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (typeof input.notes === 'string') update.notes = input.notes.slice(0, 5000)
  if (Array.isArray(input.tags)) {
    update.tags = [...new Set(input.tags
      .map(t => String(t).trim().toLowerCase())
      .filter(t => t.length > 0 && t.length <= 40))].slice(0, 20)
  }
  await ref.set(update, { merge: true })
  return true
}

export async function computeAnalytics(uid: string, scope: CrmScope): Promise<CrmAnalytics> {
  const { docs, truncated } = await scanContacts(uid)

  const withReg = docs.filter(c => c.totalRegistrations > 0)
  const repeat = docs.filter(c => c.totalRegistrations >= 2)
  const checkedIn = docs.filter(c => c.totalCheckIns > 0)
  const donors = docs.filter(c => c.totalDonations > 0)
  const totalDonationPaise = donors.reduce((s, c) => s + c.totalDonationAmountPaise, 0)
  const topDonors = [...donors]
    .sort((a, b) => b.totalDonationAmountPaise - a.totalDonationAmountPaise)
    .slice(0, 10)
    .map(c => ({ name: c.name || c.email, email: c.email, amountPaise: c.totalDonationAmountPaise, contactId: c.contactId }))

  // Finance scope: expose donation metrics only; zero out attendance figures.
  const donationsOnly = scope === 'donations'
  return {
    totalContacts:      donationsOnly ? donors.length : docs.length,
    repeatAttendees:    donationsOnly ? 0 : repeat.length,
    checkedInContacts:  donationsOnly ? 0 : checkedIn.length,
    donorCount:         donors.length,
    totalDonationPaise,
    retentionRatePct:   donationsOnly || withReg.length === 0 ? 0 : Math.round((repeat.length / withReg.length) * 100),
    topDonors,
    scanned:            docs.length,
    truncated,
  }
}
