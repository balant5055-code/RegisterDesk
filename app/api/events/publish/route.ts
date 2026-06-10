// POST /api/events/publish
//
// Security model:
//   1. Firebase ID token in Authorization header (never trusted client state).
//   2. Draft is loaded server-side from Firestore.
//   3. validateEventPublish() re-runs all business rules.
//   4. Status is written only after successful validation.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }    from 'firebase-admin/firestore'
import { adminDb, adminAuth } from '@/lib/firebase/admin'
import { validateEventPublish }  from '@/lib/events/validatePublish'
import { ensureCounterExists }   from '@/lib/firebase/firestore/registrationCounters'
import { resolveTotalCapacity }  from '@/lib/registrations/capacity'
import { txnDeductWallet }        from '@/lib/firebase/firestore/wallet'
import { calculateCommunicationCost } from '@/lib/events/communicationCost'
import { estimateCapacity }           from '@/lib/events/estimateCapacity'
import type { PublishApiResponse } from '@/types/events'


export async function POST(req: NextRequest): Promise<NextResponse<PublishApiResponse>> {
  // ── 1. Verify Firebase ID token ────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) {
    return NextResponse.json({ canPublish: false, error: 'Unauthorized' }, { status: 401 })
  }

  let uid: string
  try {
    const decoded = await adminAuth.verifyIdToken(token)
    uid = decoded.uid
  } catch {
    return NextResponse.json({ canPublish: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── 2. Parse and validate request body ────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = null }

  const draftId = (body as Record<string, unknown> | null)?.draftId
  if (typeof draftId !== 'string' || !draftId) {
    return NextResponse.json({ canPublish: false, error: 'draftId is required' }, { status: 400 })
  }

  // ── 3. Load draft from Firestore (server is source of truth) ──────────────
  const draftRef = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
  let snap: FirebaseFirestore.DocumentSnapshot
  try {
    snap = await draftRef.get()
  } catch {
    return NextResponse.json({ canPublish: false, error: 'Failed to load draft' }, { status: 500 })
  }

  if (!snap.exists) {
    return NextResponse.json({ canPublish: false, reason: 'DRAFT_NOT_FOUND', error: 'Draft not found' }, { status: 404 })
  }

  const draft = snap.data() as Record<string, unknown>

  // ── 4. Run server-side publish validation ─────────────────────────────────
  const validation = validateEventPublish({
    status:               draft.status               as string,
    pricing:              draft.pricing              as Record<string, unknown> | null,
    eventDetails:         draft.eventDetails         as Record<string, unknown> | null,
    communicationBilling: draft.communicationBilling as Record<string, unknown> | null | undefined,
    registrationForm:     draft.registrationForm     as Record<string, unknown> | null | undefined,
  })

  if (!validation.canPublish) {
    return NextResponse.json(
      { canPublish: false, reason: validation.reason },
      { status: 403 },
    )
  }

  // ── 5. Resolve public slug ────────────────────────────────────────────────
  const rawDetails  = draft.eventDetails as Record<string, unknown> | null
  const rawSeo      = rawDetails?.seo    as Record<string, unknown> | null
  const rawInfo     = rawDetails?.info   as Record<string, unknown> | null
  const customSlug  = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug.trim() : ''
  const eventName   = typeof rawInfo?.name   === 'string' ? rawInfo.name.trim()   : ''

  function slugify(text: string): string {
    return text
      .toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80)
  }

  const slugifiedName = slugify(eventName)
  const slug = customSlug
    || (slugifiedName ? `${slugifiedName}-${draftId.slice(-6)}` : draftId)

  // ── 6+7. Atomic transaction: read slug → check uniqueness → write event + draft ─
  //        runTransaction replaces batch so we can read the events/{slug} doc
  //        before writing.  If another event already owns that slug we return a
  //        typed SLUG_CONFLICT 409 instead of silently overwriting the existing
  //        event.  All Firestore transaction reads must precede writes.
  const rawPricing    = draft.pricing as Record<string, unknown> | null
  const isFreeEvent   = rawPricing?.eventType === 'free'
  const planType      = isFreeEvent ? 'free_event'  : 'paid_event'   as const
  const capacityPlan  = isFreeEvent ? 'free'        : 'unlimited'    as const
  const totalCapacity = resolveTotalCapacity(capacityPlan)

  // Pre-compute wallet deduction amount for free events with comm channels.
  // The actual balance check + deduction happens inside the atomic transaction.
  const wpEnabled  = !!(rawPricing?.whatsappEnabled as boolean)
  const smsEnabled = !!(rawPricing?.smsEnabled      as boolean)
  const needsWalletDeduction = isFreeEvent && (wpEnabled || smsEnabled)

  let commCostPaise = 0
  if (needsWalletDeduction) {
    const cost = calculateCommunicationCost({
      estimatedCapacity: estimateCapacity(rawPricing),
      whatsappEnabled: wpEnabled,
      smsEnabled,
    })
    commCostPaise = cost.totalPaise
  }

  const slugRef   = adminDb.collection('events').doc(slug)
  const walletRef = needsWalletDeduction
    ? adminDb.doc(`organizerWallets/${uid}`)
    : null

  try {
    await adminDb.runTransaction(async (txn) => {
      // Read first — Firestore transactions require all reads before any write.
      const existingSnap = await txn.get(slugRef)

      // Wallet balance read (free events with comm channels only)
      if (walletRef && commCostPaise > 0) {
        const walletSnap    = await txn.get(walletRef)
        const currentBal    = walletSnap.exists
          ? ((walletSnap.data() as Record<string, unknown>).balancePaise as number ?? 0)
          : 0
        if (currentBal < commCostPaise) {
          const err = new Error('WALLET_INSUFFICIENT')
          err.name  = 'WALLET_INSUFFICIENT'
          throw err
        }
      }

      if (existingSnap.exists && (existingSnap.data() as Record<string, unknown>)?.draftId !== draftId) {
        const conflict = new Error('SLUG_CONFLICT')
        conflict.name  = 'SLUG_CONFLICT'
        throw conflict
      }

      txn.set(slugRef, {
        slug,
        uid,
        draftId,
        eventType:       draft.eventType    ?? null,
        eventSubtype:    draft.eventSubtype ?? null,
        visibility:      draft.visibility   ?? null,
        pricing:         draft.pricing      ?? null,
        eventDetails: {
          ...(draft.eventDetails as Record<string, unknown> ?? {}),
          seo: { ...(rawSeo ?? {}), urlSlug: slug },
        },
        planType,
        capacityPlan,
        totalCapacity,
        registrationForm: draft.registrationForm ?? null,
        lifecycleStatus: 'published',
        publishedAt:     FieldValue.serverTimestamp(),
        updatedAt:       FieldValue.serverTimestamp(),
      })

      txn.update(draftRef, {
        status:                  'published',
        publishedAt:             FieldValue.serverTimestamp(),
        updatedAt:               FieldValue.serverTimestamp(),
        'eventDetails.seo.urlSlug': slug,
      })

      // Deduct wallet for free events with comm channels (read already validated above)
      if (walletRef && commCostPaise > 0) {
        txnDeductWallet(txn, uid, commCostPaise)
      }
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'WALLET_INSUFFICIENT') {
      return NextResponse.json(
        {
          canPublish: false,
          reason:     'WALLET_INSUFFICIENT' as const,
          error:      `Insufficient wallet balance. Add funds to publish this event with WhatsApp/SMS enabled.`,
        },
        { status: 402 },
      )
    }
    if (err instanceof Error && err.name === 'SLUG_CONFLICT') {
      return NextResponse.json(
        { canPublish: false, reason: 'SLUG_CONFLICT' as const, error: 'This URL is already taken by another published event. Choose a different custom URL.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ canPublish: false, error: 'Failed to publish event' }, { status: 500 })
  }

  // ── 8. Pre-create zero counter (avoids missing-doc edge case on first reg) ─
  //      Best-effort: first registration transaction creates the counter if absent.
  try {
    await ensureCounterExists(slug)
  } catch {
    console.error('[publish] Failed to initialize registration counter:', slug)
  }

  return NextResponse.json({
    canPublish:   true,
    publishedAt:  new Date().toISOString(),
    slug,
  })
}
