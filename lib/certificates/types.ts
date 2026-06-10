// Certificate engine types.
// Safe to import from both client and server — no SDK dependencies.

export type CertificateType   = 'participation' | 'completion'
export type CertificateStatus = 'generated' | 'emailed'

/**
 * certificateTemplates/{eventId}
 *
 * One document per event. Stores organizer-configured certificate settings and
 * design. Written by the organizer via the Certificates tab.
 */
export interface CertificateTemplate {
  eventId:              string
  enabled:              boolean
  type:                 CertificateType      // participation | completion
  // Design
  title:                string               // "Certificate of Participation"
  subtitle:             string               // "This is to certify that"
  issuedBy:             string               // organization / event brand name
  signatoryName:        string
  signatoryDesignation: string
  logoUrl?:             string               // public URL for org logo image
  signatureUrl?:        string               // public URL for signature image
  backgroundUrl?:       string               // public URL for background image
  // Meta
  createdAt:            unknown              // Firestore Timestamp
  updatedAt:            unknown              // Firestore Timestamp
  createdBy:            string               // organizer uid
}

/**
 * certificateRecords/{certificateId}
 *
 * One document per generated certificate. The certificateId is the public
 * capability token used for verification and download.
 */
export interface CertificateRecord {
  certificateId:  string              // "RDC-2026-AB12CD"
  eventId:        string              // draftId (for organizer queries)
  eventSlug:      string
  registrationId: string
  organizerUid:   string              // enables per-organizer queries
  attendeeName:   string
  attendeeEmail:  string
  eventName:      string
  eventDate:      string              // human-readable, e.g. "15 June 2026"
  issuedAt:       unknown             // Firestore Timestamp
  status:         CertificateStatus
  downloadCount:  number
  emailedAt?:     unknown             // Firestore Timestamp
  emailStatus?:   'sent' | 'failed' | 'skipped'
}

/** Serialized for API responses (Timestamps → ISO strings). */
export interface SerializedCertificateRecord
  extends Omit<CertificateRecord, 'issuedAt' | 'emailedAt'> {
  issuedAt:   string
  emailedAt?: string | null
}

/** Audit actions tracked on certificate records. */
export type CertificateAuditAction = 'generated' | 'downloaded' | 'emailed'

/** Shape used to save / update a template from the organizer UI. */
export type CertificateTemplateInput = Omit<
  CertificateTemplate,
  'eventId' | 'createdAt' | 'updatedAt' | 'createdBy'
>

/** Default values for a new template. */
export function defaultTemplateInput(): CertificateTemplateInput {
  return {
    enabled:              false,
    type:                 'participation',
    title:                'Certificate of Participation',
    subtitle:             'This is to certify that',
    issuedBy:             '',
    signatoryName:        '',
    signatoryDesignation: '',
  }
}
