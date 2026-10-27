// lib/notifications/actionAlerts.ts
// RD-NOTIFY-01 — the messages for organizer actions that need a Super Admin, and for the Super Admin
// decisions an organizer must hear about. PURE builders (no I/O): each returns an OutboxMessageInput
// that the authoritative server path stages in its own commit (lib/notifications/outbox).
//
// Ids are unique per occurrence and say what happened, so a retried request never doubles an alert
// and two different occurrences never collide. Content: identities, statuses and links only — never
// bank/account numbers, PAN, IFSC, credentials or attendee personal data.

import type { OutboxMessageInput, OutboxFact } from './outbox'

export interface OrganizerIdentity { uid: string; name: string; email: string }

const who = (o: OrganizerIdentity) => o.name && o.email ? `${o.name} <${o.email}>` : o.email || o.name || o.uid
const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
const organizerFact = (o: OrganizerIdentity): OutboxFact => ({ label: 'Organizer', value: who(o) })

// ─── Super Admin: event review ─────────────────────────────────────────────────

export type EventReviewSubmission = 'submitted' | 'resubmitted' | 'republished'

const SUBMISSION_LABEL: Record<EventReviewSubmission, { subject: string; action: string }> = {
  submitted:   { subject: 'New event submitted for review',   action: 'First submission' },
  resubmitted: { subject: 'Event resubmitted for review',      action: 'Resubmitted after changes / rejection' },
  republished: { subject: 'Unpublished event sent back for review', action: 'Republish request' },
}

export function eventReviewAlert(a: {
  submission: EventReviewSubmission; draftId: string; slug: string | null; eventName: string
  organizer: OrganizerIdentity; at: Date; when: string
}): OutboxMessageInput {
  const l = SUBMISSION_LABEL[a.submission]
  const name = a.eventName || 'Untitled event'
  return {
    id: `evt-review_${a.submission}_${idPart(a.draftId)}_${a.at.getTime()}`,
    audience: { kind: 'super_admins' }, adminKind: 'event_review',
    subject: `${l.subject}: ${name}`,
    heading: l.subject,
    intro: `${name} is waiting for review (status: pending review).`,
    facts: [
      { label: 'Event', value: name }, organizerFact(a.organizer), { label: 'Action', value: l.action },
      { label: 'Status', value: 'Pending review' }, { label: 'When', value: a.when },
    ],
    path: a.slug ? `/admin/events/${encodeURIComponent(a.slug)}` : '/admin/event-approvals',
    ctaLabel: 'Review event',
    metadata: { draftId: a.draftId, slug: a.slug, organizerUid: a.organizer.uid, submission: a.submission },
  }
}

// ─── Super Admin: payout profile ───────────────────────────────────────────────

export function payoutProfileAlert(a: {
  historyId: string; created: boolean; wasVerified: boolean; changedFields: string[]
  organizer: OrganizerIdentity; when: string
}): OutboxMessageInput {
  const subject = a.created ? 'New payout profile submitted' : a.wasVerified ? 'Verified payout profile changed' : 'Payout profile updated'
  // Field NAMES only (never values) — and only a short list.
  const fields = a.changedFields.slice(0, 8).join(', ') + (a.changedFields.length > 8 ? ', …' : '')
  return {
    id: `payout-profile_${idPart(a.organizer.uid)}_${idPart(a.historyId)}`,
    audience: { kind: 'super_admins' }, adminKind: 'payout_profile',
    subject: `${subject}: ${a.organizer.name || a.organizer.email || a.organizer.uid}`,
    heading: subject,
    intro: a.created
      ? 'An organizer submitted a payout profile. It needs verification before any settlement can be paid.'
      : `An organizer changed their payout profile.${a.wasVerified ? ' It was verified; verification has been reset and settlements are blocked until it is verified again.' : ' It needs verification before any settlement can be paid.'}`,
    facts: [
      organizerFact(a.organizer), { label: 'Action', value: a.created ? 'Created' : 'Updated' },
      ...(a.created || !fields ? [] : [{ label: 'Changed', value: fields }]),
      { label: 'Status', value: 'Awaiting verification' }, { label: 'When', value: a.when },
    ],
    path: '/admin/finance',
    ctaLabel: 'Open Finance → Payout Profiles',
    metadata: { organizerUid: a.organizer.uid, historyId: a.historyId },
  }
}

