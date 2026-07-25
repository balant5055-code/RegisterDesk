// RD-PLATFORM-COMMS-02 Phase 5B — the canonical Audience resolver (server).
//
// Reads the audiences collection and validates each record through the ONE pure resolver
// (./normalize). READ-ONLY — it queries and shapes; it never writes, evaluates rules against
// live organizer data, or executes anything. The collection has no writer yet (the Composer is
// a future phase), so this returns [] until audiences are created. No audience is fabricated.

import { adminDb } from '@/lib/firebase/admin'
import { normalizeAudience, resolveAudience } from './normalize'
import type { ResolvedAudience, AudienceType, AudienceScope, AudienceStatus } from './types'

export interface AudienceFilters {
  type?:   AudienceType
  scope?:  AudienceScope
  status?: AudienceStatus
  search?: string
  limit?:  number
}

function tsToIso(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') return (ts as { toDate: () => Date }).toDate().toISOString()
  return typeof ts === 'string' ? ts : ''
}

/** Resolve the audience registry (read-only). */
export async function resolveAudiences(filters: AudienceFilters = {}): Promise<ResolvedAudience[]> {
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500)

  let query = adminDb.collection('audiences').orderBy('createdAt', 'desc') as FirebaseFirestore.Query
  if (filters.type)   query = query.where('type', '==', filters.type)
  if (filters.scope)  query = query.where('scope', '==', filters.scope)
  if (filters.status) query = query.where('status', '==', filters.status)

  const snap = await query.limit(limit).get()

  let audiences = snap.docs
    .map(doc => {
      const d = doc.data() as Record<string, unknown>
      return normalizeAudience({
        ...d, id: doc.id,
        createdAt: tsToIso(d.createdAt), updatedAt: tsToIso(d.updatedAt),
        lastEvaluatedAt: d.lastEvaluatedAt ? tsToIso(d.lastEvaluatedAt) : null,
      })
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map(resolveAudience)

  const term = filters.search?.trim().toLowerCase()
  if (term) audiences = audiences.filter(a => `${a.name} ${a.description}`.toLowerCase().includes(term))

  return audiences
}
