// Organizer Notification Center — typed event helpers (Phase H.4.3). Server-only.
//
// Thin, best-effort builders called at the EXISTING event commit points. Each
// classifies a platform event into an inbox notification and delegates to the
// single writeNotification() path. They never throw (writeNotification swallows
// failures), so call sites use `void notifyX(...)` as a fire-and-forget side
// effect — exactly the codebase's standard post-commit pattern. No event is
// generated here; these only record events that already happened.

import { fmtMoney } from '@/lib/reports/format'
import { writeNotification } from './write'

const eventLink = (eventId?: string | null, tab?: string) =>
  eventId ? `/dashboard/events/${eventId}${tab ? `?tab=${tab}` : ''}` : '/dashboard/events'

// ─── 1. Event review ──────────────────────────────────────────────────────────

export type ReviewKind = 'submitted' | 'approved' | 'rejected' | 'changes_requested' | 'resubmitted'

export function notifyEventReviewed(args: {
  workspaceUid: string
  eventName:    string
  eventId?:     string | null
  kind:         ReviewKind
  reason?:      string
  comment?:     string
}): Promise<string> {
  const { workspaceUid, eventName, eventId, kind, reason, comment } = args
  const link = eventLink(eventId)
  const table: Record<ReviewKind, { title: string; body: string; severity: 'info' | 'success' | 'warning' | 'error'; action: boolean }> = {
    submitted:         { title: 'Event submitted for review', body: `“${eventName}” is now under review.`,                                        severity: 'info',    action: false },
    approved:          { title: 'Event approved',             body: `“${eventName}” has been approved.`,                                          severity: 'success', action: false },
    rejected:          { title: 'Event rejected',             body: `“${eventName}” was rejected.${reason ? ` Reason: ${reason}` : ''}`,           severity: 'error',   action: true  },
    changes_requested: { title: 'Changes requested',          body: `Changes were requested for “${eventName}”.${comment ? ` ${comment}` : ''}`,  severity: 'warning', action: true  },
    resubmitted:       { title: 'Event resubmitted',          body: `“${eventName}” was resubmitted for review.`,                                 severity: 'info',    action: false },
  }
  const m = table[kind]
  return writeNotification({
    workspaceUid, category: 'approval', type: `EVENT_${kind.toUpperCase()}`,
    title: m.title, body: m.body, severity: m.severity, actionRequired: m.action,
    link, eventId: eventId ?? null, eventName,
  })
}

// ─── 2. Payment capture ───────────────────────────────────────────────────────

export function notifyPaymentReceived(args: {
  workspaceUid:   string
  registrationId: string
  eventId?:       string | null
  eventName:      string
  amountPaise:    number
  attendeeName?:  string
}): Promise<string> {
  const { workspaceUid, registrationId, eventId, eventName, amountPaise, attendeeName } = args
  return writeNotification({
    workspaceUid, category: 'payment', type: 'PAYMENT_SUCCESS',
    title: 'Payment received',
    body:  `${fmtMoney(amountPaise)}${attendeeName ? ` from ${attendeeName}` : ''} for “${eventName}”.`,
    severity: 'success',
    link: eventId ? eventLink(eventId, 'registrations') : '/dashboard/registrations',
    eventId: eventId ?? null, eventName,
    dedupeId: `payment-${registrationId}`,
  })
}

// ─── 3. Wallet recharge ───────────────────────────────────────────────────────

export function notifyWalletRecharged(args: {
  workspaceUid:    string
  amountPaise:     number
  newBalancePaise: number
  topupId?:        string
}): Promise<string> {
  const { workspaceUid, amountPaise, newBalancePaise, topupId } = args
  return writeNotification({
    workspaceUid, category: 'wallet', type: 'WALLET_RECHARGED',
    title: 'Wallet recharged',
    body:  `${fmtMoney(amountPaise)} added. New balance: ${fmtMoney(newBalancePaise)}.`,
    severity: 'success', link: '/dashboard/wallet',
    dedupeId: topupId ? `wallet-topup-${topupId}` : undefined,
  })
}

// ─── 4. Registration milestone ────────────────────────────────────────────────

