// Certificate Firestore operations — server-only.
// All reads and writes go through adminDb (Firebase Admin SDK).

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { deleteServerFile } from '@/lib/firebase/storage/admin'
import { validateStorageUrl } from './urlGuard'
import { COLLECTIONS, REVOCATION_REASON_LABELS } from './constants'
import { Timestamp } from 'firebase-admin/firestore'
import { generateTemplateId, generateCertificateId, certificateClaimId, generateJobId } from './id'
import {
  defaultCertificateSettings,
  mergeCertificateSettings,
  settingsToInput,
  CERTIFICATE_SCHEMA_VERSION,
} from './types'
import * as jobKernel from '@/lib/jobs/kernel'
import type { ChunkCommit, LeaseReason, ChunkResult } from '@/lib/jobs/kernel'
// Re-export the generic job types so existing importers of './firestore' keep working.
export type { ChunkCommit, LeaseReason } from '@/lib/jobs/kernel'
import type {
  CertificateTemplate,
  CertificateRecord,
  CertificateTemplateInput,
  CertificateSettings,
  CertificateSettingsInput,
  CertificateSettingsPatch,
  CertificateTemplateDoc,
  CertificateDimensions,
  TemplateType,
  Certificate,
  CertificateInput,
  CertificateType,
  CertificateJob,
  CertificateJobInput,
  EmailHistoryEntry,
  CertificateEmailStatus,
  RevocationReason,
  RevocationHistoryEntry,
  CertificateLayout,
} from './types'

// ─── Service errors ─────────────────────────────────────────────────────────
// Thrown by the service layer; routes map `.code` to an HTTP status.

export type CertificateErrorCode = 'not_found' | 'forbidden' | 'conflict'

export class CertificateServiceError extends Error {
  constructor(public code: CertificateErrorCode, message: string) {
    super(message)
    this.name = 'CertificateServiceError'
  }
}

/** Thrown when a registration is not eligible to receive a certificate. */
export class CertificateIneligibleError extends Error {
  constructor(public readonly reason: string) {
    super(`Registration is not eligible for a certificate: ${reason}`)
    this.name = 'CertificateIneligibleError'
  }
}

/**
 * Server-side eligibility gate (P7.1). Loads the registration authoritatively and
 * throws CertificateIneligibleError when it must NOT receive a certificate:
 * cancelled / rejected registrations, or refunded payments (a refund leaves
 * status === 'confirmed', so paymentStatus must be checked separately). Called at
 * every generation chokepoint so no path can bypass it.
 */
export async function assertRegistrationEligibleForCertificate(registrationId: string): Promise<void> {
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) throw new CertificateIneligibleError('not_found')
  const reg = snap.data() as { status?: string; paymentStatus?: string }
  if (reg.status === 'cancelled' || reg.status === 'rejected') {
    throw new CertificateIneligibleError(reg.status)
  }
  if (reg.paymentStatus === 'refunded') {
    throw new CertificateIneligibleError('refunded')
  }
}

// ─── Template ─────────────────────────────────────────────────────────────────

/** Load the certificate template for an event. Returns null if not configured. */
export async function getTemplate(eventId: string): Promise<CertificateTemplate | null> {
  const snap = await adminDb.collection('certificateTemplates').doc(eventId).get()
  return snap.exists ? (snap.data() as CertificateTemplate) : null
}

/**
 * Create-or-update the certificate template for an event.
 * Only the organizer (createdBy) may save — ownership is enforced by the
 * API route, not here.
 */
export async function saveTemplate(
  eventId: string,
  input:   CertificateTemplateInput,
  uid:     string,
): Promise<void> {
  const ref    = adminDb.collection('certificateTemplates').doc(eventId)
  const exists = (await ref.get()).exists

  if (exists) {
    await ref.update({ ...input, updatedAt: FieldValue.serverTimestamp() })
  } else {
    await ref.set({
      ...input,
      eventId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    })
  }
}

// ─── Settings (Phase 3) ───────────────────────────────────────────────────────
// certificateSettings/{eventId} — operational config, separate from the template.
// Ownership is enforced by the API route, not here.

/** Load certificate settings for an event. Returns null if never configured. */
export async function getSettings(eventId: string): Promise<CertificateSettings | null> {
  const snap = await adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId).get()
  return snap.exists ? (snap.data() as CertificateSettings) : null
}

/** Create-or-replace the full settings document. Returns the stored value. */
export async function saveSettings(
  eventId: string,
  input:   CertificateSettingsInput,
  uid:     string,
): Promise<CertificateSettings> {
  const ref    = adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId)
  const exists = (await ref.get()).exists

  if (exists) {
    await ref.update({ ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid })
  } else {
    await ref.set({
      ...input,
      eventId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    })
  }
  return (await ref.get()).data() as CertificateSettings
}

/**
 * Apply a partial update atomically: read current settings (or defaults),
 * deep-merge the patch, and write. Creates the doc if it doesn't exist.
 * Returns the stored value.
 */
