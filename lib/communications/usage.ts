// RD-COMMS-P1 · Communication Center › Usage — ONE event's communication capacity, read-only.
// Server-only.
//
// Every figure comes from the canonical allowance ledger (eventServiceAllowances/{draftId}, read
// through serviceAllowanceLedger.viewOf) plus what this event's broadcasts hold / gave back
// (capacityActivity). Nothing here computes money, writes anything, or introduces a second
// accounting model. RD-COMMS-L2 — the figures and their meaning are the ONE organizer definition
// in lib/communications/capacityFigures (shared with License & Services):
// Purchased · Used · In progress · Returned · Refunded · Carried in / out · Available (the
// ledger's own available figure — never Purchased − Used).
//
// Ownership: the draft is read under users/{uid}/eventDrafts (another workspace's draft id is
// simply "not found"), a ledger owned by anyone else is ignored, and the broadcast query is
// filtered by organizerUid AND the owner-verified slug (the capacity activity by organizerUid AND
// this draft id).

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { viewOf, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { getWalletBalance } from '@/lib/firebase/firestore/wallet'
import { increaseLimitHref } from '@/lib/wallet/purchaseIntent'
import { communicationCapacityFigures, type CapacityActivity, type CapacityLedgerFigures, type CommunicationCapacityFigures } from './capacityFigures'
import { readWhatsAppCapacityActivity } from './capacityActivity'

export const USAGE_BROADCAST_SCAN = 300

export interface ServiceUsage extends CommunicationCapacityFigures {
  /** License & Services for THIS event, opened on this service. */
  manageHref: string
}

export interface UsageBroadcastRow {
  id:          string
  channel:     string
  status:      string
  recipients:  number
  /** What funded it: the event's capacity, the legacy balance, or nothing (email is free). */
  fundedBy:    'event_capacity' | 'legacy_balance' | 'free' | 'none'
  createdAt:   string | null
  subject:     string | null
}

export interface EventCommunicationUsage {
  event:     { draftId: string; name: string; slug: string | null }
  whatsapp:  ServiceUsage
  certificates: ServiceUsage
  email:     { free: true; sent: number | null }
  /** Most recent broadcasts of THIS event (newest first). */
  broadcasts: UsageBroadcastRow[]
  /** The broadcast scan hit its bound — older broadcasts are not listed / counted. */
  broadcastsTruncated: boolean
  /** LEGACY communication balance (paise) — only for callers with the `wallet` permission. */
  legacyBalancePaise: number | null
}

type Rec = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const iso = (v: unknown) => (v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null)

function fundedByOf(c: Rec): UsageBroadcastRow['fundedBy'] {
  if (c.fundedBy === 'prepaid_allowance') return 'event_capacity'
  if (c.channel === 'email') return 'free'
  if (num(c.chargedCostPaise) > 0 || num(c.actualCostPaise) > 0) return 'legacy_balance'
  return 'none'
}

/** Pure — exported for tests. */
export function serviceUsageOf(line: CapacityLedgerFigures, activity: CapacityActivity | null, manageHref: string): ServiceUsage {
  return { ...communicationCapacityFigures(line, activity), manageHref }
}

export async function getEventCommunicationUsage(
  uid: string, draftId: string, opts: { includeLegacyBalance: boolean },
): Promise<EventCommunicationUsage | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftId)) return null
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${draftId}`).get()
  if (!draftSnap.exists) return null
  const draft = draftSnap.data() as Rec
  const info  = ((draft.eventDetails as Rec | undefined)?.info as Rec | undefined) ?? {}
  const name  = str(info.name) ?? 'Untitled event'

  const [ledgerSnap, slug, legacyBalancePaise, whatsappActivity] = await Promise.all([
    adminDb.doc(`eventServiceAllowances/${draftId}`).get(),
    resolveOwnedEventSlug(uid, draftId, draft),
    opts.includeLegacyBalance ? getWalletBalance(uid) : Promise.resolve(null),
    readWhatsAppCapacityActivity(uid, draftId),
  ])
  const raw = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
  // A ledger keyed by this draft id but owned by another organizer is never this event's.
  const ledger = raw && raw.organizerUid === uid ? raw : undefined
  const v = viewOf(ledger)

  // This event's broadcasts (equality-only filters: served without a composite index).
  let broadcasts: UsageBroadcastRow[] = []
  let truncated = false
  let emailSent: number | null = null
  if (slug) {
    const [campSnap, emailAgg] = await Promise.all([
      adminDb.collection('broadcastCampaigns')
        .where('organizerUid', '==', uid).where('eventSlug', '==', slug)
        .limit(USAGE_BROADCAST_SCAN).get(),
      adminDb.collection('communicationUsage')
        .where('organizerUid', '==', uid).where('eventSlug', '==', slug).where('channel', '==', 'email')
        .aggregate({ total: AggregateField.sum('quantity') }).get()
        .then(a => num(a.data().total)).catch(() => null),
    ])
    truncated = campSnap.size >= USAGE_BROADCAST_SCAN
    emailSent = emailAgg
    const rows = campSnap.docs.map(d => ({ id: d.id, data: d.data() as Rec }))
    broadcasts = rows
      .map(r => ({
        id: r.id,
        channel: str(r.data.channel) ?? 'email',
        status: str(r.data.status) ?? 'unknown',
        recipients: num(r.data.recipientCount),
        fundedBy: fundedByOf(r.data),
        createdAt: iso(r.data.createdAt),
        subject: str(r.data.subject) ?? str(r.data.templateType),
      }))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, 20)
  }

  const line = (k: 'whatsapp' | 'certificates') => ({
    purchased: v.purchased[k], consumed: v.consumed[k], carriedIn: v.carriedIn[k],
    carriedOut: v.carriedOut[k], refunded: v.refunded[k], remaining: v.remaining[k],
  })
  return {
    event: { draftId, name, slug },
    whatsapp:     serviceUsageOf(line('whatsapp'), whatsappActivity, increaseLimitHref(draftId, 'whatsapp')),
    certificates: serviceUsageOf(line('certificates'), { inProgress: 0, returned: null }, increaseLimitHref(draftId, 'certificates')),
    email: { free: true, sent: emailSent },
    broadcasts,
    broadcastsTruncated: truncated,
    legacyBalancePaise,
  }
}
