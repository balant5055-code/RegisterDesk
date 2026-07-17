// PATCH /api/organizer/registrations/[registrationId]
//
// Lets the owning organizer correct attendee details (name / email / phone /
// form responses) after registration. Money, ticket, status, and identity
// fields are immutable here. Every edit is recorded in an immutable
// registrationAuditLogs document and protected by an optimistic updatedAt check.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { checkRateLimit }            from '@/lib/rateLimit'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { writeAuditEntry }           from '@/lib/firebase/firestore/registrations'
import {
  isValidEmail, normalizeEmail,
  isValidPhone, normalizePhone,
  isValidName,  normalizeName,
} from '@/lib/registrations/editValidation'
import type { RegistrationDocument } from '@/lib/registrations/types'

// Fields a client must never be able to mutate through this endpoint.
const FORBIDDEN_KEYS = [
  'id', 'registrationId', 'eventSlug', 'organizerUid', 'passId', 'passName',
  'status', 'paymentStatus', 'amount', 'originalAmount', 'discountAmount',
  'ticketCode', 'ticket', 'checkedIn', 'checkedInAt', 'checkedInBy',
  'createdAt', 'registeredAt', 'refundId', 'refundAmount', 'couponCode', 'uid',
]

export interface EditRegistrationResponse {
  success:       boolean
  error?:        string
  reason?:       string
  registration?: {
    attendee:  RegistrationDocument['attendee']
    updatedAt: string | null
  }
}

interface PatchBody {
  name?:             unknown
  email?:            unknown
  phone?:            unknown
  responses?:        unknown
  expectedUpdatedAt?: unknown
}

