// GET  /api/organizer/broadcasts          — campaign history list
// POST /api/organizer/broadcasts          — create + send a broadcast campaign

import { quoteWhatsAppBroadcastCapacity, type WhatsAppCapacityQuote } from '@/lib/communications/capacityQuote'
import { applyAudienceRefundRule } from '@/lib/broadcasts/audienceRefunds'
import { filterWhatsAppBroadcastRecipients } from '@/lib/whatsapp/broadcastConsent'
import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue, Timestamp }       from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import type { BroadcastAudience, BroadcastChannel, BroadcastCampaign } from '@/lib/broadcasts/types'
import type { RegistrationDocument }   from '@/lib/registrations/types'
import { sanitizeBroadcastHtml }              from '@/lib/broadcasts/sanitize'
import { getOrganiserSuppressionSet }  from '@/lib/firebase/firestore/emailSuppressionList'
import { dedupeRecipientsByEmail, dedupeRecipientsByPhone } from '@/lib/broadcasts/dedupeRecipients'
import { checkBroadcastLimits, resolveMaxRecipientsPerBroadcast } from '@/lib/broadcasts/limits'
import { organizerStatusGuard }        from '@/lib/admin/organizerStatus'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { startBroadcastCampaign }      from '@/lib/broadcasts/send'
import { logBroadcastAction }          from '@/lib/broadcasts/audit'
import { getFeatureFlags }             from '@/lib/config/resolveFeatureFlags'
import { hasWhatsAppTemplate, getWhatsAppTemplate } from '@/lib/whatsapp'
import { isSendableMetaStatus, isOrganizerBroadcastTemplate, validateBroadcastVariables } from '@/lib/whatsapp/registry'
import { authoritativeEventName } from '@/lib/broadcasts/eventName'
import { getCommunicationConfig }      from '@/lib/communications/resolveCommunicationConfig'
import {
  parseRegistrationDateFilter, resolveRegistrationDateWindow, applyRegistrationDateRange, toFilterRecord,
  type RegistrationDateWindow, type RegistrationDateFilterRecord,
} from '@/lib/broadcasts/registrationDateFilter'
import { resolveBroadcastTimezone }    from '@/lib/broadcasts/resolveBroadcastTimezone'
import { countUndatedRegistrations }   from '@/lib/broadcasts/undatedRegistrations'
import { todayISOInTz }                from '@/lib/registrations/salesWindow'
import { WHATSAPP_BROADCAST_CAPACITY_REQUIRED } from '@/lib/communications/capacity'

const AUDIENCES: BroadcastAudience[] = ['all', 'confirmed', 'pending', 'rejected', 'cancelled']

// ─── Serialiser ───────────────────────────────────────────────────────────────

