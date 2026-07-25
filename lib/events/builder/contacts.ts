// RD-PRODUCT-01G — Event Builder · approved-contact list utilities.
//
// Extracted VERBATIM from the Event Builder monolith (app/(dashboard)/dashboard/events/
// new/page.tsx) as part of the maintainability refactor. Pure/self-contained CSV import
// helpers for the private-event "approved contact list" — no component scope, no side
// effects beyond id/timestamp generation. Behavior is byte-for-byte identical to the
// original inline definitions; this move only relocates them so they can be unit-tested
// and reused. NOTHING about the parsing logic changed.

export interface ApprovedContact {
  id:           string
  name:         string
  mobileNumber: string
  email:        string
  memberId:     string
  addedAt:      string  // ISO timestamp
}

/** A ready-to-download CSV template for the approved-contact upload. */
export const CONTACT_TEMPLATE_CSV =
  'Name,Mobile Number,Email,Member ID\nJane Doe,+919876543210,jane@example.com,MEM001\n'

/** Short random id for a locally-added contact row. */
export function generateContactId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Parse raw CSV text into header-keyed rows (lower-cased headers). Handles quoted values
 * containing commas. Returns [] when there is no data row. Pure.
 */
export function parseCsvText(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase())
  return lines.slice(1).map(line => {
    const values: string[] = []
    let cur = ''
    let inQ = false
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { values.push(cur); cur = '' }
      else { cur += ch }
    }
    values.push(cur)
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? '').replace(/^"|"$/g, '').trim()]))
  })
}

/**
 * Map parsed CSV rows to ApprovedContacts, tolerating common header aliases for the
 * mobile/member columns. Drops rows without a mobile number. Each gets a fresh id +
 * timestamp. Behavior identical to the original inline helper.
 */
export function parseContactsFromRows(rows: Record<string, string>[]): ApprovedContact[] {
  const now = new Date().toISOString()
  return rows
    .map(r => ({
      id:           generateContactId(),
      addedAt:      now,
      name:         (r['name']          ?? '').trim(),
      mobileNumber: (r['mobile number'] ?? r['mobile'] ?? r['phone number'] ?? r['phone'] ?? '').trim(),
      email:        (r['email']         ?? '').trim(),
      memberId:     (r['member id']     ?? r['member_id'] ?? r['memberid'] ?? '').trim(),
    }))
    .filter(c => c.mobileNumber.length > 0)
}
