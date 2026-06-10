// GET /api/organizer/registrations
//
// Returns all registration records for the authenticated organizer across all
// events.  Stats are always computed over the full set; the caller filters
// client-side using the URL query param (?status=confirmed|cancelled|pending).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb, adminAuth }        from '@/lib/firebase/admin'
import type { RegistrationDocument } from '@/lib/registrations/types'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

export interface AllRegistrationsResponse {
  registrations: SerializedRegistration[]
  stats: {
    total:      number
    confirmed:  number
    cancelled:  number
    pending:    number
    waitlisted: number
  }
}

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  // Fetch all registrations for this organizer (max 300, newest-first)
  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .limit(300)
    .get()

  const registrations: SerializedRegistration[] = snap.docs
    .map(doc => {
      const data = doc.data() as RegistrationDocument
      return {
        ...data,
        registeredAt: toISO(data.registeredAt),
        updatedAt:    toISO(data.updatedAt),
        emailSentAt:  toISO(data.emailSentAt),
        checkedInAt:  toISO(data.checkedInAt),
      } as SerializedRegistration
    })
    .sort((a, b) => {
      const at = a.registeredAt ? new Date(a.registeredAt).getTime() : 0
      const bt = b.registeredAt ? new Date(b.registeredAt).getTime() : 0
      return bt - at
    })

  const stats = {
    total:      registrations.length,
    confirmed:  registrations.filter(r => r.status === 'confirmed').length,
    cancelled:  registrations.filter(r => r.status === 'cancelled').length,
    pending:    registrations.filter(r => r.status === 'pending').length,
    waitlisted: registrations.filter(r => r.status === 'waitlisted').length,
  }

  return NextResponse.json({ registrations, stats } satisfies AllRegistrationsResponse)
}
