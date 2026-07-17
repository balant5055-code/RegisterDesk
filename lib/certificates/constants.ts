// Certificate module constants — Firestore collections, ID format, labels, limits.
// Safe to import from both client and server — no SDK dependencies.
// Single source of truth: no certificate collection name or enum label should
// be hardcoded anywhere else.

import type {
  CertificateType,
  CertificateTrigger,
  TemplateType,
  CertificateStatus,
  CertificateJobStatus,
  CertificateJobScope,
  RevocationReason,
} from './types'

// ─── Firestore collections ───────────────────────────────────────────────────
//
// The Phase 2 data model uses these four collections. NOTE: the original MVP
// stored generated records in `certificateRecords` (see LEGACY_* below); the
// Phase 2 migration will consolidate those into `certificates`.
export const COLLECTIONS = {
  /** certificateSettings/{eventId} — operational config (Phase 3). */
  SETTINGS: 'certificateSettings',
  /** certificateTemplates/{templateId|eventId} — design (Phase 4). */
  TEMPLATES: 'certificateTemplates',
  /** certificates/{certificateId} — generated certificate records (Phase 5). */
  CERTIFICATES: 'certificates',
  /** certificateJobs/{jobId} — bulk generation jobs (Phase 7). */
  JOBS: 'certificateJobs',
  /** certificateClaims/{claimId} — deterministic idempotency claims (Phase 5). */
  CLAIMS: 'certificateClaims',
} as const

export type CertificateCollection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

/**
 * Legacy collection from the original certificate MVP — generated records keyed
 * by certificateId. Still read/written by the existing routes. Retained until
 * the Phase 2 data-model migration; do not reference it in new code.
 */
export const LEGACY_CERTIFICATE_RECORDS = 'certificateRecords'

// ─── Certificate ID format ───────────────────────────────────────────────────
// Format: RDC-{YEAR}-{6 random uppercase alphanumerics} (see lib/certificates/id.ts).
export const CERTIFICATE_ID_PREFIX = 'RDC'
export const CERTIFICATE_ID_RANDOM_LEN = 6

// ─── Enum labels (single source of truth for UI) ─────────────────────────────
export const CERTIFICATE_TYPE_LABELS: Record<CertificateType, string> = {
  participation: 'Participation',
  completion:    'Completion',
  achievement:   'Achievement',
  winner:        'Winner',
  runner_up:     'Runner-up',
  volunteer:     'Volunteer',
  speaker:       'Speaker',
  sponsor:       'Sponsor',
  custom:        'Custom',
}

export const CERTIFICATE_TRIGGER_LABELS: Record<CertificateTrigger, string> = {
  manual:       'Manual',
  registration: 'On registration',
  approval:     'On approval',
  checkin:      'On check-in',
  event_end:    'After event ends',
  results:      'After results published',
}

export const TEMPLATE_TYPE_LABELS: Record<TemplateType, string> = {
  pdf: 'PDF',
  png: 'PNG',
  jpg: 'JPG',
}

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  pending:   'Pending',
  generated: 'Generated',
  emailed:   'Emailed',
  revoked:   'Revoked',
  failed:    'Failed',
}

export const CERTIFICATE_JOB_STATUS_LABELS: Record<CertificateJobStatus, string> = {
  pending:    'Pending',
  processing: 'Processing',
  completed:  'Completed',
  failed:     'Failed',
  cancelled:  'Cancelled',
}

export const CERTIFICATE_JOB_SCOPE_LABELS: Record<CertificateJobScope, string> = {
  single:     'Single attendee',
  selected:   'Selected attendees',
  checked_in: 'Checked-in attendees',
  all:        'All attendees',
}

export const REVOCATION_REASON_LABELS: Record<RevocationReason, string> = {
  duplicate:                'Duplicate Certificate',
  incorrect_result:         'Incorrect Result',
  fraudulent_registration:  'Fraudulent Registration',
  participant_disqualified: 'Participant Disqualified',
  administrative_error:     'Administrative Error',
  requested_by_organizer:   'Requested By Organizer',
  other:                    'Other',
}