export function notifyRegistrationMilestone(args: {
  workspaceUid: string
  eventId?:     string | null
  eventName:    string
  title:        string
  body:         string
  dedupeId?:    string
}): Promise<string> {
  const { workspaceUid, eventId, eventName, title, body, dedupeId } = args
  return writeNotification({
    workspaceUid, category: 'registration', type: 'REGISTRATION_MILESTONE',
    title, body, severity: 'info', link: eventLink(eventId, 'registrations'),
    eventId: eventId ?? null, eventName, dedupeId,
  })
}

// ─── 5. Certificate job complete ──────────────────────────────────────────────

export function notifyCertificateJobComplete(args: {
  workspaceUid: string
  jobId:        string
  eventId?:     string | null
  eventName:    string
  issued:       number
  failed:       number
}): Promise<string> {
  const { workspaceUid, jobId, eventId, eventName, issued, failed } = args
  return writeNotification({
    workspaceUid, category: 'certificate', type: 'CERTIFICATE_JOB_COMPLETE',
    title: failed > 0 ? 'Certificate job finished' : 'Certificates ready',
    body:  `${issued} certificate${issued === 1 ? '' : 's'} issued for “${eventName}”.${failed > 0 ? ` ${failed} failed.` : ''}`,
    severity: failed > 0 ? 'warning' : 'success',
    link: eventLink(eventId, 'certificates'),
    eventId: eventId ?? null, eventName,
    dedupeId: `cert-job-${jobId}`,
  })
}

// ─── 6. Broadcast complete ────────────────────────────────────────────────────

export function notifyBroadcastComplete(args: {
  workspaceUid: string
  broadcastId:  string
  subject?:     string
  status:       'sent' | 'partial' | 'failed'
  sent:         number
  failed:       number
}): Promise<string> {
  const { workspaceUid, broadcastId, subject, status, sent, failed } = args
  const title = status === 'failed' ? 'Broadcast failed' : status === 'partial' ? 'Broadcast partially sent' : 'Broadcast sent'
  return writeNotification({
    workspaceUid, category: 'broadcast', type: 'BROADCAST_COMPLETE',
    title,
    body: `${subject ? `“${subject}”: ` : ''}${sent} delivered${failed > 0 ? `, ${failed} failed` : ''}.`,
    severity: status === 'failed' ? 'error' : status === 'partial' ? 'warning' : 'success',
    actionRequired: status === 'failed',
    link: '/dashboard/communications/broadcasts',
    dedupeId: `broadcast-${broadcastId}`,
  })
}

// ─── 7. Settlement events ─────────────────────────────────────────────────────

export type SettlementKind = 'requested' | 'approved' | 'rejected' | 'paid' | 'released'

export function notifySettlement(args: {
  workspaceUid:  string
  settlementId:  string
  kind:          SettlementKind
  amountPaise:   number
  reason?:       string
}): Promise<string> {
  const { workspaceUid, settlementId, kind, amountPaise, reason } = args
  const amt = fmtMoney(amountPaise)
  const table: Record<SettlementKind, { title: string; body: string; severity: 'info' | 'success' | 'warning' | 'error'; action: boolean }> = {
    requested: { title: 'Payout requested', body: `Your payout request for ${amt} was submitted.`,      severity: 'info',    action: false },
    approved:  { title: 'Payout approved',  body: `Your payout of ${amt} was approved.`,                 severity: 'success', action: false },
    rejected:  { title: 'Payout rejected',  body: `Your payout of ${amt} was rejected.${reason ? ` Reason: ${reason}` : ''}`, severity: 'error', action: true },
    paid:      { title: 'Payout paid',      body: `${amt} has been paid to your account.`,               severity: 'success', action: false },
    released:  { title: 'Funds released',   body: `${amt} is now available for payout.`,                 severity: 'success', action: false },
  }
  const m = table[kind]
  return writeNotification({
    workspaceUid, category: 'settlement', type: `SETTLEMENT_${kind.toUpperCase()}`,
    title: m.title, body: m.body, severity: m.severity, actionRequired: m.action,
    link: '/dashboard/finance/settlements',   // H.5.1: the Settlement Center
    dedupeId: `settlement-${settlementId}-${kind}`,
  })
}

// ─── 8. Background-job completions (EA-4 S3) ──────────────────────────────────
// GROUPED: exactly ONE notification per JOB (never one per item), summarising the
// counts. Deterministic dedupeId ⇒ a job that finishes is reported a single time.

