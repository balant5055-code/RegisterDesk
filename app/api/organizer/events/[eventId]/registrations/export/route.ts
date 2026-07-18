// GET /api/organizer/events/[eventId]/registrations/export
//
// Returns all confirmed registrations as a CSV file.
// Columns: ID, Name, Email, Phone, Pass, Status, Registered At,
//          Bib Number, Bib Category, T-Shirt Size,
//          Emergency Contact Name, Emergency Contact Phone,
//          Waiver Accepted (yes/no), Checked In

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspaceDownload } from '@/lib/team/workspace'
import { csvCell as csvEscape }        from '@/lib/utils/csv'

// GA-5 S2: streamed export — CSV rows are generated page-by-page and flushed to the
// response, so memory stays bounded to one batch regardless of event size (100k+).
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

function toISO(ts: unknown): string {
  if (!ts) return ''
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return ''
}

// Searches formResponses for a value by matching known label patterns
function findFormValue(
  formResponses: Record<string, unknown> | undefined,
  fieldLabels:   Record<string, string>,
  labelPattern:  RegExp,
): string {
  if (!formResponses) return ''
  for (const [fieldId, label] of Object.entries(fieldLabels)) {
    if (labelPattern.test(label)) {
      const val = formResponses[fieldId]
      if (Array.isArray(val)) return val.join(', ')
      return String(val ?? '')
    }
  }
  return ''
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<Response> {
  // ── Auth — canonical download guard (header or ?token= for <a download>) ──
  const authz = await authorizeWorkspaceDownload(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // ── Resolve event slug ─────────────────────────────────────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const d       = draftSnap.data() as Record<string, unknown>
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!slug) return NextResponse.json({ error: 'Event not published' }, { status: 400 })

  // ── Build field label map ──────────────────────────────────────────────────
  const rawForm = d.registrationForm as {
    sections?: Array<{ fields: Array<{ id: string; label: string }> }>
  } | null
  const fieldLabels: Record<string, string> = {}
  for (const section of rawForm?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.id && field.label) fieldLabels[field.id] = field.label
    }
  }

  // ── Column set (unchanged) ─────────────────────────────────────────────────
  const COLS = [
    'Registration ID', 'Full Name', 'Email', 'Phone', 'Pass', 'Status', 'Payment Status',
    'Registered At', 'Bib Number', 'Bib Category',
    'T-Shirt Size', 'Emergency Contact Name', 'Emergency Contact Phone',
    'Waiver Accepted',
    'Company Name', 'Designation', 'Company Website', 'Industry', 'Pass Type',
    'Ticket Code', 'Source', 'Payment Method', 'Reference Number', 'Checked In', 'Checked In At',
  ]

  // Same per-registration row shape as before, extracted so it can be streamed.
  const buildRow = (doc: FirebaseFirestore.QueryDocumentSnapshot): string => {
    const r        = doc.data() as Record<string, unknown>
    const attendee = r.attendee as Record<string, unknown> | undefined
    const form     = attendee?.formResponses as Record<string, unknown> | undefined

    const tshirt   = findFormValue(form, fieldLabels, /t.?shirt/i)
    const ecName   = findFormValue(form, fieldLabels, /emergency contact name/i)
    const ecPhone  = findFormValue(form, fieldLabels, /emergency contact (number|phone)/i)
    const waiver   = findFormValue(form, fieldLabels, /sports waiver/i)
    const waiverAt = (r.waiverAcceptedAt as string | null) ?? ''

    const companyName = (r.companyName as string | null) ?? findFormValue(form, fieldLabels, /company name/i)
    const designation = (r.designation as string | null) ?? findFormValue(form, fieldLabels, /^designation$/i)
    const website     = (r.website     as string | null) ?? findFormValue(form, fieldLabels, /company website|^website$/i)
    const industry    = (r.industry    as string | null) ?? findFormValue(form, fieldLabels, /^industry$/i)
    const passType    = (r.passType    as string | null) ?? String(r.passName ?? '')

    return [
      doc.id,
      String(attendee?.name  ?? ''),
      String(attendee?.email ?? ''),
      String(attendee?.phone ?? ''),
      String(r.passName ?? ''),
      String(r.status   ?? ''),
      String(r.paymentStatus ?? ''),
      toISO(r.registeredAt),
      String((r.bibNumber   as string | null) ?? ''),
      String((r.bibCategory as string | null) ?? ''),
      tshirt, ecName, ecPhone,
      waiver ? 'Yes' : (waiverAt ? 'Yes' : 'No'),
      companyName, designation, website, industry, passType,
      String(r.ticketCode ?? ''),
      String(r.registrationSource ?? 'online'),
      String(r.paymentMethod ?? ''),
      String(r.referenceNumber ?? ''),
      (r.checkedIn as boolean) ? 'Yes' : 'No',
      toISO(r.checkedInAt),
    ].map(csvEscape).join(',')
  }

  // ── Stream the CSV page-by-page (bounded memory; no whole-collection load) ──
  const BATCH_SIZE = 1_000
  const baseQuery = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .orderBy('registeredAt', 'asc')

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Lead with a UTF-8 BOM so Excel renders non-ASCII names (Tamil/Hindi/₹)
        // correctly — parity with tableToCsv (lib/reports/csv.ts).
        controller.enqueue(encoder.encode('﻿' + COLS.map(csvEscape).join(',')))
        let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
        for (;;) {
          const q    = cursor ? baseQuery.startAfter(cursor).limit(BATCH_SIZE) : baseQuery.limit(BATCH_SIZE)
          const snap = await q.get()
          if (snap.empty) break
          let chunk = ''
          for (const doc of snap.docs) chunk += `\r\n${buildRow(doc)}`
          controller.enqueue(encoder.encode(chunk))
          if (snap.docs.length < BATCH_SIZE) break
          cursor = snap.docs[snap.docs.length - 1]
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  const filename = `${slug}-registrations-${new Date().toISOString().slice(0, 10)}.csv`
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
    },
  })
}