export async function patchSettings(
  eventId: string,
  patch:   CertificateSettingsPatch,
  uid:     string,
): Promise<CertificateSettings> {
  const ref = adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId)

  await adminDb.runTransaction(async tx => {
    const snap   = await tx.get(ref)
    const base   = snap.exists
      ? settingsToInput(snap.data() as CertificateSettings)
      : defaultCertificateSettings()
    const merged = mergeCertificateSettings(base, patch)

    if (snap.exists) {
      tx.update(ref, { ...merged, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid })
    } else {
      tx.set(ref, {
        ...merged,
        eventId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: uid,
      })
    }
  })

  return (await ref.get()).data() as CertificateSettings
}

// ─── Templates (Phase 4) ──────────────────────────────────────────────────────
// File-based templates (PDF/PNG/JPG) live in the certificateTemplates collection
// keyed by a random templateId. They always carry `templateType` + `organizerUid`,
// which the legacy eventId-keyed design doc does not — so the two never collide
// and queries scoped by organizerUid only ever return file-based templates.

const templatesCol = () => adminDb.collection(COLLECTIONS.TEMPLATES)

/** Fields the service needs to persist a new template (metadata is server-derived). */
export interface CreateTemplateData {
  eventId:      string
  name:         string
  templateType: TemplateType
  fileUrl:      string
  fileName:     string
  fileSize:     number
  dimensions:   CertificateDimensions | null
  pageCount:    number | null
}

/** Loads a file-based template by id. Returns null if missing or not a file template. */
export async function getTemplateById(templateId: string): Promise<CertificateTemplateDoc | null> {
  const snap = await templatesCol().doc(templateId).get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown>
  // Discriminator guard: the legacy design doc has neither field.
  if (typeof data.templateType !== 'string' || typeof data.organizerUid !== 'string') return null
  return data as unknown as CertificateTemplateDoc
}

/** Loads a template and asserts it belongs to the given event + organizer. */
async function requireOwnedTemplate(
  eventId: string,
  templateId: string,
  uid: string,
): Promise<CertificateTemplateDoc> {
  const tpl = await getTemplateById(templateId)
  if (!tpl) throw new CertificateServiceError('not_found', 'Template not found')
  if (tpl.eventId !== eventId || tpl.organizerUid !== uid) {
    throw new CertificateServiceError('forbidden', 'Template does not belong to this event')
  }
  return tpl
}

/** All file-based templates for an event owned by the organizer. */
export async function listTemplates(
  eventId: string,
  organizerUid: string,
): Promise<CertificateTemplateDoc[]> {
  const snap = await templatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .get()
  return snap.docs.map(d => d.data() as CertificateTemplateDoc)
}

/** The single active file-based template for an event, or null. */
export async function getActiveTemplate(
  eventId: string,
  organizerUid: string,
): Promise<CertificateTemplateDoc | null> {
  const snap = await templatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .where('isActive',     '==', true)
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as CertificateTemplateDoc)
}

/** Creates a new (inactive) template. Activation is an explicit, separate step. */
export async function createTemplate(
  data: CreateTemplateData,
  uid:  string,
): Promise<CertificateTemplateDoc> {
  const templateId = generateTemplateId()
  const ref = templatesCol().doc(templateId)
  await ref.set({
    templateId,
    eventId:       data.eventId,
    organizerUid:  uid,
    name:          data.name,
    templateType:  data.templateType,
    fileUrl:       data.fileUrl,
    fileName:      data.fileName,
    fileSize:      data.fileSize,
    dimensions:    data.dimensions,
    pageCount:     data.pageCount,
    isActive:      false,
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    createdAt:     FieldValue.serverTimestamp(),
    updatedAt:     FieldValue.serverTimestamp(),
    createdBy:     uid,
  })
  return (await ref.get()).data() as CertificateTemplateDoc
}

/**
 * Duplicates a certificate template as a new INACTIVE program (GA-6 S4). Reuses the
 * source's stored base file (same owner → same organizer-scoped URL, no re-upload) and
 * copies the design/program metadata. No rendering change.
 */
export async function duplicateCertificateTemplate(
  eventId: string,
  templateId: string,
  uid: string,
): Promise<CertificateTemplateDoc | null> {
  const src = await getTemplateById(templateId)
  if (!src || src.eventId !== eventId || src.organizerUid !== uid) return null

  const newId = generateTemplateId()
  const ref = templatesCol().doc(newId)
  const doc: Record<string, unknown> = {
    templateId:   newId,
    eventId,
    organizerUid: uid,
    name:         `${src.name} (Copy)`,
    templateType: src.templateType,
    fileUrl:      src.fileUrl,
    fileName:     src.fileName,
    fileSize:     src.fileSize,
    dimensions:   src.dimensions ?? null,
    pageCount:    src.pageCount ?? null,
    isActive:     false,
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    createdAt:    FieldValue.serverTimestamp(),
    updatedAt:    FieldValue.serverTimestamp(),
    createdBy:    uid,
  }
  if (src.layout)             doc.layout = src.layout
  if (src.certificateType)    doc.certificateType = src.certificateType
  if (src.programDescription) doc.programDescription = src.programDescription
  await ref.set(doc)
  return (await ref.get()).data() as CertificateTemplateDoc
}