function tsToIso(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function docToCampaign(id: string, d: Record<string, unknown>): BroadcastCampaign {
  return {
    id,
    organizerUid:   typeof d.organizerUid   === 'string' ? d.organizerUid   : '',
    createdBy:      typeof d.createdBy       === 'string' ? d.createdBy       : undefined,
    eventId:        typeof d.eventId         === 'string' ? d.eventId         : '',
    eventSlug:      typeof d.eventSlug       === 'string' ? d.eventSlug       : '',
    eventName:      typeof d.eventName       === 'string' ? d.eventName       : '',
    channel:        (d.channel as BroadcastChannel)      ?? 'email',
    audience:       (d.audience as BroadcastAudience)    ?? 'all',
    subject:        typeof d.subject         === 'string' ? d.subject         : '',
    html:           typeof d.html            === 'string' ? d.html            : '',
    recipientCount: typeof d.recipientCount  === 'number' ? d.recipientCount  : 0,
    successCount:   typeof d.successCount    === 'number' ? d.successCount    : 0,
    failCount:      typeof d.failCount       === 'number' ? d.failCount       : 0,
    status:         (d.status as BroadcastCampaign['status']) ?? 'sending',
    // RD-BCAST-DATE-01 — absent on every campaign created before this feature, which is
    // exactly how they keep behaving as before.
    registeredFrom:         tsToIso(d.registeredFrom),
    registeredTo:           tsToIso(d.registeredTo),
    registrationDateFilter: (d.registrationDateFilter as RegistrationDateFilterRecord | undefined) ?? null,
    scheduledFor:       tsToIso(d.scheduledFor),
    estimatedCostPaise: typeof d.estimatedCostPaise === 'number' ? d.estimatedCostPaise : 0,
    actualCostPaise:    typeof d.actualCostPaise    === 'number' ? d.actualCostPaise    : 0,
    billing: d.billingSettlement === 'pending' || d.billingSettlement === 'settled' ? {
      fundedBy:      d.fundedBy === 'prepaid_allowance' ? 'prepaid_allowance' : 'wallet',
      settled:       d.billingSettlement === 'settled',
      chargedUnits:  typeof d.chargedUnits  === 'number' ? d.chargedUnits  : null,
      billedUnits:   typeof d.billedUnits   === 'number' ? d.billedUnits   : null,
      refundedUnits: typeof d.refundedUnits === 'number' ? d.refundedUnits : null,
      refundedPaise: typeof d.refundedPaise === 'number' ? d.refundedPaise : null,
    } : null,
    failReason:     typeof d.failReason      === 'string' ? d.failReason      : null,
    eventDraftId:   typeof d.eventDraftId    === 'string' ? d.eventDraftId    : null,
    createdAt:      tsToIso(d.createdAt) ?? new Date().toISOString(),
    sentAt:         tsToIso(d.sentAt),
  }
}

// ─── GET — campaign history ───────────────────────────────────────────────────

export type GetBroadcastsResponse =
  | { success: true;  campaigns: BroadcastCampaign[] }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetBroadcastsResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const snap = await adminDb.collection('broadcastCampaigns')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()

  const campaigns = snap.docs.map(doc => docToCampaign(doc.id, doc.data() as Record<string, unknown>))
  return NextResponse.json({ success: true, campaigns })
}

// ─── POST — create + send campaign ────────────────────────────────────────────

export type PostBroadcastResponse =
  | { success: true;  campaign: BroadcastCampaign }
  | {
      success: false
      /** Stable machine code (e.g. DAILY_LIMIT_REACHED). Kept for existing consumers. */
      error: string
      /**
       * RD-BCAST-LIMIT-01 — human-readable reason, safe to display verbatim. The UI shows
       * this in preference to `error`, so an organizer stops being handed a raw token.
       */
      message?: string
      used?:    number
      limit?:   number | string
      /** ISO instant at which a daily quota rolls over. */
      resetAt?: string
      /** RD-COMMS-CAPACITY-UX — WHATSAPP_CAPACITY_REQUIRED: required vs available for this audience. */
      capacity?: WhatsAppCapacityQuote
    }

