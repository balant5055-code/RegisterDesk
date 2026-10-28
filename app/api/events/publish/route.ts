// POST /api/events/publish
//
// Security model:
//   1. Firebase ID token in Authorization header (never trusted client state).
//   2. Draft is loaded server-side from Firestore.
//   3. validateEventPublish() re-runs all business rules.
//   4. Status is written only after successful validation.

import { NextRequest, NextResponse, after } from 'next/server'
import { randomUUID } from 'crypto'
import { organizerPaysPricing } from '@/lib/events/builder/types'
import { REVIEW_HISTORY, buildReviewHistoryEntry } from '@/lib/events/reviewHistory'
import { getEventTypeAvailability } from '@/lib/events/eventTypeAvailabilityServer'
import { isEventTypeAvailable, EVENT_TYPE_UNAVAILABLE_CODE, EVENT_TYPE_SUBMIT_UNAVAILABLE_MESSAGE } from '@/lib/events/eventTypeAvailability'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { organizerStatusGuard }  from '@/lib/admin/organizerStatus'
import { validateEventPublish }  from '@/lib/events/validatePublish'
import { ensureCounterExists }   from '@/lib/firebase/firestore/registrationCounters'
import { isEmailProviderName } from '@/lib/email/providerName'
import { resolveTotalCapacity, capacityPlanForRegistrationLimit } from '@/lib/registrations/capacity'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import { getGlobalCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import { capacityChargeSnapshot, type CapacityChargeSnapshot } from '@/lib/licensing/schema'
import type { PublishApiResponse }    from '@/types/events'
import type { LinkedCampaignDraft }   from '@/lib/campaigns/linkedCampaignConfig'
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, eventLicenseConverter } from '@/lib/licensing/schema'
import {
  CURRENT_LICENSE_VERSION,
  isValidTierForVersion,
  defaultLicenseTierForVersion,
  type AnyEventLicenseTier,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog, getLicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { pickVersionedDefinition } from '@/lib/licensing/licenseCatalogShared'
import { getPublishingMode }          from '@/lib/platform/publishing'
import { sendEventReviewEmail }        from '@/lib/events/reviewNotifications'
import { safeImageUrl }                from '@/lib/utils/imageUrl'
import { governPublish, recordPublish, extractIdentity } from '@/lib/events/governance'
import { buildEventSlug }              from '@/lib/events/slug'
import { readDraftCoverage }           from '@/lib/licensing/draftCoverage'
import { parseServiceSelection, serviceShortfall, SERVICE_KINDS, SERVICE_LABELS } from '@/lib/licensing/serviceAllowances'
import {
  checkPublishAgreement, isPaidEventPricing, AGREEMENT_REQUIRED_MESSAGE, PUBLISH_AGREEMENT_DOCUMENTS,
} from '@/lib/legal/organizerAgreement'
import { checkDraftCommerceOwnership, DRAFT_COMMERCE_FORBIDDEN_MESSAGE } from '@/lib/licensing/draftOwnership'
import { ledgerRef } from '@/lib/licensing/serviceAllowanceLedger'
import { normalizeTypeDetails, passesForType } from '@/lib/events/builder/typeTransition'
import { supersededActivationOrderId, RAZORPAY_ORDER_ID_RE } from '@/lib/licensing/manualRefundHold'
import { settleCapturedActivation } from '@/lib/licensing/activationSelfHeal'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow } from '@/lib/notifications/outbox'
import { eventReviewAlert } from '@/lib/notifications/actionAlerts'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'


