// Certificate generation engine — server-only.
// Orchestrates the full pipeline: idempotency check → generate ids/token →
// resolve placeholders → render file → upload → write the certificates record.
//
// Reused by manual single generation (Phase 5) and bulk jobs (Phase 7).

import { generateVerificationToken } from './id'
import { renderCertificatePdf }     from './render'
import {
  findCertificate,
  createCertificate,
  getCertificate,
  getActiveTemplate,
  recordCertificateRegeneration,
  reserveCertificateId,
  releaseCertificateClaim,
  getSettings,
  recordTemplateUsage,
  assertRegistrationEligibleForCertificate,
} from './firestore'
import { emailCertificate } from './email'
import { chargeCertificate } from './billing'
import { sendCertificateWhatsApp } from './whatsapp'
import { uploadServerFile }         from '@/lib/firebase/storage/admin'
import { generatedCertificatePath } from './constants'
import { safeFetchBytes, validateEventTemplateUrl, validateGlobalTemplateUrl } from './urlGuard'
import { APP_URL }                  from '@/lib/env'
import { enqueueWebhook }           from '@/lib/integrations/webhooks'
import { crmRecordCertificate }     from '@/lib/crm/service'
import { captureError, captureFinancialError } from '@/lib/monitoring/sentry'
import type { PlaceholderContext, PlaceholderKey } from './placeholders'
import type {
  Certificate,
  CertificateInput,
  CertificateType,
  CertificateSource,
  CertificateTemplateDoc,
  CertificateLayout,
} from './types'

/** All the resolved data needed to fill a certificate's placeholders. */
export interface GenerateContextInput {
  eventId:       string
  eventSlug:     string
  organizerUid:  string
  eventName:     string
  eventDate:     string        // pre-formatted, e.g. "15 June 2026"
  eventLocation: string
  organizerName: string
  registrationId: string
  attendeeName:  string
  attendeeEmail: string
  ticketCode:    string
  // Sports / timed-event fields (empty when not applicable)
  bibNumber:     string
  distance:      string
  finishTime:    string
  position:      string
  category:      string
}

export interface GenerateCertificateParams {
  input:           GenerateContextInput
  certificateType: CertificateType
  source:          CertificateSource
  template:        CertificateTemplateDoc
  jobId?:          string | null
  /** Operator who triggered issuance (attribution). Defaults to the workspace
   *  owner (organizerUid) when omitted — e.g. fully automatic generation. */
  issuedBy?:       string | null
  /**
   * Auto-email control. `undefined` (default) ⇒ send iff settings.autoEmail is
   * enabled. `true`/`false` ⇒ explicit override (bulk passes the job's choice).
   */
  email?:          boolean
  /**
   * Pre-fetched template + asset bytes (R-5). When provided (bulk passes one
   * fetch per chunk), the engine skips fetching. Omit for single generation.
   */
  prefetched?:     RenderAssets
}

export interface GenerateCertificateResult {
  certificate: Certificate
  created:     boolean   // false when an existing certificate was returned (idempotent)
  emailed?:    boolean   // true when an email was sent as part of generation
  charged?:    boolean   // true when the wallet was debited for this certificate (GA-4 S2)
}