/** Ordered lists for building dropdowns without re-deriving from the maps. */
export const CERTIFICATE_TYPES = Object.keys(CERTIFICATE_TYPE_LABELS) as CertificateType[]
export const REVOCATION_REASONS = Object.keys(REVOCATION_REASON_LABELS) as RevocationReason[]

// ─── Layout / builder (Phase 10) ──────────────────────────────────────────────
export const FONT_FAMILIES = ['helvetica', 'times', 'courier'] as const
export const CURRENT_LAYOUT_VERSION = 1
export const MAX_LAYOUT_ELEMENTS = 100
export const MAX_TEXT_CONTENT_LEN = 1000
export const CERTIFICATE_TRIGGERS = Object.keys(CERTIFICATE_TRIGGER_LABELS) as CertificateTrigger[]
export const TEMPLATE_TYPES = Object.keys(TEMPLATE_TYPE_LABELS) as TemplateType[]

// ─── Template upload (Phase 4) ───────────────────────────────────────────────
export const ALLOWED_TEMPLATE_MIME: Record<TemplateType, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
}

/** Maximum upload size per template type, in bytes. PDFs allow more (25 MB). */
export const TEMPLATE_SIZE_LIMITS: Record<TemplateType, number> = {
  pdf: 25 * 1024 * 1024,
  png: 10 * 1024 * 1024,
  jpg: 10 * 1024 * 1024,
}

/** Largest allowed across all types — used as an upfront fetch guard. */
export const MAX_TEMPLATE_BYTES = Math.max(...Object.values(TEMPLATE_SIZE_LIMITS))

// Storage layout for uploaded template assets. The owning uid is encoded in the
// path so Storage security rules can authorize writes/deletes by comparing it to
// request.auth.uid (same model as event-assets). The server also uses this
// prefix to confirm an uploaded fileUrl belongs to the caller's own folder.
export const CERT_TEMPLATE_STORAGE_ROOT = 'certificates/templates'

export function templateStoragePrefix(uid: string, eventId: string): string {
  return `${CERT_TEMPLATE_STORAGE_ROOT}/${uid}/${eventId}`
}

// ─── Generated certificate files (Phase 5) ────────────────────────────────────
// Written server-side via the Admin SDK (which bypasses Storage rules); served
// through a token-bearing download URL. Stored as:
//   certificates/generated/{eventId}/{certificateId}.pdf
export const CERT_GENERATED_STORAGE_ROOT = 'certificates/generated'

export function generatedCertificatePath(eventId: string, certificateId: string): string {
  return `${CERT_GENERATED_STORAGE_ROOT}/${eventId}/${certificateId}.pdf`
}

// Admin-curated GLOBAL template files (GA-6 S5) — trusted, read-only, platform-owned.
// Served via token download URLs; the renderer trusts this prefix so an imported
// global template renders for any organizer without copying its bytes.
export const CERT_GLOBAL_STORAGE_ROOT = 'certificates/global'

// ─── Bulk generation (Phase 7) ───────────────────────────────────────────────
// Designed to scale to 50,000+ certificates via leased, cursor-paged processing.
export const FIRESTORE_BATCH_LIMIT = 500   // hard Firestore write-batch limit

/** Registrations fetched + processed + committed per page (the resume granularity). */
export const BULK_PAGE_SIZE = 25
/** GA-7C S2: certificates rendered concurrently within a page (bounded worker pool).
 *  Render/upload/Firestore are I/O-bound and parallelize well; distinct registrations
 *  use distinct deterministic claims/ledgers, so there is no duplicate generation.
 *  ~6 in-flight PDFs keeps memory well within the function limit. */
export const BULK_CONCURRENCY = 6
/** Soft wall-clock budget for a single process() call, in ms. */
export const BULK_TIME_BUDGET_MS = 45_000
/** How long a process() call holds the job lease before another worker may take over. */
export const BULK_LEASE_MS = 120_000
/** Max registrations fetched per `in` query batch (Firestore limit is 30). */
export const FIRESTORE_IN_LIMIT = 30
