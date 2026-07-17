// Client-only: uses the Firebase client SDK.
// Do NOT import from API routes — use adminDb there.

import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase/firestore'
import type { CampaignType, CampaignDetailsDraft } from '@/lib/campaigns/campaignDetailsConfig'
import type { DonationSettingsDraft } from '@/lib/campaigns/donationSettingsConfig'

// ─── Document shape ───────────────────────────────────────────────────────────

export interface CampaignDraftDocument {
  id:               string
  status:           'draft' | 'published'
  currentStep:      number
  completedValues:  (string | null)[]
  campaignType:     CampaignType
  eventSubtype:     string | null            // DonationCampaignSubtype for donation_only
  visibility:       'public' | 'private' | null
  campaignDetails:  CampaignDetailsDraft | null
  donationSettings: DonationSettingsDraft | null
  publishedCampaignId: string | null
  publishedSlug:       string | null
  createdAt:        unknown   // Firestore Timestamp
  updatedAt:        unknown   // Firestore Timestamp
}

// Server-controlled fields — only POST /api/campaigns/publish (Admin SDK) may write these.
// Excluded from CampaignDraftPayload to mirror the Firestore security rule that blocks
// client updates to status, publishedCampaignId, and publishedSlug.
type ServerControlledFields = 'id' | 'createdAt' | 'status' | 'publishedCampaignId' | 'publishedSlug'

export type CampaignDraftPayload = Partial<Omit<CampaignDraftDocument, ServerControlledFields>>

// ─── Constants ────────────────────────────────────────────────────────────────

// Donation-only campaign wizard has 4 steps: Visibility, Campaign Details,
// Donation Settings, Review.
const CAMPAIGN_DRAFT_STEPS = 4

// ─── Firestore path ───────────────────────────────────────────────────────────

function col(uid: string) {
  return collection(db, 'users', uid, 'campaignDrafts')
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createCampaignDraft(
  uid:     string,
  initial: { campaignType?: CampaignType; eventSubtype?: string | null } = {},
): Promise<string> {
  const ref = doc(col(uid))

  // Build payload as a named variable so it can be logged before the write
  const payload = {
    id:               ref.id,
    status:           'draft'         as const,
    currentStep:      0,
    completedValues:  Array(CAMPAIGN_DRAFT_STEPS).fill(null) as null[],
    campaignType:     (initial.campaignType  ?? 'donation_only') as CampaignType,
    eventSubtype:     initial.eventSubtype  ?? null,
    visibility:       null,
    campaignDetails:  null,
    donationSettings: null,
    publishedCampaignId: null,
    publishedSlug:       null,
    createdAt:        serverTimestamp(),
    updatedAt:        serverTimestamp(),
  }

  // Diagnostic breadcrumb — non-PII identifiers only. The full draft payload is
  // deliberately NOT logged (it can contain organizer-entered contact details).
  console.log(`[campaignDrafts] createCampaignDraft uid=${uid} draftId=${ref.id} path=${ref.path}`)

  await setDoc(ref, payload)
  return ref.id
}

export async function loadCampaignDraft(
  uid:     string,
  draftId: string,
): Promise<CampaignDraftDocument | null> {
  const ref = doc(col(uid), draftId)
  console.log("Firebase Project:", db.app.options.projectId)
  console.log("[campaignDrafts] operation:", "loadCampaignDraft")
  console.log("[campaignDrafts] uid:", uid)
  console.log("[campaignDrafts] draftId:", draftId)
  console.log("[campaignDrafts] path:", ref.path)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as CampaignDraftDocument
}

export async function saveCampaignDraft(
  uid:     string,
  draftId: string,
  data:    CampaignDraftPayload,
): Promise<void> {
  const ref = doc(col(uid), draftId)
  console.log("Firebase Project:", db.app.options.projectId)
  console.log("[campaignDrafts] operation:", "saveCampaignDraft")
  console.log("[campaignDrafts] uid:", uid)
  console.log("[campaignDrafts] draftId:", draftId)
  console.log("[campaignDrafts] path:", ref.path)
  await updateDoc(ref, {
    ...data,
    updatedAt: serverTimestamp(),
  })
}