class EditConflictError extends Error {}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<EditRegistrationResponse>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const rl = checkRateLimit(uid, 'registration-edit', 60, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json({ success: false, error: 'Too many edits. Please slow down.' }, { status: 429 })
  }

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 2. Parse + reject forbidden fields ───────────────────────────────────
  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const raw = body as Record<string, unknown>
  const forbidden = FORBIDDEN_KEYS.filter(k => k in raw)
  if (forbidden.length > 0) {
    return NextResponse.json(
      { success: false, error: `These fields cannot be edited: ${forbidden.join(', ')}` },
      { status: 400 },
    )
  }

  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    return NextResponse.json({ success: false, error: 'expectedUpdatedAt is required' }, { status: 400 })
  }
  const expectedMs = Date.parse(body.expectedUpdatedAt)
  if (Number.isNaN(expectedMs)) {
    return NextResponse.json({ success: false, error: 'expectedUpdatedAt is invalid' }, { status: 400 })
  }

  // ── 3. Load + ownership ───────────────────────────────────────────────────
  const regRef  = adminDb.collection('registrations').doc(registrationId)
  const regSnap = await regRef.get()
  if (!regSnap.exists) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // ── 4. Validate + normalize the provided fields ───────────────────────────
  const cur = reg.attendee
  let newName  = cur.name
  let newEmail = cur.email
  let newPhone = cur.phone
  let newResponses = cur.formResponses ?? {}

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !isValidName(body.name)) {
      return NextResponse.json({ success: false, error: 'Invalid name' }, { status: 400 })
    }
    newName = normalizeName(body.name)
  }
  if (body.email !== undefined) {
    if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
      return NextResponse.json({ success: false, error: 'Invalid email address' }, { status: 400 })
    }
    newEmail = normalizeEmail(body.email)
  }
  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string' || (body.phone.trim() !== '' && !isValidPhone(body.phone))) {
      return NextResponse.json({ success: false, error: 'Invalid phone number' }, { status: 400 })
    }
    newPhone = body.phone.trim() === '' ? undefined : normalizePhone(body.phone)
  }
  if (body.responses !== undefined) {
    if (typeof body.responses !== 'object' || body.responses === null || Array.isArray(body.responses)) {
      return NextResponse.json({ success: false, error: 'Invalid responses' }, { status: 400 })
    }
    if (JSON.stringify(body.responses).length > 50_000) {
      return NextResponse.json({ success: false, error: 'Responses payload too large' }, { status: 400 })
    }
    newResponses = body.responses as Record<string, unknown>
  }

  // ── 5. Determine what actually changed ────────────────────────────────────
  const changedFields: string[] = []
  const before: Record<string, unknown> = {}
  const after:  Record<string, unknown> = {}

  if (newName !== cur.name)   { changedFields.push('name');  before.name = cur.name;  after.name = newName }
  if (newEmail !== cur.email) { changedFields.push('email'); before.email = cur.email; after.email = newEmail }
  if ((newPhone ?? '') !== (cur.phone ?? '')) { changedFields.push('phone'); before.phone = cur.phone ?? null; after.phone = newPhone ?? null }
  if (JSON.stringify(newResponses) !== JSON.stringify(cur.formResponses ?? {})) {
    changedFields.push('responses'); before.responses = cur.formResponses ?? {}; after.responses = newResponses
  }

  if (changedFields.length === 0) {
    return NextResponse.json({
      success: true,
      registration: { attendee: reg.attendee, updatedAt: tsToISO(reg.updatedAt) },
    })
  }

  // ── 6. Duplicate prevention (respect event rules) ─────────────────────────
  const event = await getEventBySlug(reg.eventSlug)
  const rules = (event?.registrationForm as { registrationRules?: { limitPerEmail?: boolean; limitPerMobile?: boolean } } | null)?.registrationRules

  if (changedFields.includes('email') && rules?.limitPerEmail) {
    const dup = await adminDb.collection('registrations')
      .where('eventSlug', '==', reg.eventSlug)
      .where('attendee.email', '==', newEmail)
      .limit(5).get()
    if (dup.docs.some(d => d.id !== registrationId && (d.data() as RegistrationDocument).status !== 'cancelled')) {
      return NextResponse.json(
        { success: false, reason: 'DUPLICATE_EMAIL', error: 'Another registration with this email already exists for this event.' },
        { status: 409 },
      )
    }
  }
  if (changedFields.includes('phone') && rules?.limitPerMobile) {
    if (!newPhone) {
      return NextResponse.json({ success: false, reason: 'PHONE_REQUIRED', error: 'A phone number is required for this event.' }, { status: 400 })
    }
    const dup = await adminDb.collection('registrations')
      .where('eventSlug', '==', reg.eventSlug)
      .where('attendee.phone', '==', newPhone)
      .limit(5).get()
    if (dup.docs.some(d => d.id !== registrationId && (d.data() as RegistrationDocument).status !== 'cancelled')) {
      return NextResponse.json(
        { success: false, reason: 'DUPLICATE_MOBILE', error: 'Another registration with this phone number already exists for this event.' },
        { status: 409 },
      )
    }
  }

  // ── 7. Apply atomically with optimistic concurrency + immutable audit ─────
  try {
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(regRef)
      if (!fresh.exists) throw new EditConflictError('NOT_FOUND')
      const f = fresh.data() as RegistrationDocument
      if (f.organizerUid !== uid) throw new EditConflictError('FORBIDDEN')

      // Optimistic check — reject if the row changed since the organizer loaded it.
      const storedMs = (f.updatedAt && typeof (f.updatedAt as { toMillis?: () => number }).toMillis === 'function')
        ? (f.updatedAt as { toMillis: () => number }).toMillis()
        : null
      if (storedMs !== null && storedMs !== expectedMs) throw new EditConflictError('CONFLICT')

      const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
      if (changedFields.includes('name'))      updates['attendee.name']  = newName
      if (changedFields.includes('email'))     updates['attendee.email'] = newEmail
      if (changedFields.includes('phone'))     updates['attendee.phone'] = newPhone ?? FieldValue.delete()
      if (changedFields.includes('responses')) updates['attendee.formResponses'] = newResponses
      tx.update(regRef, updates)

      // Immutable audit record — atomic with the edit (only changed fields).
      tx.set(adminDb.collection('registrationAuditLogs').doc(), {
        registrationId,
        eventSlug:    reg.eventSlug,
        organizerUid: uid,
        action:       'registration.updated',
        before,
        after,
        changedFields,
        createdAt:    FieldValue.serverTimestamp(),
      })
    })
  } catch (err) {
    if (err instanceof EditConflictError) {
      if (err.message === 'CONFLICT') {
        return NextResponse.json(
          { success: false, reason: 'CONFLICT', error: 'This registration was changed elsewhere. Please refresh and try again.' },
          { status: 409 },
        )
      }
      if (err.message === 'NOT_FOUND') return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
      if (err.message === 'FORBIDDEN') return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    console.error('[registrations/edit] transaction failed:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Could not save changes. Please try again.' }, { status: 500 })
  }

  // Timeline entry (best-effort) so the edit shows in the registration audit log.
  void writeAuditEntry(registrationId, 'updated', callerUid, 'organizer', uid).catch(() => {})

  // Re-read to return the resolved updatedAt for the next optimistic edit.
  const updatedSnap = await regRef.get()
  const updated     = updatedSnap.data() as RegistrationDocument
  return NextResponse.json({
    success: true,
    registration: { attendee: updated.attendee, updatedAt: tsToISO(updated.updatedAt) },
  })
}
