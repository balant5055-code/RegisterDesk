// Print template persistence (PA-1). Server-only. The ONLY collection this phase
// creates: `printTemplates`. No generated-assets / jobs / downloads / elements /
// variables / history collections (those belong to later phases).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { defaultCanvas, emptyDesign } from './types'
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

export async function updatePrintTemplate(id: string, input: UpdatePrintTemplateInput): Promise<void> {
  await col().doc(id).update({ ...input, updatedAt: FieldValue.serverTimestamp() })
}

/** Atomically overwrites the whole design JSON (single doc, no per-element writes). */
export async function savePrintDesign(id: string, design: PrintDesign): Promise<void> {
  await col().doc(id).update({ design, updatedAt: FieldValue.serverTimestamp() })
}

export async function deletePrintTemplate(id: string): Promise<void> {
  await col().doc(id).delete()
}

/** Duplicates a template into a new `draft` (name suffixed "(Copy)"). */
export async function duplicatePrintTemplate(source: PrintTemplate, createdBy: string): Promise<PrintTemplate> {
  return createPrintTemplate(source.organizerUid, createdBy, {
    eventId:     source.eventId,
    name:        `${source.name} (Copy)`.slice(0, 120),
    description: source.description,
    assetType:   source.assetType,
    canvas:      source.canvas,
  })
}