/** RD-HIGH-1 — shown when a draft's paid capacity was already applied to its event. */
const ENTITLEMENT_ALREADY_USED_MESSAGE =
  'This event was already submitted, and its registration capacity is applied to it. Continue from the event dashboard (edit, resubmit or republish) — a new event needs its own draft and capacity.'

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
    eventType:            typeof draft.eventType    === 'string' ? draft.eventType    : null,
    eventSubtype:         typeof draft.eventSubtype === 'string' ? draft.eventSubtype : null,
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

  // ── 4a. RD-EVENT-TYPES-01 — a FIRST submission needs an available event type (strict: an existing
  // draft of a now-disabled type stays saved and editable, and can be submitted once the type is
  // enabled). This route only ever handles first submissions; events already submitted or published
  // are never affected. After the lifecycle validation, so a repeat still answers EVENT_ALREADY_PUBLISHED.
  {
    const { availability } = await getEventTypeAvailability()
    if (!isEventTypeAvailable(availability, draft.eventType ?? null)) {
      console.warn(`[publish] event type unavailable · draftId=${draftId} eventType=${String(draft.eventType)}`)
      return NextResponse.json(
        { canPublish: false, reason: EVENT_TYPE_UNAVAILABLE_CODE, error: EVENT_TYPE_SUBMIT_UNAVAILABLE_MESSAGE },
        { status: 403 },
      )
    }
  }

  // ── 4b. RD-EVENT-COMMERCE-05F — the organizer's Publish Agreement, enforced HERE ─────────
  // The wizard shows it unchecked on License & Services and blocks the button, but that is only
  // the browser. Every required item must arrive as an explicit `true`; the fee-policy item is
  // required for a paid event (decided from the STORED draft pricing, not the request).
  // Placed after the lifecycle validation, so a repeated submission of an already-submitted
  // event still answers EVENT_ALREADY_PUBLISHED, and before anything is written.
  const agreement = checkPublishAgreement(
    (body as Record<string, unknown> | null)?.agreement,
    { paidEvent: isPaidEventPricing(draft.pricing) },
  )
  if (!agreement.ok) {
    console.warn(`[publish] agreement missing · draftId=${draftId} missing=${agreement.missing.join(',')}`)
    return NextResponse.json(
      { canPublish: false, reason: 'AGREEMENT_REQUIRED', error: AGREEMENT_REQUIRED_MESSAGE },
      { status: 422 },
    )
  }
  // Recorded atomically with the submission (event + draft), inside the transaction below. No
  // terms version exists for organizers, so none is recorded.
  const publishAgreementRecord = {
    items:      agreement.items,
    documents:  PUBLISH_AGREEMENT_DOCUMENTS,
    acceptedBy: authz.callerUid,
  }

  // ══ RD-HIGH-1 · A DRAFT PUBLISHES EXACTLY ONE EVENT ═══════════════════════════════
  // Everything this draft paid for (the activation order lic_{draftId}, pre-publish add-ons,
  // the prepaid-services ledger) is keyed by the draft id, so the draft IS the entitlement's
  // binding. `validateEventPublish` only refused status 'published'; a draft that was already
  // submitted but is now pending review, unpublished, rejected or restored could come back here
  // with a NEW client-written slug and mint a second event on the same paid capacity.
  // `publishedAt` is written only by the server (firestore.rules protects it) when the draft is
  // first submitted, and no lifecycle transition clears it — so it means "this draft already
  // produced its event". Such an event continues ONLY through its own flows (edit / Save
  // Changes, resubmit, republish, capacity purchases), never through this route again. This is a
  // fast refusal; the authoritative check is repeated inside the transaction below.
  if (draft.publishedAt != null) {
    const live = draft.status === 'published' || draft.status === 'pending_review'
    console.warn(`[publish] refused · draftId=${draftId} reason=${live ? 'EVENT_ALREADY_PUBLISHED' : 'ENTITLEMENT_ALREADY_USED'} status=${String(draft.status)}`)
    return NextResponse.json(live
      ? { canPublish: false, reason: 'EVENT_ALREADY_PUBLISHED', error: 'This event has already been submitted.' }
      : { canPublish: false, reason: 'ENTITLEMENT_ALREADY_USED', error: ENTITLEMENT_ALREADY_USED_MESSAGE },
    { status: 409 })
  }

  // ══ RD-HIGH-2 · EVERY PAID RECORD UNDER THIS DRAFT ID MUST BE THIS ORGANIZER'S ══════════
  // The draft id is a global key for the activation order, add-on orders, the services ledger
  // and live events; it is client-choosable and publicly visible once an event is live. A draft
  // whose id collides with another organizer's records can neither use them nor publish over them.
  const ownership = await checkDraftCommerceOwnership(draftId, uid)
  if (!ownership.ok) {
    console.warn(`[publish] refused · draftId=${draftId} reason=ENTITLEMENT_INVALID record=${ownership.record} verdict=${ownership.verdict}`)
    return NextResponse.json({ canPublish: false, reason: 'ENTITLEMENT_INVALID', error: DRAFT_COMMERCE_FORBIDDEN_MESSAGE }, { status: 403 })
  }

  // ── 5. Resolve public slug ────────────────────────────────────────────────
  const rawDetails  = draft.eventDetails as Record<string, unknown> | null
  const liveType    = typeof draft.eventType    === 'string' ? draft.eventType    : null
  const liveSubtype = typeof draft.eventSubtype === 'string' ? draft.eventSubtype : null
  const rawSeo      = rawDetails?.seo    as Record<string, unknown> | null
  const rawInfo     = rawDetails?.info   as Record<string, unknown> | null
  const customSlug  = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug.trim() : ''
  const eventName   = typeof rawInfo?.name   === 'string' ? rawInfo.name.trim()   : ''

  // RD-EVENT-SLUG — ONE rule, in lib/events/slug.ts, shared with the wizard's validator.
  //
  // The suffix used to be `draftId.slice(-6)` appended VERBATIM. A Firestore auto-id is
  // base62, so the generated slug usually carried an uppercase letter — which the wizard's
  // slug input then "corrected" to lowercase, silently breaking the draft's only pointer to
  // events/{slug} (Firestore ids are case-sensitive). buildEventSlug normalizes every
  // branch, so what publish mints already satisfies the wizard's contract.
  //
  // This value is used for BOTH the uniqueness check (txn.get(slugRef) below) and the
  // document id. Normalizing after the check would re-open the same bug.
  const slug = buildEventSlug({ customSlug, eventName, draftId })

  // ── RD-LEGACY-01 · licence tiers are retired ────────────────────────────────────
  // A NEW event is priced ONLY by the capacity commercial model (below). The draft's
  // `licenseTier` is client-writable and is NEVER read here, and no tier PRICE from the
  // catalog (which a raw configuration write could change) decides whether a publish owes
  // money. Every new licence carries the current version's free tier purely as a
  // compatibility stamp. The one tier entitlement that still exists is a HISTORICAL paid tier
  // order — see `legacyTier` below.
  const currentVersion = CURRENT_LICENSE_VERSION
  const [v1Catalog, v2Catalog] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const defFor = (tier: string) => pickVersionedDefinition(v1Catalog, v2Catalog, tier, currentVersion)
  const freeStamp: AnyEventLicenseTier = defaultLicenseTierForVersion(currentVersion)

  // RD-CE-FIX H4 — a pending activation checkout may already have been PAID (its confirm never ran,
  // the webhook has not arrived). Settle it BEFORE deciding what this publish owes: a captured payment
  // is activated, so the paid capacity and services are honoured below; an unknowable status changes
  // nothing and publishes nothing. An unpaid pending order is superseded in the transaction.
  const settled = await settleCapturedActivation(draftId, uid)
  if (settled === 'unknown') {
    console.warn(`[publish] refused · draftId=${draftId} reason=PAYMENT_STATUS_UNCONFIRMED`)
    return NextResponse.json({
      canPublish: false, reason: 'PAYMENT_STATUS_UNCONFIRMED',
      error: 'We couldn’t confirm the status of an earlier payment for this event, so nothing was published. Please try again in a moment — you won’t be charged twice.',
    }, { status: 409 })
  }

  const orderRef  = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`)
  const orderSnap = await orderRef.get()
  const order     = orderSnap.exists ? (orderSnap.data() as {
    tier?: unknown; status?: unknown; amountPaise?: unknown
    commercialModel?: unknown; capacityChange?: CapacityChargeSnapshot
  }) : null
  // RD-LEGACY-01 — the ONLY tier entitlement: a HISTORICAL tier order, i.e. a server-written,
  // PAID `lic_{draftId}` order that is NOT a capacity order and names a paid tier of the current
  // version. Such orders can no longer be created (/api/licensing/purchase refuses any activation
  // without a capacity, and checkout/confirm settles only an existing tier order), so this path
  // can only ever honour money paid before retirement. It reads the ORDER, never the draft, and
  // never a catalog price.
  const legacyTier: AnyEventLicenseTier | null =
    !!order && order.status === 'paid' && order.commercialModel !== 'capacity'
      && isValidTierForVersion(order.tier, currentVersion) && order.tier !== freeStamp
      ? order.tier : null
  const resolvedTier: AnyEventLicenseTier = legacyTier ?? freeStamp
  const hasPaidOrder = !!order && order.status === 'paid' && order.tier === resolvedTier

  // ══ RD-LICENSE-E2E-03 · A MISSING CAPACITY FAILS CLOSED ═══════════════════════
  //
  // Without a requested capacity this route used to fall through to the legacy
  // tier → bucket path, which for the free tier stored `pack_200` / totalCapacity 200 —
  // a capacity nobody chose, on an event whose Review screen had just shown "100 · Free".
  //
  // The ONLY pre-migration state that legitimately carries a tier-derived capacity is a
  // PAID historical tier order (`legacyTier` above). That is money-backed and cannot be forged
  // by the client, so it keeps the grandfathered path.
  // Every other draft must carry an explicit capacity — the wizard's Step 7 Continue always
  // writes one (100 is free) — and is refused here otherwise, never inferred as free/200.
  //
  // This route only ever creates an event for the FIRST time (already-published drafts are
  // refused with EVENT_ALREADY_PUBLISHED; republish is a lifecycle route that never
  // recomputes capacity), so no historical event can reach this check.
  const requestedCapacity = typeof draft.registrationCapacity === 'number' ? draft.registrationCapacity : null
  const hasLegacyPaidEntitlement = legacyTier !== null
  if (requestedCapacity === null && !hasLegacyPaidEntitlement) {
    console.warn(`[publish] failed · draftId=${draftId} reason=CAPACITY_NOT_CONFIGURED`)
    return NextResponse.json({
      canPublish: false, reason: 'CAPACITY_NOT_CONFIGURED',
      error: 'Registration capacity has not been configured. Open the License step, choose how many registrations to accept, and continue.',
    }, { status: 422 })
  }
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

  // RD-LEGACY-01 — the free-tier "one active event" rule (Starter) is gone: there is no Starter
  // plan, and the rule could only run for a capacity-less free draft, which is refused above
  // (CAPACITY_NOT_CONFIGURED). The first 100 registrations of EVERY event are free.

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
  //
  // RD-LICENSE-GA-04: the tier→limit lookup resolves from the version-aware effective
  // license definition (defFor, config-overlaid) — so a V2 tier (Free 200, Professional
  // 2,500, Business 5,000) maps to the correct capacity bucket. At version 1 this equals
  // the previous getLicenseCatalog() value byte-for-byte; it no longer routes through the
  // dormant pricing engine's V1-only tier map (pricingEngineEnabled stays false).
  // ══ RD-CAPACITY-01 · THE ENFORCED CAPACITY IS THE CAPACITY THE ORGANIZER CHOSE ══
  //
  // The previous derivation was licence limit -> CAPACITY_PLANS bucket -> that bucket's
  // limit, which silently ROUNDED an organizer's choice UP to the next pack: a request for
  // 437 was published as 500. Under the capacity model the organizer pays per registration,
  // so 437 must be stored as 437 — anything else sells capacity that was never bought, or
  // bills for capacity the event cannot use.
  //
  // Server-authoritative by construction: the draft carries only the organizer's REQUESTED
  // capacity, and this route re-quotes it against the effective commercial terms. When the
  // quote says payment is due, a PAID order that covers that capacity must exist. So a
  // tampered draft capacity cannot publish — it can only fail with PAYMENT_REQUIRED.
  //
  // LEGACY / GRANDFATHERING: a draft with no requested capacity keeps the tier-derived
  // bucket path byte-for-byte, so events created before this migration publish exactly as
  // they did, and already-published events are never touched by this route at all.
  // RD-LICENSE-E2E-03 · only a draft with a PAID legacy licence reaches that path now; any
  // other capacity-less draft was refused above with CAPACITY_NOT_CONFIGURED.
  // `requestedCapacity` is resolved above.
  const paidCapacityCharge = order?.commercialModel === 'capacity' && order.status === 'paid'
    ? order.capacityChange ?? null
    : null

  // ══ RD-EVENT-COMMERCE-02 · SELECTED PREPAID SERVICES MUST BE PAID ══════════════════
  // The License & Services step records the organizer's selection on the draft. Only the
  // allowance LEDGER (written by verified payments) proves purchase, so a selection above what
  // was bought is refused — a draft edit can never turn an unpaid selection into an allowance.
  const selectedServices = parseServiceSelection((draft as { serviceSelection?: unknown }).serviceSelection)
  if (selectedServices.ok) {
    const coverage  = await readDraftCoverage(draftId, uid)
    const shortfall = serviceShortfall(selectedServices.selection, coverage.purchased)
    const unpaid    = SERVICE_KINDS.filter(k => shortfall[k] > 0)
    if (unpaid.length > 0) {
      console.warn(`[publish] failed · draftId=${draftId} reason=SERVICES_PAYMENT_REQUIRED ${unpaid.map(k => `${k}=${shortfall[k]}`).join(' ')}`)
      return NextResponse.json({
        canPublish: false, reason: 'SERVICES_PAYMENT_REQUIRED',
        error: `Payment is required for the selected ${unpaid.map(k => SERVICE_LABELS[k].units).join(' and ')} before publishing. Complete it on License & Services.`,
      }, { status: 402 })
    }
  }

  let capacityPlan: ReturnType<typeof capacityPlanForRegistrationLimit>
  let totalCapacity: number | null
  let activationCharge: CapacityChargeSnapshot | null = null

  if (requestedCapacity !== null) {
    // RD-CE-FIX M3 — PAID capacity is never silently given up. Publishing below what was paid for
    // (activation and/or pre-publish add-ons) used to consume the paid order and store the smaller
    // number: the difference vanished with no record. The event must publish with at least the paid
    // capacity; unused paid capacity is then visible in the Wallet and refundable there (an explicit,
    // Super-Admin-reviewed request) once the event closes.
    {
      const coverageNow = await readDraftCoverage(draftId, uid)
      const paidFloor = Math.max(paidCapacityCharge?.capacity ?? 0, coverageNow.paidCapacity ?? 0)
      if (paidFloor > 0 && requestedCapacity < paidFloor) {
        console.warn(`[publish] refused · draftId=${draftId} reason=CAPACITY_BELOW_PAID requested=${requestedCapacity} paid=${paidFloor}`)
        return NextResponse.json({
          canPublish: false, reason: 'CAPACITY_BELOW_PAID',
          error: `You’ve already paid for ${paidFloor.toLocaleString('en-IN')} registrations. Set the capacity to at least ${paidFloor.toLocaleString('en-IN')} to publish — after the event closes, unused paid capacity can be refunded from the Wallet.`,
        }, { status: 409 })
      }
    }
    const terms  = await getGlobalCommercialTerms()
    const quoted = calculateActivationQuote({ capacity: requestedCapacity, terms })
    if (!quoted.ok) {
      console.warn(`[publish] failed · draftId=${draftId} reason=${quoted.code} capacity=${String(requestedCapacity)}`)
      return NextResponse.json({ canPublish: false, reason: quoted.code, error: quoted.message }, { status: 422 })
    }
    // Payment due -> a paid capacity order must cover AT LEAST what is being published.
    // ">=" rather than "===" so an organizer who paid for 500 and then trimmed the draft to
    // 300 can still publish (they keep the smaller number they asked for; the decrease
    // charge is a separate, deliberate operation and no refund is implied here).
    if (quoted.quote.paymentRequired) {
      // RD-EVENT-COMMERCE-02 — a paid pre-publish ADD-ON order can raise the paid capacity above
      // the activation order's; coverage is read from server-written paid orders only.
      const paidAddonCapacity = (await readDraftCoverage(draftId, uid)).paidCapacity
      const covered = (paidCapacityCharge !== null && paidCapacityCharge.capacity >= quoted.quote.capacity)
        || (paidAddonCapacity !== null && paidAddonCapacity >= quoted.quote.capacity)
      if (!covered) {
        console.warn(`[publish] failed · draftId=${draftId} reason=PAYMENT_REQUIRED capacity=${quoted.quote.capacity} paid=${paidCapacityCharge?.capacity ?? 'none'}`)
        return NextResponse.json({
          canPublish: false, reason: 'CAPACITY_PAYMENT_REQUIRED',
          error: `Activation payment is required before publishing an event with ${quoted.quote.capacity.toLocaleString('en-IN')} registration capacity.`,
        }, { status: 402 })
      }
    }
    totalCapacity    = quoted.quote.capacity
    activationCharge = capacityChargeSnapshot(quoted.quote)
    // `capacityPlan` is retained ONLY for backward compatibility: legacy readers and
    // `deriveStoredEventCapacity`'s fallback still look at it when `totalCapacity` is
    // absent. It is derived FROM the exact capacity and never back onto it.
    capacityPlan     = capacityPlanForRegistrationLimit(quoted.quote.capacity)
  } else {
    const licenseMaxRegistrations = defFor(resolvedTier).limits.maxRegistrations
    capacityPlan  = capacityPlanForRegistrationLimit(licenseMaxRegistrations)
    totalCapacity = resolveTotalCapacity(capacityPlan)
  }

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

  // RD-NOTIFY-01 — a submission FOR REVIEW alerts the Super Admins. The alert is staged in the
  // publish transaction below, so it exists if and only if the submission persisted. Built before
  // the transaction (identity read + a fixed timestamp → one id however often the txn retries).
  const reviewAlert = terminalStatus === 'pending_review'
    ? await resolveOrganizerEmailIdentity(uid).then(
        o => eventReviewAlert({ submission: 'submitted', draftId, slug, eventName, organizer: { uid, name: o.name, email: o.email }, at: new Date(), when: istNow() }),
        () => eventReviewAlert({ submission: 'submitted', draftId, slug, eventName, organizer: { uid, name: '', email: '' }, at: new Date(), when: istNow() }),
      )
    : null
  // RD-REVIEW-02 — a submission for review opens review cycle 1: every admin decision must name it,
  // and the first submission is now recorded in the review history (staged in the publish
  // transaction, so it exists if and only if the submission persisted). Fixed before the
  // transaction, so a retried attempt writes the same cycle and the same history entry.
  const reviewCycleId   = terminalStatus === 'pending_review' ? randomUUID() : null
  const submitEntryRef  = reviewCycleId ? adminDb.collection('events').doc(slug).collection(REVIEW_HISTORY).doc() : null

  try {
    await adminDb.runTransaction(async (txn) => {
      // ── READS (all before any write — Firestore requirement) ────────────────

      const existingSnap = await txn.get(slugRef)
      // Validated through the ONE parser, so a hand-edited or legacy value can never
      // carry an arbitrary provider string forward into the published document.
      const existingRaw = (existingSnap.data() as { emailProvider?: unknown } | undefined)?.emailProvider
      const existingEmailProvider = isEmailProviderName(existingRaw) ? existingRaw : undefined

      // RD-EVENT-15A · LEGACY ONLY.
      //
      // The canonical waitlist setting now lives at
      // `registrationForm.registrationRules.waitlistEnabled` / `.waitlistCapacity`, which
      // the set() below copies wholesale with the rest of `registrationForm` — so it
      // needs no special handling and survives republish by construction.
      //
      // This carry-forward keeps the PRE-consolidation top-level pair alive for documents
      // that still only have it (see lib/waitlist/waitlistSettings.ts). Without it a
      // republish would erase the only setting such an event has. Any save from the
      // builder or the Waitlist tab writes the canonical field and deletes this pair, so
      // the branch stops applying to that event permanently. Zero extra reads — the
      // snapshot was already read above — and an absent value stays absent.
      const existingWl = existingSnap.data() as { waitlistEnabled?: unknown; waitlistLimit?: unknown } | undefined
      const keepWaitlistEnabled = existingWl?.waitlistEnabled === true
      const keepWaitlistLimit =
        typeof existingWl?.waitlistLimit === 'number' && existingWl.waitlistLimit > 0
          ? existingWl.waitlistLimit
          : undefined

      // Campaign conflict check (event_plus_donation only)
      let existingCampaignSnap: FirebaseFirestore.DocumentSnapshot | null = null
      if (campaignRef) {
        existingCampaignSnap = await txn.get(campaignRef)
      }

      // Event License: an existing license doc must NOT be present — the license is
      // created below with the authoritative (paid) tier resolved pre-transaction.
      const licenseSnap = await txn.get(licenseRef)

      // RD-HIGH-1 — the entitlement, re-read INSIDE the transaction: the draft (still never
      // submitted?) and, when this publish relies on a paid activation, the order itself. Both
      // docs are written below, so two concurrent publishes of one draft conflict and Firestore
      // retries the loser, which then reads a submitted draft / consumed order and is refused.
      const draftNowSnap = await txn.get(draftRef)
      // RD-CE-FIX H4 — the activation order is ALWAYS re-read here: a pending (unpaid) checkout this
      // publish does not use is superseded below, and one that became PAID since the pre-read aborts.
      const orderNowSnap = await txn.get(orderRef)
      const entitlementSnap = order?.status === 'paid' ? orderNowSnap : null
      const orderNow = orderNowSnap.exists ? orderNowSnap.data() as Record<string, unknown> : null
      const pendingRzp = orderNow?.status === 'created' && typeof orderNow.razorpayOrderId === 'string'
        && RAZORPAY_ORDER_ID_RE.test(orderNow.razorpayOrderId) ? orderNow.razorpayOrderId : null
      const pendingArchiveRef = pendingRzp ? orderRef.parent.doc(supersededActivationOrderId(draftId, pendingRzp)) : null
      const pendingArchiveSnap = pendingArchiveRef ? await txn.get(pendingArchiveRef) : null
      // RD-HIGH-2 — the services ledger this event will draw on, re-read in the transaction.
      const ledgerNowSnap = await txn.get(ledgerRef(draftId))

      // ── VALIDATION (no writes yet) ─────────────────────────────────────────

      // RD-SEC-01 · same draft AND same owner — a draftId match alone is not proof of ownership.
      if (existingSnap.exists && (
        (existingSnap.data() as Record<string, unknown>)?.draftId !== draftId ||
        (existingSnap.data() as Record<string, unknown>)?.uid !== uid
      )) {
        const err = new Error('SLUG_CONFLICT')
        err.name  = 'SLUG_CONFLICT'
        throw err
      }

      if (
        existingCampaignSnap?.exists && (
          (existingCampaignSnap.data() as Record<string, unknown>)?.draftId !== draftId ||
          (existingCampaignSnap.data() as Record<string, unknown>)?.uid !== uid
        )
      ) {
        const err = new Error('SLUG_CONFLICT')
        err.name  = 'SLUG_CONFLICT'
        throw err
      }

      // RD-LEGACY-01 — no tier eligibility check here: the licence is either the free compatibility
      // stamp (capacity priced above) or a historical tier backed by a verified paid order.

      // RD-HIGH-1 — the authoritative entitlement checks (see the fast refusal above).
      const draftNow = draftNowSnap.exists ? draftNowSnap.data() as Record<string, unknown> : null
      if (!draftNow || draftNow.publishedAt != null || draftNow.status !== 'draft') {
        const err = new Error(ENTITLEMENT_ALREADY_USED_MESSAGE)
        err.name  = 'ENTITLEMENT_ALREADY_USED'
        throw err
      }
      if (order?.status !== 'paid' && orderNow?.status === 'paid') {
        // A checkout for this draft was paid between the pre-read and now: publish again so the
        // paid capacity/services are counted (and the M3 floor applies) instead of being bypassed.
        const err = new Error('A payment for this event just completed. Please publish again — nothing was charged twice.')
        err.name  = 'PAYMENT_JUST_COMPLETED'
        throw err
      }
      if (ledgerNowSnap.exists && ledgerNowSnap.get('organizerUid') !== uid) {
        console.warn(`[publish] refused · draftId=${draftId} reason=ENTITLEMENT_INVALID record=service allowance (in transaction)`)
        const err = new Error(DRAFT_COMMERCE_FORBIDDEN_MESSAGE)
        err.name  = 'ENTITLEMENT_INVALID'
        throw err
      }
      if (entitlementSnap) {
        const ent = entitlementSnap.exists ? entitlementSnap.data() as Record<string, unknown> : null
        // Paid, for THIS draft, owned by THIS organizer — from server-written fields only. A record
        // missing any of them (e.g. an unexpected historical shape) fails CLOSED, never guessed.
        if (!ent || ent.status !== 'paid' || ent.eventId !== draftId
            || typeof ent.organizerUid !== 'string' || ent.organizerUid !== uid) {
          console.warn(`[publish] refused · draftId=${draftId} reason=ENTITLEMENT_INVALID status=${String(ent?.status)} eventIdMatch=${ent?.eventId === draftId} ownerMatch=${ent?.organizerUid === uid}`)
          const err = new Error('The paid activation for this event could not be validated, so nothing was published. Please contact support.')
          err.name  = 'ENTITLEMENT_INVALID'
          throw err
        }
        // Already applied to an event — never a second time.
        if (ent.consumed === true) {
          const err = new Error(ENTITLEMENT_ALREADY_USED_MESSAGE)
          err.name  = 'ENTITLEMENT_ALREADY_USED'
          throw err
        }
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
        // RD-CE-FIX (trace #5) — the organizer's own "Other"/custom format text reaches the live event.
        customEventSubtype: typeof draft.customEventSubtype === 'string' && draft.customEventSubtype.trim()
          ? draft.customEventSubtype.trim() : null,
        campaignType:     (draft.campaignType as string | null) ?? null,
        visibility:       draft.visibility   ?? null,
        // RD-PHASE4-S3 · Q1 — the draft is organizer-controlled; the live event stores organizer-pays.
        // RD-CE-FIX H3 — passes carry sport details only when this event type has a sport block.
        pricing:          (() => {
          const p = organizerPaysPricing(draft.pricing ?? null) as Record<string, unknown> | null
          return p ? { ...p, passes: passesForType(liveType, liveSubtype, p.passes) } : p
        })(),
        eventDetails: {
          ...(draft.eventDetails as Record<string, unknown> ?? {}),
          // RD-CE-FIX H3 — type details in exactly THIS type's shape (never another type's leftovers).
          typeDetails: normalizeTypeDetails(liveType, liveSubtype, (draft.eventDetails as Record<string, unknown> | undefined)?.typeDetails),
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
        // RD-EMAIL-PROVIDER — PRESERVED across republish.
        //
        // This txn.set() is a FULL overwrite, so any field written directly onto
        // events/{slug} by an admin action is wiped the next time the organizer
        // republishes. Carrying the existing value forward is what makes the email
        // provider survive the lifecycle. Absent stays absent (⇒ SES), so legacy events
        // are untouched and nothing is backfilled.
        ...(existingEmailProvider ? { emailProvider: existingEmailProvider } : {}),
        // RD-EVENT-15 — PRESERVED across republish, for the same reason.
        ...(keepWaitlistEnabled ? { waitlistEnabled: true } : {}),
        ...(keepWaitlistLimit !== undefined ? { waitlistLimit: keepWaitlistLimit } : {}),
        // RD-EVENT-COMMERCE-05F — the consent this submission was made under.
        publishAgreement:   { ...publishAgreementRecord, acceptedAt: FieldValue.serverTimestamp() },
        publishedAt:        FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
        ...(reviewCycleId ? { reviewCycleId, reviewCycleStartedAt: FieldValue.serverTimestamp() } : {}),
      })
      if (submitEntryRef && reviewCycleId) {
        txn.set(submitEntryRef, {
          ...buildReviewHistoryEntry({
            action: 'submit', fromStatus: 'draft', toStatus: 'pending_review', actorUid: authz.callerUid, cycleId: reviewCycleId,
          }),
          at: FieldValue.serverTimestamp(),
        })
      }

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
        // RD-CAPACITY-01 — the licence RECORDS what was bought; events/{slug}.totalCapacity
        // remains the single ENFORCED value, and both are written in this one transaction so
        // they can never disagree. Absent on a legacy tier-priced publish.
        ...(activationCharge ? {
          commercialModel: 'capacity' as const,
          capacity:        totalCapacity,
          activation:      activationCharge,
          capacityOpSeq:   0,
        } : {}),
      })

      // Reconcile the paid order onto the published event (traceability), so it is
      // no longer attached only to the draft.
      if (resolvedOrderId && !entitlementSnap) {
        txn.set(orderRef, { eventSlug: slug, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      // RD-CE-FIX H4 — a pending checkout this publish did NOT use is superseded atomically with the
      // event: archived as `lic_{draft}__sup_{rzp}` (failed/superseded, the F2A shape purchase writes)
      // and `lic_` no longer carries its Razorpay order. A payment captured on it later is found by the
      // webhook / confirm and HELD for Super Admin review — never granted after publish, never lost.
      if (orderNow?.status === 'created') {
        if (pendingArchiveRef && !pendingArchiveSnap?.exists) {
          txn.create(pendingArchiveRef, {
            ...orderNow, orderId: pendingArchiveRef.id, status: 'failed', failReason: 'superseded',
            supersededFrom: orderRef.id, supersededBy: 'publish',
            supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          })
        }
        txn.update(orderRef, {
          status: 'failed', failReason: 'superseded', razorpayOrderId: null, supersededBy: 'publish',
          supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        })
      }
      // RD-HIGH-1 — CONSUME the paid activation in the SAME transaction that creates the event
      // (it used to be a best-effort write AFTER the commit, and nothing ever checked it).
      if (entitlementSnap) {
        txn.set(orderRef, {
          consumed: true, boundEventId: draftId, eventSlug: slug,
          consumedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
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
        publishAgreement:           { ...publishAgreementRecord, acceptedAt: FieldValue.serverTimestamp() },
        ...(reviewCycleId ? { reviewCycleId, reviewCycleStartedAt: FieldValue.serverTimestamp() } : {}),
      })
      if (reviewAlert) stageOutboxMessage(txn, reviewAlert)

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
    if (err instanceof Error && (err.name === 'ENTITLEMENT_ALREADY_USED' || err.name === 'ENTITLEMENT_INVALID')) {
      return NextResponse.json(
        { canPublish: false, reason: err.name as 'ENTITLEMENT_ALREADY_USED' | 'ENTITLEMENT_INVALID', error: err.message },
        { status: err.name === 'ENTITLEMENT_INVALID' ? 403 : 409 },
      )
    }
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
      PAYMENT_JUST_COMPLETED: 409,   // RD-CE-FIX H4
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
    // RD-HIGH-1 — the paid order is now consumed INSIDE the publish transaction above.
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
    // occurrenceId = this submission's history entry, so a repeated delivery lands in the inbox once.
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'submitted', eventId: draftId, occurrenceId: submitEntryRef?.id }))
    if (reviewAlert) scheduleOutboxDelivery(reviewAlert.id)
  }

  console.info(`[publish] success · draftId=${draftId} slug=${slug} lifecycleStatus=${terminalStatus} tier=${resolvedTier}`)
  return NextResponse.json({
    canPublish:      true,
    publishedAt:     new Date().toISOString(),
    slug,
    lifecycleStatus: terminalStatus,
  })
}
