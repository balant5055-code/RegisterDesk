// GET  /api/organizer/broadcasts          — campaign history list
// POST /api/organizer/broadcasts          — create + send a broadcast campaign

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue, Timestamp }       from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import type { BroadcastAudience, BroadcastChannel, BroadcastCampaign } from '@/lib/broadcasts/types'
import type { RegistrationDocument }   from '@/lib/registrations/types'
import { sanitizeBroadcastHtml }              from '@/lib/broadcasts/sanitize'
import { getOrganiserSuppressionSet }  from '@/lib/firebase/firestore/emailSuppressionList'
import { checkBroadcastLimits }        from '@/lib/broadcasts/limits'
import { organizerStatusGuard }        from '@/lib/admin/organizerStatus'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { startBroadcastCampaign }      from '@/lib/broadcasts/send'
import { logBroadcastAction }          from '@/lib/broadcasts/audit'
import { requireLimit }                from '@/lib/licensing/workspaceEntitlements'
import { getFeatureFlags }             from '@/lib/config/resolveFeatureFlags'
import { hasWhatsAppTemplate, getWhatsAppTemplate } from '@/lib/whatsapp'
import { getCommunicationConfig }      from '@/lib/communications/resolveCommunicationConfig'

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
    scheduledFor:       tsToIso(d.scheduledFor),
    estimatedCostPaise: typeof d.estimatedCostPaise === 'number' ? d.estimatedCostPaise : 0,
    actualCostPaise:    typeof d.actualCostPaise    === 'number' ? d.actualCostPaise    : 0,
    failReason:     typeof d.failReason      === 'string' ? d.failReason      : null,
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
  | { success: false; error: string }

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

  const { eventId, eventSlug, eventName, audience, subject, html, channel, templateType, languageCode, variables, scheduledFor } =
    body as Record<string, unknown>

  if (typeof eventSlug !== 'string' || !eventSlug) {
    return NextResponse.json({ success: false, error: 'eventSlug is required' }, { status: 400 })
  }
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
    const def = getWhatsAppTemplate(templateType)
    if (typeof languageCode === 'string' && languageCode) {
      if (!def.languages.includes(languageCode)) {
        return NextResponse.json({ success: false, error: `Language "${languageCode}" is not available for this template.` }, { status: 400 })
      }
      waLanguageCode = languageCode
    }
    if (variables && typeof variables === 'object') {
      for (const [k, v] of Object.entries(variables as Record<string, unknown>)) {
        if (typeof v === 'string') waVariables[k] = v
      }
    }
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

  const regsSnap = await regsQuery.get()
  const allRecipients = regsSnap.docs.map(d => ({
    id:   d.id,
    data: d.data() as RegistrationDocument,
  }))

  // Recipient filtering per channel: email removes suppressed addresses; WhatsApp
  // requires a phone number (email suppression is an email-channel concept).
  let recipients: typeof allRecipients
  if (chosenChannel === 'whatsapp') {
    recipients = allRecipients.filter(({ data: reg }) => typeof reg.attendee.phone === 'string' && reg.attendee.phone.trim().length > 0)
  } else {
    const suppressionSet = await getOrganiserSuppressionSet(uid)
    recipients = allRecipients.filter(({ data: reg }) => !suppressionSet.has(reg.attendee.email.toLowerCase().trim()))
  }

  const recipientCount = recipients.length

  // ── Plan gate — broadcasts are capped by plan (maxBroadcastRecipients) ────
  const planLimit = await requireLimit(uid, 'maxBroadcastRecipients', recipientCount)
  if (!planLimit.ok) {
    return NextResponse.json({ success: false, error: planLimit.error }, { status: planLimit.status })
  }

  // ── Broadcast rate limit check (free email quota) ─────────────────────────
  const limitCheck = await checkBroadcastLimits(uid, recipientCount)
  if (!limitCheck.ok) {
    return NextResponse.json(
      { success: false, error: limitCheck.code },
      { status: limitCheck.status },
    )
  }

  // ── Resolve schedule ───────────────────────────────────────────────────────
  // scheduledFor may be ISO string or epoch ms. A future time ⇒ schedule it.
  const scheduledMs = typeof scheduledFor === 'string' ? Date.parse(scheduledFor)
    : typeof scheduledFor === 'number' ? scheduledFor : NaN
  const isScheduled = Number.isFinite(scheduledMs) && scheduledMs > Date.now()

  // Email is free (estimate 0); WhatsApp is priced per message from Business
  // Configuration (the same unit price chargeAndStartCampaign actually charges).
  const estimatedCostPaise = chosenChannel === 'whatsapp'
    ? Math.max(0, Math.round((await getCommunicationConfig()).whatsapp.pricePaise * recipientCount))
    : 0

  // ── Create campaign document ───────────────────────────────────────────────
  const campaignRef = adminDb.collection('broadcastCampaigns').doc()
  await campaignRef.set({
    organizerUid:   uid,           // workspace owner (authorization/ownership)
    createdBy:      callerUid,     // operator who created the broadcast (attribution)
    eventId:        typeof eventId   === 'string' ? eventId   : eventSlug,
    eventSlug,
    eventName:      typeof eventName === 'string' ? eventName : '',
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
      campaignId: campaignRef.id, metadata: { scheduledFor: new Date(scheduledMs).toISOString(), recipientCount, channel: chosenChannel },
    }).catch(() => {})
  } else {
    // Single shared path — atomic bill + transition to 'sending', then deliver.
    const result = await startBroadcastCampaign({
      campaignId: campaignRef.id, organizerUid: uid, actorUid: callerUid,
      channel: chosenChannel, recipientCount,
    })
    if (!result.ok && result.reason === 'insufficient_balance') {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance for this broadcast.' },
        { status: 402 },
      )
    }
  }

  const snap = await campaignRef.get()
  return NextResponse.json({
    success:  true,
    campaign: docToCampaign(snap.id, snap.data() as Record<string, unknown>),
  })
}