/**
 * Imports an admin global template into an event as a new INACTIVE template (GA-6 S5).
 * Reuses the global's stored file URL (no re-upload — the renderer trusts the global
 * prefix) and copies its layout + metadata. Returns the new certificate template.
 */
export async function importGlobalTemplateIntoEvent(
  eventId: string,
  uid: string,
  global: {
    name: string; templateType: TemplateType; fileUrl: string; fileName: string; fileSize: number
    dimensions: CertificateDimensions | null; pageCount: number | null
    layout?: CertificateLayout; certificateType?: CertificateType; description?: string
    category?: string; tags?: string[]; thumbnailUrl?: string
  },
): Promise<CertificateTemplateDoc> {
  const newId = generateTemplateId()
  const ref = templatesCol().doc(newId)
  const doc: Record<string, unknown> = {
    templateId: newId, eventId, organizerUid: uid,
    name: global.name, templateType: global.templateType, fileUrl: global.fileUrl,
    fileName: global.fileName, fileSize: global.fileSize,
    dimensions: global.dimensions ?? null, pageCount: global.pageCount ?? null,
    isActive: false, status: 'draft', schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid,
  }
  if (global.layout)          doc.layout = global.layout
  if (global.certificateType) doc.certificateType = global.certificateType
  if (global.description)      doc.programDescription = global.description
  if (global.category)         doc.category = global.category
  if (global.tags?.length)     doc.tags = global.tags
  if (global.thumbnailUrl)     doc.thumbnailUrl = global.thumbnailUrl
  await ref.set(doc)
  return (await ref.get()).data() as CertificateTemplateDoc
}

/**
 * Records that a certificate was generated from a template (GA-6 S5 analytics).
 * Increments usageCount + stamps lastUsedAt. Best-effort, never throws — a metrics
 * write must never fail generation. No new analytics engine: it's one field bump.
 */
export async function recordTemplateUsage(templateId: string): Promise<void> {
  try {
    await templatesCol().doc(templateId).update({
      usageCount: FieldValue.increment(1),
      lastUsedAt: FieldValue.serverTimestamp(),
    })
  } catch { /* template may be legacy/missing — usage tracking is best-effort */ }
}

/** Sets governance metadata (status / favorite / category / tags / visibility). */
export async function patchTemplateMeta(
  eventId: string,
  templateId: string,
  uid: string,
  patch: Partial<Pick<CertificateTemplateDoc, 'status' | 'favorite' | 'category' | 'tags' | 'visibility' | 'programDescription' | 'certificateType'>>,
): Promise<CertificateTemplateDoc> {
  await requireOwnedTemplate(eventId, templateId, uid)
  const ref = templatesCol().doc(templateId)
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
  return (await ref.get()).data() as CertificateTemplateDoc
}

/** Renames a template. */
export async function renameTemplate(
  eventId: string,
  templateId: string,
  uid: string,
  name: string,
): Promise<CertificateTemplateDoc> {
  await requireOwnedTemplate(eventId, templateId, uid)
  const ref = templatesCol().doc(templateId)
  await ref.update({ name, updatedAt: FieldValue.serverTimestamp() })
  return (await ref.get()).data() as CertificateTemplateDoc
}

/**
 * Saves the builder layout onto a template (Phase 10). Verifies ownership +
 * event. Stamps layoutUpdatedAt. Does not affect already-issued certificates.
 */
export async function saveTemplateLayout(
  eventId: string,
  templateId: string,
  uid: string,
  layout: CertificateLayout,
): Promise<CertificateTemplateDoc> {
  const existing = await requireOwnedTemplate(eventId, templateId, uid)
  const ref = templatesCol().doc(templateId)
  await ref.update({
    layout,
    layoutUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  })

  // Reclaim image assets dropped from the layout by this save, unless this
  // template's new layout (or any other template) still references them. Never
  // touches the template file. Best-effort — a Storage failure can't fail the save.
  const removed = layoutAssetPaths(existing.layout)
  for (const p of layoutAssetPaths(layout)) removed.delete(p)
  if (removed.size > 0) {
    const others = (await listTemplates(eventId, uid)).filter(t => t.templateId !== templateId)
    await deleteUnreferencedPaths(removed, [...others, { fileUrl: existing.fileUrl, layout }])
  }

  return (await ref.get()).data() as CertificateTemplateDoc
}

/**
 * Activates a template, enforcing the single-active-per-event rule atomically:
 * deactivates any other active template for the event, activates this one, and
 * syncs certificateSettings.activeTemplateId (creating settings from defaults if
 * they don't exist yet). Ownership/event/existence are verified inside the txn.
 */
