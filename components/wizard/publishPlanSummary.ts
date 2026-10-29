// RD-PUBLISH-PLAN · "Your Plan & Included Services" for the publish confirmation. PURE.
//
// Every figure comes from the SERVER's coverage-aware quote the License & Services step already
// holds (/api/licensing/checkout/quote — the same object the Cost summary renders) plus the
// organizer's own service switches. Nothing is added up, priced or assumed here: a service the
// quote has no price or limit for is shown as not available, never as free or unlimited.
//
//   included   — part of the event at no charge (the free registrations; email notifications)
//   paid       — a paid add-on selected now, with the server's price
//   purchased  — already paid for (verified orders / allowance ledger)
//   off        — a service the organizer switched off
//   available  — offered, not selected
//   unavailable — not offered for this event (not priced, paused, no limit configured, …)

import { formatPaise } from '@/lib/licensing/capacityPricing'
import { SERVICE_KINDS, SERVICE_LABELS, type ServiceKind } from '@/lib/licensing/serviceAllowances'
import { SALE_STATE_BADGE } from './ServiceQuantitySelector'
import type { CheckoutQuoteResponse } from './LicenseCostSummary'

export type PlanItemStatus = 'included' | 'paid' | 'purchased' | 'off' | 'available' | 'unavailable'

export interface PlanItem {
  key:     string
  label:   string
  value:   string
  status:  PlanItemStatus
  detail?: string
}

export interface PlanServiceFlags { whatsappEnabled: boolean; certEnabled: boolean }

export interface PlanSummaryInput {
  quote:            CheckoutQuoteResponse | null
  flags:            PlanServiceFlags | null
  /** lib/communications/health/channels — whether each channel can send at all. */
  emailImplemented: boolean
  smsImplemented:   boolean
}

const n = (v: number) => v.toLocaleString('en-IN')

/** The switch that gates a prepaid service, where the License step has one. */
const SWITCH: Partial<Record<ServiceKind, keyof PlanServiceFlags>> = { whatsapp: 'whatsappEnabled', certificates: 'certEnabled' }

function capacityItem(quote: CheckoutQuoteResponse): PlanItem {
  if (!quote.capacity.ok) return { key: 'capacity', label: 'Registration capacity', value: 'Not available', status: 'unavailable', detail: quote.capacity.error }
  const cap = quote.capacity.quote
  const included = Math.min(cap.capacity, cap.freeCapacity)
  if (cap.chargeableCapacity <= 0) {
    return { key: 'capacity', label: 'Registration capacity', value: `${n(cap.capacity)} registrations`, status: 'included',
      detail: `Within the ${n(cap.freeCapacity)} free registrations` }
  }
  const paidCapacity = quote.coverage?.paidCapacity ?? null
  const alreadyPaid = paidCapacity !== null && paidCapacity >= cap.capacity
  return {
    key: 'capacity', label: 'Registration capacity', value: `${n(cap.capacity)} registrations`,
    status: alreadyPaid ? 'purchased' : 'paid',
    detail: alreadyPaid
      ? `${n(included)} free + ${n(cap.chargeableCapacity)} paid · already paid`
      : `${n(included)} free + ${n(cap.chargeableCapacity)} × ${formatPaise(cap.activationRatePaise)} · ${formatPaise(cap.totalPaise)} incl. GST`,
  }
}

function serviceItem(quote: CheckoutQuoteResponse, k: ServiceKind, flags: PlanServiceFlags | null): PlanItem {
  const L = SERVICE_LABELS[k], s = quote.services[k], c = quote.catalog[k]
  const label = k === 'whatsapp' ? 'WhatsApp messages' : k === 'certificates' ? 'Certificates' : 'Event photos'
  const purchased = quote.coverage?.purchased[k] ?? 0
  const limit = k === 'media' && quote.media.maxTotal > 0 ? `Up to ${n(quote.media.maxTotal)} photos per event` : null
  const noFree = k === 'media' && quote.media.baseCap === 0 ? 'no free photos' : null
  const mediaNote = [limit, noFree].filter(Boolean).join(' · ') || undefined

  if (!s.ok) return { key: k, label, value: 'Not available', status: 'unavailable', detail: s.error }
  if (s.item) {
    const covered = purchased >= s.item.quantity
    return {
      key: k, label, value: `${n(s.item.quantity)} ${L.units}`, status: covered ? 'purchased' : 'paid',
      detail: [covered ? 'Already paid' : `${formatPaise(s.item.unitPricePaise)} / ${L.unit} · ${formatPaise(s.item.totalPaise)} incl. GST`, mediaNote].filter(Boolean).join(' · '),
    }
  }
  if (purchased > 0) return { key: k, label, value: `${n(purchased)} ${L.units}`, status: 'purchased', detail: mediaNote ?? 'Already paid' }
  if (!c.purchasable) {
    return { key: k, label, value: SALE_STATE_BADGE[c.state ?? 'not_configured'], status: 'unavailable', detail: c.stateMessage }
  }
  const sw = SWITCH[k]
  if (sw && flags && !flags[sw]) {
    return { key: k, label, value: 'Off', status: 'off', detail: k === 'whatsapp' ? 'Attendees receive email only' : undefined }
  }
  return { key: k, label, value: 'Not selected', status: 'available',
    detail: k === 'whatsapp' ? 'Attendees receive email only' : mediaNote }
}

/** The plan rows for the publish confirmation, or null when no current quote is available. */
export function buildPlanSummary(input: PlanSummaryInput): PlanItem[] | null {
  const { quote } = input
  if (!quote || quote.mode !== 'draft') return null
  return [
    capacityItem(quote),
    ...SERVICE_KINDS.map(k => serviceItem(quote, k, input.flags)),
    input.emailImplemented
      ? { key: 'email', label: 'Email notifications', value: 'Included', status: 'included' as const }
      : { key: 'email', label: 'Email notifications', value: 'Not available', status: 'unavailable' as const },
    input.smsImplemented
      ? { key: 'sms', label: 'SMS notifications', value: 'Available', status: 'available' as const }
      : { key: 'sms', label: 'SMS notifications', value: 'Not available', status: 'unavailable' as const },
  ]
}

/** Rows grouped as the popup shows them: included, paid add-ons, then not included. */
export function groupPlanItems(items: PlanItem[]) {
  return {
    included: items.filter(i => i.status === 'included'),
    paid:     items.filter(i => i.status === 'paid' || i.status === 'purchased'),
    other:    items.filter(i => i.status === 'off' || i.status === 'available' || i.status === 'unavailable'),
  }
}
