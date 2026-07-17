import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase/firestore'
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
  // Server-controlled fields — never written by the client directly
  communicationBilling: CommunicationBilling | null
  publishedAt:          unknown   // Firestore Timestamp | null
  createdAt:            unknown   // Firestore Timestamp on server, null locally
  updatedAt:            unknown
}

export type DraftPayload = Partial<Omit<EventDraftDocument, 'id' | 'createdAt'>>

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Max steps across all event types (9 for event_plus_donation with the License
// step, 8 for others). Over-provisioning the array is safe — extra slots are ignored.
const MAX_STEPS = 9

function col(uid: string) {
  return collection(db, 'users', uid, 'eventDrafts')
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
 * `publishedAt`, timestamps) are fixed here and can never be overridden by the
 * seed — mirroring the constraints enforced by firestore.rules.
 */
export async function createEventDraft(
  uid:   string,
  seed?: DraftPayload,
): Promise<string> {
  const ref = doc(col(uid))

  const safeSeed: DraftPayload = { ...(seed ?? {}) }
  delete safeSeed.status
  delete safeSeed.communicationBilling
  delete safeSeed.publishedAt
  delete safeSeed.updatedAt

  await setDoc(ref, {
    id:               ref.id,
    status:           'draft',
    currentStep:      0,
    completedValues:  Array(MAX_STEPS).fill(null),
    eventType:          null,
    eventSubtype:       null,
    customEventSubtype: null,
    campaignType:       null,
    linkedCampaign:     null,
    visibility:         null,
    accessControl:    null,
    pricing:          null,
    registrationForm: null,
    eventDetails:     {},
    communicationBilling: null,
    publishedAt:          null,
    // Wizard selections (eventType, visibility, currentStep, …) override blanks.
    ...safeSeed,
    createdAt:        serverTimestamp(),
    updatedAt:        serverTimestamp(),
  })
  return ref.id
}

/** Loads a draft by id. Returns null if it does not exist. */
export async function loadEventDraft(
  uid:     string,
  draftId: string,
): Promise<EventDraftDocument | null> {
  const snap = await getDoc(doc(col(uid), draftId))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as EventDraftDocument
}

/** Merges partial data into the draft and bumps updatedAt. */
export async function saveEventDraft(
  uid:     string,
  draftId: string,
  data:    DraftPayload,
): Promise<void> {
  await updateDoc(doc(col(uid), draftId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}
