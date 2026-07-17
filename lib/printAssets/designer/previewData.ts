// PA-9 Sprint 2 — Designer authoring data. PURE (client-safe). This is UI METADATA
// + glue on top of the EXISTING variable engine (PRINT_VARIABLES / buildVariableMap /
// resolvePrintText). It does NOT re-implement any resolver: tokens are the engine's
// tokens; the map is built by buildVariableMap; substitution stays in resolvePrintText.

import { PRINT_VARIABLES, type PrintVariableSources } from '@/lib/printAssets/render/variables'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Authoring variable catalog (categories for the picker) ─────────────────────
export type VarCategory = 'participant' | 'event' | 'pass' | 'organization' | 'sponsor' | 'system' | 'custom'

export interface AuthoringVar {
  token:       string      // the ENGINE token, e.g. "name", "custom.photo"
  label:       string
  description: string
  example:     string
  category:    VarCategory
}

const SOURCE_CATEGORY: Record<string, VarCategory> = {
  registration: 'participant', event: 'event', pass: 'pass', system: 'system',
}

// Text tokens that resolve in buildVariableMap but aren't in PRINT_VARIABLES.
const EXTRA_TEXT_VARS: AuthoringVar[] = [
  { token: 'organizer',  label: 'Organizer / Company', description: 'White-label company name.', example: 'RegisterDesk', category: 'organization' },
  { token: 'brandColor', label: 'Brand colour',        description: 'Primary brand colour (hex).', example: '#e5277e',      category: 'organization' },
  { token: 'sponsor',    label: 'Sponsor name',        description: 'Sponsor name.',               example: 'Acme Corp',    category: 'sponsor' },
]

/** The base text-variable catalog (built from the engine registry — not duplicated). */
export const TEXT_VARIABLES: AuthoringVar[] = [
  ...PRINT_VARIABLES.map(v => ({ token: v.token, label: v.label, description: v.description, example: v.example, category: SOURCE_CATEGORY[v.source] ?? 'system' })),
  ...EXTRA_TEXT_VARS,
]

export const CATEGORY_LABELS: Record<VarCategory, string> = {
  participant: 'Participant', event: 'Event', pass: 'Pass', organization: 'Organization',
  sponsor: 'Sponsor', system: 'System', custom: 'Custom Fields',
}
export const CATEGORY_ORDER: VarCategory[] = ['participant', 'event', 'pass', 'organization', 'sponsor', 'system', 'custom']

/** Event custom form fields → authoring vars in the `custom.*` namespace. */
export function customFieldVariables(fieldLabels: Record<string, string>): AuthoringVar[] {
  return Object.entries(fieldLabels).map(([id, label]) => ({
    token: `custom.${id}`, label, description: 'Registration form field.', example: '', category: 'custom' as const,
  }))
}

// ─── Image source picker options ────────────────────────────────────────────────
export interface ImageSourceOption { key: string; label: string; token: string; custom?: boolean }

export const IMAGE_SOURCES: ImageSourceOption[] = [
  { key: 'organizerLogo', label: 'Organizer Logo', token: '{{logo}}' },
  { key: 'sponsorLogo',   label: 'Sponsor Logo',   token: '{{sponsorLogo}}' },
  { key: 'eventLogo',     label: 'Event Logo',     token: '{{custom.eventLogo}}' },
  { key: 'eventBanner',   label: 'Event Banner',   token: '{{custom.eventBanner}}' },
  { key: 'background',    label: 'Background',      token: '{{custom.background}}' },
  { key: 'custom',        label: 'Custom Variable', token: '{{custom.}}', custom: true },
]

/** Reverse-map a stored image source (properties.text) to a picker option key. */
export function imageSourceKey(text: string | undefined): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  const exact = IMAGE_SOURCES.find(s => !s.custom && s.token === t)
  if (exact) return exact.key
  if (/^\{\{\s*custom\..+\}\}$/.test(t)) return 'custom'
  return 'custom'
}

// ─── Sample data profiles ───────────────────────────────────────────────────────
export interface PreviewProfile { id: string; label: string; sources: PrintVariableSources }

const ev = { name: 'Tech Summit 2026', date: '15 June 2026', location: 'Chennai, India' }

