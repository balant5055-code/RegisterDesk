// Certificate Hub — typed client wrappers over the EXISTING certificate APIs.
// No new endpoints (except the read-only /records list). All calls carry the
// organizer Bearer token.

import type { CertificateRecordsResponse } from '@/app/api/organizer/events/[eventId]/certificates/records/route'
import type { EmailJobCreateResponse, EmailJobsListResponse } from '@/app/api/organizer/events/[eventId]/certificates/email-jobs/route'
import type { EmailJobResponse } from '@/app/api/organizer/events/[eventId]/certificates/email-jobs/[jobId]/route'
import type { SettingsResponse }           from '@/app/api/organizer/events/[eventId]/certificates/settings/route'
import type { TemplatesListResponse }      from '@/app/api/organizer/events/[eventId]/certificates/templates/route'
import type { TemplatePrepareResponse }    from '@/app/api/organizer/events/[eventId]/certificates/templates/prepare/route'
import type { JobsListResponse }           from '@/app/api/organizer/events/[eventId]/certificates/jobs/route'
import type { JobProcessResponse }         from '@/app/api/organizer/events/[eventId]/certificates/jobs/[jobId]/process/route'
import type { RegistrationsApiResponse }   from '@/app/api/organizer/events/[eventId]/registrations/route'
import type {
  CertificateSettingsInput, CertificateSettingsPatch,
  SerializedCertificateTemplateDoc, SerializedCertificate, SerializedCertificateJob,
  CertificateType, TemplateType, CertificateJobScope, RevocationReason, CertificateDeliveryScope,
} from '@/lib/certificates/types'
// Type-only, so both are erased at build — no server module is pulled into the bundle. Same
// idiom the route-type imports above already rely on.
import type { ProcessResult } from '@/lib/jobs/runner'
import type { JobCounts, JobStatus } from '@/lib/jobs/types'

/**
 * Response of the EXISTING email-job process route.
 *
 * Declared here rather than imported because that route exports no type of its own, and this
 * change is not permitted to modify it. Kept structurally identical to what the route returns
 * — `result` from the shared job runner, plus the job's post-chunk summary (null if the job
 * vanished between the chunk and the read-back).
 */
export interface EmailJobProcessResponse {
  result: ProcessResult
  job: {
    jobId:       string
    status:      JobStatus
    counts:      JobCounts
    needsReview: number
    error:       string | null
  } | null
}

export type ZipScope = 'all' | 'job' | 'selected'

export interface ZipJobCreateResponse {
  jobId: string; status: string; scope: ZipScope; total: number
}

/**
 * One part of a multipart export. `part` is a presentation ordinal derived from shard order;
 * `url` is a short-lived signed URL minted per poll, never stored.
 */
export interface ZipPart {
  part: number; count: number; bytes: number; url: string
}

/**
 * READ `outcome`, NOT `status`, to decide whether an export is whole.
 *
 * `status: 'completed'` only means the job stopped running. `outcome` is written by the
 * finalize seal, which refuses to pass a short or duplicated archive:
 *   complete   — every requested certificate is inside a verified part
 *   partial    — the archive is short by exactly `failedCount` certificates
 *   unverified — a job from before multipart verification existed
 */
export interface ZipJobResponse {
  jobId: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  scope: ZipScope
  counts: { total: number; processed: number; succeeded: number; failed: number }
  requested: number
  included: number
  outcome: 'complete' | 'partial' | 'unverified' | null
  failedCount: number
  failedIds: string[]
  partCount: number
  parts: ZipPart[]
  manifestUrl: string | null
  error: string | null
}

export type HubTab = 'overview' | 'settings' | 'templates' | 'programs' | 'brandkit' | 'issue' | 'recipients'

/**
 * The regenerate route's wire format. Typed here rather than imported because that route
 * returns its JSON inline and exports no named type; `CertResolveResponse` below is declared
 * the same way for the same reason.
 *
 * PARTIAL FAILURE IS THE NORMAL CASE: the route answers 200 with per-item outcomes, so
 * `failed` and `results[].ok` — not the HTTP status — are what say whether anything worked.
 */
export interface CertificateRegenerateResponse {
  succeeded: number
  failed:    number
  results:   Array<{ certificateId: string; ok: boolean; error?: string }>
}