export async function POST(req: NextRequest): Promise<NextResponse<PostBroadcastResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: the actual operator

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  // Feature flag (Business Configuration) — global broadcast master switch.
  if (!(await getFeatureFlags()).broadcast) {
    return NextResponse.json({ success: false, error: 'Broadcast is currently disabled.' }, { status: 403 })
  }

  // ── Parse + validate body ─────────────────────────────────────────────────
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const { eventSlug, audience, subject, html, channel, templateType, languageCode, variables, scheduledFor } =
    body as Record<string, unknown>

  // "Ignore duplicate email IDs". Strict `=== true` so any other value — absent, null, a
  // string, a stray truthy — means the original behaviour. Applied to EMAIL only; the
  // WhatsApp branch below never consults it, so WhatsApp is byte-for-byte unchanged.
  const dedupeEmails = (body as Record<string, unknown>).dedupeEmails === true
  const dedupePhones = (body as Record<string, unknown>).dedupePhones === true

  if (typeof eventSlug !== 'string' || !eventSlug) {
    return NextResponse.json({ success: false, error: 'eventSlug is required' }, { status: 400 })
  }
  // RD-INTEG — the event must be THIS workspace's live event. The slug decides which prepaid
  // allowance a WhatsApp campaign is billed from and which event's Wallet/analytics it counts
  // toward, so it is verified here rather than trusted from the body.
  const liveEvent = await adminDb.collection('events').doc(eventSlug).get().catch(() => null)
  const liveData  = liveEvent?.exists ? liveEvent.data() as { uid?: unknown; draftId?: unknown } & Record<string, unknown> : null
  if (!liveData || liveData.uid !== uid) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }
  const liveDraftId = typeof liveData.draftId === 'string' && liveData.draftId ? liveData.draftId : null
  if (!AUDIENCES.includes(audience as BroadcastAudience)) {
    return NextResponse.json({ success: false, error: 'Invalid audience' }, { status: 400 })
  }
  // Channel: email + WhatsApp are live. SMS billing is built but has no provider yet.
  const chosenChannel: BroadcastChannel =
    channel === 'whatsapp' ? 'whatsapp'
    : channel === 'email' || channel === undefined ? 'email'
    : channel as BroadcastChannel
  if (chosenChannel !== 'email' && chosenChannel !== 'whatsapp') {
    return NextResponse.json({ success: false, error: `${String(chosenChannel).toUpperCase()} broadcasts are not yet available.` }, { status: 501 })
  }

  // ── Channel-specific content ────────────────────────────────────────────────
  let storedSubject  = ''
  let storedHtml     = ''
  let waTemplateType: string | undefined
  let waLanguageCode: string | undefined
  const waVariables:  Record<string, string> = {}

  if (chosenChannel === 'email') {
    if (typeof subject !== 'string' || !subject.trim()) {
      return NextResponse.json({ success: false, error: 'subject is required' }, { status: 400 })
    }
    if (typeof html !== 'string' || !html.trim()) {
      return NextResponse.json({ success: false, error: 'html is required' }, { status: 400 })
    }
    const { clean, stripped } = sanitizeBroadcastHtml(html.trim())
    if (stripped) {
      return NextResponse.json(
        {
          success: false,
          error:   'Email content contains disallowed HTML elements or attributes. ' +
                   'Permitted tags: p, b, strong, i, em, u, a (https links only), ul, ol, li, h2, h3, blockquote, br, hr. ' +
                   'Event handlers, scripts, iframes, and non-https links are not allowed.',
        },
        { status: 400 },
      )
    }
    storedSubject = subject.trim()
    storedHtml    = clean
  } else {
    // WhatsApp — an approved Meta template ONLY. No free-text HTML is accepted.
    if (typeof templateType !== 'string' || !hasWhatsAppTemplate(templateType)) {
      return NextResponse.json({ success: false, error: 'Select an approved WhatsApp template.' }, { status: 400 })
    }
    // RD-COMMS-P2-C — only the organizer-broadcastable templates. Transactional (refund, cancellation,
    // confirmation…) and RegisterDesk platform templates (wallet, settlement, licence…) are sent by
    // the platform with server-derived values only; a broadcast could otherwise impersonate them.
    // Enforced HERE (and again by the broadcast job), whatever the client sends.
    if (!isOrganizerBroadcastTemplate(templateType)) {
      return NextResponse.json({ success: false, error: 'TEMPLATE_NOT_ALLOWED', message: 'This WhatsApp template cannot be used for a broadcast.' }, { status: 403 })
    }
    const def = getWhatsAppTemplate(templateType)
    // Refuse a template Meta cannot deliver HERE, before chargeAndStartCampaign runs.
    // The resolver would refuse it later anyway, but by then the campaign is created and
    // billed upfront for the whole audience — the organizer would pay for a send that
    // fails on every recipient. The UI hides these too; this is the boundary that counts.
    if (!isSendableMetaStatus(def.metaStatus)) {
      return NextResponse.json(
        { success: false, error: def.metaStatus === 'rejected'
          ? 'This WhatsApp template was rejected by Meta and cannot be used.'
          : 'This WhatsApp template is still awaiting Meta approval.' },
        { status: 422 },
      )
    }
    if (typeof languageCode === 'string' && languageCode) {
      if (!def.languages.includes(languageCode)) {
        return NextResponse.json({ success: false, error: `Language "${languageCode}" is not available for this template.` }, { status: 400 })
      }
      waLanguageCode = languageCode
    }
    // Every required template variable must be satisfiable — either filled by the server per
    // recipient (attendeeName / eventName / ticketCode / certificateUrl) or typed by the organizer.
    // Otherwise the resolver fails EVERY recipient at send time while the campaign is still charged
    // upfront (M4). Reject at create instead.
    // RD-COMMS-P2-C — and ONLY those organizer-typed variables are stored, validated (single line,
    // bounded, links https://). A typed value for a server-filled variable (e.g. eventName) or for
    // any key the template does not use is never kept, so it cannot reach the message.
    const checked = validateBroadcastVariables(templateType, variables)
    if (!checked.ok) {
      return NextResponse.json({ success: false, error: checked.error }, { status: 400 })
    }
    Object.assign(waVariables, checked.variables)
    waTemplateType = templateType
    storedSubject  = `WhatsApp · ${def.templateName}`
  }

  // ── Query recipients ──────────────────────────────────────────────────────
  let regsQuery = adminDb.collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', eventSlug) as FirebaseFirestore.Query

  if (audience !== 'all') {
    regsQuery = regsQuery.where('status', '==', audience)
  }

  // ═══ RD-BCAST-DATE-01 — resolve the registration-date window, ONCE, HERE ══════
  // "Today" becomes two absolute instants at THIS moment and is persisted below. It is
  // never stored as a word and never re-read from the clock at delivery: a campaign
  // created on 20 Aug and sent by the cron on 21 Aug must reach 20 Aug's registrants —
  // the audience that was previewed, and the audience that is billed three lines down.
  const parsedDate = parseRegistrationDateFilter((body as Record<string, unknown>).registrationDate)
  if (!parsedDate.ok) {
    return NextResponse.json({ success: false, error: `Invalid registration date filter (${parsedDate.error})` }, { status: 400 })
  }

  let dateWindow: RegistrationDateWindow | null = null
  if (parsedDate.value.type !== 'all') {
    const timezone = await resolveBroadcastTimezone(eventSlug, uid)
    const resolved = resolveRegistrationDateWindow(parsedDate.value, timezone, todayISOInTz(timezone))
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: `Invalid registration date filter (${resolved.error})` }, { status: 400 })
    }
    dateWindow = resolved.window
  }

  // Counted BEFORE the range is applied — once it is on, undated registrations are
  // invisible to the query and could not be counted at all.
  // number | null — see countUndatedRegistrations. A failure here no longer aborts the
  // campaign: the PRIMARY filtered recipient count below is the authoritative audience,
  // and it is computed by its own query that must succeed on its own merits.
  const undatedCount = dateWindow ? await countUndatedRegistrations(regsQuery) : 0

  // The range enters the QUERY, so the cap gate and the cap-bounded load below both see
  // the filtered audience. Reversing these two lines is the silent-miss bug: on an event
  // larger than the cap, limit() would truncate in document-ID order first and the date
  // filter would then see an arbitrary slice.
  regsQuery = applyRegistrationDateRange(regsQuery, dateWindow)

  // RD-ORGANIZER-04 P1-1: gate audience size with an indexed count() aggregate (zero
  // document reads) so an oversized audience is rejected WITHOUT loading the whole
  // collection into memory; then load at most cap+1 docs for suppression + billing.
  const maxRecipients = await resolveMaxRecipientsPerBroadcast(uid)
  const audienceSize  = (await regsQuery.count().get()).data().count
  if (audienceSize > maxRecipients) {
    // Explicit refusal, never a truncated send. With a date filter active this now gates
    // the FILTERED audience, which is the audience that would actually be mailed.
    return NextResponse.json({ success: false, error: 'BROADCAST_TOO_LARGE' }, { status: 422 })
  }

  const regsSnap = await regsQuery.limit(maxRecipients + 1).get()
  // RD-COMMS-CAPACITY-UX (L3) — a 'confirmed' audience never includes a completed refund.
  const allRecipients = applyAudienceRefundRule(String(audience), regsSnap.docs.map(d => ({
    id:   d.id,
    data: d.data() as RegistrationDocument,
  })))

  // Recipient filtering per channel: email removes suppressed addresses; WhatsApp
  // requires a phone number (email suppression is an email-channel concept).
  let recipients: typeof allRecipients
  let waExcluded: { noConsent: number; optedOut: number } | null = null
  if (chosenChannel === 'whatsapp') {
    const withPhone = allRecipients.filter(({ data: reg }) => typeof reg.attendee.phone === 'string' && reg.attendee.phone.trim().length > 0)
    // 'Ignore duplicate WhatsApp numbers' — WHATSAPP ONLY, applied after the presence filter
    // so both compose in the same order the send path uses. `recipientCount` below then
    // reflects the CANONICAL numbers that will actually be messaged, which is what the plan
    // gate, WhatsApp billing and the campaign history should all record.
    //
    // Deliberately AFTER the cap gate above: the cap bounds how much this route READS
    // (limit(cap+1)), exactly as it does for email. Evaluating it after dedupe would admit a
    // larger audience on the promise of fewer uniques, changing what the cap protects.
    // Existing cap semantics are unchanged.
    // RD-COMMS-WA-CONSENT — only attendees who EXPLICITLY opted in to WhatsApp updates and have
    // not replied STOP (server-side, from stored data; lib/whatsapp/broadcastConsent). Before
    // dedupe and before billing, so the paid count is the consenting count.
    const consent = await filterWhatsAppBroadcastRecipients(withPhone)
    waExcluded = { noConsent: consent.noConsent, optedOut: consent.optedOut }
    recipients = dedupePhones ? dedupeRecipientsByPhone(consent.eligible) : consent.eligible
  } else {
    const suppressionSet = await getOrganiserSuppressionSet(uid)
    const suppressed = allRecipients.filter(({ data: reg }) => !suppressionSet.has(reg.attendee.email.toLowerCase().trim()))
    // "Ignore duplicate email IDs" — EMAIL ONLY, applied after suppression so both filters
    // compose in the same order the send path uses. `recipientCount` then reflects the
    // addresses that will actually be mailed, which is what the plan/limit gates below and
    // the campaign history should record.
    //
    // Deliberately AFTER the cap gate above: the cap bounds how much this route READS
    // (count() + limit(cap+1)) and already ignores suppression filtering today. Evaluating it
    // after dedupe would admit a 1,200-registration audience on the promise of 900 unique,
    // changing what the cap protects. Existing cap semantics are unchanged.
    recipients = dedupeEmails ? dedupeRecipientsByEmail(suppressed) : suppressed
  }

  const recipientCount = recipients.length

  // RD-COMMS-P2-A — a WhatsApp broadcast is paid per recipient at start; with no recipient there is
  // nothing to pay for and nothing to send (later registrants are never added to a campaign's charge).
  if (chosenChannel === 'whatsapp' && recipientCount === 0) {
    return NextResponse.json(
      { success: false, error: 'NO_RECIPIENTS', message: waExcluded && (waExcluded.noConsent || waExcluded.optedOut)
          ? 'No one in this audience can receive WhatsApp updates: attendees must opt in to WhatsApp updates when they register, and anyone who replied STOP is excluded.'
          : 'No one in this audience has a WhatsApp number to send to.', ...(waExcluded ? { excluded: waExcluded } : {}) },
      { status: 422 },
    )
  }

  // RD-COMMS-CAPACITY-UX (M1/M2) — can the event fund this WhatsApp broadcast? Checked HERE, before
  // any campaign document exists, for send-now AND scheduled campaigns, with the same decision the
  // funding transaction makes (lib/communications/capacityQuote). Not enough ⇒ nothing is created,
  // charged, queued or sent, and the organizer is told required vs available. The funding
  // transaction at start still decides (capacity can change before a scheduled send).
  let waFundedBy: 'event_capacity' | 'legacy_balance' | null = null
  if (chosenChannel === 'whatsapp') {
    const capacity = await quoteWhatsAppBroadcastCapacity({ organizerUid: uid, eventSlug, recipientCount })
    waFundedBy = capacity.fundedBy
    if (!capacity.sufficient) {
      return NextResponse.json(
        { success: false, error: 'WHATSAPP_CAPACITY_REQUIRED', message: WHATSAPP_BROADCAST_CAPACITY_REQUIRED, capacity },
        { status: 402 },
      )
    }
  }

  // RD-CAPACITY-01 · the per-plan recipient cap is gone with the tiers. The operational
  // guard below — checkBroadcastLimits, the free email quota and the rate limits — is what
  // protects the sending infrastructure, and it is untouched. The removed check was a
  // COMMERCIAL cap, not an abuse control.

  // ── Broadcast rate limit check (free email quota) ─────────────────────────
  const limitCheck = await checkBroadcastLimits(uid, recipientCount)
  if (!limitCheck.ok) {
    // The code stays the contract; the message, counts and reset time are what make the
    // refusal actionable instead of cryptic.
    return NextResponse.json(
      {
        success: false,
        error:   limitCheck.code,
        message: limitCheck.message,
        ...(limitCheck.used    !== undefined ? { used:    limitCheck.used }    : {}),
        ...(limitCheck.limit   !== undefined ? { limit:   limitCheck.limit }   : {}),
        ...(limitCheck.resetAt !== undefined ? { resetAt: limitCheck.resetAt } : {}),
      },
      { status: limitCheck.status },
    )
  }

  // ── Resolve schedule ───────────────────────────────────────────────────────
  // scheduledFor may be ISO string or epoch ms. A future time ⇒ schedule it.
  const scheduledMs = typeof scheduledFor === 'string' ? Date.parse(scheduledFor)
    : typeof scheduledFor === 'number' ? scheduledFor : NaN
  const isScheduled = Number.isFinite(scheduledMs) && scheduledMs > Date.now()

  // RD-BCAST-COST-01 — `estimatedCostPaise` is the MONEY this campaign is expected to debit from
  // the organizer's wallet at start, i.e. what chargeAndStartCampaign would write as
  // `actualCostPaise`. It used to be `whatsapp.pricePaise × recipients` unconditionally — the
  // legacy wallet price — while a WhatsApp broadcast is now funded from the event's PREPAID
  // capacity (units, `actualCostPaise: 0`; the money was paid when the capacity was bought) and
  // the legacy balance funds nothing new (RD-WA-BLOCK-01). So it is decided by the SAME funding
  // quote just made: prepaid ⇒ 0; legacy balance ⇒ the legacy price, exactly what would be debited.
  // Units consumed are recorded by billing (`chargedUnits`). Email is free (0). Display/API only:
  // no finance, report or gate reads this field; existing campaigns keep what they stored.
  const estimatedCostPaise = chosenChannel === 'whatsapp' && waFundedBy === 'legacy_balance'
    ? Math.max(0, Math.round((await getCommunicationConfig()).whatsapp.pricePaise * recipientCount))
    : 0

  // ── Create campaign document ───────────────────────────────────────────────
  const campaignRef = adminDb.collection('broadcastCampaigns').doc()
  await campaignRef.set({
    organizerUid:   uid,           // workspace owner (authorization/ownership)
    createdBy:      callerUid,     // operator who created the broadcast (attribution)
    // RD-INTEG — eventId is the verified event SLUG, the key every transactional log, usage row
    // and analytics/Event-Communications query filters on (the client used to send the draft id
    // here, so broadcast messages were missing from per-event counts). The draft id is kept
    // alongside, from the live event — never from the body.
    eventId:        eventSlug,
    ...(liveDraftId ? { eventDraftId: liveDraftId } : {}),
    eventSlug,
    // RD-COMMS-P2-C — the event's own name (the event document), never the client's: it is what the
    // message calls the event, and a typed name could pass one event off as another.
    eventName:      authoritativeEventName(liveData, eventSlug),
    channel:        chosenChannel,
    audience,
    subject:        storedSubject,
    html:           storedHtml,
    ...(chosenChannel === 'whatsapp' ? {
      templateType: waTemplateType,
      ...(waLanguageCode ? { languageCode: waLanguageCode } : {}),
      variables:    waVariables,
    } : {}),
    recipientCount,
    // EMAIL ONLY. Persisted so a SCHEDULED campaign, resolved later by the cron from this
    // document alone, dedupes exactly like an immediate one. Written only when true, so
    // existing campaigns and every WhatsApp campaign keep an absent field.
    ...(dedupeEmails && chosenChannel !== 'whatsapp' ? { dedupeEmails: true } : {}),
    // The WhatsApp counterpart, mirrored exactly: written ONLY for a WhatsApp campaign and
    // ONLY when true, so an email campaign can never carry it and every existing campaign
    // keeps an absent field. This is what lets a SCHEDULED broadcast dedupe identically —
    // the cron resolves recipients hours later from this document alone.
    ...(dedupePhones && chosenChannel === 'whatsapp' ? { dedupePhones: true } : {}),
    // RD-BCAST-DATE-01 — the resolved window, as ABSOLUTE Timestamps. Written ONLY when a
    // filter was chosen, so "All registrations" and every pre-existing campaign keep the
    // fields absent, and send.ts adds no constraint at all for them. No migration.
    //
    // `registeredTo` is EXCLUSIVE. Persisting instants rather than the token 'today' is
    // what makes a scheduled campaign target the day it was created for, not the day it
    // happens to run.
    ...(dateWindow ? {
      registeredFrom:         Timestamp.fromDate(dateWindow.startUtc),
      registeredTo:           Timestamp.fromDate(dateWindow.endUtcExclusive),
      registrationDateFilter: toFilterRecord(parsedDate.value, dateWindow, undatedCount),
    } : {}),
    successCount:   0,
    failCount:      0,
    status:         isScheduled ? 'scheduled' : 'draft',
    scheduledFor:   isScheduled ? Timestamp.fromMillis(scheduledMs) : null,
    estimatedCostPaise,
    actualCostPaise: 0,
    failReason:     null,
    createdAt:      FieldValue.serverTimestamp(),
    sentAt:         null,
  })

  // ── Scheduled: leave for the cron; send-now: bill + deliver immediately ─────
  if (isScheduled) {
    void logBroadcastAction({
      organizerUid: uid, actorUid: callerUid, action: 'broadcast.scheduled',
      campaignId: campaignRef.id, metadata: { scheduledFor: new Date(scheduledMs).toISOString(), recipientCount, channel: chosenChannel, ...(undatedCount ? { undatedExcluded: undatedCount } : {}) },
    }).catch(() => {})
  } else {
    // Single shared path — atomic bill + transition to 'sending', then deliver.
    const result = await startBroadcastCampaign({
      campaignId: campaignRef.id, organizerUid: uid, actorUid: callerUid,
      channel: chosenChannel, recipientCount,
    })
    // RD-COMMS-P1 — every "not enough capacity" outcome points to License & Services, the ONE place
    // communication capacity is bought (lib/communications/capacity). The machine code (`error`) lets
    // the UI offer the License & Services CTA; `message` is the sentence shown.
    if (!result.ok && (result.reason === 'insufficient_balance' || result.reason === 'allowance_exhausted' || result.reason === 'allowance_required')) {
      return NextResponse.json(
        { success: false, error: 'WHATSAPP_CAPACITY_REQUIRED', message: WHATSAPP_BROADCAST_CAPACITY_REQUIRED },
        { status: 402 },
      )
    }
    // RD-COMMS-P2-B — the execution gate refused it (event no longer live, WhatsApp off, …): the
    // campaign is recorded failed with that reason; nothing was charged.
    if (!result.ok && result.reason === 'blocked') {
      return NextResponse.json(
        { success: false, error: 'BROADCAST_BLOCKED', message: `This broadcast cannot be sent: ${result.block.replace(/_/g, ' ')}.` },
        { status: 422 },
      )
    }
  }

  const snap = await campaignRef.get()
  return NextResponse.json({
    success:  true,
    campaign: docToCampaign(snap.id, snap.data() as Record<string, unknown>),
  })
}