export async function activateTemplate(
  eventId: string,
  templateId: string,
  uid: string,
): Promise<CertificateTemplateDoc> {
  const tplRef      = templatesCol().doc(templateId)
  const settingsRef = adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId)

  await adminDb.runTransaction(async tx => {
    // ── reads first ──
    const tplSnap = await tx.get(tplRef)
    if (!tplSnap.exists) throw new CertificateServiceError('not_found', 'Template not found')
    const tpl = tplSnap.data() as Record<string, unknown>
    if (typeof tpl.templateType !== 'string') {
      throw new CertificateServiceError('not_found', 'Template not found')
    }
    if (tpl.eventId !== eventId || tpl.organizerUid !== uid) {
      throw new CertificateServiceError('forbidden', 'Template does not belong to this event')
    }

    const activeSnap = await tx.get(
      templatesCol()
        .where('eventId',      '==', eventId)
        .where('organizerUid', '==', uid)
        .where('isActive',     '==', true),
    )
    const settingsSnap = await tx.get(settingsRef)

    // ── writes ──
    activeSnap.docs.forEach(d => {
      if (d.id !== templateId) tx.update(d.ref, { isActive: false, updatedAt: FieldValue.serverTimestamp() })
    })
    tx.update(tplRef, { isActive: true, updatedAt: FieldValue.serverTimestamp() })

    if (settingsSnap.exists) {
      tx.update(settingsRef, {
        activeTemplateId: templateId,
        updatedAt:        FieldValue.serverTimestamp(),
        updatedBy:        uid,
      })
    } else {
      tx.set(settingsRef, {
        ...defaultCertificateSettings(),
        activeTemplateId: templateId,
        eventId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: uid,
      })
    }
  })

  return (await tplRef.get()).data() as CertificateTemplateDoc
}

/**
 * Deactivates a template and clears certificateSettings.activeTemplateId if it
 * pointed at this template.
 */
export async function deactivateTemplate(
  eventId: string,
  templateId: string,
  uid: string,
): Promise<CertificateTemplateDoc> {
  const tplRef      = templatesCol().doc(templateId)
  const settingsRef = adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId)

  await adminDb.runTransaction(async tx => {
    const tplSnap = await tx.get(tplRef)
    if (!tplSnap.exists) throw new CertificateServiceError('not_found', 'Template not found')
    const tpl = tplSnap.data() as Record<string, unknown>
    if (typeof tpl.templateType !== 'string') {
      throw new CertificateServiceError('not_found', 'Template not found')
    }
    if (tpl.eventId !== eventId || tpl.organizerUid !== uid) {
      throw new CertificateServiceError('forbidden', 'Template does not belong to this event')
    }
    const settingsSnap = await tx.get(settingsRef)

    tx.update(tplRef, { isActive: false, updatedAt: FieldValue.serverTimestamp() })

    if (settingsSnap.exists && (settingsSnap.data() as CertificateSettings).activeTemplateId === templateId) {
      tx.update(settingsRef, {
        activeTemplateId: null,
        updatedAt:        FieldValue.serverTimestamp(),
        updatedBy:        uid,
      })
    }
  })

  return (await tplRef.get()).data() as CertificateTemplateDoc
}

// ─── Storage cleanup helpers (Phase P1-3) ─────────────────────────────────────
// Builder image assets live under the event's template prefix; the template file
// lives at fileUrl. Both are owned by the template doc, so deleting/editing a
// template must reclaim the Storage objects it no longer references.

/** Storage object paths of a layout's image assets (excludes the template file). */
function layoutAssetPaths(layout?: CertificateLayout): Set<string> {
  const paths = new Set<string>()
  for (const el of layout?.elements ?? []) {
    if (el.type === 'image' && el.assetUrl) {
      const c = validateStorageUrl(el.assetUrl)
      if (c.ok && c.objectPath) paths.add(c.objectPath)
    }
  }
  return paths
}

/** Every Storage object a template owns: its file + its layout image assets. */
function templateStoragePaths(tpl: Pick<CertificateTemplateDoc, 'fileUrl' | 'layout'>): Set<string> {
  const paths = layoutAssetPaths(tpl.layout)
  if (tpl.fileUrl) {
    const c = validateStorageUrl(tpl.fileUrl)
    if (c.ok && c.objectPath) paths.add(c.objectPath)
  }
  return paths
}

/**
 * Deletes Storage objects in `candidates` that NO template in `keep` still
 * references. Best-effort and partial-failure-safe: deleteServerFile never
 * throws (ignoreNotFound + swallow), so one failed delete cannot abort the rest
 * or the caller. Returns the paths attempted for deletion.
 */
async function deleteUnreferencedPaths(
  candidates: Set<string>,
  keep:       Array<Pick<CertificateTemplateDoc, 'fileUrl' | 'layout'>>,
): Promise<string[]> {
  if (candidates.size === 0) return []
  const referenced = new Set<string>()
  for (const t of keep) for (const p of templateStoragePaths(t)) referenced.add(p)

  const orphans = [...candidates].filter(p => !referenced.has(p))
  await Promise.all(orphans.map(p => deleteServerFile(p)))
  return orphans
}

/**
 * Deletes a template document and clears settings.activeTemplateId if needed,
 * then reclaims its Storage objects (template file + builder image assets) that
 * no other template for the event still references. Storage cleanup runs after
 * the record is gone and is best-effort, so a Storage hiccup never leaves the
 * Firestore record half-deleted. Returns the deleted fileUrl + reclaimed paths.
 */
