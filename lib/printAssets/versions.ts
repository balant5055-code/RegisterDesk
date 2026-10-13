// RD-PRINT-P1 · Immutable print-template versions. Server-only.
//
// `printTemplateVersions/{templateId}_v{n}` — one document per saved layout:
//   • written ONLY with `create()` inside a transaction, so a version number can never be
//     reused and an existing version can never be overwritten (create fails if it exists);
//   • never updated by any code path (pinned by tests/unit/printTemplateVersions.test.ts);
//   • client access is denied by Firestore rules (no rule matches → default deny);
//   • holds the layout ONLY — card size + the full designer document. Never generated
//     output, never attendee data.
//
// The template document keeps its working copy (`design`, `canvas`) for the designer and
// the preview, plus a pointer: `currentVersion` (+ `currentVersionHash`). Every change to
// the layout — a designer save, a card re-size, an import, a duplicate — commits a new
// version and moves the pointer in the SAME transaction. Saving an identical layout is a
// no-op (same content hash → no new version).
//
// A print job pins (templateId, version) at creation and renders from the version, so a
// later edit, re-size, rename or deletion of the template cannot change what it prints.
//
// TOP-LEVEL, not a subcollection, on purpose: event deletion removes it by `eventId`
// (Firestore does not cascade into subcollections), and a pinned job can still read its
// version after the template document itself was deleted.

import crypto from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { defaultCanvas, emptyDesign } from './types'
import type {
  PrintCanvas, PrintCardSpec, PrintDesign, PrintAssetType,
  PrintTemplateVersion, PrintTemplateVersionSource,
} from './types'

export const PRINT_TEMPLATE_VERSIONS = 'printTemplateVersions'
const PRINT_TEMPLATES = 'printTemplates'

export const versionDocId = (templateId: string, version: number) => `${templateId}_v${version}`

/** The card a layout is pinned to — exactly the canvas fields, nothing derived. */
export function cardSpecOf(c: PrintCanvas): PrintCardSpec {
  return { preset: c.preset, width: c.width, height: c.height, unit: c.unit, orientation: c.orientation }
}

/** Deterministic JSON (object keys sorted at every level) — the input to the hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Content hash of a layout. Two layouts with the same card + design share it. */
export function layoutHash(card: PrintCardSpec, design: PrintDesign): string {
  return crypto.createHash('sha256').update(canonical({ card, design })).digest('hex')
}

export class TemplateVersionError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface CommitVersionInput {
  templateId: string
  /** The caller's server-resolved workspace. The template must belong to it. */
  organizerUid?: string
  actorUid:   string
  source:     PrintTemplateVersionSource
  /** New designer document — omitted ⇒ keep the current one. */
  design?:    PrintDesign
  /** New card — omitted ⇒ keep the current one. */
  canvas?:    PrintCanvas
  copiedFrom?: { templateId: string; version: number }
  starter?:    { collectionId: string; templateName: string }
}

export interface CommittedVersion { version: number; hash: string; created: boolean }

/**
 * Commit the template's layout (optionally changed) as its current version, atomically.
 *
 * A template written before versioning existed has no `currentVersion`. Its existing
 * layout is first preserved as v1 (`source: 'legacy'`) so nothing it already had is
 * lost, then the change — if any — becomes v2. Identical content creates nothing.
 */
export async function commitTemplateVersion(input: CommitVersionInput): Promise<CommittedVersion> {
  const tplRef = adminDb.collection(PRINT_TEMPLATES).doc(input.templateId)
  const versions = adminDb.collection(PRINT_TEMPLATE_VERSIONS)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(tplRef)
    if (!snap.exists) throw new TemplateVersionError('Template not found', 404)
    const d = snap.data() as Record<string, unknown>
    const owner = typeof d.organizerUid === 'string' ? d.organizerUid : ''
    if (!owner || (input.organizerUid && owner !== input.organizerUid)) {
      throw new TemplateVersionError('Template not found', 404)
    }

    const base = {
      templateId:   input.templateId,
      organizerUid: owner,
      eventId:      typeof d.eventId === 'string' ? d.eventId : '',
      assetType:    (d.assetType as PrintAssetType) ?? 'CUSTOM',
      name:         typeof d.name === 'string' ? d.name : '',
      createdBy:    input.actorUid,
    }
    const make = (version: number, card: PrintCardSpec, design: PrintDesign, hash: string,
                  source: PrintTemplateVersionSource, extra: Partial<PrintTemplateVersion> = {}) => ({
      ...base, version, card, design, contentHash: hash, source, ...extra,
      createdAt: FieldValue.serverTimestamp(),
    })

    const existingCanvas = (d.canvas as PrintCanvas | undefined) ?? defaultCanvas()
    const existingDesign = (d.design as PrintDesign | undefined) ?? emptyDesign()
    let current     = typeof d.currentVersion === 'number' ? d.currentVersion : 0
    let currentHash = typeof d.currentVersionHash === 'string' ? d.currentVersionHash : ''

    // Pre-versioning template that already holds a design: keep it as v1 before changing it.
    const legacy = current === 0 && d.design !== undefined
    if (legacy) {
      const card = cardSpecOf(existingCanvas)
      currentHash = layoutHash(card, existingDesign)
      current = 1
      tx.create(versions.doc(versionDocId(input.templateId, 1)), make(1, card, existingDesign, currentHash, 'legacy'))
    }

    const canvas = input.canvas ?? existingCanvas
    const design = input.design ?? existingDesign
    const card   = cardSpecOf(canvas)
    const hash   = layoutHash(card, design)

    if (current > 0 && hash === currentHash) {
      // Same layout as the current version — nothing new to record.
      if (legacy) tx.update(tplRef, { currentVersion: current, currentVersionHash: currentHash })
      return { version: current, hash, created: legacy }
    }

    const next = current + 1
    tx.create(versions.doc(versionDocId(input.templateId, next)), make(next, card, design, hash, input.source, {
      ...(input.copiedFrom ? { copiedFrom: input.copiedFrom } : {}),
      ...(input.starter ? { starter: input.starter } : {}),
    }))
    tx.update(tplRef, {
      design, canvas, currentVersion: next, currentVersionHash: hash,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { version: next, hash, created: true }
  })
}

/**
 * The template's current version, creating v1 from its present layout if it has never
 * been versioned. Used to pin a print job. Never changes the layout.
 */
export async function ensureCurrentVersion(
  templateId: string, organizerUid: string, actorUid: string,
): Promise<CommittedVersion> {
  return commitTemplateVersion({ templateId, organizerUid, actorUid, source: 'legacy' })
}

/** One version, or null. Readable even after its template was deleted. */
export async function getTemplateVersion(templateId: string, version: number): Promise<PrintTemplateVersion | null> {
  if (!Number.isInteger(version) || version < 1) return null
  const snap = await adminDb.collection(PRINT_TEMPLATE_VERSIONS).doc(versionDocId(templateId, version)).get()
  if (!snap.exists) return null
  const d = snap.data() as Record<string, unknown>
  const created = d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : new Date(0).toISOString()
  return { ...(d as unknown as PrintTemplateVersion), createdAt: created }
}
