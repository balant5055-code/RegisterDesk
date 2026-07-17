// Certificate engine types.
// Safe to import from both client and server — no SDK dependencies.

import type { Job, JobStatus, JobCounts } from '@/lib/jobs/types'

/**
 * Certificate categories supported across every RegisterDesk event family —
 * conferences, workshops, corporate events, marathons, sports, NGOs, Rotary /
 * Lions clubs, community and fundraising events.
 *
 * Widened from the original `participation | completion` pair. The change is
 * backwards-compatible: both original members are still part of the union, so
 * existing templates and records remain valid.
 */
export type CertificateType =
  | 'participation'
  | 'completion'
  | 'achievement'
  | 'winner'
  | 'runner_up'
  | 'volunteer'
  | 'speaker'
  | 'sponsor'
  | 'custom'

/**
 * When certificate generation fires for an event. `manual` is the only trigger
 * wired today; the rest are reserved for automated generation (Phases 5 & 7)
 * and are part of the foundation so settings/data shapes stay stable.
 */
export type CertificateTrigger =
  | 'manual'        // organizer generates on demand
  | 'registration'  // immediately after a successful registration
  | 'approval'      // after the organizer approves a registration
  | 'checkin'       // after attendee check-in
  | 'event_end'     // once the event end time has passed
  | 'results'       // after results / positions are published (sports)

/** Source artefact a template is built from. */
export type TemplateType = 'pdf' | 'png' | 'jpg'

/**
 * Lifecycle status of a certificate.
 *
 * Widened from `generated | emailed` for the Phase 2 data model. Backwards
 * compatible: the MVP only ever writes `generated` / `emailed`, and the new
 * states (`pending`, `revoked`, `failed`) are additive.
 */
export type CertificateStatus =
  | 'pending'     // record exists, file not yet produced (bulk jobs)
  | 'generated'   // file is ready
  | 'emailed'     // delivered to the attendee by email
  | 'revoked'     // invalidated by the organizer (Phase 9)
  | 'failed'      // generation failed

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

// ─── Settings ───────────────────────────────────────────────────────────────

/**
 * certificateSettings/{eventId}
 *
 * One document per event. Holds *operational* configuration — whether
 * certificates are enabled, how/when they are generated, what the public
 * verification page reveals, auto-email behaviour, and download rules.
 *
 * Kept separate from the template (which holds *design*) so an organizer can
 * change operational behaviour without touching the design, and vice-versa.
 * `activeTemplateId` is the link between the two (Phase 4 selects the active
 * template; until then it may be null and the per-event template is used).
 */
export interface CertificateSettings {
  eventId:          string
  enabled:          boolean
  defaultType:      CertificateType
  trigger:          CertificateTrigger
  activeTemplateId: string | null      // certificateTemplates doc id, or null

  /**
   * Certificate PROGRAMS assignment (GA-6 S3). Ordered, deterministic rules mapping a
   * participant to a program (template). Optional + additive — when empty/absent, the
   * active template + defaultType are used (single-template events are unchanged).
   */
  assignmentRules?: import('./assignment').AssignmentRule[]

  /** Public verification page (Phase 6) — which fields are shown. */
  verification: {
    enabled:             boolean
    showParticipantName: boolean
    showEventName:       boolean
    showIssueDate:       boolean
    showCertificateType: boolean
  }

  /** Automatic email delivery (Phase 8). Subject/message support placeholders. */
  autoEmail: {
    enabled: boolean
    subject: string
    message: string
  }

  /** Download access rules (Phase 5/8). */
  download: {
    enabled:             boolean
    requireVerification: boolean   // require token match before serving the file
    allowAttendee:       boolean   // attendees may self-download their certificate
  }

  createdAt: unknown   // Firestore Timestamp
  updatedAt: unknown   // Firestore Timestamp
  updatedBy: string    // organizer uid
}

/** Shape used to save / update settings from the organizer UI (Phase 3). */
export type CertificateSettingsInput = Omit<
  CertificateSettings,
  'eventId' | 'createdAt' | 'updatedAt' | 'updatedBy'
>