export async function deleteTemplate(
  eventId: string,
  templateId: string,
  uid: string,
): Promise<{ fileUrl: string; deletedPaths: string[] }> {
  const tpl = await requireOwnedTemplate(eventId, templateId, uid)
  const tplRef      = templatesCol().doc(templateId)
  const settingsRef = adminDb.collection(COLLECTIONS.SETTINGS).doc(eventId)

  await adminDb.runTransaction(async tx => {
    const settingsSnap = await tx.get(settingsRef)
    tx.delete(tplRef)
    if (settingsSnap.exists && (settingsSnap.data() as CertificateSettings).activeTemplateId === templateId) {
      tx.update(settingsRef, {
        activeTemplateId: null,
        updatedAt:        FieldValue.serverTimestamp(),
        updatedBy:        uid,
      })
    }
  })

  // The record is now gone; listTemplates returns only the templates to keep.
  const remaining    = await listTemplates(eventId, uid)
  const deletedPaths = await deleteUnreferencedPaths(templateStoragePaths(tpl), remaining)

  return { fileUrl: tpl.fileUrl, deletedPaths }
}

// ─── Certificates (Phase 5 — new `certificates` collection) ────────────────────
// Separate from the legacy `certificateRecords` collection below. Generation
// writes ONLY here; the MVP collection is left untouched (no migration).

const certificatesCol = () => adminDb.collection(COLLECTIONS.CERTIFICATES)

/** Load a generated certificate by its public id (new collection). */
export async function getCertificate(certificateId: string): Promise<Certificate | null> {
  const snap = await certificatesCol().doc(certificateId).get()
  return snap.exists ? (snap.data() as Certificate) : null
}

/** All certificates for an event (new collection), organizer-scoped.
 *  NOTE: unbounded — prefer listEventCertificatesPage / listJobCertificates /
 *  getCertificatesByIds for large events (GA-7C P1-3). Retained for internal
 *  bounded callers. */
export async function listEventCertificates(
  eventId: string,
  organizerUid: string,
): Promise<Certificate[]> {
  const snap = await certificatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .get()
  return snap.docs.map(d => d.data() as Certificate)
}

/**
 * GA-7C P1-3: paginated page of an event's certificates, newest first. Mirrors the
 * registrations-list cursor pattern (orderBy + startAfter(cursorDoc) + limit+1).
 * Requires the composite index (eventId, organizerUid, generatedAt DESC).
 */
export async function listEventCertificatesPage(
  eventId: string,
  organizerUid: string,
  opts: { pageSize: number; cursor?: string | null },
): Promise<{ certificates: Certificate[]; hasMore: boolean; nextCursor: string | null }> {
  const base = certificatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .orderBy('generatedAt', 'desc')
  let q = base.limit(opts.pageSize + 1)
  if (opts.cursor) {
    const cur = await certificatesCol().doc(opts.cursor).get()
    if (cur.exists) q = base.startAfter(cur).limit(opts.pageSize + 1)
  }
  const snap = await q.get()
  const hasMore = snap.size > opts.pageSize
  const docs = hasMore ? snap.docs.slice(0, opts.pageSize) : snap.docs
  return {
    certificates: docs.map(d => d.data() as Certificate),
    hasMore,
    nextCursor: hasMore ? docs[docs.length - 1].id : null,
  }
}

/** Count of an event's certificates (new collection) — aggregation, no doc reads. */
export async function countEventCertificates(eventId: string, organizerUid: string): Promise<number> {
  const snap = await certificatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .count().get()
  return snap.data().count
}

/** Certificates produced by one bulk job (new collection), event + organizer scoped. */
export async function listJobCertificates(
  eventId: string,
  organizerUid: string,
  jobId: string,
): Promise<Certificate[]> {
  const snap = await certificatesCol()
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .where('jobId',        '==', jobId)
    .get()
  return snap.docs.map(d => d.data() as Certificate)
}

/** Certificates by id (new collection), event + organizer scoped via batched getAll. */
export async function getCertificatesByIds(
  eventId: string,
  organizerUid: string,
  ids: string[],
): Promise<Certificate[]> {
  if (ids.length === 0) return []
  const out: Certificate[] = []
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map(id => certificatesCol().doc(id))
    const snaps = await adminDb.getAll(...refs)
    for (const s of snaps) {
      if (!s.exists) continue
      const c = s.data() as Certificate
      if (c.eventId === eventId && c.organizerUid === organizerUid) out.push(c)
    }
  }
  return out
}

/**
 * Idempotency lookup: the existing certificate for a given
 * (eventId, registrationId, certificateType) tuple, or null.
 */
export async function findCertificate(
  eventId: string,
  registrationId: string,
  certificateType: CertificateType,
): Promise<Certificate | null> {
  const snap = await certificatesCol()
    .where('eventId',         '==', eventId)
    .where('registrationId',  '==', registrationId)
    .where('certificateType', '==', certificateType)
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as Certificate)
}

/**
 * Atomically reserves the certificateId for a (eventId, registrationId,
 * certificateType) tuple via a deterministic claim document. Returns the
 * reserved id and whether THIS caller created the claim (`owned: true` ⇒ this
 * caller must generate the file/record; `owned: false` ⇒ a claim already exists).
 *
 * Because the claim id is deterministic and the get-or-create runs inside a
 * transaction, concurrent requests for the same tuple can never both win — one
 * gets `owned: true`, the rest get `owned: false`.
 */
