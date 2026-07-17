// Public certificate verification — server-only.
// Resolves a certificateId to a verification state and a privacy-filtered view.
//
// Reads the new `certificates` collection first, then falls back to the legacy
// `certificateRecords` (MVP) for backward compatibility. Honors the organizer's
// certificateSettings.verification flags (enabled + per-field visibility).
//
// Only ever exposes: certificate id, participant name, event name, certificate
// type, issue date, issuer. It NEVER reads or returns email, phone, payment, or
// registration form answers.

import { getCertificate, getCertificateById, getSettings } from './firestore'
import { isValidCertificateId }   from './id'
import { CERTIFICATE_TYPE_LABELS } from './constants'
import { defaultCertificateSettings } from './types'
import type { CertificateType } from './types'

export type VerificationState = 'valid' | 'revoked' | 'not_found' | 'disabled'

export interface VerifiedCertificate {
  certificateId:         string
  participantName?:      string
  eventName?:            string
  certificateType?:      CertificateType
  certificateTypeLabel?: string
  issueDateIso?:         string | null
  issuer?:               string
  revokedAtIso?:         string | null
  revokeReason?:         string | null
}

export interface VerificationResult {
  state:         VerificationState
  certificateId: string
  certificate?:  VerifiedCertificate
}

function toIso(v: unknown): string | null {
  if (!v) return null
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString()
  }
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  return null
}

/** Effective verification config for an event (defaults when none configured). */
async function verificationConfig(eventId: string) {
  const settings = await getSettings(eventId)
  return settings?.verification ?? defaultCertificateSettings().verification
}

/**
 * Verifies a certificate by its public id and returns a privacy-filtered result.
 */
export async function verifyCertificate(certificateId: string): Promise<VerificationResult> {
  if (!isValidCertificateId(certificateId)) {
    return { state: 'not_found', certificateId }
  }

  // ── New `certificates` collection ───────────────────────────────────────────
  const cert = await getCertificate(certificateId)
  if (cert) {
    const v = await verificationConfig(cert.eventId)
    if (!v.enabled) return { state: 'disabled', certificateId }

    const revoked = cert.status === 'revoked'
    const issuer  =
      (typeof cert.data?.organizerName === 'string' && cert.data.organizerName) || 'RegisterDesk'

    return {
      state:         revoked ? 'revoked' : 'valid',
      certificateId: cert.certificateId,
      certificate: {
        certificateId:        cert.certificateId,
        participantName:      v.showParticipantName ? cert.attendeeName : undefined,
        eventName:            v.showEventName       ? cert.eventName    : undefined,
        certificateType:      v.showCertificateType ? cert.certificateType : undefined,
        certificateTypeLabel: v.showCertificateType ? CERTIFICATE_TYPE_LABELS[cert.certificateType] : undefined,
        issueDateIso:         v.showIssueDate ? toIso(cert.generatedAt) : undefined,
        issuer,
        revokedAtIso:         revoked ? toIso(cert.revokedAt) : undefined,
        revokeReason:         revoked ? cert.revokeReason : undefined,
      },
    }
  }

  // ── Legacy `certificateRecords` (MVP) fallback ──────────────────────────────
  const legacy = await getCertificateById(certificateId)
  if (legacy) {
    const v = await verificationConfig(legacy.eventId)
    if (!v.enabled) return { state: 'disabled', certificateId }

    return {
      state:         'valid',                 // MVP records have no revoke concept
      certificateId: legacy.certificateId,
      certificate: {
        certificateId:   legacy.certificateId,
        participantName: v.showParticipantName ? legacy.attendeeName : undefined,
        eventName:       v.showEventName       ? legacy.eventName    : undefined,
        // Legacy records carry no per-record certificate type.
        issueDateIso:    v.showIssueDate ? toIso(legacy.issuedAt) : undefined,
        issuer:          'RegisterDesk',
      },
    }
  }

  return { state: 'not_found', certificateId }
}