// Branding is intentionally omitted so the preview endpoint injects the REAL org logo.
export const PREVIEW_PROFILES: PreviewProfile[] = [
  { id: 'runner', label: 'Runner', sources: {
    registration: { name: 'Aarav Sharma', email: 'aarav@example.com', phone: '+91 98765 43210', ticket: 'BIB-1042', id: 'REG-2026-001042', category: 'Marathon 21K' },
    event: ev, pass: { label: 'Runner', type: 'runner' }, system: { qr: 'RD:demo:reg1042:BIB-1042' } } },
  { id: 'vip', label: 'VIP', sources: {
    registration: { name: 'Priya Nair', email: 'priya@example.com', phone: '+91 90000 12345', ticket: 'TKT-VIP-07', id: 'REG-2026-000007', company: 'Nimbus Group', designation: 'Chief Guest', category: 'VIP' },
    event: ev, pass: { label: 'VIP', type: 'vip' }, system: { qr: 'RD:demo:reg0007:TKT-VIP-07' } } },
  { id: 'volunteer', label: 'Volunteer', sources: {
    registration: { name: 'Rahul Kumar', email: 'rahul@example.com', phone: '+91 91234 56780', ticket: 'VOL-231', id: 'REG-2026-000231', category: 'Logistics' },
    event: ev, pass: { label: 'Volunteer', type: 'volunteer' }, system: { qr: 'RD:demo:reg0231:VOL-231' } } },
  { id: 'speaker', label: 'Speaker', sources: {
    registration: { name: 'Dr. Meera Iyer', email: 'meera@example.com', phone: '+91 99887 66554', ticket: 'SPK-14', id: 'REG-2026-000014', company: 'IISc', designation: 'Keynote Speaker', category: 'Speaker' },
    event: ev, pass: { label: 'Speaker', type: 'speaker' }, system: { qr: 'RD:demo:reg0014:SPK-14' } } },
  { id: 'sponsor', label: 'Sponsor', sources: {
    registration: { name: 'Acme Corporation', email: 'partners@acme.com', phone: '+91 80000 00000', ticket: 'SPO-03', id: 'REG-2026-000003', company: 'Acme Corporation', designation: 'Platinum Sponsor', category: 'Sponsor' },
    event: ev, pass: { label: 'Sponsor', type: 'sponsor' }, sponsor: { name: 'Acme Corporation' }, system: { qr: 'RD:demo:reg0003:SPO-03' } } },
  { id: 'media', label: 'Media', sources: {
    registration: { name: 'John Smith', email: 'john@herald.com', phone: '+91 70000 11111', ticket: 'MED-58', id: 'REG-2026-000058', company: 'The Herald', designation: 'Press', category: 'Media' },
    event: ev, pass: { label: 'Media', type: 'media' }, system: { qr: 'RD:demo:reg0058:MED-58' } } },
  { id: 'organizer', label: 'Organizer', sources: {
    registration: { name: 'Kavya Rao', email: 'kavya@registerdesk.in', phone: '+91 60000 22222', ticket: 'ORG-01', id: 'REG-2026-000001', designation: 'Event Lead', category: 'Organizer' },
    event: ev, pass: { label: 'Organizer', type: 'organizer' }, system: { qr: 'RD:demo:reg0001:ORG-01' } } },
]

// ─── Registration → preview sources (mirrors the generation-time mapping) ────────
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

export function registrationToSources(reg: SerializedRegistration, eventName: string): PrintVariableSources {
  const custom: Record<string, string> = {}
  for (const [k, v] of Object.entries(reg.attendee.formResponses ?? {})) {
    if (v !== null && v !== undefined && typeof v !== 'object') custom[k] = String(v)
  }
  return {
    registration: {
      name: s(reg.attendee.name), email: s(reg.attendee.email), phone: s(reg.attendee.phone),
      ticket: s(reg.ticketCode), id: s(reg.id), company: s(reg.companyName),
      designation: s(reg.designation), category: s(reg.bibCategory ?? reg.passType ?? ''),
    },
    event:  { name: eventName },
    pass:   { label: s(reg.passName), type: s(reg.passName) },
    system: { qr: s(reg.ticket?.qrValue) },
    custom,
  }
}

// ─── Inject event/sponsor image URLs so the image-source picker previews ─────────
export interface EventPreviewAssets { logoUrl?: string | null; bannerUrl?: string | null; sponsorLogo?: string | null }

export function mergePreviewImageSources(base: PrintVariableSources, assets: EventPreviewAssets): PrintVariableSources {
  return {
    ...base,
    sponsor: { ...base.sponsor, ...(assets.sponsorLogo ? { logo: assets.sponsorLogo } : {}) },
    custom: {
      ...base.custom,
      ...(assets.logoUrl   ? { eventLogo: assets.logoUrl } : {}),
      ...(assets.bannerUrl ? { eventBanner: assets.bannerUrl, background: assets.bannerUrl } : {}),
    },
  }
}