/** Safe defaults for an event that has never configured certificates. */
export function defaultCertificateSettings(): CertificateSettingsInput {
  return {
    enabled:          false,
    defaultType:      'participation',
    trigger:          'manual',
    activeTemplateId: null,
    verification: {
      enabled:             true,
      showParticipantName: true,
      showEventName:       true,
      showIssueDate:       true,
      showCertificateType: true,
    },
    autoEmail: {
      enabled: false,
      subject: 'Your certificate for {{eventName}}',
      message:
        'Hi {{participantName}},\n\n' +
        'Your certificate for {{eventName}} is ready. You can verify it any ' +
        'time using the QR code or the link on the certificate.\n\n' +
        'Certificate ID: {{certificateId}}',
    },
    download: {
      enabled:             true,
      requireVerification: false,
      allowAttendee:       true,
    },
  }
}

/**
 * A partial settings update (Phase 3 PATCH). Top-level scalars and each nested
 * group may be partially supplied; absent fields are left unchanged by
 * `mergeCertificateSettings`.
 */
export interface CertificateSettingsPatch {
  enabled?:          boolean
  defaultType?:      CertificateType
  trigger?:          CertificateTrigger
  activeTemplateId?: string | null
  verification?:     Partial<CertificateSettings['verification']>
  autoEmail?:        Partial<CertificateSettings['autoEmail']>
  download?:         Partial<CertificateSettings['download']>
  assignmentRules?:  import('./assignment').AssignmentRule[]
}

/**
 * Deep-merges a validated patch onto a base settings value, returning a
 * complete `CertificateSettingsInput`. Pure — nested groups are merged
 * key-by-key so unspecified siblings are preserved.
 */
export function mergeCertificateSettings(
  base:  CertificateSettingsInput,
  patch: CertificateSettingsPatch,
): CertificateSettingsInput {
  return {
    enabled:          patch.enabled          ?? base.enabled,
    defaultType:      patch.defaultType      ?? base.defaultType,
    trigger:          patch.trigger          ?? base.trigger,
    activeTemplateId: patch.activeTemplateId !== undefined ? patch.activeTemplateId : base.activeTemplateId,
    verification: { ...base.verification, ...patch.verification },
    autoEmail:    { ...base.autoEmail,    ...patch.autoEmail },
    download:     { ...base.download,     ...patch.download },
    // Only include the key when a value exists (Firestore rejects `undefined`).
    ...(patch.assignmentRules !== undefined || base.assignmentRules !== undefined
      ? { assignmentRules: patch.assignmentRules ?? base.assignmentRules ?? [] }
      : {}),
  }
}

