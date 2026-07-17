// GET /api/admin/licenses/export — Admin License Console CSV export.
// Admin-only. Streams every license (respecting the current search/status filters)
// as CSV. Capped defensively; pages through the same list service.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { listLicenses } from '@/lib/admin/licenseAdminService'
import type { LicenseRow } from '@/lib/admin/licenseAdminTypes'
import { csvCell as csvEscape } from '@/lib/utils/csv'

const MAX_PAGES = 50   // 50 × 100 = up to 5,000 rows

const rupees = (paise: number): string => (paise / 100).toFixed(2)
const fmtDate = (iso: string | null): string => (iso ? iso.slice(0, 10) : '')

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp     = req.nextUrl.searchParams
  const search = sp.get('search') ?? ''
  const status = sp.get('status') ?? ''

  const rows: LicenseRow[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: { items: LicenseRow[]; nextCursor: string | null } =
        await listLicenses({ pageSize: 100, cursor, search, status })
      rows.push(...res.items)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
  } catch (e) {
    console.error('[admin/licenses/export] failed', e)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }

  const header = [
    'Event ID', 'Event', 'Organizer', 'Organization', 'Email', 'Tier', 'Status',
    'Payment', 'Source', 'Price Paid (INR)', 'Effective Price (INR)',
    'Registration Limit', 'Used', 'Purchase Date',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.eventId, r.eventName, r.organizerName, r.organizationName, r.organizerEmail,
      r.tier, r.displayStatus, r.paymentStatus, r.source,
      rupees(r.amountPaidPaise), rupees(r.effectivePricePaise),
      r.registrationLimit === null ? 'Unlimited' : String(r.registrationLimit),
      String(r.used), fmtDate(r.purchaseDate),
    ].map(v => csvEscape(String(v))).join(','))
  }
  // UTF-8 BOM so Excel renders unicode correctly.
  const csv = '﻿' + lines.join('\r\n') + '\r\n'

  return new NextResponse(csv, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="event-licenses.csv"',
      'Cache-Control':       'no-store',
    },
  })
}
