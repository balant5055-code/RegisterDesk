// THE canonical registration export definition. PURE — no Firebase, no SDK imports,
// so it unit-tests in the `node` environment and both exporters share one truth.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// There were two "Export CSV" buttons producing DIFFERENT columns: the server route
// carried Registration ID + bib/sports fields but no money at all, while the client
// bulk export carried refund fields and every custom form answer but no Registration ID.
// Same label, different data, neither a superset. Columns are defined once here and
// every exporter (CSV stream, XLSX) consumes this — a new column appears everywhere or
// nowhere.
//
// ═══ SHAPE ═══════════════════════════════════════════════════════════════════
// Emits the repo's existing ReportColumn/ReportRow contract, so lib/reports/xlsx
// renders it with no new spreadsheet code. Money cells hold PAISE and are typed 'money',
// which is what keeps amounts numeric (and SUM-able) in Excel.
//
// Timestamps are typed 'text' holding full ISO strings, NOT the shared 'date' type: that
// type renders through fmtDate, which prints "20 Sep 2026" and throws the TIME away —
// unusable for a check-in timestamp, and a regression against the previous export, which
// already emitted toISO(). Fidelity wins over sharing a formatter here.
//
// ═══ WHAT IS DELIBERATELY ABSENT ═════════════════════════════════════════════
// Currency (never persisted — INR is implicit), a separate "final amount" (`amount` IS
// already the net charged figure), postal address (only exists if the organiser happens
// to have added a form field, in which case it appears as a custom column), and
// confirmation/cancellation timestamps (not persisted on the registration; the auditLog
// subcollection holds them and is out of scope for a row-per-registration export).

import type { ReportColumn, ReportRow, ReportCell } from '@/lib/reports/types'
import { refundLabel } from './paymentDisplay'

/** Everything the row builder needs that does not live on the registration itself. */
export interface RegistrationExportContext {
  eventId:   string   // organizer draft id — the event's stable identifier
  eventSlug: string
  /** fieldId → question label, from the event's registrationForm. */
  fieldLabels: Record<string, string>
}

/** Column key prefix for custom form answers — namespaced so a form field can never
 *  collide with a fixed column key (a form question literally named "Email" is real). */
export const CUSTOM_FIELD_PREFIX = 'form:'

// ─── Fixed columns ────────────────────────────────────────────────────────────
// Order is the report's reading order and is part of the contract: attendee → event →
// payment → check-in → communication → metadata. Custom form answers are appended last.
const FIXED_COLUMNS: ReportColumn[] = [
  // Attendee
  { key: 'registrationId', label: 'Registration ID', type: 'text' },
  { key: 'ticketId',       label: 'Ticket ID',       type: 'text' },
  { key: 'ticketCode',     label: 'Ticket Code',     type: 'text' },
  { key: 'name',           label: 'Name',            type: 'text' },
  { key: 'email',          label: 'Email',           type: 'text' },
  { key: 'phone',          label: 'Phone',           type: 'text' },
  // Event
  { key: 'eventId',          label: 'Event ID',            type: 'text' },
  { key: 'eventSlug',        label: 'Event Slug',          type: 'text' },
  { key: 'eventName',        label: 'Event Name',          type: 'text' },
  { key: 'passName',         label: 'Pass',                type: 'text' },
  { key: 'selectedSessions', label: 'Selected Sessions',   type: 'text' },
  { key: 'registeredAt',     label: 'Registration Date',   type: 'text' },
  { key: 'status',           label: 'Registration Status', type: 'text' },
  { key: 'registrationSource', label: 'Source',            type: 'text' },
  // Payment
  { key: 'paymentStatus',   label: 'Payment Status',    type: 'text'  },
  { key: 'amount',          label: 'Amount',            type: 'money' },
  { key: 'originalAmount',  label: 'Original Amount',   type: 'money' },
  { key: 'discountAmount',  label: 'Discount Amount',   type: 'money' },
  { key: 'couponCode',      label: 'Coupon Code',       type: 'text'  },
  { key: 'paymentId',       label: 'Payment ID',        type: 'text'  },
  { key: 'razorpayOrderId', label: 'Razorpay Order ID', type: 'text'  },
  { key: 'paymentMethod',   label: 'Payment Method',    type: 'text'  },
  { key: 'referenceNumber', label: 'Reference Number',  type: 'text'  },
  { key: 'refundStatus',    label: 'Refund Status',     type: 'text'  },
  { key: 'refundAmount',    label: 'Refund Amount',     type: 'money' },
  { key: 'refundId',        label: 'Refund ID',         type: 'text'  },
  { key: 'refundedAt',      label: 'Refunded At',       type: 'text'  },
  // Check-in
  { key: 'checkedIn',       label: 'Checked In',      type: 'text' },
  { key: 'checkedInAt',     label: 'Check-in Time',   type: 'text' },
  { key: 'checkedInBy',     label: 'Checked-in By',   type: 'text' },
  { key: 'checkedInSource', label: 'Check-in Source', type: 'text' },
  // Communication
  { key: 'emailStatus',           label: 'Email Status',           type: 'text' },
  { key: 'emailSentAt',           label: 'Email Sent At',          type: 'text' },
  { key: 'emailFailureReason',    label: 'Email Failure Reason',   type: 'text' },
  { key: 'whatsappStatus',        label: 'WhatsApp Status',        type: 'text' },
  { key: 'whatsappSentAt',        label: 'WhatsApp Sent At',       type: 'text' },
  { key: 'whatsappMessageId',     label: 'WhatsApp Message ID',    type: 'text' },
  { key: 'whatsappFailureReason', label: 'WhatsApp Failure Reason', type: 'text' },
  // Sports / exhibition — populated only for those event types, blank otherwise.
  { key: 'bibNumber',        label: 'Bib Number',        type: 'text' },
  { key: 'bibCategory',      label: 'Bib Category',      type: 'text' },
  { key: 'waiverAcceptedAt', label: 'Waiver Accepted At', type: 'text' },
  { key: 'companyName',      label: 'Company Name',      type: 'text' },
  { key: 'designation',      label: 'Designation',       type: 'text' },
  { key: 'website',          label: 'Company Website',   type: 'text' },
  { key: 'industry',         label: 'Industry',          type: 'text' },
  // Metadata
  { key: 'uid',       label: 'Attendee UID', type: 'text' },
  { key: 'updatedAt', label: 'Updated At',   type: 'text' },
]