/** Strips server-managed metadata from a stored settings doc back to its input shape. */
export function settingsToInput(settings: CertificateSettings): CertificateSettingsInput {
  const { eventId: _e, createdAt: _c, updatedAt: _u, updatedBy: _b, ...input } = settings
  void _e; void _c; void _u; void _b
  return input
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — FINAL DATA MODEL
//
// These are the canonical models for the enterprise certificate system. They
// live alongside the MVP models above (`CertificateTemplate`, `CertificateRecord`)
// which remain fully operational — see the compatibility notes per model.
//
// Collections (see lib/certificates/constants.ts → COLLECTIONS):
//   certificates        → Certificate          (keyed by certificateId)
//   certificateTemplates→ CertificateTemplateDoc(keyed by templateId)
//   certificateJobs     → CertificateJob        (keyed by jobId)
//
// All interfaces here are SDK-free (importable from client + server). Firestore
// `Timestamp` fields are typed `unknown`; use the serialize helpers below for
// API responses.
// ════════════════════════════════════════════════════════════════════════════

/** How a certificate came to be generated. */
export type CertificateSource = CertificateTrigger | 'bulk'

/** Per-send email delivery status for a certificate (Phase 8). */
export type CertificateEmailStatus = 'pending' | 'sent' | 'delivered' | 'failed'

/** Supported revocation reasons (Phase 9). `other` requires a customReason. */
export type RevocationReason =
  | 'duplicate'
  | 'incorrect_result'
  | 'fraudulent_registration'
  | 'participant_disqualified'
  | 'administrative_error'
  | 'requested_by_organizer'
  | 'other'

/** Append-only audit entry for a revoke / restore action. */
export interface RevocationHistoryEntry {
  action:       'revoked' | 'restored'
  by:           string            // organizer uid
  at:           string            // ISO 8601 (array-safe — not a Firestore Timestamp)
  reason?:      RevocationReason   // present on `revoked`
  customReason?: string            // present when reason === 'other'
}

/** One entry in a certificate's email delivery history. */
export interface EmailHistoryEntry {
  recipient:  string
  provider:   string            // e.g. "ses"
  status:     'sent' | 'delivered' | 'failed'
  timestamp:  string            // ISO 8601 (array-safe — not a Firestore Timestamp)
  messageId?: string
  error?:     string
}

/** Schema version stamped on every new-model document, for safe migrations. */
export const CERTIFICATE_SCHEMA_VERSION = 1

// ─── certificates/{certificateId} ─────────────────────────────────────────────

/**
 * A single generated certificate.
 *
 * Supersedes the MVP `CertificateRecord`. New fields vs the MVP:
 *   verificationToken, certificateType, templateId, fileUrl, fileSize, source,
 *   data (placeholder snapshot for sports/timed vars), revokedAt/By/reason,
 *   jobId, schemaVersion, legacy.
 *
 * No data is migrated in Phase 2 — existing records stay in `certificateRecords`
 * and are read through `legacyRecordToCertificate()` when a unified view is
 * needed.
 */
export interface Certificate {
  certificateId:     string               // public ID, e.g. "RDC-2026-AB12CD"
  verificationToken: string | null        // private capability token (Phase 5)
  eventId:           string               // draftId — organizer/event queries
  eventSlug:         string
  organizerUid:      string
  /** Operator who issued this certificate (attribution). Optional — null/absent
   *  for auto-generated and pre-attribution historical records. */
  issuedBy?:         string | null
  registrationId:    string
  attendeeName:      string
  attendeeEmail:     string
  eventName:         string
  eventDate:         string               // human-readable, e.g. "15 June 2026"
  certificateType:   CertificateType
  templateId:        string | null        // CertificateTemplateDoc used, if any
  fileUrl:           string | null        // stored asset; null = generated on demand
  fileSize:          number | null        // bytes, when stored
  status:            CertificateStatus
  source:            CertificateSource
  /** Snapshot of placeholder values at generation time (bib, distance, etc.). */
  data:              Record<string, string | number>
  downloadCount:     number
  lastDownloadedAt:  unknown | null       // Firestore Timestamp (Phase 8)
  emailStatus:       CertificateEmailStatus | null
  emailHistory?:     EmailHistoryEntry[]  // append-only delivery log (Phase 8)
  generatedAt:       unknown              // Firestore Timestamp
  emailedAt:         unknown | null
  revokedAt:         unknown | null       // Phase 9
  revokedBy:         string | null        // organizer uid
  revokeReason:      string | null        // resolved human-readable reason text
  revocationHistory?: RevocationHistoryEntry[]   // append-only revoke/restore log
  jobId:             string | null        // owning bulk job (Phase 7), if any
  schemaVersion:     number
  /** True only when this object was adapted from a legacy certificateRecord. */
  legacy?:           boolean
}

/** Fields required to create a certificate; the rest are defaulted server-side. */
export type CertificateInput = Pick<Certificate,
  | 'certificateId' | 'verificationToken' | 'eventId' | 'eventSlug'
  | 'organizerUid' | 'issuedBy' | 'registrationId' | 'attendeeName' | 'attendeeEmail'
  | 'eventName' | 'eventDate' | 'certificateType' | 'templateId'
  | 'fileUrl' | 'fileSize' | 'source' | 'data' | 'jobId'
>

/** Serialized for API responses (Timestamps → ISO strings). */
export interface SerializedCertificate
  extends Omit<Certificate, 'generatedAt' | 'emailedAt' | 'revokedAt' | 'lastDownloadedAt'> {
  generatedAt:      string | null
  emailedAt:        string | null
  revokedAt:        string | null
  lastDownloadedAt: string | null
}

// ─── certificateTemplates/{templateId} ────────────────────────────────────────

export interface CertificateDimensions {
  width:  number
  height: number
  unit:   'pt' | 'px'
}

// ─── Layout (Phase 10 — drag-and-drop builder design) ─────────────────────────
//
// A layout is resolution-independent: positions and sizes are stored as
// FRACTIONS [0,1] of the reference canvas, with a TOP-LEFT origin (matching the
// builder UI). The renderer maps these onto the actual output and flips the
// origin for pdf-lib. fontSizeFrac is a fraction of canvas height so text scales
// with the canvas. The renderer is forward-tolerant: unknown element types are
// skipped, so the format can evolve safely.

/** Builder-selectable font families (mapped to embedded/standard fonts at render). */
export type FontFamily = 'helvetica' | 'times' | 'courier'

export type LayoutElementType = 'text' | 'image' | 'qr' | 'line'

export interface BaseLayoutElement {
  id:        string
  type:      LayoutElementType
  zIndex:    number
  x:         number            // [0,1] of canvas width  (top-left origin)
  y:         number            // [0,1] of canvas height (top-left origin)
  width?:    number            // [0,1] of canvas width  (box for wrap/fit/align)
  height?:   number            // [0,1] of canvas height
  rotation?: number            // degrees, clockwise
  opacity?:  number            // [0,1]
}

export interface TextLayoutElement extends BaseLayoutElement {
  type:        'text'
  content:     string                       // may contain {{placeholder}} tokens
  fontFamily:  FontFamily
  fontSizeFrac: number                      // (0,1] fraction of canvas height
  weight:      'normal' | 'bold'
  italic?:     boolean
  color:       string                       // #RRGGBB
  align:       'left' | 'center' | 'right'
}

/** Semantic role of an image element — drives the builder's upload slots / labels. */
export type ImageRole = 'image' | 'logo' | 'signature' | 'seal'

export interface ImageLayoutElement extends BaseLayoutElement {
  type:     'image'
  assetUrl: string                          // must live in the project's Storage bucket
  fit:      'contain' | 'cover'
  role?:    ImageRole                       // logo / signature / seal / generic image
}

export interface QrLayoutElement extends BaseLayoutElement {
  type:       'qr'
  source:     'verify'                      // QR encodes the verification URL
  darkColor?: string                        // #RRGGBB (default near-black)
}

export interface LineLayoutElement extends BaseLayoutElement {
  type:      'line'
  color:     string                         // #RRGGBB
  thickness: number                         // [0,1] fraction of canvas height
}

export type LayoutElement =
  | TextLayoutElement
  | ImageLayoutElement
  | QrLayoutElement
  | LineLayoutElement

export interface CertificateLayout {
  version:  number
  canvas:   CertificateDimensions           // reference canvas (= template dimensions)
  elements: LayoutElement[]                 // drawn in ascending zIndex order
}

/**
 * An uploaded certificate template (PDF / PNG / JPG) with its metadata.
 *
 * IMPORTANT — coexistence with the MVP: the MVP also uses the
 * `certificateTemplates` collection, but stores ONE design-config document per
 * event keyed by eventId (the `CertificateTemplate` interface above, which has
 * no `templateId`/`fileUrl`/`templateType`). New file-based templates are keyed
 * by a random `templateId` and always carry `templateId` + `templateType`, so
 * the two never collide by key and can be told apart by field presence.
 * The MVP's `getTemplate(eventId)` only reads the eventId-keyed doc and is
 * unaffected. Phase 4 owns multi-template management and the single-active rule.
 */
/** Template lifecycle status (GA-6 S5). Absent on legacy templates ⇒ treated as 'published'. */
export type CertificateTemplateStatus = 'draft' | 'published' | 'archived'
export const CERTIFICATE_TEMPLATE_STATUSES: readonly CertificateTemplateStatus[] = ['draft', 'published', 'archived']

export interface CertificateTemplateDoc {
  templateId:    string
  eventId:       string
  organizerUid:  string
  name:          string                   // organizer-facing label
  templateType:  TemplateType             // pdf | png | jpg
  fileUrl:       string                    // stored template asset
  fileName:      string
  fileSize:      number                    // bytes
  dimensions:    CertificateDimensions | null
  pageCount:     number | null             // PDFs; null for images
  isActive:      boolean                   // at most one active per event (Phase 4)
  // Program metadata (GA-6 S3) — a template doubles as a certificate PROGRAM. Optional
  // + additive; absent for legacy templates (they simply have no declared type/desc).
  certificateType?:    CertificateType      // the type/label this program issues
  programDescription?: string
  // Governance metadata (GA-6 S5) — all optional + additive. Legacy templates have
  // none and behave exactly as before (status defaults to 'published' when absent).
  status?:       CertificateTemplateStatus  // draft | published | archived
  category?:     string
  tags?:         string[]
  visibility?:   'private' | 'shared'        // 'shared' = discoverable by the workspace's team
  favorite?:     boolean
  usageCount?:   number                      // times a certificate was generated from it
  lastUsedAt?:   unknown                     // Firestore Timestamp
  thumbnailUrl?: string
  version?:      number                      // template revision (bumped on layout save)
  layout?:       CertificateLayout         // builder design (Phase 10); default layout used when absent
  layoutUpdatedAt?: unknown                // Firestore Timestamp — last layout save
  schemaVersion: number
  createdAt:     unknown                   // Firestore Timestamp
  updatedAt:     unknown                   // Firestore Timestamp
  createdBy:     string                    // organizer uid
}

/** Shape used to create a template; server fills id/timestamps/createdBy. */
export type CertificateTemplateDocInput = Omit<
  CertificateTemplateDoc,
  'templateId' | 'isActive' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'createdBy'
> & { isActive?: boolean }

/** Serialized for API responses (Timestamps → ISO strings). */
export interface SerializedCertificateTemplateDoc
  extends Omit<CertificateTemplateDoc, 'createdAt' | 'updatedAt' | 'layoutUpdatedAt'> {
  createdAt:        string | null
  updatedAt:        string | null
  layoutUpdatedAt?: string | null
}

// ─── certificateJobs/{jobId} ──────────────────────────────────────────────────

// The certificate job's generic control fields now come from the shared job model
// (ROE-1a). These aliases keep the certificate-namespace names for existing imports.
export type CertificateJobStatus = JobStatus
export type CertificateJobCounts = JobCounts

/** Which attendees a bulk job targets (Phase 7). */
export type CertificateJobScope = 'single' | 'selected' | 'checked_in' | 'all'

/**
 * A bulk certificate generation job. Designed to scale to 50,000+ certificates
 * via chunked, resumable processing — `cursor` (from the generic Job) records the
 * last processed registrationId so a worker can resume after a timeout without
 * redoing work. The generic control fields (jobId/organizerUid/createdBy/status/
 * counts/cursor/error/lockedUntil/timestamps) come from `Job`; the fields below
 * are the certificate-specific payload.
 */
export interface CertificateJob extends Job {
  eventId:         string
  templateId:      string | null          // active template at enqueue time
  certificateType: CertificateType
  scope:           CertificateJobScope
  /** Explicit targets for `single`/`selected`; null for `all`/`checked_in`. */
  registrationIds: string[] | null
  autoEmail:       boolean
  /**
   * "Generate by program" filter (GA-6 S3). When set, a query-scope job issues ONLY to
   * participants matching this rule (evaluated in-memory, O(1) per attendee), using the
   * job's own `templateId` (the program). Absent → every scoped participant (unchanged).
   */
  assignmentFilter?: import('./assignment').AssignmentRule | null
  schemaVersion:   number
}

/** Shape used to enqueue a job; server fills id/status/counts/timestamps. */
export type CertificateJobInput = Pick<CertificateJob,
  | 'eventId' | 'organizerUid' | 'createdBy' | 'templateId'
  | 'certificateType' | 'scope' | 'registrationIds' | 'autoEmail' | 'assignmentFilter'
>

/** Serialized for API responses (Timestamps → ISO strings). */
export interface SerializedCertificateJob
  extends Omit<CertificateJob, 'createdAt' | 'startedAt' | 'updatedAt' | 'completedAt'> {
  createdAt:   string | null
  startedAt:   string | null
  updatedAt:   string | null
  completedAt: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Zeroed job counters, optionally seeded with a known total. */
export function defaultJobCounts(total = 0): CertificateJobCounts {
  return { total, processed: 0, succeeded: 0, failed: 0 }
}

/** True when a job scope requires an explicit list of registration IDs. */
export function jobScopeRequiresIds(scope: CertificateJobScope): boolean {
  return scope === 'single' || scope === 'selected'
}

// ─── Serialization (Firestore Timestamp → ISO string) ─────────────────────────

interface TimestampLike { toDate: () => Date }

function isTimestampLike(v: unknown): v is TimestampLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { toDate?: unknown }).toDate === 'function'
  )
}