export function notifyPrintJobComplete(args: {
  workspaceUid: string; jobId: string; kind: 'generation' | 'package'
  eventId?: string | null; eventName?: string | null; succeeded: number; failed: number
}): Promise<string> {
  const { workspaceUid, jobId, kind, eventId, eventName, succeeded, failed } = args
  const noun = kind === 'package' ? 'Print package' : 'Print job'
  return writeNotification({
    workspaceUid, category: 'system', type: kind === 'package' ? 'PRINT_PACKAGE_COMPLETE' : 'PRINT_JOB_COMPLETE',
    title: failed > 0 ? `${noun} finished with errors` : `${noun} completed`,
    body:  `${succeeded} item${succeeded === 1 ? '' : 's'} ready${eventName ? ` for “${eventName}”` : ''}.${failed > 0 ? ` ${failed} failed.` : ''}`,
    severity: failed > 0 ? 'warning' : 'success', link: '/dashboard/print-assets',
    eventId: eventId ?? null, eventName: eventName ?? null,
    dedupeId: `print-${kind}-${jobId}`,
  })
}

export function notifyExportReady(args: {
  workspaceUid: string; jobId: string; rowCount: number; label?: string; link?: string
}): Promise<string> {
  const { workspaceUid, jobId, rowCount, label, link } = args
  return writeNotification({
    workspaceUid, category: 'system', type: 'EXPORT_READY',
    title: 'Export ready',
    body:  `${label ? `${label}: ` : ''}${rowCount} row${rowCount === 1 ? '' : 's'} ready to download.`,
    severity: 'success', link: link ?? '/dashboard/finance/reports',
    dedupeId: `export-${jobId}`,
  })
}

export function notifyImportComplete(args: {
  workspaceUid: string; jobId: string; eventId?: string | null; eventName?: string | null
  imported: number; failed: number
}): Promise<string> {
  const { workspaceUid, jobId, eventId, eventName, imported, failed } = args
  return writeNotification({
    workspaceUid, category: 'registration', type: 'IMPORT_COMPLETE',
    title: failed > 0 ? 'Import finished with errors' : 'Import completed',
    body:  `${imported} registration${imported === 1 ? '' : 's'} imported${eventName ? ` into “${eventName}”` : ''}.${failed > 0 ? ` ${failed} failed.` : ''}`,
    severity: failed > 0 ? 'warning' : 'success', link: eventLink(eventId, 'registrations'),
    eventId: eventId ?? null, eventName: eventName ?? null,
    dedupeId: `import-${jobId}`,
  })
}

export function notifyBulkComplete(args: {
  workspaceUid: string; jobId: string; action: string; eventId?: string | null; eventName?: string | null
  succeeded: number; failed: number
}): Promise<string> {
  const { workspaceUid, jobId, action, eventId, eventName, succeeded, failed } = args
  return writeNotification({
    workspaceUid, category: 'registration', type: 'BULK_COMPLETE',
    title: failed > 0 ? 'Bulk operation finished with errors' : 'Bulk operation completed',
    body:  `${action}: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}${eventName ? ` for “${eventName}”` : ''}.`,
    severity: failed > 0 ? 'warning' : 'success', link: eventLink(eventId, 'registrations'),
    eventId: eventId ?? null, eventName: eventName ?? null,
    dedupeId: `bulk-${jobId}`,
  })
}

// ─── 9. Expiry notices (EA-4 S3) ──────────────────────────────────────────────

export function notifyLicenseExpired(args: {
  workspaceUid: string; eventId?: string | null; eventName?: string | null
}): Promise<string> {
  const { workspaceUid, eventId, eventName } = args
  return writeNotification({
    workspaceUid, category: 'system', type: 'LICENSE_EXPIRED',
    title: 'License expired',
    body:  `The event license${eventName ? ` for “${eventName}”` : ''} has expired. Renew it to publish.`,
    severity: 'warning', actionRequired: true, link: eventLink(eventId),
    eventId: eventId ?? null, eventName: eventName ?? null,
    dedupeId: eventId ? `license-expired-${eventId}` : undefined,
  })
}

export function notifyCouponExpired(args: {
  workspaceUid: string; code: string
}): Promise<string> {
  const { workspaceUid, code } = args
  return writeNotification({
    workspaceUid, category: 'system', type: 'COUPON_EXPIRED',
    title: 'Coupon expired',
    body:  `The license coupon “${code}” has expired.`,
    severity: 'info', link: '/dashboard',
    dedupeId: `coupon-expired-${code}`,
  })
}