export async function reserveCertificateId(
  eventId: string,
  registrationId: string,
  certificateType: CertificateType,
): Promise<{ certificateId: string; owned: boolean }> {
  const claimRef = adminDb
    .collection(COLLECTIONS.CLAIMS)
    .doc(certificateClaimId(eventId, registrationId, certificateType))

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(claimRef)
    if (snap.exists) {
      return { certificateId: (snap.data() as { certificateId: string }).certificateId, owned: false }
    }
    const certificateId = generateCertificateId()
    tx.set(claimRef, {
      eventId,
      registrationId,
      certificateType,
      certificateId,
      createdAt: FieldValue.serverTimestamp(),
    })
    return { certificateId, owned: true }
  })
}

/** Releases a claim so generation can be retried after a failure. Best-effort. */
export async function releaseCertificateClaim(
  eventId: string,
  registrationId: string,
  certificateType: CertificateType,
): Promise<void> {
  await adminDb
    .collection(COLLECTIONS.CLAIMS)
    .doc(certificateClaimId(eventId, registrationId, certificateType))
    .delete()
    .catch(() => { /* non-fatal */ })
}

// ─── Stale-claim cleanup (Phase P1-4) ─────────────────────────────────────────
// A claim is created when generation reserves a certificateId. On success the
// certificate record is written; on failure releaseCertificateClaim removes it.
// If the process dies in between, the claim is orphaned: no certificate ever
// appears, so reserveCertificateId keeps returning owned:false and that
// (event, registration, type) tuple can never be (re)generated. A TTL sweep
// reclaims such claims.
//
// "Active" = a claim younger than the TTL — generation completes in seconds, so
// a TTL far longer than that can never describe an in-flight generation. Past
// the TTL a claim is vestigial: if its certificate exists, the strongly
// consistent findCertificate fast path already short-circuits generation (so the
// claim is redundant); if it doesn't, the claim is the orphan we must remove.
// Either way it is safe to delete, which also keeps the collection bounded.

/** Claims younger than this are treated as possibly-in-flight and never swept. */
export const CLAIM_TTL_MS = 15 * 60_000  // 15 minutes ≫ any real generation

export interface ClaimSweepResult { scanned: number; deleted: number; skipped: number }

/**
 * Deletes certificateClaims older than `ttlMs`, in a bounded batch. Each delete
 * runs in its own transaction that re-reads the claim and re-checks its age, so
 * the sweep is safe under concurrency with reserveCertificateId /
 * releaseCertificateClaim and with other sweep runs: a claim that was released
 * and recreated (fresh timestamp) since the scan is skipped, never deleted.
 */
export async function sweepStaleCertificateClaims(
  opts: { ttlMs?: number; batchSize?: number } = {},
): Promise<ClaimSweepResult> {
  const ttlMs     = opts.ttlMs ?? CLAIM_TTL_MS
  const batchSize = Math.min(Math.max(opts.batchSize ?? 200, 1), 500)
  const cutoffMs  = Date.now() - ttlMs
  const cutoff    = Timestamp.fromMillis(cutoffMs)

  // Range filter on createdAt — served by the automatic single-field index.
  const snap = await adminDb
    .collection(COLLECTIONS.CLAIMS)
    .where('createdAt', '<=', cutoff)
    .limit(batchSize)
    .get()

  let deleted = 0
  let skipped = 0

  for (const doc of snap.docs) {
    const removed = await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(doc.ref)
      if (!fresh.exists) return false
      const createdAt = (fresh.data() as { createdAt?: Timestamp }).createdAt
      const createdMs = createdAt instanceof Timestamp ? createdAt.toMillis() : 0
      if (createdMs > cutoffMs) return false   // recreated since the scan → active
      tx.delete(doc.ref)
      return true
    })
    if (removed) deleted++
    else skipped++
  }

  return { scanned: snap.size, deleted, skipped }
}

/**
 * Create a generated certificate record. Keyed by certificateId.
 *
 * Uses `.create()` (not `.set()`) so a certificateId collision FAILS LOUD instead
 * of silently overwriting an existing attendee's certificate (RD-EVENT-GA-02D F1).
 * The id is random (RDC-{year}-{6}); the deterministic claim only makes it unique
 * per (event, registration, type) tuple — NOT globally across the flat collection —
 * so at scale a birthday collision with another tuple's id is possible. The single
 * caller (generateCertificate, owned path) only reaches here when no record exists
 * for this tuple, so the only way the doc can already exist is a cross-tuple id
 * collision: rejecting it preserves the existing certificate, and the caller's
 * releaseCertificateClaim + rethrow lets a retry reserve a fresh id.
 */
export async function createCertificate(input: CertificateInput): Promise<Certificate> {
  const ref = certificatesCol().doc(input.certificateId)
  await ref.create({
    ...input,
    status:           'generated',
    downloadCount:    0,
    lastDownloadedAt: null,
    emailStatus:       null,
    emailHistory:      [],
    generatedAt:       FieldValue.serverTimestamp(),
    emailedAt:         null,
    revokedAt:         null,
    revokedBy:         null,
    revokeReason:      null,
    revocationHistory: [],
    schemaVersion:     CERTIFICATE_SCHEMA_VERSION,
  })
  return (await ref.get()).data() as Certificate
}