/**
 * The canonical column list: fixed columns then EVERY custom registration-form field.
 *
 * Custom fields are derived from the event's own form definition, so a question added
 * next season appears in the export with no code change — replacing the previous
 * hardcoded regex probes for t-shirt / emergency contact / waiver, which silently
 * dropped every other answer the organiser had collected.
 *
 * Ordering is deterministic (fieldId ascending) rather than object-key order, so two
 * exports of the same event always produce identical columns — object key order is a
 * property of how Firestore happened to serialise the map, not of the form.
 */
export function buildRegistrationExportColumns(
  fieldLabels: Record<string, string>,
): ReportColumn[] {
  const custom = Object.keys(fieldLabels).sort().map<ReportColumn>(id => ({
    key:   CUSTOM_FIELD_PREFIX + id,
    label: fieldLabels[id] || id,
    type:  'text',
  }))
  return [...FIXED_COLUMNS, ...custom]
}

// ─── Value helpers ────────────────────────────────────────────────────────────

/** Firestore Timestamp | Date | ISO string → ISO string, or null. Never throws. */
function toISO(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  const t = v as { toDate?: () => Date }
  if (typeof t.toDate === 'function') {
    try { return t.toDate().toISOString() } catch { return null }
  }
  return null
}

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v)

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** A form answer flattened for one cell: arrays (checkbox groups) join with ", ". */
function formValue(v: unknown): ReportCell {
  if (v === null || v === undefined || v === '') return null
  if (Array.isArray(v)) return v.map(x => String(x)).join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}


/**
 * One raw Firestore registration → one canonical export row.
 *
 * Takes the RAW document (not the typed shape) because the export streams straight from
 * Firestore snapshots, and because a legacy record may be missing anything. Every field
 * degrades to null rather than throwing: a malformed row must never abort a 40k-row export.
 */
