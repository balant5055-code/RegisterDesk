// GET /api/organizer/crm/contacts/export?search&filter&tag
//
// Streams the workspace's CRM contacts as a CSV download. Workspace + role aware
// (same as the list): owner/admin/manager → all contacts; finance → donors only;
// checkin_staff → denied. Firestore is read in bounded batches and rows are
// streamed out as they are produced, so memory stays flat for large datasets.

import { NextRequest } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeCrm } from '@/lib/crm/access'
import { CRM_CONTACTS, type CrmContactDoc } from '@/lib/crm/types'
import type { ContactFilter } from '@/lib/crm/queries'
import { csvCell } from '@/lib/utils/csv'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FILTERS: ContactFilter[] = ['all', 'donors', 'repeat', 'checked_in', 'not_checked_in']
const BATCH = 500

// Shared csvCell (formula-injection defense + quoting); this variant appends CRLF.
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n'
}

function isoDate(ms: number): string {
  return ms ? new Date(ms).toISOString() : ''
}

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) {
    return new Response(JSON.stringify({ error: authz.error }), {
      status: authz.status, headers: { 'Content-Type': 'application/json' },
    })
  }

  const p = req.nextUrl.searchParams
  const filterParam = p.get('filter')
  const filter = FILTERS.includes(filterParam as ContactFilter) ? (filterParam as ContactFilter) : 'all'
  const tag = (p.get('tag') ?? '').trim().toLowerCase() || undefined
  const search = (p.get('search') ?? '').slice(0, 120).trim().toLowerCase() || undefined
  const donationsScope = authz.scope === 'donations'

  // Same predicate as the list, applied per row during the stream.
  function matches(c: CrmContactDoc): boolean {
    if (donationsScope && (c.totalDonations ?? 0) <= 0) return false
    switch (filter) {
      case 'donors':         if ((c.totalDonations ?? 0) <= 0) return false; break
      case 'repeat':         if ((c.totalRegistrations ?? 0) < 2) return false; break
      case 'checked_in':     if ((c.totalCheckIns ?? 0) <= 0) return false; break
      case 'not_checked_in': if (!((c.totalRegistrations ?? 0) > 0 && (c.totalCheckIns ?? 0) === 0)) return false; break
      default: break
    }
    if (tag && !(c.tags ?? []).includes(tag)) return false
    if (search) {
      const hit = (c.name ?? '').toLowerCase().includes(search)
        || (c.email ?? '').includes(search)
        || (c.phone ?? '').includes(search)
      if (!hit) return false
    }
    return true
  }

  const uid = authz.workspaceUid
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvRow([
          'Name', 'Email', 'Phone', 'Registrations', 'Check-ins',
          'Donations', 'Donation Value (INR)', 'Tags', 'First Seen', 'Last Seen',
        ])))

        let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
        for (;;) {
          let q = adminDb.collection(CRM_CONTACTS)
            .where('organizerUid', '==', uid)
            .orderBy('lastSeenAt', 'desc')
            .limit(BATCH)
          if (cursor) q = q.startAfter(cursor)

          const snap = await q.get()
          if (snap.empty) break

          for (const doc of snap.docs) {
            const c = doc.data() as CrmContactDoc
            if (!matches(c)) continue
            controller.enqueue(encoder.encode(csvRow([
              c.name ?? '',
              c.email ?? '',
              c.phone ?? '',
              c.totalRegistrations ?? 0,
              c.totalCheckIns ?? 0,
              c.totalDonations ?? 0,
              ((c.totalDonationAmountPaise ?? 0) / 100).toFixed(2),
              (c.tags ?? []).join('; '),
              isoDate(c.firstSeenAt ?? 0),
              isoDate(c.lastSeenAt ?? 0),
            ])))
          }

          cursor = snap.docs[snap.docs.length - 1]
          if (snap.size < BATCH) break
        }

        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="crm-contacts.csv"',
      'Cache-Control':       'no-store',
    },
  })
}
