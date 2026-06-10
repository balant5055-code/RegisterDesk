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

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EventDraftDocument {
  id:               string
  status:           'draft' | 'published'
  currentStep:      number
  completedValues:  (string | null)[]
  eventType:          string | null
  eventSubtype:       string | null
  customEventSubtype: string | null
  visibility:         string | null
  accessControl:    Record<string, unknown> | null
  pricing:          Record<string, unknown> | null
  registrationForm: Record<string, unknown> | null
  eventDetails:     Record<string, unknown>
  // Server-controlled fields — never written by the client directly
  communicationBilling: CommunicationBilling | null
  publishedAt:          unknown   // Firestore Timestamp | null
  createdAt:            unknown   // Firestore Timestamp on server, null locally
  updatedAt:            unknown
}

export type DraftPayload = Partial<Omit<EventDraftDocument, 'id' | 'createdAt'>>

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 7

function col(uid: string) {
  return collection(db, 'users', uid, 'eventDrafts')
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Creates a blank draft document and returns its id. */
export async function createEventDraft(uid: string): Promise<string> {
  const ref = doc(col(uid))
  await setDoc(ref, {
    id:               ref.id,
    status:           'draft',
    currentStep:      0,
    completedValues:  Array(TOTAL_STEPS).fill(null),
    eventType:          null,
    eventSubtype:       null,
    customEventSubtype: null,
    visibility:         null,
    accessControl:    null,
    pricing:          null,
    registrationForm: null,
    eventDetails:     {},
    communicationBilling: null,
    publishedAt:          null,
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
