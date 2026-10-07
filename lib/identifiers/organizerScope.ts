// Phase H.3 — Shared organizer scope resolution for the identifier API layer.
//
// One place that: (1) authenticates + enforces the `participants` permission,
// (2) resolves eventId (draft id) → eventSlug within the caller's workspace, and
// (3) guards registration-targeting actions against cross-event / cross-organizer
// access. Every identifier route reuses this — no duplicated auth/scope logic.

import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace, authorizeWorkspaceDownload } from '@/lib/team/workspace'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/** A pass as the event draft records it. Id + name only — never PII, never price. */
export interface ScopePass { id: string; name: string }

export type ScopeResult =
  | {
      ok: true; slug: string; workspaceUid: string; callerUid: string
      /**
       * RD-EVENT-19B · the event's passes, from the SAME draft snapshot the slug
       * comes from. Costs nothing: this document was already read.
       *
       * It exists so a pool wired to a DELETED pass can be reported as orphaned
       * without a second query. `passesKnown` is false when the draft carries no
       * readable pass list — in which case nothing is called orphaned, because
       * guessing in that direction would condemn every pool at once.
       */
      passes: ScopePass[]
      passesKnown: boolean
      /**
       * RD-EVENT-19C · the event's lifecycle, from the SAME draft snapshot the
       * slug and passes come from — zero extra reads.
       *
       * The organizer identifier routes had NO lifecycle check at all, so an
       * identifier could be assigned on a cancelled or archived event. The gate
       * lives in `resolveEventAssignmentGate`; this only carries the fact.
       */
      lifecycleStatus: string | null
    }
  | { ok: false; status: number; error: string }

/**
 * Auth (`participants`) + workspace-scoped eventId→slug resolution.
 *
 * `forDownload` accepts the Firebase ID token from a `?token=` query parameter as
 * well as the Authorization header, via the platform's existing
 * `authorizeWorkspaceDownload` — required for an `<a href>` download, which cannot
 * set a header. The guarantees are identical; only where the token is read differs.
 */
export async function resolveIdentifierScope(
  req: Request, eventId: string, opts: { forDownload?: boolean } = {},
): Promise<ScopeResult> {
  const authz = opts.forDownload
    ? await authorizeWorkspaceDownload(req, 'participants')
    : await authorizeWorkspace(req, 'participants')
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error }

  const uid = authz.workspaceUid
  // RD-EVENT-19A (audit finding I-9) · `adminDb.doc()` THROWS on a path with the
  // wrong number of segments, so an eventId like `..%2F..%2Fadmin` escaped as an
  // unhandled 500 carrying a Next digest. An id that cannot name a document
  // cannot name an event the caller owns — so it is a 404, and nothing internal
  // reaches the client. Mirrors the guard already in lib/sessions/eventScope.
  let draftSnap
  try {
    draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  } catch {
    return { ok: false, status: 404, error: 'Event not found' }
  }
  if (!draftSnap.exists) return { ok: false, status: 404, error: 'Event not found' }

  const d   = draftSnap.data() as Record<string, unknown>
  // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft.
  const slug = (await resolveOwnedEventSlug(uid, eventId, d)) ?? ''
  if (!slug) return { ok: false, status: 400, error: 'Event not published' }

  const { passes, passesKnown } = readPasses(d)
  return {
    ok: true, slug, workspaceUid: uid, callerUid: authz.callerUid, passes, passesKnown,
    lifecycleStatus: typeof d.lifecycleStatus === 'string' ? d.lifecycleStatus : null,
  }
}

/**
 * Pass ids + names out of the draft's `pricing.passes`, the same place the event
 * detail API reads them. A draft with no readable list yields `passesKnown:false`
 * rather than an empty list, because "this event has no passes" and "we could not
 * see the passes" lead to opposite conclusions about an orphaned pool.
 */
function readPasses(d: Record<string, unknown>): { passes: ScopePass[]; passesKnown: boolean } {
  const pricing = d.pricing as Record<string, unknown> | undefined
  const raw = pricing?.passes
  if (!Array.isArray(raw)) return { passes: [], passesKnown: false }

  const passes: ScopePass[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const p = entry as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) continue
    passes.push({ id, name: typeof p.name === 'string' && p.name ? p.name : 'Pass' })
  }
  return { passes, passesKnown: true }
}

export type RegScopeResult =
  /**
   * RD-EVENT-19A · `passId` rides along ADDITIVELY. This function already reads
   * the registration document to prove ownership, so returning the pass it names
   * lets a route allocate into the pass's own pool at ZERO extra read cost —
   * and the pass id comes from the stored document, never from the request body,
   * so a caller cannot steer allocation into a pool it does not own.
   *
   * Existing callers destructure only `.ok` and are unaffected.
   */
  | { ok: true; passId: string | null; category: string | null }
  | { ok: false; status: number; error: string }

/** Confirms a registration belongs to this workspace AND this event. */
export async function assertRegistrationInScope(
  registrationId: string, workspaceUid: string, slug: string,
): Promise<RegScopeResult> {
  if (!registrationId) return { ok: false, status: 400, error: 'registrationId is required' }
  let snap
  try {
    snap = await adminDb.collection('registrations').doc(registrationId).get()
  } catch {
    // A malformed registrationId cannot name a document, so it names nothing
    // this workspace owns. Never a 500.
    return { ok: false, status: 404, error: 'Registration not found' }
  }
  if (!snap.exists) return { ok: false, status: 404, error: 'Registration not found' }
  const r = snap.data() as Record<string, unknown>
  if (r.organizerUid !== workspaceUid || r.eventSlug !== slug) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return {
    ok: true,
    passId:   typeof r.passId === 'string' && r.passId ? r.passId : null,
    category: typeof r.bibCategory === 'string' && r.bibCategory ? r.bibCategory : null,
  }
}
