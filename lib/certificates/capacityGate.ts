// RD-CERT-CAPACITY-UX-01 · what the Issue & Bulk panel may offer, given the event's certificate capacity.
//
// Client-safe and pure. The server is the authority — generateCertificate reserves a unit in a
// transaction and refuses with 402 CERTIFICATE_CAPACITY_REQUIRED — this only stops the workspace
// from offering generation it already knows will be refused, and says why.
//
// Scope is deliberately narrow: only CREATING a new certificate uses capacity. Existing
// certificates — the Recipients list, emailing, downloading, regenerating, revoking, attendee
// download/lookup and public verification — are never gated here.

import type { CertificateCapacityStatus } from '@/app/api/organizer/events/[eventId]/certificates/stats/route'

export interface CertificateIssueGate {
  /** true ⇒ the generate controls are disabled. Only for a state the server has confirmed. */
  blocked: boolean
  tone:    'none' | 'info' | 'warning'
  message: string | null
  /** The existing License & Services purchase path, when the server supplied it. */
  href:    string | null
}

export const EXISTING_CERTIFICATES_NOTE =
  'Certificates already issued stay available to download, email and verify.'

/**
 * @param capacity `undefined` = still loading · `null` = the server could not read it (unknown).
 */
export function certificateIssueGate(capacity: CertificateCapacityStatus | null | undefined): CertificateIssueGate {
  if (capacity === undefined) return { blocked: false, tone: 'none', message: null, href: null }
  if (capacity === null) {
    // Unknown is NOT "available": say so, but don't block on a guess — the server still decides.
    return {
      blocked: false, tone: 'warning', href: null,
      message: 'Certificate capacity couldn’t be checked. A new certificate is generated only while this event has certificate capacity.',
    }
  }
  if (capacity.state === 'none') {
    return {
      blocked: true, tone: 'warning', href: capacity.manageHref,
      message: `This event has no certificate capacity, so new certificates can’t be generated. ${EXISTING_CERTIFICATES_NOTE}`,
    }
  }
  if (capacity.state === 'exhausted') {
    return {
      blocked: true, tone: 'warning', href: capacity.manageHref,
      message: `All ${capacity.purchased.toLocaleString('en-IN')} certificate${capacity.purchased === 1 ? '' : 's'} for this event ${capacity.purchased === 1 ? 'has' : 'have'} been used, so new certificates can’t be generated. ${EXISTING_CERTIFICATES_NOTE}`,
    }
  }
  return {
    blocked: false, tone: 'info', href: capacity.manageHref,
    message: `${capacity.available.toLocaleString('en-IN')} of ${capacity.purchased.toLocaleString('en-IN')} certificate${capacity.purchased === 1 ? '' : 's'} left for new certificates.`,
  }
}
