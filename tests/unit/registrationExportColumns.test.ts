// RD-REGISTRATIONS-DATA-AND-EXPORT — the canonical registration export.
//
// This module is the single definition both exporters consume, so these tests are what
// stop the two "Export CSV" buttons drifting apart again. They also pin the specific
// data-loss defects the audit found:
//
//   • Payment ID / Order ID were persisted but never exported (the whole point)
//   • money was absent from the server export entirely
//   • custom form answers were dropped unless the label matched one of four regexes
//   • `q` did not affect the exported set
//
// Pure module — no Firebase, no route, runs in the `node` environment.

import { describe, it, expect } from 'vitest'
import {
  buildRegistrationExportColumns,
  buildRegistrationExportRow,
  registrationMatchesQuery,
  exportCellValue,
  CUSTOM_FIELD_PREFIX,
  type RegistrationExportContext,
} from '@/lib/registrations/exportColumns'

const FIELD_LABELS = {
  f_tshirt:    'T-Shirt Size',
  f_emergency: 'Emergency Contact Name',
  f_diet:      'Dietary Preference',        // ← would have been DROPPED by the old regexes
  f_club:      'Running Club',              // ← would have been DROPPED by the old regexes
}

const CTX: RegistrationExportContext = {
  eventId:   'draft-abc123',
  eventSlug: 'noyyal-marathon-2026',
  fieldLabels: FIELD_LABELS,
}

/** A fully-populated PAID registration, using the real persisted field names. */
const PAID = {
  id:            'reg-uuid-1',
  eventSlug:     'noyyal-marathon-2026',
  eventName:     'Noyyal Marathon 2026',
  passId:        'p1',
  passName:      '42K Full Marathon',
  organizerUid:  'org-1',
  attendee: {
    name:  'Arun Prakash',
    email: 'arun@example.test',
    phone: '+919812345678',
    formResponses: {
      f_tshirt:    'L',
      f_emergency: 'Meena',
      f_diet:      'Vegetarian',
      f_club:      ['Kovai Runners', 'Trail Club'],
    },
  },
  status:          'confirmed',
  paymentStatus:   'paid',
  amount:          149000,          // paise
  originalAmount:  199000,
  discountAmount:  50000,
  couponCode:      'EARLYBIRD',
  paymentId:       'pay_QxKf82hAsdLm01',
  razorpayOrderId: 'order_QxKf7wVv11Aa22',
  ticketCode:      'NYM-4K72-QH19',
  ticket:          { ticketId: 'reg-uuid-1', qrValue: 'RD:x', qrGeneratedAt: null },
  checkedIn:       true,
  checkedInAt:     { toDate: () => new Date('2026-09-20T05:40:00.000Z') },
  checkedInBy:     'operator-9',
  checkedInSource: 'qr',
  emailStatus:     'sent',
  emailSentAt:     { toDate: () => new Date('2026-08-01T10:00:00.000Z') },
  registeredAt:    { toDate: () => new Date('2026-08-01T09:59:00.000Z') },
  updatedAt:       { toDate: () => new Date('2026-08-02T09:00:00.000Z') },
  uid:             'attendee-uid-7',
  selectedSessions: ['s1', 's2'],
} as Record<string, unknown>

/** A FREE registration — no Razorpay identifiers exist at all. */
const FREE = {
  id:            'reg-uuid-2',
  eventSlug:     'noyyal-marathon-2026',
  eventName:     'Noyyal Marathon 2026',
  passName:      'Volunteer',
  attendee:      { name: 'Priya R', email: 'priya@example.test' },
  status:        'confirmed',
  paymentStatus: 'not_required',
  amount:        0,
  ticketCode:    'NYM-0001-AAAA',
  registeredAt:  { toDate: () => new Date('2026-08-03T09:00:00.000Z') },
} as Record<string, unknown>

const byKey = (cols: ReturnType<typeof buildRegistrationExportColumns>) =>
  Object.fromEntries(cols.map(c => [c.key, c]))

// ─── Columns ──────────────────────────────────────────────────────────────────

