// GET /api/registrations/gate?slug={slug}&passId={passId}
//
// Public endpoint — no auth required.
// Used by the registration form to validate eligibility before rendering
// the attendee form, and by the public event page to surface real-time
// availability to prospective registrants.
//
// Returns RegistrationGateResult as JSON.

import { NextRequest, NextResponse } from 'next/server'
import { checkRegistrationGate, GATE_REASON_LABELS } from '@/lib/registrations/gate'
import type { RegistrationGateResult } from '@/lib/registrations/types'

interface GateApiResponse extends RegistrationGateResult {
  message?: string   // human-readable label for the reason code
}

export async function GET(req: NextRequest): Promise<NextResponse<GateApiResponse>> {
  const { searchParams } = req.nextUrl

  const slug   = searchParams.get('slug')?.trim()  ?? ''
  const passId = searchParams.get('passId')?.trim() ?? ''

  if (!slug || !passId) {
    return NextResponse.json(
      { allowed: false, reason: 'EVENT_NOT_FOUND', message: 'slug and passId are required' },
      { status: 400 },
    )
  }

  try {
    const result = await checkRegistrationGate(slug, passId)

    const response: GateApiResponse = {
      ...result,
      message: result.reason ? GATE_REASON_LABELS[result.reason] : undefined,
    }

    // 200 for both allowed and blocked — the consumer decides what to do.
    // Use 4xx only for malformed requests, not business-rule blocks.
    return NextResponse.json(response, { status: 200 })
  } catch (err) {
    console.error('[gate] Unexpected error:', err)
    return NextResponse.json(
      { allowed: false, message: 'An unexpected error occurred. Please try again.' },
      { status: 500 },
    )
  }
}
