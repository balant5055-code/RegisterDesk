// RD-CE-FIX M2/H6 · The ONLY shape a client may write into an event draft. SERVER-ONLY.
//
// Drafts used to be written straight from the browser (client SDK → users/{uid}/eventDrafts),
// guarded by a firestore.rules DENY-list. That let a client seed lifecycle stamps on create
// (lifecycleStatus, completedAt, reviewStatus, publishedAt), set `restoredAt`, or add any unknown
// field — and it pinned drafts to the CALLER's uid, so a team member's draft was invisible to
// every server route (which reads users/{workspaceUid}/…).
//
// The wizard now saves through /api/organizer/drafts (Admin SDK, authorizeWorkspace 'events').
// This module is the allow-list both routes apply: a key not listed here never reaches the draft,
// and every value is shape-checked. Lifecycle, review, billing, publish and commerce fields are
// written by their own server routes and nothing else.

/** Top-level draft fields the wizard writes (lib/events/builder/stepRegistry.ts draftKeys + extras). */
export const CLIENT_DRAFT_FIELDS = [
  'currentStep', 'completedValues',
  'eventType', 'eventSubtype', 'customEventSubtype', 'campaignType',
  'visibility', 'accessControl', 'pricing', 'registrationForm', 'eventDetails', 'linkedCampaign',
  'licenseTier', 'registrationCapacity', 'serviceSelection',
] as const
export type ClientDraftField = typeof CLIENT_DRAFT_FIELDS[number]

/** After a draft has produced its live event, these are identity — the live event owns them (H5). */
export const POST_PUBLISH_LOCKED_FIELDS: readonly ClientDraftField[] = [
  'eventType', 'eventSubtype', 'customEventSubtype', 'campaignType', 'visibility', 'licenseTier',
]

const STRING_FIELDS = new Set<string>(['eventType', 'eventSubtype', 'customEventSubtype', 'campaignType', 'visibility', 'licenseTier'])
const OBJECT_FIELDS = new Set<string>(['accessControl', 'pricing', 'registrationForm', 'eventDetails', 'linkedCampaign', 'serviceSelection'])
const MAX_STRING = 200
const MAX_STEPS = 12
/** Firestore's document limit is 1 MiB; leave headroom for server-written fields. */
export const MAX_DRAFT_PAYLOAD_BYTES = 900_000

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

export type DraftPayloadCheck =
  | { ok: true; fields: Partial<Record<ClientDraftField, unknown>>; dropped: string[] }
  | { ok: false; error: string; field?: string }

/**
 * Pure. Validates a client draft payload against the allow-list. Unknown keys are DROPPED and
 * reported (never written); a known key with the wrong shape fails the whole payload, so a bad
 * value can never be half-applied.
 */
export function sanitizeDraftPayload(raw: unknown): DraftPayloadCheck {
  if (!isPlainObject(raw)) return { ok: false, error: 'Draft payload must be an object.' }
  let size = 0
  try { size = JSON.stringify(raw).length } catch { return { ok: false, error: 'Draft payload is not serialisable.' } }
  if (size > MAX_DRAFT_PAYLOAD_BYTES) return { ok: false, error: 'Draft is too large to save.' }

  const allowed = new Set<string>(CLIENT_DRAFT_FIELDS)
  const fields: Partial<Record<ClientDraftField, unknown>> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) { dropped.push(key); continue }
    const f = key as ClientDraftField
    if (value === null) {
      if (f === 'currentStep' || f === 'completedValues') return { ok: false, error: `${f} cannot be empty.`, field: f }
      fields[f] = null; continue
    }
    if (f === 'currentStep') {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= MAX_STEPS) return { ok: false, error: 'Invalid step.', field: f }
    } else if (f === 'completedValues') {
      if (!Array.isArray(value) || value.length > MAX_STEPS || !value.every(v => v === null || (typeof v === 'string' && v.length <= MAX_STRING))) {
        return { ok: false, error: 'Invalid step progress.', field: f }
      }
    } else if (f === 'registrationCapacity') {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        return { ok: false, error: 'Capacity must be a whole number.', field: f }
      }
    } else if (STRING_FIELDS.has(f)) {
      if (typeof value !== 'string' || value.length > MAX_STRING) return { ok: false, error: `Invalid ${f}.`, field: f }
    } else if (OBJECT_FIELDS.has(f)) {
      if (!isPlainObject(value)) return { ok: false, error: `Invalid ${f}.`, field: f }
    }
    fields[f] = value
  }
  return { ok: true, fields, dropped }
}

/**
 * Pure. For a draft that already produced its live event (`publishedAt` set): drops identity
 * changes and pins the public slug to the stored one, so neither the wizard nor a forged request
 * can re-type the event, change its visibility/licence, or repoint it at another event (C1/H5).
 * Returns the fields to write and the keys that were refused.
 */
export function pinPublishedDraftFields(
  fields:  Partial<Record<ClientDraftField, unknown>>,
  current: Record<string, unknown>,
): { fields: Partial<Record<ClientDraftField, unknown>>; refused: string[] } {
  if (current.publishedAt == null) return { fields, refused: [] }
  const out = { ...fields }
  const refused: string[] = []
  for (const k of POST_PUBLISH_LOCKED_FIELDS) {
    if (k in out && JSON.stringify(out[k] ?? null) !== JSON.stringify(current[k] ?? null)) { delete out[k]; refused.push(k) }
  }
  if (isPlainObject(out.eventDetails)) {
    const curSeo = isPlainObject(current.eventDetails) && isPlainObject(current.eventDetails.seo) ? current.eventDetails.seo : {}
    const nextSeo = isPlainObject(out.eventDetails.seo) ? out.eventDetails.seo : {}
    if ((nextSeo.urlSlug ?? null) !== (curSeo.urlSlug ?? null)) refused.push('eventDetails.seo.urlSlug')
    out.eventDetails = { ...out.eventDetails, seo: { ...nextSeo, urlSlug: curSeo.urlSlug ?? null } }
  }
  return { fields: out, refused }
}

/** JSON-safe view of a stored draft: Firestore Timestamps become epoch millis. */
/** RD-REVIEW-02 — admin-only fields that never leave the server in an organizer-facing draft. */
const ADMIN_ONLY_DRAFT_FIELDS = ['rejectionNotes'] as const

export function serializeDraft(id: string, input: Record<string, unknown>): Record<string, unknown> {
  // The rejection NOTES are the Super Admin's internal note (older code copied them onto the draft).
  const data = { ...input }
  for (const k of ADMIN_ONLY_DRAFT_FIELDS) delete data[k]
  const walk = (v: unknown): unknown => {
    if (v && typeof v === 'object') {
      const t = v as { toMillis?: () => number }
      if (typeof t.toMillis === 'function') return t.toMillis()
      if (Array.isArray(v)) return v.map(walk)
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return { ...(walk(data) as Record<string, unknown>), id }
}
