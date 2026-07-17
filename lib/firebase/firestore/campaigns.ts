// Server-only: Firebase Admin SDK reads — never import from client components.

import { adminDb } from '@/lib/firebase/admin'
import type { CampaignDetailsDraft } from '@/lib/campaigns/campaignDetailsConfig'
import type { DonationSettingsDraft } from '@/lib/campaigns/donationSettingsConfig'
import type { ModerationStatus }      from '@/lib/admin/moderation'
import { isContentTakenDown }         from '@/lib/admin/moderation'
import { safeImageUrl }               from '@/lib/utils/imageUrl'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Serializable campaign summary passed from Server Components to Client Components.
 * All Firestore Timestamps are converted to ISO strings.
 */
export interface CampaignListItem {
  slug:             string
  eventSubtype:     string | null
  title:            string
  tagline:          string
  coverImageUrl:    string | null
  beneficiaryName:  string
  goalRupees:       number | null
  showGoalAmount:   boolean
  endDate:          string           // ISO date YYYY-MM-DD
  organizerName:    string
  is80G:            boolean
  totalRaisedPaise: number
  donorCount:       number
  publishedAt:      string | null    // ISO string
}

export interface PublishedCampaign {
  slug:             string
  uid:              string
  draftId:          string
  campaignType:     string
  eventSubtype:     string | null
  visibility:       'public' | 'private'
  campaignDetails:  CampaignDetailsDraft
  donationSettings: DonationSettingsDraft | null
  status:           'active' | 'paused' | 'ended' | 'cancelled'
  totalRaisedPaise: number
  donorCount:       number
  publishedAt:      FirebaseFirestore.Timestamp | null
  updatedAt:        FirebaseFirestore.Timestamp | null
  // Set for event_plus_donation campaigns — both fields hold the same value (slug = Firestore doc ID)
  linkedEventSlug?: string
  linkedEventId?:   string
  // Admin moderation (Phase 3) — missing = 'active'. See lib/admin/moderation.ts.
  moderationStatus?: ModerationStatus
  moderationReason?: string
  moderationBy?:     string
  moderationAt?:     FirebaseFirestore.Timestamp
}

export interface CampaignCounter {
  totalRaisedPaise: number
  donorCount:       number
  lastDonationAt:   FirebaseFirestore.Timestamp | null
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getCampaignBySlug(slug: string): Promise<PublishedCampaign | null> {
  const snap = await adminDb.collection('donationCampaigns').doc(slug).get()
  if (!snap.exists) return null
  return snap.data() as PublishedCampaign
}

export async function getCampaignCounter(slug: string): Promise<CampaignCounter | null> {
  const snap = await adminDb.collection('donationCounters').doc(slug).get()
  if (!snap.exists) return null
  return snap.data() as CampaignCounter
}

/**
 * List all active public donation campaigns for the /causes discovery page.
 * Returns serialized summaries safe to pass to Client Components.
 */
export async function listCampaigns(): Promise<CampaignListItem[]> {
  const snap = await adminDb
    .collection('donationCampaigns')
    .where('status',     '==', 'active')
    .where('visibility', '==', 'public')
    .orderBy('publishedAt', 'desc')
    .limit(100)
    .get()

  return snap.docs
    // Exclude admin-taken-down campaigns from public discovery (status stays
    // 'active'; moderation is a separate axis). Filtered in memory — 'active' is
    // the absence of the field and can't be queried directly.
    .filter(doc => !isContentTakenDown((doc.data() as PublishedCampaign).moderationStatus))
    .map(doc => {
    const d  = doc.data() as PublishedCampaign
    const cd = d.campaignDetails

    const publishedAt = d.publishedAt
      ? (d.publishedAt as unknown as { toDate: () => Date }).toDate().toISOString()
      : null

    return {
      slug:             d.slug,
      eventSubtype:     d.eventSubtype ?? null,
      title:            cd.basics.title,
      tagline:          cd.basics.tagline,
      // Neutralise any unapproved/invalid stored URL (e.g. a pasted Google
      // thumbnail) at the data layer → the list never carries a src that would
      // crash next/Image; the card renders its existing empty state instead.
      coverImageUrl:    safeImageUrl(cd.media.coverImageUrl),
      beneficiaryName:  cd.beneficiary.name,
      goalRupees:       cd.goal.targetAmountRupees,
      showGoalAmount:   cd.goal.showGoalAmount,
      endDate:          cd.goal.endDate,
      organizerName:    cd.organizer.name,
      is80G:            cd.taxConfig.enabled,
      totalRaisedPaise: d.totalRaisedPaise ?? 0,
      donorCount:       d.donorCount       ?? 0,
      publishedAt,
    } satisfies CampaignListItem
  })
}
