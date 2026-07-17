// Certificate Hub — typed client wrappers over the EXISTING certificate APIs.
// No new endpoints (except the read-only /records list). All calls carry the
// organizer Bearer token.

import type { CertificateRecordsResponse } from '@/app/api/organizer/events/[eventId]/certificates/records/route'
import type { SettingsResponse }           from '@/app/api/organizer/events/[eventId]/certificates/settings/route'
import type { TemplatesListResponse }      from '@/app/api/organizer/events/[eventId]/certificates/templates/route'
import type { JobsListResponse }           from '@/app/api/organizer/events/[eventId]/certificates/jobs/route'
import type { JobProcessResponse }         from '@/app/api/organizer/events/[eventId]/certificates/jobs/[jobId]/process/route'
import type { RegistrationsApiResponse }   from '@/app/api/organizer/events/[eventId]/registrations/route'
import type {
  CertificateSettingsInput, CertificateSettingsPatch,
  SerializedCertificateTemplateDoc, SerializedCertificate, SerializedCertificateJob,
  CertificateType, TemplateType, CertificateJobScope, RevocationReason,
} from '@/lib/certificates/types'

export type HubTab = 'overview' | 'settings' | 'templates' | 'programs' | 'brandkit' | 'issue' | 'recipients'

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
    getRecords: () => fetch(`${B}/records`, { headers: auth }).then(jsonOrThrow<CertificateRecordsResponse>),

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
    createTemplate: (body: { name: string; templateType: TemplateType; fileUrl: string; fileName: string }) =>
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
    createJob: (body: { scope: CertificateJobScope; certificateType?: CertificateType; registrationIds?: string[] | null; autoEmail: boolean }) =>
      fetch(`${B}/jobs`, { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) })
        .then(jsonOrThrow<{ success: boolean; job: SerializedCertificateJob }>),
    listJobs: () => fetch(`${B}/jobs`, { headers: auth }).then(jsonOrThrow<JobsListResponse>),
    processJob: (jobId: string) =>
      fetch(`${B}/jobs/${jobId}/process`, { method: 'POST', headers: auth }).then(jsonOrThrow<JobProcessResponse>),
    cancelJob: (jobId: string) =>
      fetch(`${B}/jobs/${jobId}/cancel`, { method: 'POST', headers: auth }).then(jsonOrThrow<{ status: string }>),

    // ── Email ──
    emailCertificate: (certificateId: string, resend: boolean) =>
      fetch(`${B}/email`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId, resend }) })
        .then(jsonOrThrow<{ success: boolean; skipped: boolean }>),

    // ── Revocation ──
    revoke: (certificateId: string, reason: RevocationReason, customReason?: string) =>
      fetch(`${B}/revoke`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId, reason, customReason }) })
        .then(jsonOrThrow<{ success: boolean; certificate: SerializedCertificate }>),
    restore: (certificateId: string) =>
      fetch(`${B}/restore`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ certificateId }) })
        .then(jsonOrThrow<{ success: boolean; certificate: SerializedCertificate }>),

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
