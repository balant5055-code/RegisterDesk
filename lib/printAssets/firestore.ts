// Print template persistence (PA-1). Server-only. `printTemplates` holds each template's
// metadata and its working layout; every layout change is ALSO committed as an immutable
// version in `printTemplateVersions` (RD-PRINT-P1 — see ./versions.ts).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { defaultCanvas, emptyDesign } from './types'
import { commitTemplateVersion, ensureCurrentVersion, getTemplateVersion, type CommittedVersion } from './versions'
import type {
  PrintTemplate, PrintCanvas, PrintAssetType, PrintTemplateStatus, PrintDesign,
  CreatePrintTemplateInput, UpdatePrintTemplateInput,
} from './types'

export const PRINT_TEMPLATES = 'printTemplates'

const col = () => adminDb.collection(PRINT_TEMPLATES)

function toIso(v: unknown): string {
  if (v instanceof Timestamp) return v.toDate().toISOString()
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { /* fall through */ }
  }
  return new Date(0).toISOString()
}

function serialize(id: string, d: Record<string, unknown>): PrintTemplate {
  return {
    id,
    eventId:      typeof d.eventId      === 'string' ? d.eventId      : '',
    organizerUid: typeof d.organizerUid === 'string' ? d.organizerUid : '',
    name:         typeof d.name         === 'string' ? d.name         : '',
    description:  typeof d.description  === 'string' ? d.description  : '',
    assetType:    (d.assetType as PrintAssetType)      ?? 'CUSTOM',
    status:       (d.status    as PrintTemplateStatus) ?? 'draft',
    canvas:       (d.canvas as PrintCanvas) ?? defaultCanvas(),
    design:       (d.design as PrintDesign) ?? emptyDesign(),
    createdBy:    typeof d.createdBy === 'string' ? d.createdBy : undefined,
    createdAt:    toIso(d.createdAt),
    updatedAt:    toIso(d.updatedAt),
    ...(typeof d.currentVersion === 'number' ? { currentVersion: d.currentVersion } : {}),
  }
}

/** All templates for a workspace, newest-updated first. */
export async function listPrintTemplates(organizerUid: string): Promise<PrintTemplate[]> {
  const snap = await col()
    .where('organizerUid', '==', organizerUid)
    .orderBy('updatedAt', 'desc')
    .limit(500)
    .get()
  return snap.docs.map(d => serialize(d.id, d.data() as Record<string, unknown>))
}

export async function getPrintTemplate(id: string): Promise<PrintTemplate | null> {
  const snap = await col().doc(id).get()
  return snap.exists ? serialize(snap.id, snap.data() as Record<string, unknown>) : null
}

export async function createPrintTemplate(
  organizerUid: string, createdBy: string, input: CreatePrintTemplateInput,
): Promise<PrintTemplate> {
  const ref = col().doc()
  await ref.set({
    eventId:      input.eventId,
    organizerUid,
    createdBy,
    name:         input.name,
    description:  input.description ?? '',
    assetType:    input.assetType,
    status:       'draft' as PrintTemplateStatus,
    canvas:       input.canvas,
    createdAt:    FieldValue.serverTimestamp(),
    updatedAt:    FieldValue.serverTimestamp(),
  })
  return (await getPrintTemplate(ref.id))!
}

/**
 * Metadata edits (name / description / assetType / status). A CANVAS change is a layout
 * change, so it is committed as a new immutable version first (RD-PRINT-P1); every
 * other field is plain metadata and never touches a version.
 */
export async function updatePrintTemplate(
  id: string, input: UpdatePrintTemplateInput, actorUid: string,
): Promise<void> {
  const { canvas, ...meta } = input
  if (canvas) await commitTemplateVersion({ templateId: id, actorUid, source: 'resize', canvas })
  if (Object.keys(meta).length) await col().doc(id).update({ ...meta, updatedAt: FieldValue.serverTimestamp() })
}

/**
 * Saves the designer document: commits it as the template's new immutable version and
 * moves the template's pointer, in one transaction (RD-PRINT-P1). Saving an unchanged
 * design creates no version.
 */
export async function savePrintDesign(
  id: string, design: PrintDesign,
  opts: { actorUid: string; source?: 'save' | 'import'; starter?: { collectionId: string; templateName: string } },
): Promise<CommittedVersion> {
  return commitTemplateVersion({ templateId: id, actorUid: opts.actorUid, source: opts.source ?? 'save', design, starter: opts.starter })
}

export async function deletePrintTemplate(id: string): Promise<void> {
  await col().doc(id).delete()
}

/**
 * Duplicates a template into a new `draft` (name suffixed "(Copy)") WITH its design.
 *
 * RD-PRINT-P1 — this used to copy only the metadata, so every copy opened blank. It now
 * copies the source's CURRENT VERSION exactly (card + design, versioning the source
 * first if it never was) and records it as the copy's v1, with `copiedFrom`.
 */
export async function duplicatePrintTemplate(source: PrintTemplate, createdBy: string): Promise<PrintTemplate> {
  const pinned  = await ensureCurrentVersion(source.id, source.organizerUid, createdBy)
  const version = await getTemplateVersion(source.id, pinned.version)
  const card    = version?.card ?? source.canvas
  const copy = await createPrintTemplate(source.organizerUid, createdBy, {
    eventId:     source.eventId,
    name:        `${source.name} (Copy)`.slice(0, 120),
    description: source.description,
    assetType:   source.assetType,
    canvas:      { ...card },
  })
  await commitTemplateVersion({
    templateId: copy.id, organizerUid: source.organizerUid, actorUid: createdBy, source: 'duplicate',
    design: version?.design ?? source.design, canvas: { ...card },
    copiedFrom: { templateId: source.id, version: pinned.version },
  })
  return (await getPrintTemplate(copy.id))!
}