/**
 * RD-CERT-DELETE — permanent deletion. Same partial-failure contract as regenerate.
 *
 * `orphanedKeys` counts R2 objects that survived the deletion. Those certificates ARE deleted
 * (their `ok` is true); the number exists so unreferenced bytes are reported rather than
 * swallowed, and it must never be presented as a failed deletion.
 */
export interface CertificateDeleteResponse {
  succeeded:    number
  failed:       number
  orphanedKeys: number
  results:      Array<{
    certificateId:   string
    ok:              boolean
    error?:          string
    alreadyDeleted?: boolean
    orphanedKeys?:   string[]
  }>
}

// ── Extra response/patch shapes for the newly-surfaced endpoints (GA-7D S3) ──
// The engines already exist server-side; these only type the wire format.
export interface CertResolveResponse {
  registrationId: string
  resolved: {
    matchedRuleId:        string | null
    ruleLabel:            string | null
    programTemplateId:    string | null
    programTemplateName:  string | null
    certificateType:      CertificateType
    isDefault:            boolean
  }
  context: Record<string, string | number | boolean | null>
}

export interface TemplateMetaPatch {
  status?:             'draft' | 'published' | 'archived'
  favorite?:           boolean
  category?:           string
  tags?:               string[]
  visibility?:         'private' | 'shared'
  programDescription?: string
  certificateType?:    CertificateType
}

// Read-only view of a global-library template (a superset of the API's serialized shape).
export interface GlobalTemplateItem {
  id:            string
  name:          string
  description:   string
  category:      string
  tier:          string
  featured:      boolean
  tags:          string[]
  usageCount:    number
  templateType:  string
  fileName:      string
  thumbnailUrl?: string
}

