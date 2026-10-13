// Request parsing shared by the print-job create and quote routes. Server-only.
// (Moved from app/api/organizer/print-jobs/route.ts for RD-PRINT-BILL-P5 — the quote route reads
// the same body; one parser means the quote and the job always describe the same selection.)

import { adminDb } from '@/lib/firebase/admin'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { MAX_EXPLICIT_SELECTION, type PrintGenerationFilters } from '@/lib/printAssets/generationJob'

export type ParsedFilters =
  | { ok: true;  filters: PrintGenerationFilters }
  | { ok: false; requested: number }

/**
 * RD-PRINT-SCALE-IMPLEMENTATION-01 — this used to end in `ids.slice(0, 5000)`.
 *
 * A selection of 20,000 was silently cut to 5,000 and still answered 201 success, so the
 * organizer only found out which 15,000 badges were missing at the print shop. Over the
 * cap is now a rejection that names the number asked for.
 *
 * Duplicate ids are collapsed: the same registration selected twice is one badge, and
 * counting it twice would push a legitimate selection over the cap.
 */
export function parsePrintJobFilters(raw: unknown): ParsedFilters {
  const b = (raw ?? {}) as Record<string, unknown>
  const f: PrintGenerationFilters = {}
  if (typeof b.pass === 'string' && b.pass) f.pass = b.pass
  if (typeof b.category === 'string' && b.category) f.category = b.category
  if (Array.isArray(b.registrationIds)) {
    const ids = [...new Set(b.registrationIds.filter((x): x is string => typeof x === 'string' && !!x))]
    if (ids.length > MAX_EXPLICIT_SELECTION) return { ok: false, requested: ids.length }
    if (ids.length) f.registrationIds = ids
  }
  return { ok: true, filters: f }
}

export const overSelectionError = (requested: number) =>
  `Select at most ${MAX_EXPLICIT_SELECTION.toLocaleString('en-IN')} registrations per print job — you selected ${requested.toLocaleString('en-IN')}. Generate them in smaller batches.`

/**
 * The template stores the event DRAFT id; registrations are keyed by the published
 * slug. '' when the event is not published — OR when its live document does not prove it
 * belongs to this workspace and draft.
 *
 * RD-PRINT-BILL-P5 fix 1 — the draft's `eventDetails.seo.urlSlug` is client-writable, so it is
 * never used as-is: resolveOwnedEventSlug requires `events/{slug}.uid` to be this workspace and
 * its `draftId`, when present, to be this draft (fail closed). Billed jobs additionally require
 * the `draftId` stamp to be present and equal (resolvePrintJobBillingMode).
 */
export async function printEventSlugForDraft(workspaceUid: string, draftId: string): Promise<string> {
  const draftSnap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${draftId}`).get()
  if (!draftSnap.exists) return ''
  return (await resolveOwnedEventSlug(workspaceUid, draftId, draftSnap.data() as Record<string, unknown>)) ?? ''
}

/** RD-PRINT-BILL-P5 (D5) — a client-generated idempotency key; null when absent or malformed. */
export function parseRequestId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(v) ? v : null
}
