// Generic job serialization (Firestore Timestamp → ISO string) for API responses.
// Domain-neutral: works for ANY `Job` subtype (certificates, registration import,
// …). Mirrors the certificate serializer's timestamp handling so every job feature
// exposes the same wire shape without re-implementing it.

import type { Job } from './types'

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  if (v instanceof Date)     return v.toISOString()
  if (typeof v === 'string') return v
  return null
}

export type SerializedJob<T extends Job> =
  Omit<T, 'createdAt' | 'startedAt' | 'updatedAt' | 'completedAt' | 'lockedUntil'> & {
    createdAt:   string | null
    startedAt:   string | null
    updatedAt:   string | null
    completedAt: string | null
    lockedUntil: string | null
  }

export function serializeJob<T extends Job>(j: T): SerializedJob<T> {
  return {
    ...j,
    createdAt:   toIso(j.createdAt),
    startedAt:   toIso(j.startedAt),
    updatedAt:   toIso(j.updatedAt),
    completedAt: toIso(j.completedAt),
    lockedUntil: toIso(j.lockedUntil),
  } as SerializedJob<T>
}