/**
 * Revokes a certificate (Phase 9): sets status `revoked`, stamps
 * revokedAt/By/Reason, and appends an append-only revocationHistory entry.
 * Verifies ownership + event inside the transaction. Idempotent — re-revoking an
 * already-revoked certificate returns it unchanged (no duplicate history).
 */
export async function revokeCertificate(
  eventId: string,
  certificateId: string,
  uid: string,
  reason: RevocationReason,
  customReason?: string,
): Promise<Certificate> {
  const ref = certificatesCol().doc(certificateId)
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new CertificateServiceError('not_found', 'Certificate not found')
    const cert = snap.data() as Certificate
    if (cert.organizerUid !== uid || cert.eventId !== eventId) {
      throw new CertificateServiceError('forbidden', 'Certificate does not belong to this event')
    }
    if (cert.status === 'revoked') return   // idempotent — no duplicate history

    const reasonText = reason === 'other'
      ? (customReason ?? 'Other')
      : REVOCATION_REASON_LABELS[reason]

    const entry: RevocationHistoryEntry = {
      action: 'revoked',
      by:     uid,
      at:     new Date().toISOString(),
      reason,
      ...(customReason ? { customReason } : {}),
    }

    tx.update(ref, {
      status:            'revoked',
      revokedAt:         FieldValue.serverTimestamp(),
      revokedBy:         uid,
      revokeReason:      reasonText,
      revocationHistory: FieldValue.arrayUnion(entry),
    })
  })
  return (await ref.get()).data() as Certificate
}

/**
 * Restores a previously revoked certificate (Phase 9): clears the revoked
 * status (back to `emailed` if it had been emailed, else `generated`), clears
 * revokedAt/By/Reason, and appends a `restored` history entry. The certificate
 * is NOT regenerated and prior history is preserved (append-only).
 */
export async function restoreCertificate(
  eventId: string,
  certificateId: string,
  uid: string,
): Promise<Certificate> {
  const ref = certificatesCol().doc(certificateId)
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new CertificateServiceError('not_found', 'Certificate not found')
    const cert = snap.data() as Certificate
    if (cert.organizerUid !== uid || cert.eventId !== eventId) {
      throw new CertificateServiceError('forbidden', 'Certificate does not belong to this event')
    }
    if (cert.status !== 'revoked') return   // idempotent — nothing to restore

    const restoredStatus =
      cert.emailStatus === 'sent' || cert.emailStatus === 'delivered' ? 'emailed' : 'generated'

    const entry: RevocationHistoryEntry = {
      action: 'restored',
      by:     uid,
      at:     new Date().toISOString(),
    }

    tx.update(ref, {
      status:            restoredStatus,
      revokedAt:         null,
      revokedBy:         null,
      revokeReason:      null,
      revocationHistory: FieldValue.arrayUnion(entry),
    })
  })
  return (await ref.get()).data() as Certificate
}

/**
 * Appends an email-delivery entry to a certificate's history and updates its
 * emailStatus (Phase 8). The entry's timestamp is an ISO string (Firestore
 * disallows serverTimestamp inside arrayUnion).
 */
export async function recordCertificateEmail(
  certificateId: string,
  entry: EmailHistoryEntry,
  status: CertificateEmailStatus,
): Promise<void> {
  await certificatesCol().doc(certificateId).update({
    emailHistory: FieldValue.arrayUnion(entry),
    emailStatus:  status,
    emailedAt:    FieldValue.serverTimestamp(),
  })
}

/**
 * Records an in-place regeneration (GA-4 S2): updates the stored file pointer +
 * template reference, stamps regeneratedAt, increments the count, and appends an
 * audit entry. The certificateId + verificationToken are UNCHANGED, so the
 * verification URL / QR / ID / public verification keep working.
 */
export async function recordCertificateRegeneration(
  certificateId: string,
  patch: { fileUrl: string; fileSize: number; templateId: string },
  actorUid?: string,
): Promise<void> {
  const entry = { at: new Date().toISOString(), templateId: patch.templateId, actorUid: actorUid ?? null }
  await certificatesCol().doc(certificateId).update({
    fileUrl:             patch.fileUrl,
    fileSize:            patch.fileSize,
    templateId:          patch.templateId,
    regeneratedAt:       FieldValue.serverTimestamp(),
    regenerationCount:   FieldValue.increment(1),
    regenerationHistory: FieldValue.arrayUnion(entry),
    updatedAt:           FieldValue.serverTimestamp(),
  })
}

/** Increments a certificate's download counter and stamps lastDownloadedAt. */
export async function incrementCertificateDownload(certificateId: string): Promise<void> {
  await certificatesCol().doc(certificateId).update({
    downloadCount:    FieldValue.increment(1),
    lastDownloadedAt: FieldValue.serverTimestamp(),
  })
}

// ─── Bulk jobs (Phase 7 — `certificateJobs` collection) ─────────────────────────