// ─── Super Admin: wallet refund / carry-forward request ───────────────────────

const SERVICE_LABEL: Record<string, string> = {
  registrations: 'registration capacity', whatsapp: 'WhatsApp messages', certificates: 'certificates',
  media: 'event photos', print_badges: 'print badges',
}
const svc = (s: string) => SERVICE_LABEL[s] ?? s

export function serviceRequestAlert(a: {
  requestIds: string[]; kind: 'refund' | 'carry_forward'; services: { service: string; quantity: number }[]
  eventName: string; draftId: string; organizer: OrganizerIdentity; when: string
}): OutboxMessageInput {
  const what = a.kind === 'refund' ? 'Refund request' : 'Carry-forward request'
  const lines = a.services.map(s => `${s.quantity.toLocaleString('en-IN')} ${svc(s.service)}`).join(', ')
  return {
    id: `svc-req_${idPart(a.requestIds[0] ?? 'x')}_submitted`,
    audience: { kind: 'super_admins' }, adminKind: 'service_request',
    subject: `${what} submitted: ${a.eventName || 'event'}`,
    heading: `New ${what.toLowerCase()}`,
    intro: `An organizer asked RegisterDesk to ${a.kind === 'refund' ? 'refund unused' : 'carry forward unused'} prepaid services. It needs a decision.`,
    facts: [
      { label: 'Event', value: a.eventName || a.draftId }, organizerFact(a.organizer),
      { label: 'Services', value: lines || '—' }, { label: 'Status', value: 'Submitted — awaiting decision' },
      { label: 'Request', value: a.requestIds.join(', ') }, { label: 'When', value: a.when },
    ],
    path: `/admin/wallet-management?tab=${a.kind === 'refund' ? 'refunds' : 'carry_forward'}&event=${encodeURIComponent(a.draftId)}`,
    ctaLabel: 'Review request',
    metadata: { requestId: a.requestIds[0] ?? null, draftId: a.draftId, organizerUid: a.organizer.uid, kind: a.kind },
  }
}

// ─── Super Admin: settlement (payout) request ─────────────────────────────────

