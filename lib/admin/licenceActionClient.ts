// RD-SA-COMMERCE-P1 · client helper for POST /api/admin/licenses/[eventId] — client-safe, no server imports.
//
// Shared by the three admin screens that act on a licence (Licenses, License Center, Event 360):
//   • postLicenceAction — sends an action; when the server answers CONFIRMATION_REQUIRED (e.g. restoring
//     a REFUNDED licence), shows the server's message and, if confirmed, re-sends once with the field set.
//   • refundWithPreview — asks the server for the refund preview (dryRun, changes nothing), shows the
//     amount and the capacity before/after, and only then issues the refund. A refund the server says
//     needs a Super Admin decision is never sent.

import type { ConfirmOptions } from '@/components/ui/ConfirmDialog'
import type {
  LicenseAdminActionRequest, LicenseAdminActionResponse, LicenseRefundAssessmentView,
} from './licenseAdminTypes'

type Confirm = (opts: ConfirmOptions) => Promise<boolean>

interface ErrorBody {
  error?: string; code?: string; confirmField?: string; confirmValue?: unknown
  refundAssessment?: LicenseRefundAssessmentView
}

export class LicenceActionCancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'LicenceActionCancelled' }
}

async function send(eventId: string, body: Partial<LicenseAdminActionRequest>, getToken: () => Promise<string | null | undefined>) {
  const token = await getToken()
  const res = await fetch(`/api/admin/licenses/${eventId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: '', ...body }),
  })
  const json = await res.json().catch(() => null) as (LicenseAdminActionResponse & ErrorBody) | null
  return { ok: res.ok, status: res.status, json }
}

export async function postLicenceAction(
  eventId: string, body: Partial<LicenseAdminActionRequest>,
  getToken: () => Promise<string | null | undefined>, confirm: Confirm,
): Promise<LicenseAdminActionResponse> {
  let r = await send(eventId, body, getToken)
  if (!r.ok && r.json?.code === 'CONFIRMATION_REQUIRED' && r.json.confirmField) {
    const ok = await confirm({ title: 'Confirm', message: r.json.error ?? 'Confirm this action?', tone: 'danger' })
    if (!ok) throw new LicenceActionCancelled()
    r = await send(eventId, { ...body, [r.json.confirmField]: r.json.confirmValue }, getToken)
  }
  if (!r.ok) throw new Error(r.json?.error ?? `Request failed (${r.status})`)
  return r.json as LicenseAdminActionResponse
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const cap = (n: number | null) => (n === null ? 'unlimited' : n.toLocaleString('en-IN'))

/** The preview, as plain lines for the confirm dialog (rendered with whitespace-pre-line). */
export function describeRefundAssessment(a: LicenseRefundAssessmentView): string {
  const lines = [
    `Refund: ${rupees(a.totalRefundPaise)}${a.walletCreditPaise ? ` (gateway ${rupees(a.gatewayRefundPaise)} + wallet ${rupees(a.walletCreditPaise)})` : ''}`,
    `Registrations taken: ${a.sold.toLocaleString('en-IN')}`,
    a.capacityChange
      ? `Capacity: ${cap(a.capacityBefore)} → ${cap(a.capacityAfter)}${a.paidSeats ? ` (${a.paidSeats.toLocaleString('en-IN')} refunded seats removed; never below registrations taken)` : ''}`
      : `Capacity: unchanged (${cap(a.capacityBefore)})`,
    ...a.services.map(s => `${s.service}: ${s.retirable.toLocaleString('en-IN')} of ${s.bought.toLocaleString('en-IN')} prepaid units retired${s.consumed ? `, ${s.consumed.toLocaleString('en-IN')} already used` : ''}`),
    'The licence is cancelled and the event stops taking new registrations. Existing registrations and payments are kept.',
  ]
  return lines.join('\n')
}

export async function refundWithPreview(
  eventId: string, reason: string,
  getToken: () => Promise<string | null | undefined>, confirm: Confirm,
): Promise<LicenseAdminActionResponse> {
  const preview = await send(eventId, { action: 'refund', reason, dryRun: true }, getToken)
  if (!preview.ok) throw new Error(preview.json?.error ?? `Request failed (${preview.status})`)
  const a = preview.json?.refundAssessment
  if (!a) throw new Error('The refund preview could not be loaded.')
  if (a.conflicts.length) {
    throw new Error(`This refund needs a Super Admin decision and was not issued.\n${a.conflicts.map(c => `• ${c.message}`).join('\n')}`)
  }
  const ok = await confirm({ title: 'Refund this licence?', message: describeRefundAssessment(a), confirmLabel: 'Refund', tone: 'danger' })
  if (!ok) throw new LicenceActionCancelled()
  return postLicenceAction(eventId, { action: 'refund', reason }, getToken, confirm)
}