function formatToday(): string {
  return new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

export interface RenderAssets {
  templateBytes: Uint8Array
  assets:        Map<string, Uint8Array>   // image asset bytes by URL
}

/**
 * Fetches the template file plus every distinct image asset referenced by the
 * template's layout — every URL is SSRF-validated (must be a Firebase Storage
 * object inside this event's own folder) and fetched without redirect-following.
 * Bulk processing calls this ONCE per chunk and reuses the result.
 */
export async function loadRenderAssets(
  template: CertificateTemplateDoc,
  layoutOverride?: CertificateLayout | null,
): Promise<RenderAssets> {
  // A template file / asset is valid if it lives under THIS event's own prefix OR the
  // trusted admin-curated global-templates prefix (GA-6 S5 import). Both are Firebase
  // Storage URLs — SSRF-safe. Event ownership is checked first.
  const checkTemplateUrl = (url: string) => {
    const ev = validateEventTemplateUrl(url, template.organizerUid, template.eventId)
    return ev.ok ? ev : validateGlobalTemplateUrl(url)
  }

  // Template file — validated (was previously fetched unguarded: SSRF P0).
  const templateBytes = await safeFetchBytes(template.fileUrl, checkTemplateUrl(template.fileUrl))

  const assets = new Map<string, Uint8Array>()
  const elements = (layoutOverride ?? template.layout)?.elements ?? []
  const urls = new Set<string>()
  for (const el of elements) {
    if (el.type === 'image' && el.assetUrl) urls.add(el.assetUrl)
  }
  await Promise.all([...urls].map(async url => {
    // Asset fetch is best-effort: a blocked/failed asset is skipped, not fatal.
    const bytes = await safeFetchBytes(url, checkTemplateUrl(url)).catch(() => null)
    if (bytes) assets.set(url, bytes)
  }))

  return { templateBytes, assets }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * When another request owns generation (claim already exists but the file isn't
 * written yet), wait briefly for the certificate record to appear. Returns null
 * if it never does within the window (owner still working, or it failed and
 * released the claim — a later call will regenerate).
 */
async function waitForCertificate(certificateId: string): Promise<Certificate | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cert = await getCertificate(certificateId)
    if (cert) return cert
    await sleep(300)
  }
  return null
}

/** Raised when a concurrent request owns generation and it isn't ready yet. */
export class CertificateInProgressError extends Error {
  constructor() {
    super('Certificate generation is already in progress')
    this.name = 'CertificateInProgressError'
  }
}

/** Resolves the full placeholder context for a certificate. */
function buildContext(
  input: GenerateContextInput,
  certificateId: string,
  issueDate: string,
): PlaceholderContext {
  return {
    participantName: input.attendeeName,
    eventName:       input.eventName,
    eventDate:       input.eventDate,
    eventLocation:   input.eventLocation,
    registrationId:  input.registrationId,
    ticketCode:      input.ticketCode,
    certificateId,
    issueDate,
    organizerName:   input.organizerName,
    bibNumber:       input.bibNumber,
    distance:        input.distance,
    finishTime:      input.finishTime,
    position:        input.position,
    category:        input.category,
  }
}

/** Snapshot of non-empty resolved placeholder values, stored on the record. */
function snapshotData(context: PlaceholderContext): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(context)) {
    if (v !== '' && v !== null && v !== undefined) out[k] = v as string | number
  }
  return out
}

/**
 * Generates a single certificate. Idempotent over
 * (eventId, registrationId, certificateType): if one already exists it is
 * returned unchanged with `created: false`.
 */