describe('canonical columns', () => {
  const cols = buildRegistrationExportColumns(FIELD_LABELS)
  const m = byKey(cols)

  it('carries the payment identifiers that were previously exported nowhere', () => {
    expect(m.paymentId?.label).toBe('Payment ID')
    expect(m.razorpayOrderId?.label).toBe('Razorpay Order ID')
  })

  it('carries the money block the server export had NO column for', () => {
    for (const k of ['amount', 'originalAmount', 'discountAmount', 'refundAmount']) {
      expect(m[k], `missing money column: ${k}`).toBeDefined()
      expect(m[k].type).toBe('money')
    }
    expect(m.couponCode).toBeDefined()
  })

  it('carries refund, check-in attribution and communication columns', () => {
    for (const k of [
      'refundStatus', 'refundId', 'refundedAt',
      'checkedInBy', 'checkedInSource',
      'emailStatus', 'emailSentAt', 'emailFailureReason',
    ]) expect(m[k], `missing column: ${k}`).toBeDefined()
  })

  it('carries identity + event columns', () => {
    for (const k of ['registrationId', 'ticketId', 'ticketCode', 'eventId', 'eventName', 'selectedSessions']) {
      expect(m[k], `missing column: ${k}`).toBeDefined()
    }
  })

  it('includes EVERY custom form field, not four hardcoded patterns', () => {
    // The old export probed for /t.?shirt/i, emergency contact and /sports waiver/i only.
    // "Dietary Preference" and "Running Club" were collected and silently discarded.
    expect(m[`${CUSTOM_FIELD_PREFIX}f_diet`]?.label).toBe('Dietary Preference')
    expect(m[`${CUSTOM_FIELD_PREFIX}f_club`]?.label).toBe('Running Club')
  })

  it('a NEW form field appears with no code change', () => {
    const withNew = buildRegistrationExportColumns({ ...FIELD_LABELS, f_new: 'Bus Pickup Point' })
    expect(byKey(withNew)[`${CUSTOM_FIELD_PREFIX}f_new`]?.label).toBe('Bus Pickup Point')
  })

  it('orders custom fields deterministically regardless of key insertion order', () => {
    const a = buildRegistrationExportColumns({ b_x: 'X', a_y: 'Y' }).map(c => c.key)
    const b = buildRegistrationExportColumns({ a_y: 'Y', b_x: 'X' }).map(c => c.key)
    expect(a).toEqual(b)
  })

  it('namespaces custom keys so a form question cannot shadow a fixed column', () => {
    const cols2 = buildRegistrationExportColumns({ email: 'Alternate Email' })
    const emailCols = cols2.filter(c => c.key === 'email')
    expect(emailCols).toHaveLength(1)                       // the fixed one survives
    expect(byKey(cols2)[`${CUSTOM_FIELD_PREFIX}email`]?.label).toBe('Alternate Email')
  })
})

// ─── Rows ─────────────────────────────────────────────────────────────────────

describe('paid registration row', () => {
  const row = buildRegistrationExportRow(PAID, CTX)

  it('exports the Razorpay identifiers verbatim', () => {
    expect(row.paymentId).toBe('pay_QxKf82hAsdLm01')
    expect(row.razorpayOrderId).toBe('order_QxKf7wVv11Aa22')
  })

  it('exports money as PAISE so the serializer owns the rupee conversion', () => {
    expect(row.amount).toBe(149000)
    expect(row.originalAmount).toBe(199000)
    expect(row.discountAmount).toBe(50000)
    expect(row.couponCode).toBe('EARLYBIRD')
  })

  it('resolves ticket id, event id and sessions', () => {
    expect(row.registrationId).toBe('reg-uuid-1')
    expect(row.ticketId).toBe('reg-uuid-1')
    expect(row.eventId).toBe('draft-abc123')
    expect(row.selectedSessions).toBe('s1, s2')
  })

  it('converts Firestore Timestamps to full ISO strings, preserving the TIME', () => {
    // fmtDate would render "20 Sep 2026" and lose the check-in time entirely.
    expect(row.checkedInAt).toBe('2026-09-20T05:40:00.000Z')
    expect(row.registeredAt).toBe('2026-08-01T09:59:00.000Z')
    expect(row.emailSentAt).toBe('2026-08-01T10:00:00.000Z')
  })

  it('exports check-in attribution and communication state', () => {
    expect(row.checkedIn).toBe('Yes')
    expect(row.checkedInBy).toBe('operator-9')
    expect(row.checkedInSource).toBe('qr')
    expect(row.emailStatus).toBe('sent')
  })

  it('flattens every custom answer, joining multi-select values', () => {
    expect(row[`${CUSTOM_FIELD_PREFIX}f_diet`]).toBe('Vegetarian')
    expect(row[`${CUSTOM_FIELD_PREFIX}f_club`]).toBe('Kovai Runners, Trail Club')
  })

  it('defaults an absent source to online rather than blank', () => {
    expect(row.registrationSource).toBe('online')
  })
})

