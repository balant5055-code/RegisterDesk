// POST /api/campaigns/publish
//
// Security model:
//   1. Firebase ID token in Authorization header (never trusted client state).
//   2. Campaign draft is loaded server-side from Firestore.
//   3. All business rules (including 80G completeness) re-run here.
//   4. Atomic transaction writes to donationCampaigns/{slug} + donationCounters/{slug}.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { verifyCaller } from '@/lib/team/access'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import {
  type CampaignDetailsDraft,
  getCampaignPublishBlockers,
} from '@/lib/campaigns/campaignDetailsConfig'
import { safeImageUrl } from '@/lib/utils/imageUrl'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

// ─── Response shapes ──────────────────────────────────────────────────────────

interface PublishSuccess {
  success:    true
  slug:       string
  campaignId: string
}

interface PublishError {
  success: false
  error:   string
  reason?: string
  blockers?: Array<{ field: string; message: string }>
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<PublishSuccess | PublishError>> {
  // ── 1. Verify Firebase ID token (canonical — email-verification gate) ───────
  //      Matches /api/events/publish, which already authorizes through this gate.
  const caller = await verifyCaller(req)
  if (!caller) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const uid = caller.uid

  // ── 1b. Block suspended/banned organizers ──────────────────────────────────
  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  // ── 2. Parse and validate request body ────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = null }

  const draftId = (body as Record<string, unknown> | null)?.draftId
  if (typeof draftId !== 'string' || !draftId) {
    return NextResponse.json({ success: false, error: 'draftId is required' }, { status: 400 })
  }

  // ── 3. Load campaign draft from Firestore ──────────────────────────────────
  const draftRef = adminDb.doc(`users/${uid}/campaignDrafts/${draftId}`)
  let draftSnap: FirebaseFirestore.DocumentSnapshot
  try {
    draftSnap = await draftRef.get()
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to load draft' }, { status: 500 })
  }

  if (!draftSnap.exists) {
    return NextResponse.json({ success: false, reason: 'DRAFT_NOT_FOUND', error: 'Campaign draft not found' }, { status: 404 })
  }

  const draftData = draftSnap.data() as Record<string, unknown>

  if (draftData.status === 'published') {
    return NextResponse.json({ success: false, reason: 'ALREADY_PUBLISHED', error: 'Campaign is already published' }, { status: 409 })
  }

  // ── 4. Validate campaign details and donation settings ────────────────────
  const campaignDetails = draftData.campaignDetails as CampaignDetailsDraft | null
  if (!campaignDetails) {
    return NextResponse.json({
      success:  false,
      reason:   'MISSING_CAMPAIGN_DETAILS',
      error:    'Campaign details are required before publishing',
    }, { status: 422 })
  }

  const blockers = getCampaignPublishBlockers(campaignDetails)
  if (blockers.length > 0) {
    return NextResponse.json({
      success:  false,
      reason:   'VALIDATION_FAILED',
      error:    'Campaign has errors that must be fixed before publishing',
      blockers,
    }, { status: 422 })
  }

  // Enforce 80G completeness separately as a hard gate
  if (campaignDetails.taxConfig.enabled) {
    const t = campaignDetails.taxConfig
    const missing: string[] = []
    if (!t.organizationPan?.trim())    missing.push('Organization PAN')
    if (!t.registrationNumber?.trim()) missing.push('80G Registration Number')
    if (!t.certificateUrl)             missing.push('80G Certificate (upload required)')
    if (!t.certificateExpiry)          missing.push('Certificate Expiry Date')

    if (missing.length > 0) {
      return NextResponse.json({
        success: false,
        reason:  '80G_INCOMPLETE',
        error:   `80G tax exemption requires: ${missing.join(', ')}`,
        blockers: missing.map(field => ({ field, message: `${field} is required for 80G compliance` })),
      }, { status: 422 })
    }
  }

  // ── 5. Generate slug ───────────────────────────────────────────────────────
  const title       = campaignDetails.basics.title ?? ''
  const slugifiedTitle = slugify(title)
  const slug        = slugifiedTitle
    ? `${slugifiedTitle}-${draftId.slice(-6)}`
    : draftId

  // ── 6. Atomic transaction: check slug → write campaign + counter + update draft ──
  const campaignRef = adminDb.collection('donationCampaigns').doc(slug)
  const counterRef  = adminDb.collection('donationCounters').doc(slug)

  const finalSlug = slug

  try {
    await adminDb.runTransaction(async txn => {
      // All reads before writes (Firestore transaction rule)
      const existingCampaign = await txn.get(campaignRef)

      if (existingCampaign.exists) {
        const existing = existingCampaign.data() as Record<string, unknown>
        if (existing.draftId !== draftId) {
          const conflict   = new Error('SLUG_CONFLICT')
          conflict.name    = 'SLUG_CONFLICT'
          throw conflict
        }
        // Same draftId already published — idempotent re-publish is fine
      }

      const now = FieldValue.serverTimestamp()

      // Write campaign document
      txn.set(campaignRef, {
        slug,
        uid,
        draftId,
        campaignType:     draftData.campaignType    ?? 'donation_only',
        eventSubtype:     draftData.eventSubtype    ?? null,
        visibility:       draftData.visibility      ?? 'public',
        // Never persist an unapproved/invalid cover URL (e.g. a pasted Google
        // thumbnail) — store null instead so the public page renders its
        // placeholder rather than a src that crashes next/Image.
        campaignDetails:  {
          ...campaignDetails,
          media: { ...campaignDetails.media, coverImageUrl: safeImageUrl(campaignDetails.media.coverImageUrl) },
        },
        donationSettings: draftData.donationSettings ?? null,
        status:           'active',
        totalRaisedPaise: 0,
        donorCount:       0,
        createdAt:        now,
        publishedAt:      now,
        updatedAt:        now,
      })

      // Write donation counter (separate doc for high-frequency writes)
      txn.set(counterRef, {
        slug,
        uid,
        totalRaisedPaise: 0,
        donorCount:       0,
        lastDonationAt:   null,
        createdAt:        now,
        updatedAt:        now,
      }, { merge: true })

      // Update draft to published state
      txn.update(draftRef, {
        status:              'published',
        publishedCampaignId: slug,
        publishedSlug:       slug,
        updatedAt:           now,
      })
    })
  } catch (err: unknown) {
    const name = (err as Error).name
    if (name === 'SLUG_CONFLICT') {
      return NextResponse.json({
        success: false,
        reason:  'SLUG_CONFLICT',
        error:   'A campaign with this title already exists. Please choose a different title.',
      }, { status: 409 })
    }
    console.error('[POST /api/campaigns/publish] transaction failed:', err)
    return NextResponse.json({ success: false, error: 'Failed to publish campaign. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, slug: finalSlug, campaignId: slug })
}
