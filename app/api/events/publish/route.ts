// POST /api/events/publish
//
// Security model:
//   1. Firebase ID token in Authorization header (never trusted client state).
//   2. Draft is loaded server-side from Firestore.
//   3. validateEventPublish() re-runs all business rules.
//   4. Status is written only after successful validation.

import { NextRequest, NextResponse, after } from 'next/server'
import { FieldValue }    from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { organizerStatusGuard }  from '@/lib/admin/organizerStatus'
import { validateEventPublish }  from '@/lib/events/validatePublish'
import { ensureCounterExists }   from '@/lib/firebase/firestore/registrationCounters'
import { resolveTotalCapacity, capacityPlanForRegistrationLimit } from '@/lib/registrations/capacity'
import type { PublishApiResponse }    from '@/types/events'
import type { LinkedCampaignDraft }   from '@/lib/campaigns/linkedCampaignConfig'
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, eventLicenseConverter } from '@/lib/licensing/schema'
import {
  CURRENT_LICENSE_VERSION,
  isEventLicenseTier,
  type EventLicenseTier,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { validatePublishEligibility } from '@/lib/licensing/publishValidation'
import { getPublishingMode }          from '@/lib/platform/publishing'
import { sendEventReviewEmail }        from '@/lib/events/reviewNotifications'
import { safeImageUrl }                from '@/lib/utils/imageUrl'
import { governPublish, recordPublish, extractIdentity } from '@/lib/events/governance'
import { deriveLifecycleStatus }       from '@/lib/events/lifecycle'


export async function POST(req: NextRequest): Promise<NextResponse<PublishApiResponse>> {
  // ── 1. Verify Firebase ID token ────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ canPublish: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 1b. Block suspended/banned organizers ──────────────────────────────────
  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ canPublish: false, error: blocked.message }, { status: 403 })

  // ── 2. Parse and validate request body ────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = null }

  const draftId = (body as Record<string, unknown> | null)?.draftId
  if (typeof draftId !== 'string' || !draftId) {
    return NextResponse.json({ canPublish: false, error: 'draftId is required' }, { status: 400 })
  }
  // EA-4 S1: organizer confirmation for a moderate identity-change warning.
  const confirmed = (body as Record<string, unknown> | null)?.confirmIdentityChange === true

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

  // Donation-only campaigns must go through /api/campaigns/publish, not this route.
  if (draft.campaignType === 'donation_only') {
    return NextResponse.json({
      canPublish: false,
      reason:     'WRONG_FLOW',
      error:      'Donation-only campaigns must be published via the campaign publish flow, not the event publish flow.',
    }, { status: 400 })
  }

  // ── 4. Run server-side publish validation ─────────────────────────────────
  console.info(`[publish] start · draftId=${draftId} organizerUid=${uid}`)
  const validation = validateEventPublish({
    status:               draft.status               as string,
    pricing:              draft.pricing              as Record<string, unknown> | null,
    eventDetails:         draft.eventDetails         as Record<string, unknown> | null,
    communicationBilling: draft.communicationBilling as Record<string, unknown> | null | undefined,
    registrationForm:     draft.registrationForm     as Record<string, unknown> | null | undefined,
  })

  if (!validation.canPublish) {
    console.warn(`[publish] validation failed · draftId=${draftId} reason=${validation.reason} blockers=${(validation.blockers ?? []).map(b => b.id).join(',') || 'none'}`)
    return NextResponse.json(
      // Pass the SAME structured blockers the Review page renders, so a
      // post-payment failure shows the REAL missing fields (Phase 4/5).
      { canPublish: false, reason: validation.reason, blockers: validation.blockers },
      { status: 403 },
    )
  }
  console.info(`[publish] validation ok · draftId=${draftId}`)

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

  // ── Paid License reconciliation (F2.2.1) ─────────────────────────────────────
  // The Event License must reflect the tier the organizer actually PAID for — not
  // just the draft's selection. Resolve the authoritative tier from the draft
  // selection validated against a PAID licenseOrders record (keyed by draft id,
  // written by /api/licensing/checkout/confirm). A paid tier
  // (Growth/Professional/Enterprise) without a matching paid order is rejected.
  // Starter needs no payment. Every paid tier — Enterprise included — uses the
  // identical purchase flow; there is no contact-sales or admin-grant path.
  const selectedTier: EventLicenseTier = isEventLicenseTier(draft.licenseTier) ? draft.licenseTier : 'starter'
  // Resolve the EFFECTIVE (config-aware) catalog once — used for paid-tier gating,
  // publish capacity, and the publish-eligibility check below.
  const catalog      = await getLicenseCatalog()
  const selectedDef  = catalog[selectedTier]
  const isPaidTier   = !selectedDef.contactSales && selectedDef.licensePricePaise > 0   // growth / professional / enterprise

  const orderRef  = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`)
  const orderSnap = await orderRef.get()
  const order     = orderSnap.exists ? (orderSnap.data() as { tier?: unknown; status?: unknown; amountPaise?: unknown }) : null
  const hasPaidOrder = !!order && order.status === 'paid' && order.tier === selectedTier

  if (isPaidTier && !hasPaidOrder) {
    console.warn(`[publish] failed · draftId=${draftId} reason=PAYMENT_REQUIRED tier=${selectedTier}`)
    return NextResponse.json(
      { canPublish: false, error: `Payment is required before publishing a ${selectedDef.name} event.` },
      { status: 402 },
    )
  }

  const resolvedTier: EventLicenseTier = (isPaidTier && hasPaidOrder) ? selectedTier : 'starter'
  const resolvedOrderId     = hasPaidOrder ? `lic_${draftId}` : null
  const resolvedAmountPaise = hasPaidOrder && typeof order?.amountPaise === 'number' ? order.amountPaise : 0

  // ── EA-4 S1: License expiry (default OFF). An UNCONSUMED license past its expiry
  //    cannot publish; a CONSUMED license's expiry never invalidates its event. ───
  const orderExpiry = order as { expiresAt?: { toMillis?: () => number } | null; consumed?: boolean } | null
  const expMs = typeof orderExpiry?.expiresAt?.toMillis === 'function' ? orderExpiry.expiresAt.toMillis() : null
  if (expMs !== null && !orderExpiry?.consumed && expMs < Date.now()) {
    return NextResponse.json(
      { canPublish: false, reason: 'LICENSE_EXPIRED', error: 'This license has expired. Please renew it before publishing.' },
      { status: 402 },
    )
  }

  // ── EA-4 S1: PUBLISH GOVERNANCE — the single gateway. Binds this license to ONE
  //    immutable event identity. First publish captures the baseline (below); a
  //    later publish is classified: minor→allow, moderate→confirm, major→block. ──
  const gov = await governPublish({ eventId: draftId, draft, slug, confirmed })
  if (!gov.ok) {
    return NextResponse.json(
      {
        canPublish: false,
        reason:     gov.decision === 'warn' ? 'IDENTITY_CONFIRMATION_REQUIRED' : 'IDENTITY_CHANGED',
        error:      gov.reason,
        governance: {
          decision: gov.decision as 'warn' | 'block', level: gov.level, changedFields: gov.changedFields,
          requiresConfirmation: gov.requiresConfirmation, suggestDuplicate: gov.suggestDuplicate,
        },
      },
      { status: gov.decision === 'warn' ? 409 : 403 },
    )
  }

  // ── EA-4 S1: free-tier "one active event" enforcement (previously a placeholder).
  //    The rule targets the FREE license (Starter today) — resolved from the catalog
  //    (licensePricePaise === 0), NOT a hardcoded tier name, so an admin price/config
  //    override flows through. Counts the organizer's currently-LIVE free-tier events
  //    (archived ones free the slot), reusing deriveLifecycleStatus + the rule. ─
  const isFreeTier = (t: EventLicenseTier): boolean => catalog[t].licensePricePaise === 0
  if (isFreeTier(resolvedTier)) {
    const LIVE = new Set(['published', 'pending_review', 'registration_closed'])
    const draftsSnap = await adminDb.collection(`users/${uid}/eventDrafts`).limit(500).get()
    const activeStarters = draftsSnap.docs.filter(ds => {
      if (ds.id === draftId) return false
      const dd = ds.data() as Record<string, unknown>
      const tier = isEventLicenseTier(dd.licenseTier) ? dd.licenseTier : 'starter'
      return isFreeTier(tier) && LIVE.has(deriveLifecycleStatus(dd))
    }).length
    const starterCheck = validatePublishEligibility({
      intendedTier: resolvedTier, licenseStatus: 'active',
      definition: catalog[resolvedTier], starterActiveEventCount: activeStarters,
    })
    if (!starterCheck.ok) {
      return NextResponse.json({ canPublish: false, error: starterCheck.message }, { status: 403 })
    }
  }

  // Publishing mode: 'auto_publish' → go live immediately (legacy behaviour);
  // 'manual_approval' (default) → create the event as 'pending_review' awaiting
  // admin approval. Read from platform config, not hard-coded.
  const publishingMode  = await getPublishingMode()
  const terminalStatus: 'published' | 'pending_review' =
    publishingMode === 'auto_publish' ? 'published' : 'pending_review'

  // ── 6+7. Atomic transaction: read slug → check uniqueness → write event + draft ─
  //        runTransaction replaces batch so we can read the events/{slug} doc
  //        before writing.  If another event already owns that slug we return a
  //        typed SLUG_CONFLICT 409 instead of silently overwriting the existing
  //        event.  All Firestore transaction reads must precede writes.
  const rawPricing    = draft.pricing as Record<string, unknown> | null
  const isFreeEvent   = rawPricing?.eventType === 'free'
  const planType      = isFreeEvent ? 'free_event'  : 'paid_event'   as const
  // Registration capacity is driven by the resolved Event License tier (the single
  // source of truth), NOT by free-vs-paid event type. The license's maxRegistrations
  // maps to the enforcing capacity bucket. Only new publishes get tier-derived
  // capacity; already-published events keep their stored capacityPlan (grandfathered).
  const licenseMaxRegistrations = catalog[resolvedTier].limits.maxRegistrations
  const capacityPlan  = capacityPlanForRegistrationLimit(licenseMaxRegistrations)
  const totalCapacity = resolveTotalCapacity(capacityPlan)

  // LS1: communication (WhatsApp/SMS) is billed PAY-AS-YOU-USE at actual send time
  // (attendee WhatsApp is charged per message on registration), NOT estimated and
  // deducted at publish. The former publish-time deduction was a ledgerless,
  // phantom (SMS has no transport) and double (WhatsApp) charge — removed here.

  // ── 5b. Detect linked campaign (event_plus_donation only) ────────────────────
  const rawLinkedCampaign  = draft.linkedCampaign as LinkedCampaignDraft | null | undefined
  const hasLinkedCampaign  = draft.campaignType === 'event_plus_donation' && rawLinkedCampaign?.enabled === true
  const linkedCampaignSlug = hasLinkedCampaign ? slug : undefined

  // Build the donationCampaigns document from event data + inline campaign draft.
  // Title, cover, and organizer are derived from the event; only unique fields come from the draft.
  const rawOrganizer     = (rawDetails?.organizer  as Record<string, unknown> | null) ?? {}
  const rawMedia         = (rawDetails?.media       as Record<string, unknown> | null) ?? {}
  const rawCoverBanner   = (rawMedia?.coverBanner   as Record<string, unknown> | null) ?? {}
  // Sanitize the event banner before copying it onto the linked campaign — never
  // persist an unapproved/invalid image URL into donationCampaigns.
  const coverImageUrl    = safeImageUrl((rawCoverBanner?.value as string | null) ?? null)
  const organizerName    = (rawOrganizer?.name       as string | null)               ?? ''
  const organizerEmail   = (rawOrganizer?.email      as string | null)               ?? ''

  const linkedCampaignDoc = hasLinkedCampaign && rawLinkedCampaign ? {
    slug:         slug,
    uid,
    draftId,
    campaignType: 'event_plus_donation',
    eventSubtype: (draft.eventSubtype as string | null) ?? null,
    visibility:   (draft.visibility   as string | null) ?? 'public',
    linkedEventSlug: slug,
    linkedEventId:   slug,
    campaignDetails: {
      basics: {
        title:   eventName,
        tagline: '',
        story:   rawLinkedCampaign.story,
      },
      media: {
        coverImageUrl,
        promoVideoUrl: null,
      },
      beneficiary: {
        name:              organizerName,
        type:              'organization',
        description:       '',
        ngoName:           '',
        ngoRegistrationNo: '',
      },
      goal: {
        targetAmountRupees: rawLinkedCampaign.goal.targetAmountRupees,
        startDate:          new Date().toISOString().split('T')[0],
        endDate:            rawLinkedCampaign.goal.endDate,
        allowOverFunding:   rawLinkedCampaign.goal.allowOverFunding,
        showGoalAmount:     rawLinkedCampaign.goal.showGoalAmount,
      },
      organizer: {
        name:    organizerName,
        email:   organizerEmail,
        phone:   '',
        website: '',
      },
      taxConfig: rawLinkedCampaign.taxConfig,
    },
    donationSettings: rawLinkedCampaign.donationSettings,
    status:           'active',
    totalRaisedPaise: 0,
    donorCount:       0,
    publishedAt:      FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  } : null

  const slugRef    = adminDb.collection('events').doc(slug)
  const licenseRef = adminDb.collection(EVENT_LICENSES_COLLECTION).doc(slug)
  const campaignRef = linkedCampaignDoc
    ? adminDb.collection('donationCampaigns').doc(slug)
    : null
  const campaignCounterRef = linkedCampaignDoc
    ? adminDb.collection('donationCounters').doc(slug)
    : null

  try {
    await adminDb.runTransaction(async (txn) => {
      // ── READS (all before any write — Firestore requirement) ────────────────

      const existingSnap = await txn.get(slugRef)

      // Campaign conflict check (event_plus_donation only)
      let existingCampaignSnap: FirebaseFirestore.DocumentSnapshot | null = null
      if (campaignRef) {
        existingCampaignSnap = await txn.get(campaignRef)
      }

      // Event License: an existing license doc must NOT be present — the license is
      // created below with the authoritative (paid) tier resolved pre-transaction.
      const licenseSnap = await txn.get(licenseRef)

      // ── VALIDATION (no writes yet) ─────────────────────────────────────────

      if (existingSnap.exists && (existingSnap.data() as Record<string, unknown>)?.draftId !== draftId) {
        const err = new Error('SLUG_CONFLICT')
        err.name  = 'SLUG_CONFLICT'
        throw err
      }

      if (
        existingCampaignSnap?.exists &&
        (existingCampaignSnap.data() as Record<string, unknown>)?.draftId !== draftId
      ) {
        const err = new Error('SLUG_CONFLICT')
        err.name  = 'SLUG_CONFLICT'
        throw err
      }

      // Event License eligibility — validation only; throws to abort before writes.
      // The resolved tier is either Starter (free) or a paid tier backed by a
      // verified paid order, so it is treated as active.
      const licenseCheck = validatePublishEligibility({ intendedTier: resolvedTier, licenseStatus: 'active', definition: catalog[resolvedTier] })
      if (!licenseCheck.ok) {
        const err = new Error(licenseCheck.message)
        err.name  = licenseCheck.code
        throw err
      }

      // The Event License is created atomically with the event below, so one must
      // not already exist. (Normal re-publish is blocked upstream by
      // EVENT_ALREADY_PUBLISHED; this guards anomalous states.)
      if (licenseSnap.exists) {
        const err = new Error('An Event License already exists for this event.')
        err.name  = 'LICENSE_ALREADY_EXISTS'
        throw err
      }

      // ── WRITES (all atomic) ────────────────────────────────────────────────

      txn.set(slugRef, {
        slug,
        uid,
        draftId,
        eventType:        draft.eventType    ?? null,
        eventSubtype:     draft.eventSubtype ?? null,
        campaignType:     (draft.campaignType as string | null) ?? null,
        visibility:       draft.visibility   ?? null,
        pricing:          draft.pricing      ?? null,
        eventDetails: {
          ...(draft.eventDetails as Record<string, unknown> ?? {}),
          seo: { ...(rawSeo ?? {}), urlSlug: slug },
        },
        planType,
        capacityPlan,
        totalCapacity,
        registrationForm:   draft.registrationForm ?? null,
        accessControl:      draft.accessControl    ?? null,
        // Cross-references set for event_plus_donation; null for all other types
        linkedCampaignSlug: linkedCampaignSlug ?? null,
        linkedCampaignId:   linkedCampaignSlug ?? null,
        lifecycleStatus:    terminalStatus,
        publishedAt:        FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
      })

      // Event License — created atomically with the event, keyed by the same slug.
      // The CANONICAL license document (source of truth): its tier is the paid tier
      // (Growth/Professional) when a matching paid order exists, else Starter. The
      // paid order id + amount are recorded for traceability. Built through the D3.1
      // converter so the document shape has a single source of truth.
      txn.set(licenseRef.withConverter(eventLicenseConverter), {
        eventId:      slug,
        organizerUid: uid,
        tier:         resolvedTier,
        status:       'active',
        version:      CURRENT_LICENSE_VERSION,
        amountPaise:  resolvedAmountPaise,
        orderId:      resolvedOrderId,
        paidAt:       hasPaidOrder ? (FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp) : null,
        upgradedFrom: null,
        upgradedAt:   null,
        createdAt:    FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
        updatedAt:    FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
      })

      // Reconcile the paid order onto the published event (traceability), so it is
      // no longer attached only to the draft.
      if (resolvedOrderId) {
        txn.set(orderRef, { eventSlug: slug, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }

      txn.update(draftRef, {
        status:                     terminalStatus,
        // Stamp the canonical lifecycle field on the DRAFT too (the event doc
        // already gets it above). Without this, deriveLifecycleStatus fell back to
        // 'published' for a pending_review draft — the approve bug's root cause.
        lifecycleStatus:            terminalStatus,
        publishedAt:                FieldValue.serverTimestamp(),
        updatedAt:                  FieldValue.serverTimestamp(),
        'eventDetails.seo.urlSlug': slug,
      })

      // Atomically publish the linked donation campaign alongside the event
      if (campaignRef && linkedCampaignDoc) {
        txn.set(campaignRef, linkedCampaignDoc)
        // Initialize donation counter only for new campaigns; re-publish preserves raised/donor data
        if (campaignCounterRef && !existingCampaignSnap?.exists) {
          txn.set(campaignCounterRef, { totalRaisedPaise: 0, donorCount: 0, lastDonationAt: null })
        }
      }
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'SLUG_CONFLICT') {
      return NextResponse.json(
        { canPublish: false, reason: 'SLUG_CONFLICT' as const, error: 'This URL is already taken by another published event. Choose a different custom URL.' },
        { status: 409 },
      )
    }
    // Event License validation failures — structured business errors (D5.1). The
    // code travels in err.name; the friendly message in err.message.
    const licenseFailureStatus: Record<string, number> = {
      LICENSE_REQUIRED:       402,
      LICENSE_NOT_ACTIVE:     402,
      CONTACT_SALES_REQUIRED: 402,
      STARTER_LIMIT_REACHED:  403,
      INVALID_LICENSE:        400,
      LICENSE_ALREADY_EXISTS: 409,
    }
    if (err instanceof Error && licenseFailureStatus[err.name] !== undefined) {
      console.warn(`[publish] failed · draftId=${draftId} reason=${err.name}`)
      return NextResponse.json({ canPublish: false, error: err.message }, { status: licenseFailureStatus[err.name] })
    }
    console.error(`[publish] failed · draftId=${draftId} reason=TRANSACTION_ERROR`, err)
    return NextResponse.json({ canPublish: false, error: 'Failed to publish event' }, { status: 500 })
  }

  // ── 8. Pre-create zero counter (avoids missing-doc edge case on first reg) ─
  //      Best-effort: first registration transaction creates the counter if absent.
  try {
    await ensureCounterExists(slug)
  } catch {
    console.error('[publish] Failed to initialize registration counter:', slug)
  }

  // ── 8b. EA-4 S1: capture the immutable publish baseline (lazy — first publish
  //      snapshots identity; later publishes only bump the count) and explicitly
  //      CONSUME the license so this paid order can never authorize a different
  //      event identity. Best-effort: on failure the next publish re-captures. ────
  try {
    await recordPublish(draftId, extractIdentity(draft), { orderId: resolvedOrderId, tier: resolvedTier, slug })
    if (resolvedOrderId) {
      await orderRef.set(
        { consumed: true, boundEventId: draftId, consumedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
    }
  } catch (e) {
    console.error('[publish] governance baseline/consume failed (non-fatal):', draftId, e)
  }

  // Notify the organizer their event is under review (manual-approval mode only;
  // auto-published events are confirmed by the success screen). Scheduled via
  // after() so email + WhatsApp complete AFTER the response without being cut off
  // by serverless termination (LS1 fix — previously a dangling void promise).
  if (terminalStatus === 'pending_review') {
    console.info(`[wa-trace][EVENT_SUBMITTED] STEP 1  Event submitted ✓ · slug=${slug} organizerUid=${uid}`)
    console.info(`[wa-trace][EVENT_SUBMITTED] STEP 2  Notification scheduled via after() ✓ (runs after response)`)
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'submitted', eventId: draftId }))
  }

  console.info(`[publish] success · draftId=${draftId} slug=${slug} lifecycleStatus=${terminalStatus} tier=${resolvedTier}`)
  return NextResponse.json({
    canPublish:      true,
    publishedAt:     new Date().toISOString(),
    slug,
    lifecycleStatus: terminalStatus,
  })
}