function base(eventId: string) {
  return `/api/organizer/events/${eventId}/certificates`
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export function makeCertApi(eventId: string, token: string) {
  const auth = { Authorization: `Bearer ${token}` }
  const jsonAuth = { ...auth, 'Content-Type': 'application/json' }
  const B = base(eventId)

  return {
    // ── Records (Overview + Recipients) ──
    // Cursor-paginated. The server has always returned hasMore/nextCursor; the client now
    // uses them, so a 10,000-certificate event is paged instead of silently truncated to
    // the first response.
    getRecords: (opts: { limit?: number; cursor?: string | null } = {}) => {
      const q = new URLSearchParams()
      if (opts.limit) q.set('limit', String(opts.limit))
      if (opts.cursor) q.set('cursor', opts.cursor)
      const suffix = q.toString() ? `?${q}` : ''
      return fetch(`${B}/records${suffix}`, { headers: auth }).then(jsonOrThrow<CertificateRecordsResponse>)
    },

    // ── Bulk delivery (RD-CERT-EMAIL-BULK) ──
    // "Select all matching" sends a SCOPE, never a list of ids, so the payload is the same
    // size for 10 certificates and for 100,000.
    createEmailJob: (body: { scopeType: CertificateDeliveryScope; certificateIds?: string[] }) =>
      fetch(`${B}/email-jobs`, { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) })
        .then(jsonOrThrow<EmailJobCreateResponse>),
    listEmailJobs: () => fetch(`${B}/email-jobs`, { headers: auth }).then(jsonOrThrow<EmailJobsListResponse>),
    // Progress is READ from the job document, so it survives a closed tab, a refresh and a
    // navigation. This is the authoritative state — `processEmailJob` advances the work, but
    // what the UI shows always comes from here.
    getEmailJob: (jobId: string) =>
      fetch(`${B}/email-jobs/${jobId}`, { headers: auth }).then(jsonOrThrow<EmailJobResponse>),
    /**
     * Advances ONE chunk of a delivery job, exactly as the cron driver does.
     *
     * WHY THIS EXISTS. Creating the job only enqueues it; something has to run it. Generation
     * (`processJob`) and ZIP export (`processZipJob`) have always been driven by the open tab,
     * with cron as the safety net. Delivery had no such method, so "Send all not sent" left the
     * job `pending` until the next scheduled tick — observed in production at 20–56 minute
     * intervals, because GitHub throttles scheduled workflows regardless of the five-minute cron expression they declare.
     * The organizer saw a button that appeared to do nothing.
     *
     * This wraps the EXISTING route; no endpoint, permission or server behaviour is added. The
     * job lease arbitrates a tab-driven chunk against a cron chunk, and the per-certificate
     * claim makes a double send impossible, so calling this is safe at any time — and safe to
     * fail, since cron still finishes the job.
     */
    processEmailJob: (jobId: string) =>
      fetch(`${B}/email-jobs/${jobId}/process`, { method: 'POST', headers: auth })
        .then(jsonOrThrow<EmailJobProcessResponse>),

    // ── Settings ──
    getSettings: () => fetch(`${B}/settings`, { headers: auth }).then(jsonOrThrow<SettingsResponse>),
    putSettings: (input: CertificateSettingsInput) =>
      fetch(`${B}/settings`, { method: 'PUT', headers: jsonAuth, body: JSON.stringify(input) })
        .then(jsonOrThrow<{ success: boolean }>),
    patchSettings: (patch: CertificateSettingsPatch) =>
      fetch(`${B}/settings`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify(patch) })
        .then(jsonOrThrow<{ success: boolean }>),

    // ── Templates ──
    getTemplates: () => fetch(`${B}/templates`, { headers: auth }).then(jsonOrThrow<TemplatesListResponse>),
    // RD-CERT-TPL-R2 — step 1 of the upload: ask the server for a signed PUT url. The key
    // is decided server-side; the browser never names the object it writes.
    prepareTemplate: (body: { fileName: string; templateType: TemplateType }) =>
      fetch(`${B}/templates/prepare`, { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) })
        .then(jsonOrThrow<TemplatePrepareResponse>),
    // Step 2: register the uploaded object. `fileKey` is the R2 path; `fileUrl` remains
    // accepted for the legacy Firebase flow so an older client keeps working.
    createTemplate: (body: { name: string; templateType: TemplateType; fileName: string }
                          & ({ fileKey: string } | { fileUrl: string })) =>
      fetch(`${B}/templates`, { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) })
        .then(jsonOrThrow<{ success: boolean; template: SerializedCertificateTemplateDoc }>),
    patchTemplate: (templateId: string, patch: { name?: string; isActive?: boolean }) =>
      fetch(`${B}/templates/${templateId}`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify(patch) })
        .then(jsonOrThrow<{ success: boolean; template: SerializedCertificateTemplateDoc | null }>),
    deleteTemplate: (templateId: string) =>
      fetch(`${B}/templates/${templateId}`, { method: 'DELETE', headers: auth })
        .then(jsonOrThrow<{ success: boolean; fileUrl: string }>),
    // GA-7D S3: template governance/program metadata (existing meta route).
    patchTemplateMeta: (templateId: string, patch: TemplateMetaPatch) =>
      fetch(`${B}/templates/${templateId}/meta`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify(patch) })
        .then(jsonOrThrow<{ success: boolean; template: SerializedCertificateTemplateDoc }>),
    // GA-7D S3: duplicate a template (existing duplicate route).
    duplicateTemplate: (templateId: string) =>
      fetch(`${B}/templates/${templateId}/duplicate`, { method: 'POST', headers: auth })
        .then(jsonOrThrow<{ success: boolean; template: SerializedCertificateTemplateDoc }>),

    // ── Global template library (GA-7D S3 — browse + import existing endpoints) ──
    listGlobalTemplates: (params?: { category?: string; q?: string }) => {
      const qs = new URLSearchParams()
      if (params?.category) qs.set('category', params.category)
      if (params?.q)        qs.set('q', params.q)
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return fetch(`/api/organizer/global-templates${suffix}`, { headers: auth })
        .then(jsonOrThrow<{ templates: GlobalTemplateItem[] }>)
    },
    importGlobalTemplate: (globalTemplateId: string) =>
      fetch(`${B}/templates/import-global`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ globalTemplateId }) })
        .then(jsonOrThrow<{ success: boolean; template: SerializedCertificateTemplateDoc }>),

    // ── Assignment resolve preview (GA-7D S3 — existing resolve route) ──
    resolvePreview: (registrationId: string) =>
      fetch(`${B}/resolve`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ registrationId }) })
        .then(jsonOrThrow<CertResolveResponse>),

    // ── Issue + Bulk jobs ──
    issue: (registrationId: string, certificateType?: CertificateType) =>
      fetch(`${B}/issue`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ registrationId, certificateType }) })
        .then(jsonOrThrow<{ success: boolean; created: boolean; certificate: SerializedCertificate }>),
    createJob: (body: { scope: CertificateJobScope; certificateType?: CertificateType; registrationIds?: string[] | null }) =>
      fetch(`${B}/jobs`, { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) })
        .then(jsonOrThrow<{ success: boolean; job: SerializedCertificateJob }>),
    listJobs: () => fetch(`${B}/jobs`, { headers: auth }).then(jsonOrThrow<JobsListResponse>),
    processJob: (jobId: string) =>
      fetch(`${B}/jobs/${jobId}/process`, { method: 'POST', headers: auth }).then(jsonOrThrow<JobProcessResponse>),
    // ── Bulk ZIP export (RD-CERT-ARTIFACT-01 enqueue + poll, RD-CERT-SCALE P2-2 multipart) ──
    // These wrap the EXISTING endpoints; the export mechanism is the sharded job, not a
    // second download path. `processZipJob` exists so the organizer's open tab drives the
    // job immediately instead of waiting for the cron that would otherwise pick it up.
    createZipJob: (scope: ZipScope, body?: { certificateIds?: string[]; jobId?: string }) =>
      fetch(`${B}/download`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, ...body }),
      }).then(jsonOrThrow<ZipJobCreateResponse>),
    getZipJob: (jobId: string) =>
      fetch(`${B}/zip-jobs/${jobId}`, { headers: auth }).then(jsonOrThrow<ZipJobResponse>),
    processZipJob: (jobId: string) =>
      fetch(`${B}/zip-jobs/${jobId}/process`, { method: 'POST', headers: auth })
        .then(jsonOrThrow<{ status: string }>),

    cancelJob: (jobId: string) =>
      fetch(`${B}/jobs/${jobId}/cancel`, { method: 'POST', headers: auth }).then(jsonOrThrow<{ status: string }>),

    // ── Email ──
    // `intent` is how "Review & Send" is distinguished from an ordinary resend: only
    // `resend_after_review` can take a certificate whose delivery outcome is unknown.
    emailCertificate: (
      certificateId: string,
      resend: boolean,
      intent?: 'send' | 'resend' | 'resend_after_review',
    ) =>
      fetch(`${B}/email`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId, resend, intent }) })
        .then(jsonOrThrow<{ success: boolean; skipped: boolean }>),

    // ── Revocation ──
    revoke: (certificateId: string, reason: RevocationReason, customReason?: string) =>
      fetch(`${B}/revoke`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId, reason, customReason }) })
        .then(jsonOrThrow<{ success: boolean; certificate: SerializedCertificate }>),
    restore: (certificateId: string) =>
      fetch(`${B}/restore`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId }) })
        .then(jsonOrThrow<{ success: boolean; certificate: SerializedCertificate }>),

    // ── In-place regeneration (GA-4 S2) ──
    // Re-renders EXISTING certificates against the event's current active template. The
    // certificateId and verificationToken are preserved and no new record is created — this
    // is deliberately NOT the issue/generate endpoint, which is idempotent per
    // (eventId, registrationId, certificateType) and would silently return the old record.
    //
    // The route answers 200 even when every item failed, so the caller MUST read
    // `results[].ok` rather than trusting the HTTP status. The shape below is the route's
    // own, unchanged.
    regenerate: (certificateIds: string[]) =>
      fetch(`${B}/regenerate`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateIds }) })
        .then(jsonOrThrow<CertificateRegenerateResponse>),

    // ── Permanent deletion (one endpoint for one certificate or many) ──
    // Individual delete is a batch of one, so the browser never fires N independent deletion
    // requests. Same 200-with-per-item-outcomes contract as regenerate above.
    remove: (certificateIds: string[]) =>
      fetch(`${B}/delete`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateIds }) })
        .then(jsonOrThrow<CertificateDeleteResponse>),

    // ── Authenticated certificate file download (organizer bypass) ──
    // Fetches with the organizer's Bearer token so the /file route's organizer
    // bypass applies regardless of download settings; returns an object URL.
    downloadCertificateObjectUrl: async (certificateId: string): Promise<string> => {
      const res = await fetch(`/api/certificates/${certificateId}/file`, { headers: auth })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Download failed (${res.status})`)
      }
      return URL.createObjectURL(await res.blob())
    },

    // ── Attendees (reuse existing registrations endpoint) ──
    getConfirmedAttendees: () =>
      fetch(`/api/organizer/events/${eventId}/registrations?all=true`, { headers: auth })
        .then(jsonOrThrow<RegistrationsApiResponse>),
  }
}

export type CertApi = ReturnType<typeof makeCertApi>