const jobsCol = () => adminDb.collection(COLLECTIONS.JOBS)

/** Create a bulk job in `pending` state. `total` seeds the progress denominator.
 *  Delegates the generic scaffold to the shared job kernel; the certificate payload
 *  (`...input`) + schemaVersion are the feature-specific seed. */
export async function createJob(
  input: CertificateJobInput,
  total: number,
): Promise<CertificateJob> {
  return jobKernel.createJob<CertificateJob>(
    COLLECTIONS.JOBS,
    generateJobId(),
    { ...input, schemaVersion: CERTIFICATE_SCHEMA_VERSION },
    total,
  )
}

export async function getJob(jobId: string): Promise<CertificateJob | null> {
  return jobKernel.getJob<CertificateJob>(COLLECTIONS.JOBS, jobId)
}

/**
 * Non-terminal jobs across all organizers/events, for the scheduled driver.
 * `status in [pending, processing]` uses the automatic single-field index — no
 * composite index or orderBy needed.
 */
export async function listActiveJobs(limitN = 25): Promise<CertificateJob[]> {
  return jobKernel.listActiveJobs<CertificateJob>(COLLECTIONS.JOBS, limitN)
}

/** Jobs for an event, newest first (needs the certificateJobs composite index). */
export async function listJobs(
  eventId: string,
  organizerUid: string,
): Promise<CertificateJob[]> {
  const snap = await jobsCol()
    .where('organizerUid', '==', organizerUid)
    .where('eventId',      '==', eventId)
    .orderBy('createdAt', 'desc')
    .get()
  return snap.docs.map(d => d.data() as CertificateJob)
}

/** Attempts to lease a job for processing (delegates to the shared job kernel). */
export async function leaseJob(
  jobId: string,
  leaseMs: number,
): Promise<{ proceed: true; job: CertificateJob } | { proceed: false; reason: LeaseReason }> {
  return jobKernel.leaseJob<CertificateJob>(COLLECTIONS.JOBS, jobId, leaseMs)
}

/** Atomically commits one page of progress (delegates to the shared job kernel). */
export async function commitChunk(jobId: string, c: ChunkCommit): Promise<ChunkResult> {
  return jobKernel.commitChunk(COLLECTIONS.JOBS, jobId, c)
}

/** Marks a job failed (systemic error — not a per-certificate failure). */
export async function failJob(jobId: string, message: string): Promise<void> {
  return jobKernel.failJob(COLLECTIONS.JOBS, jobId, message)
}

/** Requests cancellation. No-op if already completed. Returns the resulting status. */
export async function cancelJob(jobId: string): Promise<CertificateJob['status'] | null> {
  return jobKernel.cancelJob(COLLECTIONS.JOBS, jobId)
}

// ─── Records (legacy MVP — `certificateRecords` collection) ─────────────────────

/** Load a certificate record by its public certificateId. */
export async function getCertificateById(
  certificateId: string,
): Promise<CertificateRecord | null> {
  const snap = await adminDb.collection('certificateRecords').doc(certificateId).get()
  return snap.exists ? (snap.data() as CertificateRecord) : null
}

/** Find the certificate for a specific registration (at most one). */
export async function getCertificateByRegistrationId(
  registrationId: string,
): Promise<CertificateRecord | null> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('registrationId', '==', registrationId)
    .limit(1)
    .get()
  return snap.empty ? null : (snap.docs[0].data() as CertificateRecord)
}

/** Create a new certificate record. Keyed by certificateId. */
export async function createCertificateRecord(
  record: Omit<CertificateRecord, 'issuedAt' | 'downloadCount' | 'status'>,
): Promise<void> {
  await adminDb.collection('certificateRecords').doc(record.certificateId).set({
    ...record,
    status:        'generated',
    downloadCount:  0,
    issuedAt:       FieldValue.serverTimestamp(),
  })
}

/** Atomically increment download counter. */
export async function incrementDownloadCount(certificateId: string): Promise<void> {
  await adminDb
    .collection('certificateRecords')
    .doc(certificateId)
    .update({ downloadCount: FieldValue.increment(1) })
}

/** Mark a certificate as emailed. */
export async function markCertificateEmailed(
  certificateId: string,
  success:       boolean,
): Promise<void> {
  await adminDb.collection('certificateRecords').doc(certificateId).update({
    status:      'emailed',
    emailStatus: success ? 'sent' : 'failed',
    emailedAt:   FieldValue.serverTimestamp(),
  })
}

/** All certificates for a specific event (organizer-scoped). */
export async function getCertificatesByEventId(
  eventId:     string,
  organizerUid: string,
): Promise<CertificateRecord[]> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .get()
  return snap.docs.map(d => d.data() as CertificateRecord)
}

/** All certificates for an organizer (across all events), newest first in memory. */
export async function getCertificatesByOrganizerUid(
  organizerUid: string,
  limitN = 100,
): Promise<CertificateRecord[]> {
  const snap = await adminDb
    .collection('certificateRecords')
    .where('organizerUid', '==', organizerUid)
    .limit(limitN)
    .get()
  return snap.docs.map(d => d.data() as CertificateRecord)
}