/** Best-effort conversion of a Firestore Timestamp / Date / string to ISO. */
export function toIsoString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (isTimestampLike(v)) return v.toDate().toISOString()
  if (v instanceof Date)  return v.toISOString()
  if (typeof v === 'string') return v
  return null
}

export function serializeCertificate(c: Certificate): SerializedCertificate {
  return {
    ...c,
    generatedAt:      toIsoString(c.generatedAt),
    emailedAt:        toIsoString(c.emailedAt),
    revokedAt:        toIsoString(c.revokedAt),
    lastDownloadedAt: toIsoString(c.lastDownloadedAt),
  }
}

export function serializeCertificateTemplateDoc(
  t: CertificateTemplateDoc,
): SerializedCertificateTemplateDoc {
  return {
    ...t,
    createdAt:       toIsoString(t.createdAt),
    updatedAt:       toIsoString(t.updatedAt),
    layoutUpdatedAt: toIsoString(t.layoutUpdatedAt),
  }
}

export function serializeCertificateJob(j: CertificateJob): SerializedCertificateJob {
  return {
    ...j,
    createdAt:   toIsoString(j.createdAt),
    startedAt:   toIsoString(j.startedAt),
    updatedAt:   toIsoString(j.updatedAt),
    completedAt: toIsoString(j.completedAt),
  }
}

