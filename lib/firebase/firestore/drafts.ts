import { auth } from '@/lib/firebase/auth'
import type { CommunicationBilling } from '@/types/events'
import type { LinkedCampaignDraft }  from '@/lib/campaigns/linkedCampaignConfig'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EventDraftDocument {
  id:               string
  status:           'draft' | 'published'
  currentStep:      number
  completedValues:  (string | null)[]
  eventType:          string | null
  eventSubtype:       string | null
  customEventSubtype: string | null
  // Set when eventType === 'fundraising' to signal campaign-wizard handoff
  campaignType:       string | null
  // Inline campaign data for event_plus_donation — null for all other types
  linkedCampaign:     LinkedCampaignDraft | null
  visibility:         string | null
  accessControl:    Record<string, unknown> | null
  pricing:          Record<string, unknown> | null
  registrationForm: Record<string, unknown> | null
  eventDetails:     Record<string, unknown>
  // Organizer's chosen Event License tier (F2.1). Persisted for the License step;
  // does not itself create or pay for a license.
  licenseTier?:     string | null
  // RD-CAPACITY-01 — the registration capacity the organizer selected. The publish step
  // re-quotes it server-side and requires a paid order to cover it, so this is the
  // organizer INTENT, never an authority on price. Absent on pre-migration drafts, which
  // keep publishing through the legacy tier-derived capacity path.
  registrationCapacity?: number | null
  // RD-EVENT-COMMERCE-02 — the prepaid service QUANTITIES the organizer selected on License &
  // Services. INTENT only: the allowance ledger (written by verified payments) is what an event
  // actually has, and publish refuses a selection the ledger does not cover.
  serviceSelection?: { whatsapp: number; certificates: number } | null
  // Server-controlled fields — never written by the client directly
  communicationBilling: CommunicationBilling | null
  publishedAt:          unknown   // Firestore Timestamp | null
  createdAt:            unknown   // Firestore Timestamp on server, null locally
  updatedAt:            unknown
}

export type DraftPayload = Partial<Omit<EventDraftDocument, 'id' | 'createdAt'>>


// ─── Transport ────────────────────────────────────────────────────────────────
//
// RD-CE-FIX M2/H6 · drafts are no longer written with the client SDK. Every read and write goes
// through /api/organizer/drafts (Admin SDK): the server resolves the WORKSPACE the caller acts for
// (so a team member edits the workspace's draft, the one publish and licensing read), checks the
// `events` permission, and applies the wizard-field allow-list in lib/events/draftWrite.ts — a
// lifecycle/review/publish/commerce field, or any unknown key, can no longer reach a draft.
// The function signatures are unchanged; `uid` is kept for callers but the server decides the path.

async function draftApi(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Not signed in')
  return fetch(`/api/organizer/drafts${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: 'no-store',
  })
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: unknown }
  return new Error(typeof body.error === 'string' && body.error ? body.error : `${what} failed (${res.status})`)
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates a draft document and returns its id.
 *
 * Callable with no arguments (blank draft — backward compatible) or with a
 * `seed` payload of wizard fields. The seed is used to defer creation until the
 * organizer explicitly clicks Continue, so the very first write already carries
 * their Step 1/2 selections (event category + visibility).
 *
 * Server-controlled / identity fields (`id`, `status`, `communicationBilling`,
 * `publishedAt`, timestamps) are fixed by the server and can never be set by the seed.
 */
export async function createEventDraft(
  _uid:  string,
  seed?: DraftPayload,
): Promise<string> {
  // RD-CE-FIX (orphan drafts) — one request id per creation attempt, kept in this tab's
  // sessionStorage until the server acknowledges it: a refresh mid-create (or a retried submit)
  // resolves to the SAME draft instead of orphaning one and creating another.
  const KEY = 'rd_draft_create_request'
  let requestId: string | null = null
  try {
    requestId = sessionStorage.getItem(KEY)
    if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(KEY, requestId) }
  } catch { requestId = null }
  const res = await draftApi('', { method: 'POST', body: JSON.stringify({ seed: seed ?? {}, ...(requestId ? { requestId } : {}) }) })
  if (!res.ok) throw await failure(res, 'Creating the draft')
  const { id } = await res.json() as { id: string }
  try { sessionStorage.removeItem(KEY) } catch { /* storage unavailable — nothing to clear */ }
  return id
}

/** Loads a draft by id. Returns null if it does not exist. Timestamps arrive as epoch millis. */
export async function loadEventDraft(
  _uid:    string,
  draftId: string,
): Promise<EventDraftDocument | null> {
  const res = await draftApi(`/${encodeURIComponent(draftId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, 'Loading the draft')
  const { draft } = await res.json() as { draft: EventDraftDocument }
  return draft
}

/** Merges partial data into the draft; the server bumps updatedAt. */
export async function saveEventDraft(
  _uid:    string,
  draftId: string,
  data:    DraftPayload,
): Promise<void> {
  const res = await draftApi(`/${encodeURIComponent(draftId)}`, { method: 'PATCH', body: JSON.stringify(data) })
  if (!res.ok) throw await failure(res, 'Saving the draft')
}
