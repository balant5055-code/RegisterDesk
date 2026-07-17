// GET /api/verify/certificate/[certificateId]
//
// Public JSON verification endpoint. No authentication required.
// Called by the /verify/certificate/[certificateId] page.
//
// Privacy: returns only non-sensitive fields (id, participant, event, type,
// issue date, issuer). Never email/phone/payment/registration answers.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCertificate }         from '@/lib/certificates/verify'
import type { VerificationState }    from '@/lib/certificates/verify'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'

type Params = { params: Promise<{ certificateId: string }> }

export interface CertificateVerifyResponse {
  valid:           boolean            // true only when state === 'valid'
  state:           VerificationState  // valid | revoked | not_found | disabled
  certificateId:   string
  participantName?: string
  eventName?:      string
  certificateType?: string            // human label, e.g. "Participation"
  issueDate?:      string             // ISO string
  issuer?:         string
  revokedAt?:      string             // ISO string (revoked state)
  revokeReason?:   string             // human-readable (revoked state)
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { certificateId } = await params

  // Rate limit per IP to prevent certificateId enumeration / scraping of the
  // public verification endpoint (P7.1). 30 lookups / minute is ample for real
  // verifiers while throttling brute-force discovery of valid certificates.
  const rl = checkRateLimit(getClientIp(req), 'cert-verify', 30, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many verification requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  const result = await verifyCertificate(certificateId)
  const c = result.certificate

  return NextResponse.json({
    valid:           result.state === 'valid',
    state:           result.state,
    certificateId:   result.certificateId,
    participantName: c?.participantName,
    eventName:       c?.eventName,
    certificateType: c?.certificateTypeLabel,
    issueDate:       c?.issueDateIso ?? undefined,
    issuer:          c?.issuer,
    revokedAt:       c?.revokedAtIso ?? undefined,
    revokeReason:    c?.revokeReason ?? undefined,
  } satisfies CertificateVerifyResponse)
}