export async function generateCertificate(
  params: GenerateCertificateParams,
): Promise<GenerateCertificateResult> {
  const { input, certificateType, source, template } = params
  const { eventId, registrationId } = input

  // 0. Eligibility gate (P7.1) — never issue to a cancelled/rejected/refunded
  //    registration. Authoritative server-side check; throws when ineligible.
  await assertRegistrationEligibleForCertificate(registrationId)

  // 1. Fast path — return an already-completed certificate (also covers any
  //    pre-claim records). Strongly consistent Firestore query.
  const existing = await findCertificate(eventId, registrationId, certificateType)
  if (existing) return { certificate: existing, created: false }

  // 2. Deterministic claim — atomically reserve the certificateId for this tuple.
  //    Only the caller that creates the claim (`owned`) proceeds to generate.
  const { certificateId, owned } = await reserveCertificateId(eventId, registrationId, certificateType)

  if (!owned) {
    // Another request owns generation; wait briefly for its record to appear.
    const cert = await waitForCertificate(certificateId)
    if (cert) return { certificate: cert, created: false }
    throw new CertificateInProgressError()
  }

  // 3. We own generation. Any failure releases the claim so a retry can recover.
  try {
    const verificationToken = generateVerificationToken()
    const issueDate         = formatToday()
    const verifyUrl         = `${APP_URL}/verify/certificate/${certificateId}`

    // Resolve placeholders.
    const context = buildContext(input, certificateId, issueDate)

    // Render the certificate file from the active template + its layout.
    const { templateBytes, assets } = params.prefetched ?? await loadRenderAssets(template)
    const pdfBytes = await renderCertificatePdf({
      templateBytes,
      templateType: template.templateType,
      dimensions:   template.dimensions,
      context,
      verifyUrl,
      layout:       template.layout ?? null,
      assets,
    })

    // Upload the generated file.
    const path = generatedCertificatePath(eventId, certificateId)
    const { url } = await uploadServerFile(path, pdfBytes, 'application/pdf')

    // Persist the certificate record (new `certificates` collection).
    const certInput: CertificateInput = {
      certificateId,
      verificationToken,
      eventId,
      eventSlug:      input.eventSlug,
      organizerUid:   input.organizerUid,
      issuedBy:       params.issuedBy ?? input.organizerUid,
      registrationId,
      attendeeName:   input.attendeeName,
      attendeeEmail:  input.attendeeEmail,
      eventName:      input.eventName,
      eventDate:      input.eventDate,
      certificateType,
      templateId:     template.templateId,
      fileUrl:        url,
      fileSize:       pdfBytes.length,
      source,
      data:           snapshotData(context),
      jobId:          params.jobId ?? null,
    }
    const certificate = await createCertificate(certInput)

    // Wallet billing (GA-4 S2). Idempotent + config-driven; runs on the create path
    // only, so a re-issued/duplicate tuple (which returns early above) never charges
    // twice. Best-effort: an insufficient balance skips the charge but never fails an
    // already-issued certificate (the result carries the outcome for surfacing).
    const billing = await chargeCertificate({
      organizerUid: input.organizerUid, certificateId, eventId, eventName: input.eventName,
    }).catch(err => {
      // A billing infra error must not fail an already-issued certificate, but a
      // silent money-path failure must raise an alert (same as payment/webhook paths).
      captureFinancialError(err, { scope: 'certificate_billing', area: 'financial', certificateId, eventId, organizerUid: input.organizerUid })
      return null
    })
    const charged = billing?.charged === true

    // Auto-email: explicit override wins; otherwise honor settings.autoEmail.
    let shouldEmail = params.email
    if (shouldEmail === undefined) {
      const settings = await getSettings(eventId)
      shouldEmail = settings?.autoEmail.enabled ?? false
    }

    let emailed = false
    if (shouldEmail) {
      // Best-effort — a delivery failure must not fail generation. Reuse the
      // in-memory PDF so we don't re-fetch what we just uploaded.
      const r = await emailCertificate(certificate, { pdfBytes })
        .catch(err => { captureError(err, { scope: 'certificate_email', area: 'certificate', certificateId }); return null })
      emailed = r?.success ?? false
    }

    // WhatsApp delivery (GA-4 S2) — automatically sent after successful generation.
    // Fire-and-forget; reuses the Notification/WhatsApp engine + certificate_ready
    // template. Never throws (a delivery problem must not fail generation).
    void sendCertificateWhatsApp({
      certificateId,
      registrationId,
      organizerUid:  input.organizerUid,
      eventSlug:     input.eventSlug,
      attendeeName:  input.attendeeName,
      eventName:     input.eventName,
    })

    // Organizer webhook (fire-and-forget; no-op when no webhook configured).
    void enqueueWebhook(input.organizerUid, 'certificate.issued', {
      certificateId, registrationId, eventSlug: input.eventSlug, attendeeName: input.attendeeName,
    }).catch(() => {})

    // Template usage analytics (GA-6 S5) — fire-and-forget, counts one generation.
    void recordTemplateUsage(template.templateId)

    // CRM certificate activity (fire-and-forget, idempotent).
    crmRecordCertificate({
      organizerUid: input.organizerUid, email: input.attendeeEmail, name: input.attendeeName,
      certificateId, eventSlug: input.eventSlug,
    })

    return { certificate, created: true, emailed, charged }
  } catch (err) {
    // Render/upload/persist failure — alert (same helpers as payment/webhook paths).
    // Retry is unaffected: the claim is still released and the error still re-thrown.
    captureError(err, { scope: 'certificate_generation', area: 'certificate', eventId, registrationId, certificateType })
    await releaseCertificateClaim(eventId, registrationId, certificateType)
    throw err
  }
}

