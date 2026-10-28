// RD-WA-TEMPLATES-01 — organizer WhatsApp templates: storage, lifecycle, Meta submission, status
// sync and send eligibility. SERVER-ONLY.
//
// ═══ DATA ════════════════════════════════════════════════════════════════════
//   whatsappTemplates/{id}                    one template (name fixed), workspace-owned
//     ├─ versions/v{n}                        the content of each version — IMMUTABLE once it leaves
//     │                                       'draft'; carries its internal and Meta state separately
//     ├─ history/{auto}                       append-only lifecycle trail (organizer + admin visible)
//     └─ adminNotes/{auto}                    Super Admin internal notes — never read by an organizer route
//   whatsappTemplateMetaNames/{metaName__lang} → { templateId, version }   (webhook lookup by name)
//   whatsappTemplateMetaIds/{metaTemplateId}   → { templateId, version }   (webhook lookup by id)
//   whatsappTemplateMetaEvents/{sha}           webhook de-duplication (create() = processed once)
//
// The id is derived from the workspace and the name, so a name is unique per workspace by
// construction (create() refuses a second one). Each version is a SEPARATE Meta template named
// rd_{workspace}_{name}_v{n}: an approval at Meta, or by a Super Admin, belongs to one exact
// version's content and can never be inherited by an edit.
//
// ═══ CONCURRENCY ═════════════════════════════════════════════════════════════
// Every organizer mutation carries the template's `revision` (bumped by every write) and is refused
// with STALE when it changed. A Super Admin decision names the exact version AND its contentHash, and
// the transaction re-checks both. A Meta submission is claimed in a transaction with a lease token;
// a second driver (double click, cron, retry) finds 'submitting' and stops.
//
// ═══ ELIGIBILITY (resolveSendableTemplate) ═══════════════════════════════════
// A broadcast may use version N only when ALL hold, checked on the server when the campaign is
// created AND again when the job starts sending:
//   the template belongs to the workspace · N is the template's current active (Meta-approved)
//   version · N has an internal approval of exactly its content · Meta's status for N permits
//   sending · that status was confirmed within META_STATUS_MAX_AGE_MS (else re-read from Meta).

import { createHash, randomUUID } from 'crypto'
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { isMetaConfigured } from '@/lib/whatsapp/config'
import { stageOutboxMessage, scheduleOutboxDelivery } from '@/lib/notifications/outbox'
import { stageAdminAudit } from '@/lib/admin/audit'
import {
  LIMITS, SENDABLE_META_STATUSES, SUBMITTABLE_META_STATUSES, INTERNAL_STATUS_LABEL, META_STATUS_LABEL, catalogVariable,
  type TemplateDraftInput, type InternalStatus, type MetaStatus, type ReviewMode, type ValidationFinding,
  type VersionView, type HistoryView, type TemplateSummary, type TemplateDetail, type SendableTemplateView,
  type TemplateContent, type CustomVariable, type TemplateCategory,
} from './types'
import { validateTemplate, compileTemplate, hasErrors, type CompiledTemplate } from './validate'
import { normalizeMetaStatus, normalizeMetaCategory, normalizeRejectionReason, isStatusRestoringEvent } from './metaStatus'
import { submitMetaTemplate, getMetaTemplate, findMetaTemplate, type MetaTemplateNode } from './metaApi'
import { resolveReviewMode, resolveMarketingTemplatesEnabled } from './governance'
import type { TemplateWebhookEvent } from './webhook'

export const TEMPLATES = 'whatsappTemplates'
const META_NAMES = 'whatsappTemplateMetaNames'
const META_IDS = 'whatsappTemplateMetaIds'
const META_EVENTS = 'whatsappTemplateMetaEvents'
const SUBMIT_LEASE_MS = 90_000
/** A Meta status older than this is re-read from Meta before a broadcast relies on it. */
export const META_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000
const LIST_LIMIT = 200

export class TemplateError extends Error {
  constructor(public code: string, message: string, public status = 400, public extra?: Record<string, unknown>) { super(message) }
}

export interface OrganizerCaller { workspaceUid: string; callerUid: string }
type Actor = { kind: 'organizer' | 'super_admin' | 'system' | 'meta'; uid?: string | null }

// ─── Stored shapes ────────────────────────────────────────────────────────────

interface StoredMeta {
  status: MetaStatus; rawStatus?: string | null; templateId?: string | null; category?: string | null; categoryChanged?: boolean
  previousCategory?: string | null; rejectionReason?: string | null
  rejectionDetail?: { reason: string | null; recommendation: string | null } | null
  otherInfo?: { title: string | null; description: string | null } | null; disabledAt?: Timestamp | null
  lastError?: string | null; attempts?: number; submittedAt?: Timestamp | null; lastAttemptAt?: Timestamp | null
  statusAt?: Timestamp | null; syncedAt?: Timestamp | null; leaseId?: string | null; leaseUntil?: Timestamp | null
}
interface StoredVersion {
  version: number; parentVersion: number | null
  category: TemplateCategory; language: string; eventSlug: string | null; eventType: string | null
  content: TemplateContent; customVariables: CustomVariable[]; examples: Record<string, string>
  contentHash: string; metaName: string
  /** componentsJson: Meta's components as JSON — Firestore cannot store their nested example arrays. */
  compiled: { bodyOrder: string[]; headerOrder: string[]; componentsJson: string } | null
  validation: ValidationFinding[]
  internal: {
    status: InternalStatus; mode: ReviewMode | null; submittedAt?: Timestamp | null; submittedBy?: string | null
    decidedAt?: Timestamp | null; decidedBy?: string | null; decidedBySystem?: boolean; decisionReason?: string | null; approvedHash?: string | null
  }
  meta: StoredMeta
  createdAt?: Timestamp; createdBy?: string
}
interface StoredTemplate {
  organizerUid: string; name: string; category: TemplateCategory; language: string; eventSlug: string | null
  latestVersion: number; activeVersion: number | null; revision: number
  summary: { internalStatus: InternalStatus; metaStatus: MetaStatus; body: string }
  createdAt?: Timestamp; updatedAt?: Timestamp; createdBy?: string
}

const tRef = (id: string) => adminDb.collection(TEMPLATES).doc(id)
const vRef = (id: string, n: number) => tRef(id).collection('versions').doc(`v${n}`)
const iso = (t: unknown): string | null => (t && typeof (t as Timestamp).toDate === 'function' ? (t as Timestamp).toDate().toISOString() : null)
const ms = (t: unknown): number => (t && typeof (t as Timestamp).toMillis === 'function' ? (t as Timestamp).toMillis() : 0)

export const workspaceTag = (workspaceUid: string) => createHash('sha256').update(workspaceUid).digest('hex').slice(0, 10)
export const templateIdFor = (workspaceUid: string, name: string) => `wt_${workspaceTag(workspaceUid)}_${name}`
export const metaNameFor = (workspaceUid: string, name: string, version: number) => `rd_${workspaceTag(workspaceUid)}_${name}_v${version}`
const metaNameKey = (metaName: string, language: string) => `${metaName}__${language}`