export function settlementRequestAlert(a: {
  settlementId: string; amountPaise: number; eventName: string | null; organizer: OrganizerIdentity; when: string
}): OutboxMessageInput {
  const amount = `₹${(a.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  return {
    id: `settlement-req_${idPart(a.settlementId)}`,
    audience: { kind: 'super_admins' }, adminKind: 'settlement_request',
    subject: `Payout request: ${amount} — ${a.organizer.name || a.organizer.email || a.organizer.uid}`,
    heading: 'New payout (settlement) request',
    intro: 'An organizer requested a payout. It needs approval before any transfer.',
    facts: [
      organizerFact(a.organizer), ...(a.eventName ? [{ label: 'Event', value: a.eventName }] : []),
      { label: 'Amount', value: amount }, { label: 'Status', value: 'Pending approval' },
      { label: 'Request', value: a.settlementId }, { label: 'When', value: a.when },
    ],
    path: '/admin/finance',
    ctaLabel: 'Open Finance → Settlements',
    metadata: { settlementId: a.settlementId, organizerUid: a.organizer.uid, amountPaise: a.amountPaise },
  }
}

// ─── Super Admin: a registration refund needs attention ───────────────────────

export type RefundAttention = 'review' | 'failed' | 'queue_escalated'

const ATTENTION: Record<RefundAttention, { subject: string; intro: string }> = {
  review:          { subject: 'Refund needs review',              intro: 'A gateway refund did not match the expected state and was held for review. The settlement stays held until a Super Admin resolves it.' },
  failed:          { subject: 'Refund failed',                    intro: 'Razorpay reported a refund as failed. Check whether the attendee was refunded and resolve the record.' },
  queue_escalated: { subject: 'Refund reconciliation needs action', intro: 'Automatic refund reconciliation gave up after its retries. It needs manual review.' },
}

export function refundAttentionAlert(a: {
  attention: RefundAttention; key: string; registrationId: string; eventSlug: string | null
  amountPaise: number | null; reason: string | null; when: string
}): OutboxMessageInput {
  const t = ATTENTION[a.attention]
  return {
    id: `refund-attn_${a.attention}_${idPart(a.key)}`,
    audience: { kind: 'super_admins' }, adminKind: 'refund_attention',
    subject: `${t.subject}${a.eventSlug ? `: ${a.eventSlug}` : ''}`,
    heading: t.subject,
    intro: t.intro,
    facts: [
      ...(a.eventSlug ? [{ label: 'Event', value: a.eventSlug }] : []),
      { label: 'Registration', value: a.registrationId },
      ...(a.amountPaise !== null ? [{ label: 'Amount', value: `₹${(a.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` }] : []),
      ...(a.reason ? [{ label: 'Reason', value: a.reason }] : []),
      { label: 'When', value: a.when },
    ],
    path: '/admin/finance',
    ctaLabel: 'Open Finance',
    metadata: { registrationId: a.registrationId, eventSlug: a.eventSlug, attention: a.attention },
  }
}

// ─── Organizer: decisions on their requests ───────────────────────────────────

export type ServiceRequestDecision = 'approved' | 'rejected' | 'processed'

export function serviceRequestDecisionNotice(a: {
  requestId: string; decision: ServiceRequestDecision; kind: 'refund' | 'carry_forward'; service: string
  quantity: number; eventName: string; draftId: string; organizerUid: string; note: string | null; when: string
}): OutboxMessageInput {
  const what = a.kind === 'refund' ? 'refund request' : 'carry-forward request'
  const headline: Record<ServiceRequestDecision, string> = {
    approved: `Your ${what} was approved`, rejected: `Your ${what} was not approved`,
    processed: a.kind === 'refund' ? 'Your refund has been processed' : 'Your carry-forward is complete',
  }
  return {
    id: `svc-req_${idPart(a.requestId)}_${a.decision}`,
    audience: { kind: 'organizer', organizerUid: a.organizerUid },
    inbox: { category: 'wallet', type: `service_request_${a.decision}`, severity: a.decision === 'rejected' ? 'warning' : 'success', eventId: a.draftId, eventName: a.eventName },
    subject: `${headline[a.decision]} — ${a.eventName || 'your event'}`,
    heading: headline[a.decision],
    intro: `${a.quantity.toLocaleString('en-IN')} ${svc(a.service)} for ${a.eventName || 'your event'}.`,
    facts: [
      { label: 'Event', value: a.eventName || a.draftId }, { label: 'Request', value: a.requestId },
      { label: 'Status', value: a.decision === 'approved' ? 'Approved' : a.decision === 'rejected' ? 'Rejected' : 'Processed' },
      ...(a.note ? [{ label: a.decision === 'rejected' ? 'Reason' : 'Note', value: a.note }] : []),
      { label: 'When', value: a.when },
    ],
    path: `/dashboard/wallet?eventId=${encodeURIComponent(a.draftId)}`,
    ctaLabel: 'Open Wallet',
  }
}

export function payoutProfileChangesNotice(a: { organizerUid: string; note: string | null; stamp: number; when: string }): OutboxMessageInput {
  return {
    id: `payout-profile_${idPart(a.organizerUid)}_changes_${a.stamp}`,
    audience: { kind: 'organizer', organizerUid: a.organizerUid },
    inbox: { category: 'settlement', type: 'payout_profile_changes_requested', severity: 'warning', actionRequired: true },
    subject: 'Changes requested on your payout profile',
    heading: 'Your payout profile needs changes',
    intro: 'RegisterDesk reviewed your payout profile and needs you to update it before payouts can continue.',
    facts: [...(a.note ? [{ label: 'Requested', value: a.note }] : []), { label: 'When', value: a.when }],
    path: '/dashboard/finance/payout-profile',
    ctaLabel: 'Update payout profile',
  }
}