describe('free registration row', () => {
  const row = buildRegistrationExportRow(FREE, CTX)

  it('leaves payment identifiers null rather than inventing them', () => {
    expect(row.paymentId).toBeNull()
    expect(row.razorpayOrderId).toBeNull()
    expect(row.couponCode).toBeNull()
    expect(row.refundStatus).toBeNull()
  })

  it('still emits every custom column so the row is rectangular', () => {
    for (const id of Object.keys(FIELD_LABELS)) {
      expect(row).toHaveProperty(CUSTOM_FIELD_PREFIX + id)
    }
  })

  it('falls back to the registration id when no ticket sub-document exists', () => {
    expect(row.ticketId).toBe('reg-uuid-2')
  })
})

describe('refund status is derived consistently', () => {
  const of = (r: Record<string, unknown>) =>
    buildRegistrationExportRow({ ...FREE, ...r }, CTX).refundStatus

  it('reads refunded / refund_pending from the persisted payment status', () => {
    expect(of({ paymentStatus: 'refunded' })).toBe('Refunded')
    expect(of({ paymentStatus: 'refund_pending' })).toBe('Refund pending')
  })

  it('reports a refund id even when the status has not caught up', () => {
    expect(of({ paymentStatus: 'paid', refundId: 'rfnd_1' })).toBe('Refund issued')
  })

  it('is null when nothing was refunded', () => {
    expect(of({ paymentStatus: 'paid' })).toBeNull()
  })
})

describe('a malformed legacy record cannot abort an export', () => {
  it('degrades every field to null instead of throwing', () => {
    expect(() => buildRegistrationExportRow({}, CTX)).not.toThrow()
    const row = buildRegistrationExportRow({ attendee: null, registeredAt: 'nonsense' }, CTX)
    expect(row.name).toBeNull()
    expect(row.checkedIn).toBe('No')
  })
})

// ─── Cell serialization (shared by CSV and XLSX) ──────────────────────────────

describe('exportCellValue', () => {
  it('converts paise to a rupee NUMBER so Excel can sum it', () => {
    const v = exportCellValue(149000, 'money')
    expect(v).toBe(1490)
    expect(typeof v).toBe('number')
  })

  it('handles sub-rupee paise without floating drift', () => {
    expect(exportCellValue(149050, 'money')).toBe(1490.5)
  })

  it('leaves an absent money cell BLANK, never ₹0.00', () => {
    // A "₹0.00" discount asserts a coupon of zero value that never existed.
    expect(exportCellValue(null, 'money')).toBe('')
  })

  it('passes ISO timestamps through untouched', () => {
    expect(exportCellValue('2026-09-20T05:40:00.000Z', 'text')).toBe('2026-09-20T05:40:00.000Z')
  })

  it('preserves Unicode verbatim', () => {
    expect(exportCellValue('அருண் ₹1,490', 'text')).toBe('அருண் ₹1,490')
  })
})

// ─── Search ───────────────────────────────────────────────────────────────────

describe('registrationMatchesQuery — makes `q` affect the export', () => {
  it.each([
    ['name substring',   'arun'],
    ['email substring',  'example.test'],
    ['phone substring',  '98123'],
    ['ticket code',      'NYM-4K72-QH19'],
    ['registration id',  'reg-uuid-1'],
    ['payment id',       'pay_QxKf82hAsdLm01'],
    ['order id',         'order_QxKf7wVv11Aa22'],
  ])('matches on %s', (_label, q) => {
    expect(registrationMatchesQuery(PAID, q)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(registrationMatchesQuery(PAID, 'ARUN')).toBe(true)
    expect(registrationMatchesQuery(PAID, 'PAY_QXKF82HASDLM01')).toBe(true)
  })

  it('excludes a non-matching registration', () => {
    expect(registrationMatchesQuery(PAID, 'zzz-not-here')).toBe(false)
  })

  it('an empty query matches everything (no filter)', () => {
    expect(registrationMatchesQuery(PAID, '')).toBe(true)
    expect(registrationMatchesQuery(PAID, '   ')).toBe(true)
  })

  it('does not crash on a record with no attendee', () => {
    expect(registrationMatchesQuery({}, 'arun')).toBe(false)
  })
})