// ─── Compatibility adapter (legacy certificateRecords → Certificate) ──────────

/**
 * Adapts a legacy MVP `CertificateRecord` into the new `Certificate` shape so a
 * single read path can present records from both `certificateRecords` (legacy)
 * and `certificates` (new) uniformly. Fields the MVP never stored are filled
 * with safe defaults; `legacy: true` marks the origin.
 *
 * The MVP regenerates its PDF on demand, so `fileUrl` is null — callers that
 * need a file for a legacy record should fall through to the existing
 * on-demand generation path.
 */
export function legacyRecordToCertificate(r: CertificateRecord): Certificate {
  return {
    certificateId:     r.certificateId,
    verificationToken: null,
    eventId:           r.eventId,
    eventSlug:         r.eventSlug,
    organizerUid:      r.organizerUid,
    registrationId:    r.registrationId,
    attendeeName:      r.attendeeName,
    attendeeEmail:     r.attendeeEmail,
    eventName:         r.eventName,
    eventDate:         r.eventDate,
    certificateType:   'participation',   // MVP records carry no per-record type
    templateId:        null,
    fileUrl:           null,              // regenerated on demand by the MVP
    fileSize:          null,
    status:            r.status,
    source:            'manual',
    data:              {},
    downloadCount:     r.downloadCount,
    lastDownloadedAt:  null,
    emailStatus:       r.emailStatus === 'sent' || r.emailStatus === 'failed' ? r.emailStatus : null,
    generatedAt:       r.issuedAt,
    emailedAt:         r.emailedAt ?? null,
    revokedAt:         null,
    revokedBy:         null,
    revokeReason:      null,
    jobId:             null,
    schemaVersion:     CERTIFICATE_SCHEMA_VERSION,
    legacy:            true,
  }
}