/** Rebuild the placeholder context from a certificate's stored value snapshot. */
function contextFromSnapshot(data: Record<string, string | number> | undefined, certificateId: string): PlaceholderContext {
  const g = (k: string): string => {
    const v = data?.[k]
    return v === undefined || v === null ? '' : String(v)
  }
  return {
    participantName: g('participantName'), eventName: g('eventName'), eventDate: g('eventDate'),
    eventLocation: g('eventLocation'), registrationId: g('registrationId'), ticketCode: g('ticketCode'),
    certificateId, issueDate: g('issueDate'), organizerName: g('organizerName'),
    bibNumber: g('bibNumber'), distance: g('distance'), finishTime: g('finishTime'),
    position: g('position'), category: g('category'),
  }
}

/**
 * Regenerates an EXISTING certificate in place (GA-4 S2) — re-renders it against the
 * event's CURRENT active template (i.e. after a template/layout update) and OVERWRITES
 * the stored PDF at the same path. The certificateId + verificationToken are preserved,
 * so verification (URL / QR / public page) is unaffected, and NO duplicate record is
 * created. Revoked certificates are never regenerated. Not re-billed (already charged).
 */
/** GA-7C S2: resolve the event's active template + render assets ONCE so a batch
 *  regenerate can reuse them across every certificate (same RenderAssets cache the
 *  bulk generator uses) instead of re-fetching the template file + images per cert. */
export async function prefetchRegenAssets(
  eventId: string,
  organizerUid: string,
): Promise<{ template: CertificateTemplateDoc; render: RenderAssets } | null> {
  const template = await getActiveTemplate(eventId, organizerUid)
  if (!template) return null
  return { template, render: await loadRenderAssets(template) }
}

export async function regenerateCertificate(
  certificateId: string,
  opts?: { actorUid?: string; prefetched?: { template: CertificateTemplateDoc; render: RenderAssets } },
): Promise<{ ok: true; certificate: Certificate } | { ok: false; error: string }> {
  const existing = await getCertificate(certificateId)
  if (!existing) return { ok: false, error: 'not_found' }
  if (existing.status === 'revoked') return { ok: false, error: 'revoked' }

  // GA-7C S2: reuse a caller-supplied template + render-asset cache when provided
  // (batch regenerate), falling back to a per-cert fetch for the single-cert path —
  // identical rendering either way.
  const template = opts?.prefetched?.template ?? await getActiveTemplate(existing.eventId, existing.organizerUid)
  if (!template) return { ok: false, error: 'no_active_template' }

  const verifyUrl = `${APP_URL}/verify/certificate/${certificateId}`
  const context   = contextFromSnapshot(existing.data, certificateId)
  const { templateBytes, assets } = opts?.prefetched?.render ?? await loadRenderAssets(template)
  const pdfBytes = await renderCertificatePdf({
    templateBytes,
    templateType: template.templateType,
    dimensions:   template.dimensions,
    context,
    verifyUrl,
    layout:       template.layout ?? null,
    assets,
  })

  const path = generatedCertificatePath(existing.eventId, certificateId)
  const { url } = await uploadServerFile(path, pdfBytes, 'application/pdf')
  await recordCertificateRegeneration(certificateId, { fileUrl: url, fileSize: pdfBytes.length, templateId: template.templateId }, opts?.actorUid)

  return { ok: true, certificate: { ...existing, fileUrl: url, fileSize: pdfBytes.length, templateId: template.templateId } }
}

// Re-export for callers that want the placeholder key type without a second import.
export type { PlaceholderKey }