export function buildRegistrationExportRow(
  raw: Record<string, unknown>,
  ctx: RegistrationExportContext,
): ReportRow {
  const attendee = (raw.attendee as Record<string, unknown> | undefined) ?? {}
  const ticket   = (raw.ticket   as Record<string, unknown> | undefined) ?? {}
  const form     = (attendee.formResponses as Record<string, unknown> | undefined) ?? {}
  const sessions = raw.selectedSessions

  const row: ReportRow = {
    registrationId: str(raw.id),
    // ticketId is documented as equal to the registration id; fall back to it for
    // pre-ticket-field records rather than emitting a blank column.
    ticketId:   str(ticket.ticketId) ?? str(raw.id),
    ticketCode: str(raw.ticketCode),
    name:       str(attendee.name),
    email:      str(attendee.email),
    phone:      str(attendee.phone),

    eventId:          str(ctx.eventId),
    eventSlug:        str(raw.eventSlug) ?? str(ctx.eventSlug),
    eventName:        str(raw.eventName),
    passName:         str(raw.passName),
    selectedSessions: Array.isArray(sessions) ? sessions.map(String).join(', ') || null : null,
    registeredAt:     toISO(raw.registeredAt),
    status:           str(raw.status),
    // Absent ⇒ 'online': pre-Phase-C records predate the field entirely.
    registrationSource: str(raw.registrationSource) ?? 'online',

    paymentStatus:   str(raw.paymentStatus),
    amount:          num(raw.amount),
    originalAmount:  num(raw.originalAmount),
    discountAmount:  num(raw.discountAmount),
    couponCode:      str(raw.couponCode),
    paymentId:       str(raw.paymentId),
    razorpayOrderId: str(raw.razorpayOrderId),
    paymentMethod:   str(raw.paymentMethod),
    referenceNumber: str(raw.referenceNumber),
    refundStatus:    refundLabel(raw as { paymentStatus?: string | null; refundId?: string | null }),
    refundAmount:    num(raw.refundAmount),
    refundId:        str(raw.refundId),
    refundedAt:      toISO(raw.refundedAt),

    checkedIn:       raw.checkedIn ? 'Yes' : 'No',
    checkedInAt:     toISO(raw.checkedInAt),
    checkedInBy:     str(raw.checkedInBy),
    checkedInSource: str(raw.checkedInSource),

    emailStatus:           str(raw.emailStatus),
    emailSentAt:           toISO(raw.emailSentAt),
    emailFailureReason:    str(raw.emailFailureReason),
    whatsappStatus:        str(raw.whatsappStatus),
    whatsappSentAt:        toISO(raw.whatsappSentAt),
    whatsappMessageId:     str(raw.whatsappMessageId),
    whatsappFailureReason: str(raw.whatsappFailureReason),

    bibNumber:        str(raw.bibNumber),
    bibCategory:      str(raw.bibCategory),
    waiverAcceptedAt: toISO(raw.waiverAcceptedAt),
    companyName:      str(raw.companyName),
    designation:      str(raw.designation),
    website:          str(raw.website),
    industry:         str(raw.industry),

    uid:       str(raw.uid),
    updatedAt: toISO(raw.updatedAt),
  }

  // Every custom answer the organiser's form defines — driven by the form, not by
  // whatever keys this particular response happens to contain, so the column set is
  // identical for every row.
  for (const fieldId of Object.keys(ctx.fieldLabels)) {
    row[CUSTOM_FIELD_PREFIX + fieldId] = formValue(form[fieldId])
  }

  return row
}

// ─── Cell serialization ───────────────────────────────────────────────────────

/**
 * One cell → the plain value both exporters write.
 *
 * CSV and XLSX MUST agree: a reconciliation that disagrees depending on which button the
 * operator pressed is worse than no export. Money converts paise → rupees (2dp) so the
 * figure means the same in both, and an absent value stays BLANK rather than becoming
 * "₹0.00" — the finance-report convention, which would here assert a zero discount or a
 * zero refund that never happened.
 */
export function exportCellValue(value: ReportCell, type: ReportColumn['type']): string | number {
  if (value === null || value === undefined || value === '') return ''
  if (type === 'money') {
    const paise = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(paise) ? Math.round(paise) / 100 : ''
  }
  if (type === 'number') return typeof value === 'number' ? value : String(value)
  return String(value)
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Does this registration match a free-text query?
 *
 * Firestore cannot do substring search, so the export applies this in-stream over rows
 * it is already reading — which makes `q` genuinely affect the exported set instead of
 * being silently ignored (the previous behaviour: an operator searching "Priya" and
 * hitting Export got the whole event).
 *
 * Names/emails/phones match on SUBSTRING, mirroring the table's client-side filter.
 * Identifiers (ticket code, registration id, payment id, order id) also match on
 * substring so a partially pasted id still finds its row; they are opaque and
 * high-entropy, so a substring hit is not ambiguous in practice.
 */
export function registrationMatchesQuery(
  raw: Record<string, unknown>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const attendee = (raw.attendee as Record<string, unknown> | undefined) ?? {}
  const haystack = [
    attendee.name, attendee.email, attendee.phone,
    raw.ticketCode, raw.id, raw.paymentId, raw.razorpayOrderId,
  ]
  for (const v of haystack) {
    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
  }
  return false
}