/** Hash of everything Meta and a reviewer see. An approval is bound to it. */
export function contentHashOf(input: Pick<TemplateDraftInput, 'category' | 'language' | 'content' | 'customVariables' | 'examples'>): string {
  const canonical = JSON.stringify({
    category: input.category, language: input.language,
    header: input.content.header?.text?.trim() ? { format: input.content.header.format, text: input.content.header.text.trim() } : null,
    body: input.content.body.trim(), footer: input.content.footer?.trim() || null,
    buttons: (input.content.buttons ?? []).map(b => ({ ...b, text: b.text.trim() })),
    customVariables: input.customVariables.map(v => ({ key: v.key, label: v.label.trim(), example: v.example.trim() })),
    examples: Object.fromEntries(Object.entries(input.examples ?? {}).filter(([, v]) => v.trim()).sort(([a], [b]) => a.localeCompare(b))),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40)
}

function history(txn: Transaction, id: string, h: { action: string; version: number | null; actor: Actor; summary: string; details?: Record<string, unknown> }) {
  txn.create(tRef(id).collection('history').doc(), {
    at: FieldValue.serverTimestamp(), action: h.action, version: h.version, actorKind: h.actor.kind, actorUid: h.actor.uid ?? null,
    summary: h.summary.slice(0, 500), details: h.details ?? {},
  })
}

// ─── Context ──────────────────────────────────────────────────────────────────

async function eventTypeFor(workspaceUid: string, eventSlug: string | null): Promise<string | null> {
  if (!eventSlug) return null
  const snap = await adminDb.collection('events').doc(eventSlug).get()
  const d = snap.exists ? snap.data() as Record<string, unknown> : null
  if (!d || d.uid !== workspaceUid) throw new TemplateError('EVENT_NOT_FOUND', 'That event was not found in this workspace.', 404)
  return typeof d.eventType === 'string' ? d.eventType : null
}

async function workspaceTemplates(workspaceUid: string): Promise<Array<{ id: string; data: StoredTemplate }>> {
  const snap = await adminDb.collection(TEMPLATES).where('organizerUid', '==', workspaceUid).limit(LIST_LIMIT).get()
  return snap.docs.map(d => ({ id: d.id, data: d.data() as StoredTemplate }))
}

async function validateFor(workspaceUid: string, input: TemplateDraftInput, selfId: string | null, forSubmission: boolean) {
  const eventType = await eventTypeFor(workspaceUid, input.eventSlug)
  const existing = (await workspaceTemplates(workspaceUid)).map(t => ({ id: t.id, name: t.data.name, language: t.data.language, body: t.data.summary?.body ?? '' }))
  const findings = validateTemplate(input, { eventType, existing, selfId, ...(forSubmission ? { metaConfigured: isMetaConfigured() } : {}) })
  return { eventType, findings }
}

function versionDoc(workspaceUid: string, input: TemplateDraftInput, n: number, parent: number | null, eventType: string | null, findings: ValidationFinding[], by: string): StoredVersion {
  const compiled: CompiledTemplate | null = hasErrors(findings) ? null : compileTemplate(input)
  return {
    version: n, parentVersion: parent, category: input.category, language: input.language, eventSlug: input.eventSlug, eventType,
    content: input.content, customVariables: input.customVariables, examples: input.examples,
    contentHash: contentHashOf(input), metaName: metaNameFor(workspaceUid, input.name, n),
    compiled: compiled ? { bodyOrder: compiled.bodyOrder, headerOrder: compiled.headerOrder, componentsJson: JSON.stringify(compiled.components) } : null,
    validation: findings,
    internal: { status: 'draft', mode: null },
    meta: { status: 'not_submitted', attempts: 0 },
    createdAt: FieldValue.serverTimestamp() as unknown as Timestamp, createdBy: by,
  }
}

function inputOf(t: StoredTemplate, v: StoredVersion): TemplateDraftInput {
  return { name: t.name, category: v.category, language: v.language, content: v.content, customVariables: v.customVariables ?? [], examples: v.examples ?? {}, eventSlug: v.eventSlug }
}

// ─── Organizer: create, edit, revise, submit ─────────────────────────────────

export const MARKETING_DISABLED_MESSAGE =
  'Marketing templates are not available yet. Choose the Utility category, or try again once RegisterDesk enables Marketing templates.'

/**
 * RD-WA-MARKETING-01 — creating, editing or starting a new version of a MARKETING template is refused
 * while the Super Admin switch is off (the default). Checked here, at the service boundary every
 * organizer route goes through, before anything is written. Utility templates are never affected;
 * existing Marketing templates stay readable and keep their approved / sending state.
 */
async function assertMarketingAllowed(input: TemplateDraftInput): Promise<void> {
  if (input.category !== 'marketing') return
  if ((await resolveMarketingTemplatesEnabled()).enabled) return
  throw new TemplateError('MARKETING_DISABLED', MARKETING_DISABLED_MESSAGE, 403)
}

export async function createTemplate(a: { caller: OrganizerCaller; input: TemplateDraftInput }): Promise<{ id: string; version: number; findings: ValidationFinding[] }> {
  const { caller, input } = a
  await assertMarketingAllowed(input)
  const id = templateIdFor(caller.workspaceUid, input.name)
  const { eventType, findings } = await validateFor(caller.workspaceUid, input, id, false)
  if (findings.some(f => f.code === 'NAME_FORMAT' || f.code === 'NAME_LENGTH')) {
    throw new TemplateError('INVALID', 'Fix the template name first.', 400, { findings })
  }
  await adminDb.runTransaction(async txn => {
    const existing = await txn.get(tRef(id))
    if (existing.exists) throw new TemplateError('NAME_TAKEN', 'A template with this name already exists in your workspace. Choose another name or open the existing one.', 409)
    const v = versionDoc(caller.workspaceUid, input, 1, null, eventType, findings, caller.callerUid)
    txn.create(tRef(id), {
      organizerUid: caller.workspaceUid, name: input.name, category: input.category, language: input.language, eventSlug: input.eventSlug,
      latestVersion: 1, activeVersion: null, revision: 1,
      summary: { internalStatus: 'draft', metaStatus: 'not_submitted', body: input.content.body.slice(0, LIMITS.body + 50) },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: caller.callerUid,
    } satisfies Omit<StoredTemplate, 'createdAt' | 'updatedAt'> & Record<string, unknown>)
    txn.create(vRef(id, 1), v as unknown as FirebaseFirestore.DocumentData)
    history(txn, id, { action: 'created', version: 1, actor: { kind: 'organizer', uid: caller.callerUid }, summary: 'Template created as a draft.' })
  })
  return { id, version: 1, findings }
}

async function loadOwned(txn: Transaction | null, caller: OrganizerCaller, id: string): Promise<StoredTemplate> {
  const snap = txn ? await txn.get(tRef(id)) : await tRef(id).get()
  const t = snap.exists ? snap.data() as StoredTemplate : null
  // Another workspace's template is indistinguishable from a missing one.
  if (!t || t.organizerUid !== caller.workspaceUid) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
  return t
}

function checkRevision(t: StoredTemplate, expected: unknown) {
  if (typeof expected !== 'number' || expected !== t.revision) {
    throw new TemplateError('STALE', 'This template was changed in another window or by someone else. Reload it to see the latest version.', 409, { revision: t.revision })
  }
}

/** Edit the latest version while it is still a draft. */
export async function updateDraft(a: { caller: OrganizerCaller; id: string; version: number; expectedRevision: unknown; input: TemplateDraftInput }): Promise<{ findings: ValidationFinding[] }> {
  const t0 = await loadOwned(null, a.caller, a.id)
  const input = { ...a.input, name: t0.name }                      // the name is fixed for the template's life
  await assertMarketingAllowed(input)
  const { eventType, findings } = await validateFor(a.caller.workspaceUid, input, a.id, false)
  await adminDb.runTransaction(async txn => {
    const t = await loadOwned(txn, a.caller, a.id)
    checkRevision(t, a.expectedRevision)
    if (a.version !== t.latestVersion) throw new TemplateError('NOT_LATEST', 'Only the latest version can be edited.', 409)
    const vs = await txn.get(vRef(a.id, a.version))
    const v = vs.data() as StoredVersion | undefined
    if (!v) throw new TemplateError('NOT_FOUND', 'Version not found.', 404)
    if (v.internal.status !== 'draft') throw new TemplateError('LOCKED', 'This version has been submitted and can no longer be edited. Create a new version instead.', 409)
    const next = versionDoc(a.caller.workspaceUid, input, a.version, v.parentVersion, eventType, findings, v.createdBy ?? a.caller.callerUid)
    txn.update(vRef(a.id, a.version), {
      category: next.category, language: next.language, eventSlug: next.eventSlug, eventType: next.eventType, content: next.content,
      customVariables: next.customVariables, examples: next.examples, contentHash: next.contentHash, compiled: next.compiled, validation: next.validation,
    })
    txn.update(tRef(a.id), {
      category: input.category, language: input.language, eventSlug: input.eventSlug, revision: t.revision + 1,
      'summary.body': input.content.body.slice(0, LIMITS.body + 50), updatedAt: FieldValue.serverTimestamp(),
    })
    history(txn, a.id, { action: 'edited', version: a.version, actor: { kind: 'organizer', uid: a.caller.callerUid }, summary: 'Draft edited.', details: { contentHash: next.contentHash } })
  })
  return { findings }
}

/** Start version n+1 from an earlier version (after changes were requested, or after any rejection). */
export async function reviseTemplate(a: { caller: OrganizerCaller; id: string; fromVersion: number; expectedRevision: unknown; input: TemplateDraftInput }): Promise<{ version: number; findings: ValidationFinding[] }> {
  const t0 = await loadOwned(null, a.caller, a.id)
  const input = { ...a.input, name: t0.name }
  await assertMarketingAllowed(input)
  const { eventType, findings } = await validateFor(a.caller.workspaceUid, input, a.id, false)
  let created = 0
  await adminDb.runTransaction(async txn => {
    const t = await loadOwned(txn, a.caller, a.id)
    checkRevision(t, a.expectedRevision)
    const latest = (await txn.get(vRef(a.id, t.latestVersion))).data() as StoredVersion | undefined
    if (!latest) throw new TemplateError('NOT_FOUND', 'Version not found.', 404)
    if (latest.internal.status === 'draft') throw new TemplateError('DRAFT_EXISTS', 'The latest version is still a draft — edit it instead of creating another.', 409)
    if (latest.internal.status === 'pending_review') throw new TemplateError('IN_REVIEW', 'The latest version is waiting for review. Wait for the decision before creating a new version.', 409)
    if (latest.meta.status === 'submitting') throw new TemplateError('SUBMITTING', 'The latest version is being submitted to Meta. Try again in a minute.', 409)
    if (!(await txn.get(vRef(a.id, a.fromVersion))).exists) throw new TemplateError('NOT_FOUND', 'The version to revise was not found.', 404)
    created = t.latestVersion + 1
    txn.create(vRef(a.id, created), versionDoc(a.caller.workspaceUid, input, created, a.fromVersion, eventType, findings, a.caller.callerUid) as unknown as FirebaseFirestore.DocumentData)
    txn.update(tRef(a.id), {
      latestVersion: created, category: input.category, language: input.language, eventSlug: input.eventSlug, revision: t.revision + 1,
      summary: { internalStatus: 'draft', metaStatus: 'not_submitted', body: input.content.body.slice(0, LIMITS.body + 50) },
      updatedAt: FieldValue.serverTimestamp(),
    })
    history(txn, a.id, { action: 'version_created', version: created, actor: { kind: 'organizer', uid: a.caller.callerUid }, summary: `Version ${created} created from version ${a.fromVersion}.`, details: { parentVersion: a.fromVersion } })
  })
  return { version: created, findings }
}

export interface SubmitResult {
  mode: ReviewMode; internalStatus: InternalStatus; metaStatus: MetaStatus; findings: ValidationFinding[]; metaMessage?: string | null
}

/**
 * Submit the latest draft. The server validates the stored content again (errors refuse it). Manual
 * mode → pending review (Super Admins are notified). Automatic mode → approved by the system and
 * submitted to Meta straight away; Meta still has to approve it before it can be broadcast.
 */
export async function submitForReview(a: { caller: OrganizerCaller; id: string; version: number; expectedRevision: unknown }): Promise<SubmitResult> {
  const t0 = await loadOwned(null, a.caller, a.id)
  const v0 = (await vRef(a.id, a.version).get()).data() as StoredVersion | undefined
  if (!v0) throw new TemplateError('NOT_FOUND', 'Version not found.', 404)
  const { findings } = await validateFor(a.caller.workspaceUid, inputOf(t0, v0), a.id, true)
  if (hasErrors(findings)) throw new TemplateError('VALIDATION_FAILED', 'Fix the errors before submitting.', 422, { findings })
  const { mode } = await resolveReviewMode()
  const reviewId = `wtpl_review_${a.id}_v${a.version}_${randomUUID().slice(0, 8)}`
  await adminDb.runTransaction(async txn => {
    const t = await loadOwned(txn, a.caller, a.id)
    checkRevision(t, a.expectedRevision)
    if (a.version !== t.latestVersion) throw new TemplateError('NOT_LATEST', 'Only the latest version can be submitted.', 409)
    const v = (await txn.get(vRef(a.id, a.version))).data() as StoredVersion | undefined
    if (!v) throw new TemplateError('NOT_FOUND', 'Version not found.', 404)
    if (v.internal.status !== 'draft') throw new TemplateError('ALREADY_SUBMITTED', 'This version has already been submitted.', 409)
    if (v.contentHash !== v0.contentHash) throw new TemplateError('STALE', 'The draft changed while it was being submitted. Review it and submit again.', 409)
    const compiled = compileTemplate(inputOf(t, v))
    const base = { compiled: { bodyOrder: compiled.bodyOrder, headerOrder: compiled.headerOrder, componentsJson: JSON.stringify(compiled.components) }, validation: findings }
    const actor: Actor = { kind: 'organizer', uid: a.caller.callerUid }
    if (mode === 'manual') {
      txn.update(vRef(a.id, a.version), { ...base, internal: { status: 'pending_review', mode, submittedAt: FieldValue.serverTimestamp(), submittedBy: a.caller.callerUid } })
      txn.update(tRef(a.id), { 'summary.internalStatus': 'pending_review', revision: t.revision + 1, updatedAt: FieldValue.serverTimestamp() })
      history(txn, a.id, { action: 'submitted_for_review', version: a.version, actor, summary: 'Submitted for Super Admin review.', details: { contentHash: v.contentHash, warnings: findings.filter(f => f.severity === 'warning').length } })
      stageOutboxMessage(txn, {
        id: reviewId, audience: { kind: 'super_admins' }, adminKind: 'whatsapp_template',
        subject: `WhatsApp template to review: ${t.name} (v${a.version})`, heading: 'A WhatsApp template is waiting for review',
        intro: 'An organizer submitted a WhatsApp template. Approve it for submission to Meta, request changes, or reject it.',
        facts: [{ label: 'Template', value: `${t.name} · version ${a.version}` }, { label: 'Category', value: v.category }, { label: 'Language', value: v.language }],
        path: `/admin/whatsapp-templates?template=${encodeURIComponent(a.id)}`, ctaLabel: 'Review template',
        metadata: { templateId: a.id, version: a.version, organizerUid: t.organizerUid },
      })
    } else {
      txn.update(vRef(a.id, a.version), {
        ...base,
        internal: { status: 'approved_for_submission', mode, submittedAt: FieldValue.serverTimestamp(), submittedBy: a.caller.callerUid, decidedAt: FieldValue.serverTimestamp(), decidedBy: null, decidedBySystem: true, decisionReason: null, approvedHash: v.contentHash },
      })
      txn.update(tRef(a.id), { 'summary.internalStatus': 'approved_for_submission', revision: t.revision + 1, updatedAt: FieldValue.serverTimestamp() })
      history(txn, a.id, { action: 'auto_approved', version: a.version, actor: { kind: 'system' }, summary: 'Passed automatic validation (automatic review mode) — submitting to Meta.', details: { contentHash: v.contentHash } })
    }
  })
  if (mode === 'manual') { scheduleOutboxDelivery(reviewId); return { mode, internalStatus: 'pending_review', metaStatus: 'not_submitted', findings } }
  const outcome = await submitVersionToMeta({ id: a.id, version: a.version, actor: { kind: 'system' } })
  return { mode, internalStatus: 'approved_for_submission', metaStatus: outcome.metaStatus, findings, metaMessage: outcome.message }
}

// ─── Super Admin decisions and notes ─────────────────────────────────────────

export type AdminAction = 'approve' | 'reject' | 'request_changes'

export async function adminDecide(a: { adminUid: string; id: string; version: number; contentHash: string; action: AdminAction; reason: string | null; note: string | null }): Promise<{ internalStatus: InternalStatus; metaStatus: MetaStatus; metaMessage?: string | null }> {
  const reason = a.reason?.trim() || null
  if ((a.action === 'reject' || a.action === 'request_changes') && (!reason || reason.length < LIMITS.reasonMin || reason.length > LIMITS.reasonMax)) {
    throw new TemplateError('REASON_REQUIRED', `Explain the decision to the organizer (${LIMITS.reasonMin}–${LIMITS.reasonMax} characters).`)
  }
  if (reason && reason.length > LIMITS.reasonMax) throw new TemplateError('INVALID', 'The message is too long.')
  const note = a.note?.trim() || null
  if (note && note.length > LIMITS.noteMax) throw new TemplateError('INVALID', 'The internal note is too long.')

  const t0 = (await tRef(a.id).get()).data() as StoredTemplate | undefined
  const v0 = (await vRef(a.id, a.version).get()).data() as StoredVersion | undefined
  if (!t0 || !v0) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
  // Re-validated HERE, on the stored content, at decision time — never trusted from review time.
  if (a.action === 'approve') {
    const { findings } = await validateFor(t0.organizerUid, inputOf(t0, v0), a.id, true)
    if (hasErrors(findings)) throw new TemplateError('VALIDATION_FAILED', 'This version no longer passes validation and cannot be approved.', 422, { findings })
  }
  const next: InternalStatus = a.action === 'approve' ? 'approved_for_submission' : a.action === 'reject' ? 'rejected' : 'changes_requested'
  const outboxId = `wtpl_decision_${a.id}_v${a.version}_${randomUUID().slice(0, 8)}`
  await adminDb.runTransaction(async txn => {
    const ts = await txn.get(tRef(a.id))
    const t = ts.data() as StoredTemplate | undefined
    const v = (await txn.get(vRef(a.id, a.version))).data() as StoredVersion | undefined
    if (!t || !v) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
    if (v.internal.status !== 'pending_review') throw new TemplateError('NOT_PENDING', `This version is ${INTERNAL_STATUS_LABEL[v.internal.status].toLowerCase()}, not waiting for review.`, 409)
    if (v.contentHash !== a.contentHash) throw new TemplateError('STALE', 'The content you reviewed is not the content stored. Reload and review again.', 409)
    txn.update(vRef(a.id, a.version), {
      'internal.status': next, 'internal.decidedAt': FieldValue.serverTimestamp(), 'internal.decidedBy': a.adminUid, 'internal.decidedBySystem': false,
      'internal.decisionReason': reason, 'internal.approvedHash': a.action === 'approve' ? v.contentHash : null,
    })
    txn.update(tRef(a.id), { ...(t.latestVersion === a.version ? { 'summary.internalStatus': next } : {}), revision: t.revision + 1, updatedAt: FieldValue.serverTimestamp() })
    const label = a.action === 'approve' ? 'Approved for submission to Meta' : a.action === 'reject' ? 'Rejected' : 'Changes requested'
    history(txn, a.id, { action: `review.${a.action}`, version: a.version, actor: { kind: 'super_admin', uid: a.adminUid }, summary: reason ? `${label}: ${reason}` : `${label}.`, details: { contentHash: v.contentHash } })
    if (note) txn.create(tRef(a.id).collection('adminNotes').doc(), { text: note, version: a.version, authorUid: a.adminUid, createdAt: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, {
      adminUid: a.adminUid, actorRole: 'super_admin', action: 'whatsapp_template.reviewed', entityType: 'whatsapp_template', entityId: a.id,
      ...(reason ? { reason } : {}), changedFields: ['internal.status'], before: { status: 'pending_review' }, after: { status: next },
      metadata: { version: a.version, organizerUid: t.organizerUid, contentHash: v.contentHash, noteAdded: !!note },
    })
    stageOutboxMessage(txn, {
      id: outboxId, audience: { kind: 'organizer', organizerUid: t.organizerUid },
      subject: a.action === 'approve' ? `WhatsApp template approved for submission: ${t.name}` : a.action === 'reject' ? `WhatsApp template not approved: ${t.name}` : `Changes requested on WhatsApp template: ${t.name}`,
      heading: label,
      intro: a.action === 'approve'
        ? 'RegisterDesk approved your template and is submitting it to Meta. It can be used in broadcasts once Meta approves it too.'
        : 'RegisterDesk reviewed your WhatsApp template. Open it to see the explanation and create a revised version.',
      facts: [{ label: 'Template', value: `${t.name} · version ${a.version}` }, ...(reason ? [{ label: 'Message from RegisterDesk', value: reason }] : [])],
      path: `/dashboard/communications?tab=templates&template=${encodeURIComponent(a.id)}`, ctaLabel: 'Open template',
      inbox: { category: 'broadcast', type: 'whatsapp_template', severity: a.action === 'approve' ? 'success' : 'warning', actionRequired: a.action !== 'approve' },
    })
  })
  scheduleOutboxDelivery(outboxId)
  if (a.action !== 'approve') return { internalStatus: next, metaStatus: v0.meta.status }
  const outcome = await submitVersionToMeta({ id: a.id, version: a.version, actor: { kind: 'super_admin', uid: a.adminUid } })
  return { internalStatus: next, metaStatus: outcome.metaStatus, metaMessage: outcome.message }
}

export async function adminAddNote(a: { adminUid: string; id: string; text: string; version: number | null }): Promise<void> {
  const text = a.text.trim()
  if (!text || text.length > LIMITS.noteMax) throw new TemplateError('INVALID', `Write a note of 1–${LIMITS.noteMax} characters.`)
  await adminDb.runTransaction(async txn => {
    if (!(await txn.get(tRef(a.id))).exists) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
    txn.create(tRef(a.id).collection('adminNotes').doc(), { text, version: a.version, authorUid: a.adminUid, createdAt: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, { adminUid: a.adminUid, actorRole: 'super_admin', action: 'whatsapp_template.note_added', entityType: 'whatsapp_template', entityId: a.id, metadata: { version: a.version } })
  })
}

// ─── Meta submission ─────────────────────────────────────────────────────────

export interface MetaSubmission { metaStatus: MetaStatus; message: string | null }

/**
 * Claim → submit → record. Only an internally-approved version whose content still matches the
 * approval, in a submittable Meta state and not already being submitted, is sent. Any attempt after
 * the first looks the template up at Meta first, so a lost answer can never create a duplicate.
 */
export async function submitVersionToMeta(a: { id: string; version: number; actor: Actor }): Promise<MetaSubmission> {
  const leaseId = randomUUID()
  let claimed: { t: StoredTemplate; v: StoredVersion; attempt: number } | null = null
  try {
    claimed = await adminDb.runTransaction(async txn => {
      const t = (await txn.get(tRef(a.id))).data() as StoredTemplate | undefined
      const v = (await txn.get(vRef(a.id, a.version))).data() as StoredVersion | undefined
      if (!t || !v) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
      if (v.internal.status !== 'approved_for_submission' || v.internal.approvedHash !== v.contentHash) {
        throw new TemplateError('NOT_APPROVED', 'Only a version approved for submission can be sent to Meta.', 409)
      }
      if (v.meta.status === 'submitting' && ms(v.meta.leaseUntil) > Date.now()) throw new TemplateError('SUBMITTING', 'This version is already being submitted.', 409)
      if (v.meta.status !== 'submitting' && !SUBMITTABLE_META_STATUSES.has(v.meta.status)) {
        throw new TemplateError('ALREADY_AT_META', `Meta already holds this version (${META_STATUS_LABEL[v.meta.status].toLowerCase()}). Use "Sync with Meta" instead.`, 409)
      }
      if (!v.compiled) throw new TemplateError('NOT_COMPILED', 'This version has validation errors and cannot be submitted.', 409)
      const attempt = (v.meta.attempts ?? 0) + 1
      txn.update(vRef(a.id, a.version), {
        'meta.status': 'submitting', 'meta.leaseId': leaseId, 'meta.leaseUntil': Timestamp.fromMillis(Date.now() + SUBMIT_LEASE_MS),
        'meta.attempts': attempt, 'meta.lastAttemptAt': FieldValue.serverTimestamp(),
      })
      txn.set(adminDb.collection(META_NAMES).doc(metaNameKey(v.metaName, v.language)), { templateId: a.id, version: a.version, organizerUid: t.organizerUid })
      if (t.latestVersion === a.version) txn.update(tRef(a.id), { 'summary.metaStatus': 'submitting', updatedAt: FieldValue.serverTimestamp() })
      history(txn, a.id, { action: 'meta.submission_started', version: a.version, actor: a.actor, summary: `Submission to Meta started (attempt ${attempt}).`, details: { metaName: v.metaName } })
      return { t, v, attempt }
    })
  } catch (err) {
    if (err instanceof TemplateError && a.actor.kind === 'system') return { metaStatus: 'not_submitted', message: err.message }
    throw err
  }

  const { t, v, attempt } = claimed
  const outcome = await submitMetaTemplate({
    name: v.metaName, language: v.language, category: v.category === 'marketing' ? 'marketing' : 'utility',
    components: JSON.parse(v.compiled!.componentsJson) as Record<string, unknown>[], lookupFirst: attempt > 1,
  }).catch(err => ({ kind: 'unknown' as const, error: err instanceof Error ? err.message : 'Unexpected error' }))

  let metaStatus: MetaStatus
  let message: string | null = null
  const patch: Record<string, unknown> = { 'meta.leaseId': null, 'meta.leaseUntil': null }
  if (outcome.kind === 'created' || outcome.kind === 'found') {
    metaStatus = normalizeMetaStatus(outcome.node.status ?? 'PENDING')
    if (metaStatus === 'unknown') metaStatus = 'pending'
    const cat = normalizeMetaCategory(outcome.node.category)
    Object.assign(patch, {
      'meta.status': metaStatus, 'meta.rawStatus': outcome.node.status ?? null, 'meta.templateId': outcome.node.id,
      'meta.category': cat, 'meta.categoryChanged': !!cat && cat !== v.category,
      'meta.rejectionReason': normalizeRejectionReason(outcome.node.rejected_reason),
      // No 'meta.statusAt': that is the time of a Meta EVENT (webhook / sync). Stamping the create
      // response with "now" would make Meta's own near-instant webhook look older and be ignored.
      'meta.submittedAt': FieldValue.serverTimestamp(), 'meta.syncedAt': FieldValue.serverTimestamp(), 'meta.lastError': null,
    })
    message = outcome.kind === 'found' ? 'Meta already had this version from an earlier attempt; it was linked rather than created again.' : null
  } else if (outcome.kind === 'failed') {
    metaStatus = 'submission_failed'; message = outcome.error
    Object.assign(patch, { 'meta.status': metaStatus, 'meta.lastError': outcome.error })
  } else if (outcome.kind === 'not_configured') {
    metaStatus = 'not_submitted'; message = 'WhatsApp is not connected to Meta on this platform, so nothing was submitted.'
    Object.assign(patch, { 'meta.status': metaStatus, 'meta.lastError': message })
  } else {
    metaStatus = 'submission_unknown'
    message = `Meta did not give a definite answer (${'error' in outcome ? outcome.error : 'no response'}). The template may or may not have been created; retrying checks Meta first, so it cannot be created twice.`
    Object.assign(patch, { 'meta.status': metaStatus, 'meta.lastError': message })
  }

  const alertId = `wtpl_submitfail_${a.id}_v${a.version}_${attempt}`
  const notify = metaStatus === 'submission_failed' || metaStatus === 'submission_unknown'
  await adminDb.runTransaction(async txn => {
    const cur = (await txn.get(vRef(a.id, a.version))).data() as StoredVersion | undefined
    const tcur = (await txn.get(tRef(a.id))).data() as StoredTemplate | undefined
    if (!cur || !tcur || cur.meta.leaseId !== leaseId) return            // lost the lease: the other driver records
    // Meta's webhook can arrive before this answer is recorded. Its status is newer than the create
    // response, so keep it and record only the link (template id, submission time).
    if (cur.meta.status !== 'submitting') {
      for (const k of ['meta.status', 'meta.rawStatus', 'meta.rejectionReason', 'meta.lastError']) delete patch[k]
      metaStatus = cur.meta.status
    }
    txn.update(vRef(a.id, a.version), patch)
    if (outcome.kind === 'created' || outcome.kind === 'found') {
      txn.set(adminDb.collection(META_IDS).doc(outcome.node.id), { templateId: a.id, version: a.version, organizerUid: tcur.organizerUid })
    }
    const sendable = SENDABLE_META_STATUSES.has(metaStatus)
    txn.update(tRef(a.id), {
      ...(tcur.latestVersion === a.version ? { 'summary.metaStatus': metaStatus } : {}),
      ...(sendable && a.version > (tcur.activeVersion ?? 0) ? { activeVersion: a.version } : {}),
      revision: tcur.revision + 1, updatedAt: FieldValue.serverTimestamp(),
    })
    history(txn, a.id, {
      action: outcome.kind === 'created' || outcome.kind === 'found' ? 'meta.submitted' : `meta.${metaStatus}`, version: a.version, actor: a.actor,
      summary: outcome.kind === 'created' || outcome.kind === 'found' ? `Submitted to Meta — ${META_STATUS_LABEL[metaStatus].toLowerCase()}.${message ? ` ${message}` : ''}` : `${META_STATUS_LABEL[metaStatus]}: ${message ?? ''}`,
      details: { attempt, ...(outcome.kind === 'created' || outcome.kind === 'found' ? { metaTemplateId: outcome.node.id, metaStatus: outcome.node.status ?? null } : {}) },
    })
    if (a.actor.kind === 'super_admin' && a.actor.uid) {
      stageAdminAudit(txn, { adminUid: a.actor.uid, actorRole: 'super_admin', action: 'whatsapp_template.meta_submitted', entityType: 'whatsapp_template', entityId: a.id, metadata: { version: a.version, attempt, outcome: metaStatus } })
    }
    if (notify) {
      stageOutboxMessage(txn, {
        id: alertId, audience: { kind: 'super_admins' }, adminKind: 'whatsapp_template',
        subject: `WhatsApp template submission ${metaStatus === 'submission_failed' ? 'failed' : 'needs checking'}: ${t.name} (v${a.version})`,
        heading: META_STATUS_LABEL[metaStatus], intro: (message ?? '').slice(0, 900),
        facts: [{ label: 'Template', value: `${t.name} · version ${a.version}` }, { label: 'Attempt', value: String(attempt) }],
        path: `/admin/whatsapp-templates?template=${encodeURIComponent(a.id)}`, ctaLabel: 'Open template',
        metadata: { templateId: a.id, version: a.version },
      })
    }
  })
  if (notify) scheduleOutboxDelivery(alertId)
  return { metaStatus, message }
}

// ─── Meta status: webhook and controlled sync ────────────────────────────────

async function locate(metaTemplateId: string, name: string, language: string): Promise<{ id: string; version: number } | null> {
  const byId = await adminDb.collection(META_IDS).doc(metaTemplateId).get()
  if (byId.exists) { const d = byId.data() as { templateId: string; version: number }; return { id: d.templateId, version: d.version } }
  if (!/^[a-z0-9_]+$/.test(name) || !/^[A-Za-z_]{2,8}$/.test(language)) return null
  const byName = await adminDb.collection(META_NAMES).doc(metaNameKey(name, language)).get()
  if (byName.exists) { const d = byName.data() as { templateId: string; version: number }; return { id: d.templateId, version: d.version } }
  return null
}

export type ApplyResult = 'applied' | 'duplicate' | 'stale' | 'unmatched' | 'needs_sync' | 'unchanged'

interface MetaUpdate {
  source: 'webhook' | 'sync'
  metaTemplateId: string; name: string; language: string
  status?: { raw: string; reason: string | null; rejectionInfo?: VersionView['meta']['rejectionDetail']; otherInfo?: VersionView['meta']['otherInfo']; disableDateMs?: number | null }
  category?: { previous: string | null; next: string | null }
  timeMs: number
  dedupeKey: string | null
}

const NOTIFY_STATUSES: ReadonlySet<MetaStatus> = new Set(['approved', 'rejected', 'paused', 'disabled'])
const NOTICE_VERB: Partial<Record<MetaStatus, string>> = { approved: 'approved by Meta', rejected: 'rejected by Meta', paused: 'paused by Meta', disabled: 'disabled by Meta' }

async function applyMetaUpdate(u: MetaUpdate, actor: Actor): Promise<ApplyResult> {
  const where = await locate(u.metaTemplateId, u.name, u.language)
  if (!where) return 'unmatched'                       // e.g. a platform template created in WhatsApp Manager
  const outboxId = u.dedupeKey ? `wtpl_meta_${u.dedupeKey.slice(0, 48)}` : `wtpl_meta_${randomUUID()}`
  let notified = false
  const result = await adminDb.runTransaction(async (txn): Promise<ApplyResult> => {
    notified = false
    const evRef = u.dedupeKey ? adminDb.collection(META_EVENTS).doc(u.dedupeKey) : null
    if (evRef && (await txn.get(evRef)).exists) return 'duplicate'
    const t = (await txn.get(tRef(where.id))).data() as StoredTemplate | undefined
    const v = (await txn.get(vRef(where.id, where.version))).data() as StoredVersion | undefined
    if (!t || !v) return 'unmatched'
    if (evRef) txn.create(evRef, { templateId: where.id, version: where.version, metaTemplateId: u.metaTemplateId, receivedAt: FieldValue.serverTimestamp(), timeMs: u.timeMs })

    // An event older than the state already recorded (Meta does not guarantee order; a captured
    // request could be replayed) is kept in history but never rolls the status back.
    if (u.source === 'webhook' && u.timeMs && ms(v.meta.statusAt) && u.timeMs < ms(v.meta.statusAt)) {
      history(txn, where.id, { action: 'meta.event_ignored', version: where.version, actor, summary: `Older Meta event ignored (${u.status?.raw ?? 'category update'}).` })
      return 'stale'
    }

    const patch: Record<string, unknown> = { 'meta.templateId': u.metaTemplateId, 'meta.syncedAt': FieldValue.serverTimestamp() }
    let next: MetaStatus = v.meta.status
    const notes: string[] = []
    let outcome: ApplyResult = 'applied'

    if (u.status) {
      if (isStatusRestoringEvent(u.status.raw)) {
        outcome = 'needs_sync'
        notes.push(`Meta reported ${u.status.raw}.`)
      } else {
        next = normalizeMetaStatus(u.status.raw)
        const reason = normalizeRejectionReason(u.status.reason)
        const sameStatus = next === v.meta.status && (u.status.raw ?? null) === (v.meta.rawStatus ?? null) && reason === (v.meta.rejectionReason ?? null)
        if (u.source === 'sync' && sameStatus && !u.category) {
          txn.update(vRef(where.id, where.version), { 'meta.syncedAt': FieldValue.serverTimestamp() })
          return 'unchanged'
        }
        Object.assign(patch, {
          'meta.status': next, 'meta.rawStatus': u.status.raw, 'meta.statusAt': Timestamp.fromMillis(u.timeMs || Date.now()),
          'meta.rejectionReason': next === 'rejected' ? reason : (v.meta.rejectionReason ?? null),
          ...(u.status.rejectionInfo !== undefined ? { 'meta.rejectionDetail': u.status.rejectionInfo } : {}),
          ...(u.status.otherInfo !== undefined ? { 'meta.otherInfo': u.status.otherInfo } : {}),
          ...(u.status.disableDateMs ? { 'meta.disabledAt': Timestamp.fromMillis(u.status.disableDateMs) } : {}),
          // The submission lease is left alone: an in-flight submit still records its link.
          'meta.lastError': null,
        })
        notes.push(`Meta status: ${META_STATUS_LABEL[next]}${reason && next === 'rejected' ? ` (reason: ${reason})` : ''}${next === 'unknown' ? ` (Meta sent "${u.status.raw}")` : ''}.`)
      }
    }
    if (u.category?.next) {
      const cat = normalizeMetaCategory(u.category.next)
      Object.assign(patch, { 'meta.category': cat ?? u.category.next.toLowerCase(), 'meta.previousCategory': u.category.previous ? u.category.previous.toLowerCase() : null, 'meta.categoryChanged': !!cat && cat !== v.category })
      notes.push(`Meta category: ${u.category.previous ? `${u.category.previous.toLowerCase()} → ` : ''}${u.category.next.toLowerCase()}.`)
    }
    txn.update(vRef(where.id, where.version), patch)
    const sendable = SENDABLE_META_STATUSES.has(next)
    txn.update(tRef(where.id), {
      ...(t.latestVersion === where.version ? { 'summary.metaStatus': next } : {}),
      ...(sendable && where.version > (t.activeVersion ?? 0) ? { activeVersion: where.version } : {}),
      revision: t.revision + 1, updatedAt: FieldValue.serverTimestamp(),
    })
    history(txn, where.id, { action: u.category && !u.status ? 'meta.category_changed' : `meta.${u.source}`, version: where.version, actor, summary: notes.join(' ') || 'Meta update recorded.', details: { raw: u.status?.raw ?? null, source: u.source } })

    const categoryNotice = !!u.category?.next && normalizeMetaCategory(u.category.next) !== v.category
    if ((u.status && next !== v.meta.status && NOTIFY_STATUSES.has(next)) || categoryNotice) {
      notified = true
      const rejected = next === 'rejected'
      stageOutboxMessage(txn, {
        id: outboxId, audience: { kind: 'organizer', organizerUid: t.organizerUid },
        subject: categoryNotice && !u.status ? `Meta changed the category of your WhatsApp template: ${t.name}` : `WhatsApp template ${NOTICE_VERB[next] ?? META_STATUS_LABEL[next].toLowerCase()}: ${t.name}`,
        heading: categoryNotice && !u.status ? 'Template category changed by Meta' : META_STATUS_LABEL[next],
        intro: next === 'approved' ? 'Meta approved your template. It can now be used in WhatsApp broadcasts.'
          : rejected ? 'Meta rejected your template. Open it to see Meta’s reason and create a revised version.'
          : categoryNotice ? 'Meta re-categorised your template. Marketing messages are charged at a different Meta rate.'
          : 'Meta changed the status of your template. It cannot be used in broadcasts while it is in this state.',
        facts: [{ label: 'Template', value: `${t.name} · version ${where.version}` }, ...(rejected && normalizeRejectionReason(u.status?.reason) ? [{ label: 'Meta’s reason', value: String(normalizeRejectionReason(u.status?.reason)) }] : [])],
        path: `/dashboard/communications?tab=templates&template=${encodeURIComponent(where.id)}`, ctaLabel: 'Open template',
        inbox: { category: 'broadcast', type: 'whatsapp_template', severity: next === 'approved' ? 'success' : 'warning', actionRequired: next !== 'approved' },
      })
    }
    return outcome
  })
  if (notified) scheduleOutboxDelivery(outboxId)
  if (result === 'needs_sync') await syncVersion({ id: where.id, version: where.version, actor: { kind: 'system' } }).catch(() => undefined)
  return result
}

/** Apply one webhook event (already signature-verified by the route). Idempotent per event. */
export async function applyTemplateWebhookEvent(e: TemplateWebhookEvent): Promise<ApplyResult> {
  const fingerprint = e.kind === 'status'
    ? ['status', e.metaTemplateId, e.event, e.reason ?? '', e.entryTimeMs, e.rejectionInfo?.reason ?? '', e.otherInfo?.title ?? ''].join('|')
    : ['category', e.metaTemplateId, e.previousCategory ?? '', e.newCategory ?? '', e.entryTimeMs].join('|')
  const dedupeKey = createHash('sha256').update(fingerprint).digest('hex').slice(0, 40)
  return applyMetaUpdate({
    source: 'webhook', metaTemplateId: e.metaTemplateId, name: e.name, language: e.language, timeMs: e.entryTimeMs, dedupeKey,
    ...(e.kind === 'status'
      ? { status: { raw: e.event, reason: e.reason, rejectionInfo: e.rejectionInfo, otherInfo: e.otherInfo, disableDateMs: e.disableDateMs } }
      : { category: { previous: e.previousCategory, next: e.newCategory } }),
  }, { kind: 'meta' })
}

/** Read the version's current state from Meta and record any change (controlled sync). */
export async function syncVersion(a: { id: string; version: number; actor: Actor }): Promise<{ ok: boolean; result?: ApplyResult; error?: string }> {
  const v = (await vRef(a.id, a.version).get()).data() as StoredVersion | undefined
  if (!v) return { ok: false, error: 'Version not found.' }
  let node: MetaTemplateNode | null = null
  if (v.meta.templateId) {
    const r = await getMetaTemplate(v.meta.templateId)
    if (!r.ok) return { ok: false, error: r.error }
    node = r.node
  } else {
    try { node = await findMetaTemplate(v.metaName, v.language) } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Meta.' } }
    if (!node) return { ok: false, error: 'Meta has no template for this version.' }
    await adminDb.collection(META_IDS).doc(node.id).set({ templateId: a.id, version: a.version })
  }
  const cat = normalizeMetaCategory(node.category)
  const result = await applyMetaUpdate({
    source: 'sync', metaTemplateId: node.id, name: v.metaName, language: v.language, timeMs: Date.now(), dedupeKey: null,
    status: { raw: String(node.status ?? 'UNKNOWN'), reason: node.rejected_reason ?? null },
    ...(cat && cat !== (v.meta.category ?? null) ? { category: { previous: v.meta.category ?? null, next: cat } } : {}),
  }, a.actor)
  if (a.actor.kind === 'super_admin' && a.actor.uid) {
    const batch = adminDb.batch()
    stageAdminAudit(batch, { adminUid: a.actor.uid, actorRole: 'super_admin', action: 'whatsapp_template.meta_synced', entityType: 'whatsapp_template', entityId: a.id, metadata: { version: a.version, result } })
    await batch.commit().catch(err => console.error('[whatsapp-templates] sync audit row failed', err instanceof Error ? err.message : err))
  }
  return { ok: true, result }
}

/** Cron: re-read every template whose Meta outcome is still open. Bounded per run. */
export async function syncOpenTemplates(limit = 25): Promise<{ checked: number; changed: number; failed: number }> {
  const snap = await adminDb.collection(TEMPLATES).where('summary.metaStatus', 'in', ['pending', 'submission_unknown', 'in_appeal', 'unknown']).limit(limit).get()
  let changed = 0, failed = 0
  for (const d of snap.docs) {
    const t = d.data() as StoredTemplate
    const r = await syncVersion({ id: d.id, version: t.latestVersion, actor: { kind: 'system' } }).catch(err => ({ ok: false, error: String(err) }))
    if (!r.ok) failed++
    else if ('result' in r && r.result === 'applied') changed++
  }
  return { checked: snap.size, changed, failed }
}

// ─── Send eligibility ────────────────────────────────────────────────────────

export interface SendableTemplate {
  templateId: string; version: number; name: string; metaName: string; language: string; category: string
  bodyOrder: string[]; headerOrder: string[]; customVariables: CustomVariable[]; eventSlug: string | null
}
export type Eligibility = { ok: true; template: SendableTemplate } | { ok: false; code: string; message: string }

const refuse = (code: string, message: string): Eligibility => ({ ok: false, code, message })

/**
 * May this workspace broadcast with template `templateId` at `version` NOW? Server-side, at campaign
 * creation and again when the job starts. `version` must be the template's active approved version.
 */
export async function resolveSendableTemplate(workspaceUid: string, templateId: string, version: number | null, opts: { refreshIfStale?: boolean } = {}): Promise<Eligibility> {
  if (typeof templateId !== 'string' || !/^wt_[a-z0-9_]{1,140}$/.test(templateId)) return refuse('TEMPLATE_NOT_FOUND', 'Template not found.')
  const t = (await tRef(templateId).get()).data() as StoredTemplate | undefined
  if (!t || t.organizerUid !== workspaceUid) return refuse('TEMPLATE_NOT_FOUND', 'Template not found.')
  if (!t.activeVersion) return refuse('TEMPLATE_NOT_APPROVED', 'This template has no version approved by Meta yet.')
  if (version !== null && version !== t.activeVersion) {
    return refuse('TEMPLATE_VERSION_MISMATCH', `Version ${version} is not the template's approved version (version ${t.activeVersion} is). Reload and choose the template again.`)
  }
  let v = (await vRef(templateId, t.activeVersion).get()).data() as StoredVersion | undefined
  if (!v) return refuse('TEMPLATE_NOT_FOUND', 'Template version not found.')
  if (v.internal.status !== 'approved_for_submission' || !v.internal.approvedHash || v.internal.approvedHash !== v.contentHash) {
    return refuse('TEMPLATE_NOT_INTERNALLY_APPROVED', 'This template version does not have RegisterDesk approval for its current content.')
  }
  const fresh = Math.max(ms(v.meta.syncedAt), ms(v.meta.statusAt))
  if (Date.now() - fresh > META_STATUS_MAX_AGE_MS) {
    if (!opts.refreshIfStale) return refuse('TEMPLATE_META_STATUS_STALE', 'Meta’s approval for this template has not been confirmed recently.')
    const s = await syncVersion({ id: templateId, version: t.activeVersion, actor: { kind: 'system' } }).catch(err => ({ ok: false, error: String(err) }))
    if (!s.ok) return refuse('TEMPLATE_META_STATUS_STALE', 'Meta’s current status for this template could not be confirmed, so it was not used. Try again shortly.')
    v = (await vRef(templateId, t.activeVersion).get()).data() as StoredVersion | undefined
    if (!v) return refuse('TEMPLATE_NOT_FOUND', 'Template version not found.')
  }
  if (!SENDABLE_META_STATUSES.has(v.meta.status)) {
    return refuse('TEMPLATE_NOT_SENDABLE', `This template cannot be sent: ${META_STATUS_LABEL[v.meta.status].toLowerCase()}.`)
  }
  if (!v.compiled) return refuse('TEMPLATE_NOT_FOUND', 'Template content is unavailable.')
  return {
    ok: true,
    template: {
      templateId, version: v.version, name: t.name, metaName: v.metaName, language: v.language, category: v.meta.category ?? v.category,
      bodyOrder: v.compiled.bodyOrder, headerOrder: v.compiled.headerOrder, customVariables: v.customVariables ?? [], eventSlug: v.eventSlug,
    },
  }
}

const TYPED_URL = /url$/i

/** Validate the organizer-typed values for a template's broadcast-time variables (only those are kept). */
export function validateCampaignValues(template: Pick<SendableTemplate, 'customVariables'>, raw: unknown): { ok: true; values: Record<string, string> } | { ok: false; error: string; variable: string } {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const values: Record<string, string> = {}
  for (const cv of template.customVariables) {
    const v = typeof input[cv.key] === 'string' ? (input[cv.key] as string).trim() : ''
    if (!v) return { ok: false, variable: cv.key, error: `Enter a value for "${cv.label}".` }
    if (/[\r\n\t]| {4,}/.test(v)) return { ok: false, variable: cv.key, error: `"${cv.label}" must be a single line.` }
    if (v.length > LIMITS.campaignValueMax) return { ok: false, variable: cv.key, error: `"${cv.label}" is too long (max ${LIMITS.campaignValueMax} characters).` }
    if (TYPED_URL.test(cv.key)) {
      let ok = false
      try { ok = new URL(v).protocol === 'https:' } catch { ok = false }
      if (!ok) return { ok: false, variable: cv.key, error: `"${cv.label}" must be a full https:// link.` }
    }
    values[cv.key] = v
  }
  return { ok: true, values }
}

/** Event-sourced values a template needs, refusing when one is empty (Meta rejects an empty parameter). */
export function missingEventValues(template: Pick<SendableTemplate, 'bodyOrder' | 'headerOrder'>, eventValues: Record<string, string>): string[] {
  return [...new Set([...template.headerOrder, ...template.bodyOrder])]
    .filter(k => catalogVariable(k)?.source === 'event' && !(eventValues[k] ?? '').trim())
}

// ─── Read models ─────────────────────────────────────────────────────────────

function versionView(v: StoredVersion): VersionView {
  return {
    version: v.version, parentVersion: v.parentVersion ?? null, content: v.content, customVariables: v.customVariables ?? [], examples: v.examples ?? {},
    contentHash: v.contentHash, metaName: v.metaName, validation: v.validation ?? [],
    internal: {
      status: v.internal.status, mode: v.internal.mode ?? null, submittedAt: iso(v.internal.submittedAt), decidedAt: iso(v.internal.decidedAt),
      decisionReason: v.internal.decisionReason ?? null, decidedBySystem: !!v.internal.decidedBySystem,
    },
    meta: {
      status: v.meta.status, templateId: v.meta.templateId ?? null, category: v.meta.category ?? null, categoryChanged: !!v.meta.categoryChanged,
      rejectionReason: v.meta.rejectionReason ?? null, rejectionDetail: v.meta.rejectionDetail ?? null, otherInfo: v.meta.otherInfo ?? null,
      lastError: v.meta.lastError ?? null, attempts: v.meta.attempts ?? 0, submittedAt: iso(v.meta.submittedAt), statusAt: iso(v.meta.statusAt), syncedAt: iso(v.meta.syncedAt),
    },
    createdAt: iso(v.createdAt),
  }
}

function summaryView(id: string, t: StoredTemplate, withOwner = false): TemplateSummary {
  return {
    id, name: t.name, category: t.category, language: t.language, eventSlug: t.eventSlug ?? null, latestVersion: t.latestVersion, activeVersion: t.activeVersion ?? null,
    internalStatus: t.summary?.internalStatus ?? 'draft', metaStatus: t.summary?.metaStatus ?? 'not_submitted', updatedAt: iso(t.updatedAt),
    ...(withOwner ? { organizerUid: t.organizerUid } : {}),
  }
}

async function detail(id: string, t: StoredTemplate, withOwner: boolean): Promise<TemplateDetail> {
  const [vs, hs] = await Promise.all([
    tRef(id).collection('versions').get(),
    tRef(id).collection('history').orderBy('at', 'desc').limit(200).get(),
  ])
  const versions = vs.docs.map(d => versionView(d.data() as StoredVersion)).sort((a, b) => b.version - a.version)
  const history: HistoryView[] = hs.docs.map(d => {
    const h = d.data()
    return { id: d.id, at: iso(h.at), action: String(h.action ?? ''), version: typeof h.version === 'number' ? h.version : null, actor: (h.actorKind ?? 'system') as HistoryView['actor'], summary: String(h.summary ?? '') }
  })
  return { ...summaryView(id, t, withOwner), revision: t.revision, versions, history }
}

export async function listOrganizerTemplates(caller: OrganizerCaller): Promise<TemplateSummary[]> {
  return (await workspaceTemplates(caller.workspaceUid)).map(t => summaryView(t.id, t.data)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

export async function getOrganizerTemplate(caller: OrganizerCaller, id: string): Promise<TemplateDetail> {
  const t = await loadOwned(null, caller, id)
  return detail(id, t, false)                           // no adminNotes, ever
}

/** Templates the composer may offer right now (best-effort list; the server re-checks on send). */
export async function listSendableTemplates(caller: OrganizerCaller): Promise<SendableTemplateView[]> {
  const out: SendableTemplateView[] = []
  for (const { id, data } of await workspaceTemplates(caller.workspaceUid)) {
    if (!data.activeVersion) continue
    // refreshIfStale: an approval older than a day is re-read from Meta rather than hidden.
    const r = await resolveSendableTemplate(caller.workspaceUid, id, data.activeVersion, { refreshIfStale: true })
    if (!r.ok) continue
    const v = (await vRef(id, data.activeVersion).get()).data() as StoredVersion
    out.push({ id, name: data.name, version: data.activeVersion, language: v.language, category: r.template.category, content: v.content, customVariables: v.customVariables ?? [] })
  }
  return out
}

export async function adminListTemplates(f: { status?: string | null }): Promise<TemplateSummary[]> {
  const col = adminDb.collection(TEMPLATES)
  const snap = f.status === 'pending_review'
    ? await col.where('summary.internalStatus', '==', 'pending_review').limit(LIST_LIMIT).get()
    : await col.orderBy('updatedAt', 'desc').limit(LIST_LIMIT).get()
  let rows = snap.docs.map(d => summaryView(d.id, d.data() as StoredTemplate, true))
  if (f.status === 'at_meta') rows = rows.filter(r => ['submitting', 'pending', 'submission_unknown', 'in_appeal'].includes(r.metaStatus))
  else if (f.status === 'meta_rejected') rows = rows.filter(r => ['rejected', 'paused', 'disabled', 'submission_failed'].includes(r.metaStatus))
  else if (f.status === 'approved') rows = rows.filter(r => r.activeVersion !== null)
  return rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

export interface AdminTemplateDetail extends TemplateDetail {
  notes: Array<{ id: string; text: string; version: number | null; authorUid: string; createdAt: string | null }>
  organizer: { uid: string; name: string | null; email: string | null }
}

export async function adminGetTemplate(id: string): Promise<AdminTemplateDetail> {
  const t = (await tRef(id).get()).data() as StoredTemplate | undefined
  if (!t) throw new TemplateError('NOT_FOUND', 'Template not found.', 404)
  const [d, notes, user] = await Promise.all([
    detail(id, t, true),
    tRef(id).collection('adminNotes').orderBy('createdAt', 'desc').limit(100).get(),
    adminDb.collection('users').doc(t.organizerUid).get(),
  ])
  const u = user.exists ? user.data() as Record<string, unknown> : {}
  const name = typeof u.organizationName === 'string' ? u.organizationName : typeof u.displayName === 'string' ? u.displayName : typeof u.name === 'string' ? u.name : null
  return {
    ...d,
    notes: notes.docs.map(n => { const x = n.data(); return { id: n.id, text: String(x.text ?? ''), version: typeof x.version === 'number' ? x.version : null, authorUid: String(x.authorUid ?? ''), createdAt: iso(x.createdAt) } }),
    organizer: { uid: t.organizerUid, name, email: typeof u.email === 'string' ? u.email : null },
  }
}
