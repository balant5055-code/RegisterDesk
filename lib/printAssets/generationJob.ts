// Print Asset generation on the generic job runner (PA-4). Server-only.
//
// Background generation of individual print assets (badge / bib / pass / ID card /
// table tent …) — ONE card per registration. Execution is entirely the ROE generic
// runner (lib/jobs/runner): this module supplies only the four JobStrategy hooks.
//
// REUSE — nothing is redesigned or duplicated:
//   • Generic Job Runner (runJobChunk) → lease / cursor / resume / cancel / budget.
//   • Print Renderer (renderToPdf)      → unchanged; same pipeline as the preview.
//   • Print Template + normalize/validate + Variable Resolver (PA-3).
//
// ═══ NO STORED OUTPUT (RD-PRINT-P0) ══════════════════════════════════════════════
// This job used to upload one PDF per registration to Firebase Storage
// (`printAssets/{owner}/{job}/{reg}.pdf`) and persist a PERMANENT, unauthenticated
// download-token URL on the item — files that were never deleted, holding a copy of
// every attendee's credential. It now:
//   • renders each card IN MEMORY to prove it renders, then discards the bytes;
//   • records only metadata on the item (`rendered`, `renderedAt`, `error`);
//   • stores NO attendee copy — the item keeps the registration id plus the pass /
//     category it was selected by; names, contacts, ticket/QR values and form answers
//     are read fresh from the registration whenever a card is rendered;
//   • serves downloads by rendering on demand (renderPrintCard), never from storage.
// Legacy items written before this change are READ but never rewritten; their stored
// `output` (path + token URL) is ignored by every reader and never returned.
//
// One registration = one unit of work. Per-item failures are persisted on the item
// doc (never fail the whole job) so a resumed run retries only what is missing.
// NO ZIP, NO printing, NO email/WhatsApp, NO QR/image generation — generation only.

import crypto            from 'crypto'
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult, JobPage } from '@/lib/jobs/runner'
import type { Job, JobStatus, JobCounts } from '@/lib/jobs/types'
import { getPrintTemplate } from '@/lib/printAssets/firestore'
import { getTemplateVersion } from '@/lib/printAssets/versions'
import {
  normalizeDesign, validateRenderDocument, renderToPdf, renderSheetsToPdf, RenderError, SheetBudgetError,
  buildVariableMap, collectImageSources, ensurePrintAssets, analyzeTextOverflow, createTextMeasurer,
  type RenderDocument, type PrintVariableSources,
} from '@/lib/printAssets/render'
import { computeSheetLayout, type SheetSpec } from '@/lib/printAssets/sheet/layout'
import { cardSizeMm } from '@/lib/printAssets/cardDimensions'
import { notifyPrintJobComplete } from '@/lib/notifications/inbox/notify'
import { buildQrValue }     from '@/lib/tickets/generate'
import { resolvePublicBranding } from '@/lib/branding/service'
import type { PublicBranding } from '@/lib/branding/types'
import { mergePreviewImageSources, type EventPreviewAssets } from '@/lib/printAssets/designer/previewData'
import type { PrintAssetType } from '@/lib/printAssets/types'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { identifierRosterVisible, ROSTER_STATUSES } from '@/lib/identifiers/eligibility'
import { checkInBlockReason }      from '@/lib/registrations/checkinEligibility'
import type { EffectivePrintBadgeTerms } from '@/lib/licensing/printBadgeCommercial'
import {
  billingOf, badgeQuoteHash, checkQuote, parseClientQuote, BADGE_QUOTE_TTL_MS,
  type PrintJobBilling, type QuoteSubject,
} from '@/lib/printAssets/badgeBilling/decisions'
import {
  claimedRegistrationIds, readBadgeAvailability, createBilledJob, claimBadgeForItem, markBilledItemFailed,
  settlePrintBadgeRound, reopenBilledJob, releaseReopenHold, roundRef,
  readPrintJobRequest, claimPrintJobRequest, renewPrintJobRequest, releasePrintJobRequest,
} from '@/lib/printAssets/badgeBilling/store'
import { readPrintBadgePilot } from '@/lib/licensing/printBadgePilotServer'
import { isPilotOrganizer } from '@/lib/licensing/printBadgePilot'

export const PRINT_GENERATION_JOBS = 'printGenerationJobs'

// Tunables — rendering is CPU-bound, so page size stays modest; the lease covers a
// slow page and the budget yields well before a serverless timeout.
const PRINT_PAGE_SIZE  = 10
const PRINT_BUDGET_MS  = 50_000
const PRINT_LEASE_MS   = 120_000

// Seeding tunables (RD-PRINT-SCALE-IMPLEMENTATION-01). One read page = one write batch,
// so this is BOTH the page size and the batch size: peak memory during job creation is
// SEED_PAGE_SIZE registrations at any event size. 400 keeps the batch inside the 500-op
// Firestore limit and matches the batch size this module already used.
const SEED_PAGE_SIZE   = 400
/** Fan-out for the explicit-selection document-id lookup. */
const GETALL_CHUNK     = 300
/**
 * The status every credential-issuing job in this repo selects on, taken from the
 * roster definition itself rather than copied — lib/identifiers/assignmentJob.ts reads
 * it the same way. A second literal here is exactly how two "canonical" rules drift.
 */
const ISSUABLE_STATUS  = ROSTER_STATUSES[0]   // 'confirmed'

/**
 * Hard ceiling on an explicit "Selected registrations" request. Exceeding it is an
 * ERROR, never a silent truncation: the create route rejects with 413 and reports the
 * requested count, because a job that quietly prints the first 5,000 of 20,000 badges
 * is discovered at the print shop.
 */
export const MAX_EXPLICIT_SELECTION = 5000

// ─── Filters (create-time selection only — no designer changes) ─────────────────
export interface PrintGenerationFilters {
  pass?:            string      // passId
  category?:        string      // matches bibCategory / passType / passName
  registrationIds?: string[]    // explicit selection ("Selected Registrations")
}

// ─── Job document ────────────────────────────────────────────────────────────────
// printGenerationJobs/{jobId} — generic control fields (Job) + payload.
export interface PrintGenerationJob extends Job {
  templateId: string
  /**
   * RD-PRINT-P1 — the immutable template version this job renders (printTemplateVersions).
   * Absent only on jobs created before versioning: those keep rendering the live template.
   */
  templateVersion?:     number
  templateVersionHash?: string
  eventId:    string
  eventSlug:  string
  eventName:  string
  assetType:  PrintAssetType
  filters:    PrintGenerationFilters
  /** RD-PRINT-BILL-P5 — present only on a paid / complimentary badge job; absent ⇒ free (as before). */
  billing?:   PrintJobBilling
  /** RD-PRINT-BILL-P5 fix 4 — a paid partial regenerate's targets; absent ⇒ the whole job runs. */
  runScope?:  string[]
}

/**
 * LEGACY ONLY — the stored output written before RD-PRINT-P0 (a Storage path and a
 * permanent token URL). Declared so legacy documents type-check when read; nothing
 * writes it any more, nothing reads its `url`/`path`, and no view returns it.
 */
export interface LegacyPrintItemOutput {
  path?:        string
  filename?:    string
  contentType?: string
  expiresAt?:   unknown
  url?:         string
}

// items/{registrationId} — selection METADATA only (RD-PRINT-P0). The pass / category
// are kept because the packaging filters select on them; nothing that identifies or
// contacts the attendee, and no credential, is copied here.
export interface PrintJobItem {
  registrationId: string
  passId:         string
  passName:       string
  category:       string
  /** True once the card rendered successfully (bytes discarded — nothing stored). */
  rendered?:      boolean
  renderedAt?:    unknown   // Firestore Timestamp
  error?:         string | null
  /** RD-PRINT-BILL-P5 — billed jobs only: how the card was paid for, and the round that billed it. */
  billed?:        'new' | 'prior' | 'complimentary'
  billedRound?:   number
  /** LEGACY (pre RD-PRINT-P0) — present only on old items; never written, never served. */
  output?:        LegacyPrintItemOutput
}

type PrintItemSeed = Pick<PrintJobItem, 'registrationId' | 'passId' | 'passName' | 'category'>

/**
 * The values a card is rendered from — built IN MEMORY from the live registration each
 * time a card renders, and never persisted (RD-PRINT-P0).
 */
export interface PrintCardFields {
  registrationId: string
  name:           string
  email:          string
  phone:          string
  ticketCode:     string
  qrValue:        string
  company:        string
  designation:    string
  category:       string
  bibNumber:      string
  passId:         string
  passName:       string
  formResponses:  Record<string, string>
}

/**
 * Whether an item's card is ready to download. `rendered` is authoritative once set;
 * a LEGACY item (no `rendered` field) counts as ready when it once produced output —
 * it is re-rendered on demand like any other, its stored file is never used.
 */
export function isPrintItemReady(item: Pick<PrintJobItem, 'rendered' | 'output'>): boolean {
  return item.rendered === undefined ? !!item.output : item.rendered === true
}

const itemsCol = (jobId: string) =>
  adminDb.collection(PRINT_GENERATION_JOBS).doc(jobId).collection('items')

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

// ─── Credential eligibility (RD-PRINT-SCALE-IMPLEMENTATION-01) ──────────────────
//
// A printed badge / ID card IS an event credential — it is what the holder presents
// at the gate. Issuing one to somebody the gate will refuse is the defect this closes.
//
// REUSE — no third status model is introduced here:
//   • the ROSTER arm is `identifierRosterVisible` (lib/identifiers/eligibility): the
//     same 'confirmed'-only rule BIB assignment and certificate generation select on.
//   • the REFUND arm is delegated to `checkInBlockReason` (lib/registrations/
//     checkinEligibility): the ONE canonical gate rule, so a card is never printed
//     for somebody check-in would turn away.
//
// The admitted set is therefore a strict SUBSET of what the gate admits, which is the
// invariant worth having: every card this job prints is a card that actually works.
//
//   INCLUDED   status 'confirmed' AND paymentStatus ≠ 'refunded'
//              (i.e. paymentStatus paid / not_required / pending / refund_pending)
//   EXCLUDED   'cancelled' · 'rejected' · 'pending' · 'waitlisted', and any
//              'confirmed' registration whose payment has been refunded
//   UNKNOWN    a status outside the RegistrationStatus union fails CLOSED — it is not
//              on the roster, so it receives no credential. Never silently issued.
export type PrintCredentialBlock = 'NOT_ON_ROSTER' | 'REFUNDED'

export function printCredentialBlockReason(
  reg: { status?: unknown; paymentStatus?: unknown },
): PrintCredentialBlock | null {
  if (!identifierRosterVisible(reg)) return 'NOT_ON_ROSTER'
  // Status is 'confirmed' by the line above, so the only verdict the gate can still
  // return is REFUNDED. Delegated rather than re-implemented so the two cannot drift.
  const status        = typeof reg.status === 'string' ? reg.status : ''
  const paymentStatus = typeof reg.paymentStatus === 'string' ? reg.paymentStatus : null
  return checkInBlockReason({ status, paymentStatus }) ? 'REFUNDED' : null
}

/**
 * What a filter MEANS — the single source of truth, used by BOTH intake paths.
 *
 * `pass` is additionally pushed into Firestore on the scan path, but it is still
 * evaluated here: the server-side `where` is an OPTIMISATION that must never change
 * the answer, and keeping this predicate authoritative is what makes the scan path and
 * the explicit-id path provably identical.
 *
 * `category` deliberately stays in memory. It matches ANY of bibCategory / passType /
 * passName — a three-field OR that no single Firestore equality can express, and
 * collapsing it into one would silently change which registrations are selected.
 */
export function matchesPrintFilters(
  r: { passId?: unknown; bibCategory?: unknown; passType?: unknown; passName?: unknown },
  filters: PrintGenerationFilters,
): boolean {
  if (filters.pass && r.passId !== filters.pass) return false
  if (filters.category) {
    const cat = filters.category
    if (r.bibCategory !== cat && r.passType !== cat && r.passName !== cat) return false
  }
  return true
}

/** The selection metadata an item carries (RD-PRINT-P0: no attendee copy). Pure. */
function buildPrintItemSeed(registrationId: string, r: RegistrationDocument): PrintItemSeed {
  return {
    registrationId,
    passId:   str(r.passId),
    passName: str(r.passName),
    category: str(r.bibCategory ?? r.passType ?? ''),
  }
}

/** The card's values, from the LIVE registration. In memory only — never stored. Pure. */
export function printCardFieldsFor(
  registrationId: string, r: RegistrationDocument, eventSlug: string,
): PrintCardFields {
  const responses: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.attendee.formResponses ?? {})) {
    if (v !== null && v !== undefined && typeof v !== 'object') responses[k] = String(v)
  }

  // Reuse buildQrValue() for the fallback when a legacy row lacks ticket.qrValue.
  const ticketCode = str(r.ticketCode)
  const qrValue = str(r.ticket?.qrValue) || (ticketCode ? buildQrValue(eventSlug, registrationId, ticketCode) : '')

  return {
    registrationId,
    name:        str(r.attendee.name),
    email:       str(r.attendee.email),
    phone:       str(r.attendee.phone),
    ticketCode,
    qrValue,
    company:     str(r.companyName),
    designation: str(r.designation),
    category:    str(r.bibCategory ?? r.passType ?? ''),
    bibNumber:   str(r.bibNumber),
    passId:      str(r.passId),
    passName:    str(r.passName),
    formResponses: responses,
  }
}

// ─── Item seeding (bounded — RD-PRINT-SCALE-IMPLEMENTATION-01) ──────────────────
//
// THE BUG THIS REPLACES. `resolvePrintItems` read EVERY registration for the event
// with one unbounded `.get()`, filtered in memory, and returned the whole set as an
// array which was then written in 400-doc batches. At 20,000 registrations that is
// 20,000 documents materialised inside a single request, and a create that dies
// part-way has to redo all of it.
//
// The read is now a keyset walk: one page in, one batch out, page discarded. Peak
// memory is SEED_PAGE_SIZE registrations regardless of event size, and every page
// already committed is durable work a retry does not repeat.
//
// INDEX NOTE — the query shape here is deliberately the one lib/certificates/jobs.ts
// and lib/identifiers/assignmentJob.ts already run in production: equality filters
// plus orderBy(__name__). Both variants are covered by indexes already declared in
// firestore.indexes.json, so this phase deploys nothing:
//   without pass →  organizerUid, eventSlug, status, __name__
//   with pass    →  organizerUid, eventSlug, status, passId   (__name__ implicit)
async function seedPrintItems(
  jobId: string, organizerUid: string, eventSlug: string, filters: PrintGenerationFilters,
  // RD-PRINT-BILL-P5 — `dryRun` walks the SAME selection without writing (the billing quote);
  // `onPage` sees each page's accepted registration ids (the billing recount). Absent ⇒ unchanged.
  // `merge` (billed jobs, whose ids are deterministic per requestId) writes ONLY the selection
  // fields, so a duplicate request seeding while the first job already runs can never reset a
  // card's rendered / billed state (fix 2).
  opts: { dryRun?: boolean; merge?: boolean; onPage?: (registrationIds: string[]) => Promise<void> } = {},
): Promise<{ total: number; eventName: string }> {
  const col  = itemsCol(jobId)
  const regs = adminDb.collection('registrations')
  let total     = 0
  let eventName = ''

  /**
   * Ownership + event scope are re-derived from the STORED document on every path,
   * never from the request. The explicit-id path is the one that matters: those ids
   * arrive from the browser, so a caller who substitutes another organizer's — or
   * another event's — registration id gets it dropped here rather than printed.
   */
  const accept = (id: string, r: RegistrationDocument): PrintItemSeed | null => {
    if (r.organizerUid !== organizerUid)  return null
    if (r.eventSlug    !== eventSlug)     return null
    if (printCredentialBlockReason(r))    return null
    if (!matchesPrintFilters(r, filters)) return null
    if (!eventName) eventName = str(r.eventName)
    return buildPrintItemSeed(id, r)
  }

  /** One page in ⇒ one batch out. Never more than SEED_PAGE_SIZE docs are held. */
  const flush = async (seeds: PrintItemSeed[]): Promise<void> => {
    if (!seeds.length) return
    if (!opts.dryRun) {
      const batch = adminDb.batch()
      for (const s of seeds) {
        if (opts.merge) batch.set(col.doc(s.registrationId), s, { merge: true })
        else batch.set(col.doc(s.registrationId), s)
      }
      await batch.commit()
    }
    if (opts.onPage) await opts.onPage(seeds.map(s => s.registrationId))
    total += seeds.length
  }

  const ids = filters.registrationIds
  if (ids && ids.length) {
    // Explicit selection ("Selected registrations"). A document-id lookup, so the read
    // is proportional to the SELECTION and never scans the collection. The size is
    // capped by MAX_EXPLICIT_SELECTION at the route, which rejects rather than truncates.
    for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
      const refs  = ids.slice(i, i + GETALL_CHUNK).map(id => regs.doc(id))
      const snaps = await adminDb.getAll(...refs)
      const seeds: PrintItemSeed[] = []
      for (const snap of snaps) {
        if (!snap.exists) continue
        const seed = accept(snap.id, snap.data() as RegistrationDocument)
        if (seed) seeds.push(seed)
      }
      await flush(seeds)
    }
    return { total, eventName }
  }

  // Whole-event scan, paged by document id.
  let cursor: string | null = null
  for (;;) {
    let q = regs
      .where('organizerUid', '==', organizerUid)
      .where('eventSlug',    '==', eventSlug)
      .where('status',       '==', ISSUABLE_STATUS)
    if (filters.pass) q = q.where('passId', '==', filters.pass)
    q = q.orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)

    const snap = await q.limit(SEED_PAGE_SIZE).get()
    if (snap.empty) break

    const seeds: PrintItemSeed[] = []
    for (const doc of snap.docs) {
      const seed = accept(doc.id, doc.data() as RegistrationDocument)
      if (seed) seeds.push(seed)
    }
    await flush(seeds)

    if (snap.size < SEED_PAGE_SIZE) break
    // The cursor advances on the last FETCHED document, not the last KEPT one — a page
    // whose every row was filtered out must still move the walk forward, or the loop
    // re-reads it for ever.
    cursor = snap.docs[snap.docs.length - 1].id
  }

  return { total, eventName }
}

// ─── Job creation ────────────────────────────────────────────────────────────────
export async function createPrintGenerationJob(meta: {
  templateId: string; eventId: string; eventSlug: string; assetType: PrintAssetType
  filters: PrintGenerationFilters; organizerUid: string; createdBy: string
  /** RD-PRINT-P1 — the version to pin (from ensureCurrentVersion). */
  templateVersion?: number; templateVersionHash?: string
}): Promise<PrintGenerationJob> {
  const jobId = `pgen_${crypto.randomUUID()}`

  // Items are seeded BEFORE the job document exists, on purpose. The job doc is what
  // every driver looks for — the cron scans `listActiveJobs`, the reaper revives from
  // it — so creating it last means no driver can ever observe a half-seeded job and
  // read a total that is still climbing. If this request dies mid-seed the orphaned
  // item docs are unreachable (no job doc references them) rather than harmful.
  const { total, eventName } = await seedPrintItems(jobId, meta.organizerUid, meta.eventSlug, meta.filters)

  return kernelCreateJob<PrintGenerationJob>(
    PRINT_GENERATION_JOBS,
    jobId,
    {
      organizerUid: meta.organizerUid,
      createdBy:    meta.createdBy,
      templateId:   meta.templateId,
      ...(meta.templateVersion ? { templateVersion: meta.templateVersion } : {}),
      ...(meta.templateVersionHash ? { templateVersionHash: meta.templateVersionHash } : {}),
      eventId:      meta.eventId,
      eventSlug:    meta.eventSlug,
      eventName,
      assetType:    meta.assetType,
      filters:      meta.filters,
    },
    total,
  )
}

// ─── Generation billing (RD-PRINT-BILL-P5) ─────────────────────────────────────────
//
// FREE jobs (every non-chargeable asset type, certificates, and every event while the code gate
// PAID_BADGE_GENERATION_RELEASED is closed) never reach this section: the create route calls
// createPrintGenerationJob above, unchanged. Paid and complimentary jobs are created here, and
// carry `billing` — the per-item claim and the round settlement key off it (badgeBilling/store.ts).

type CreatePrintJobMeta = Parameters<typeof createPrintGenerationJob>[0]

/** What the organizer is shown — and agrees to — before a paid job reserves units. */
export interface PrintBadgeQuote {
  mode:             'paid'
  /** Cards the selection will print. */
  eligible:         number
  /** Of those, attendees already billed on this event (reprints are free — D2). */
  previouslyBilled: number
  /** Attendees this job will bill: one unit each. */
  chargeable:       number
  /** Units the event can still use. */
  available:        number
  shortfall:        number
  unitPricePaise:   number | null
  priceSource:      string | null
  /** D3 — only the workspace owner can start a job that bills attendees. */
  ownerRequired:    boolean
  quoteHash:        string
  issuedAt:         number
  expiresAt:        number
}

export type PrintBillingRefusal = {
  ok: false; status: number; error: string
  code: 'REQUEST_ID_REQUIRED' | 'REQUEST_ID_REUSED' | 'REQUEST_IN_PROGRESS' | 'OWNER_REQUIRED' | 'INSUFFICIENT_BADGE_UNITS' | 'BILLING_STATE_CHANGED'
    | 'BILLING_QUOTE_REQUIRED' | 'QUOTE_INVALID' | 'QUOTE_EXPIRED' | 'QUOTE_CHANGED'
    | 'PILOT_REMOVED' | 'BILLING_UNAVAILABLE'   // RD-PRINT-P8 — reopening a paid job outside the pilot
  quote?: PrintBadgeQuote
}

const QUOTE_ERRORS: Record<'BILLING_QUOTE_REQUIRED' | 'QUOTE_INVALID' | 'QUOTE_EXPIRED' | 'QUOTE_CHANGED', string> = {
  BILLING_QUOTE_REQUIRED: 'This job uses prepaid ID badges. Review the quote and confirm it to continue.',
  QUOTE_INVALID:          'The quote does not match this selection. Review the new quote and confirm it.',
  QUOTE_EXPIRED:          'The quote has expired. Review the new quote and confirm it.',
  QUOTE_CHANGED:          'More attendees need a new badge than when you were quoted. Review the new quote and confirm it.',
}

function makeQuote(
  binding: { workspaceUid: string; draftId: string; subject: QuoteSubject },
  counts: { eligible: number; chargeable: number }, available: number, unitPricePaise: number | null,
  priceSource: string | null, nowMs: number,
): PrintBadgeQuote {
  const issuedAt = nowMs
  return {
    mode: 'paid', eligible: counts.eligible, previouslyBilled: counts.eligible - counts.chargeable,
    chargeable: counts.chargeable, available, shortfall: Math.max(0, counts.chargeable - available),
    unitPricePaise, priceSource, ownerRequired: counts.chargeable > 0,
    quoteHash: badgeQuoteHash({ ...binding, chargeable: counts.chargeable, issuedAt }),
    issuedAt, expiresAt: issuedAt + BADGE_QUOTE_TTL_MS,
  }
}

/** Counts a NEW job's selection without writing: eligible cards and attendees not yet billed. */
async function countPrintSelection(
  meta: Pick<CreatePrintJobMeta, 'organizerUid' | 'eventId' | 'eventSlug' | 'filters'>, write?: string, countClaims = true,
  /** Runs after every seeded page (the request marker's lease renewal); throws to stop the walk. */
  afterPage?: () => Promise<void>,
): Promise<{ eligible: number; chargeable: number; eventName: string }> {
  let chargeable = 0
  const onPage = countClaims || afterPage
    ? async (ids: string[]) => {
      if (countClaims) chargeable += ids.length - (await claimedRegistrationIds(meta.eventId, ids)).size
      if (afterPage) await afterPage()
    }
    : undefined
  // No job id for a dry run: the walk never writes, so the items path it is given is never used.
  const { total, eventName } = await seedPrintItems(write ?? 'pgen_quote', meta.organizerUid, meta.eventSlug, meta.filters, { dryRun: !write, merge: !!write, onPage })
  return { eligible: total, chargeable, eventName }
}

const createSubject = (meta: CreatePrintJobMeta): QuoteSubject =>
  ({ kind: 'create', templateId: meta.templateId, assetType: meta.assetType, filters: meta.filters })

/** Read-only quote for a NEW paid job (POST /api/organizer/print-jobs/quote). */
export async function quotePrintGenerationJob(
  meta: CreatePrintJobMeta, terms: EffectivePrintBadgeTerms | null, nowMs = Date.now(),
): Promise<PrintBadgeQuote> {
  const counts = await countPrintSelection(meta)
  const { available } = await readBadgeAvailability(meta.eventId, meta.organizerUid)
  return makeQuote({ workspaceUid: meta.organizerUid, draftId: meta.eventId, subject: createSubject(meta) },
    counts, available, terms?.unitPricePaise ?? null, terms?.sources.unitPricePaise ?? null, nowMs)
}

/** D5 — a stable requestId maps to ONE job id per workspace, so a retried create finds its job. */
export const billedPrintJobId = (workspaceUid: string, requestId: string) =>
  `pgen_${crypto.createHash('sha256').update(`${workspaceUid}\n${requestId}`).digest('hex').slice(0, 32)}`

export type BilledCreateResult = { ok: true; job: PrintGenerationJob; existing: boolean } | PrintBillingRefusal

const REUSED: PrintBillingRefusal = { ok: false, status: 409, code: 'REQUEST_ID_REUSED', error: 'This requestId was already used for a different print job' }
const IN_PROGRESS: PrintBillingRefusal = { ok: false, status: 409, code: 'REQUEST_IN_PROGRESS', error: 'This print job is still being created. Try again in a moment.' }
/** Thrown from inside the seed walk when this request's marker was taken over. */
class RequestOwnershipLost extends Error {}

/**
 * Creates a PAID or COMPLIMENTARY job. Paid:
 *   1. requestId required (D5). A repeat is answered from the request marker WITHOUT writing:
 *      the created job unchanged, 409 REQUEST_ID_REUSED, or 409 REQUEST_IN_PROGRESS.
 *   2. Dry-run count — nothing is written for a refusal: staff with chargeable attendees (D3),
 *      a missing / invalid / expired quote or one below the count (D4), too few units (blocks).
 *   3. Claim the request marker create-only (store.claimPrintJobRequest): only its owner seeds.
 *   4. Seed the items, recounting; a count that GREW since the pre-check is re-validated.
 *   5. ONE transaction — fenced on the marker — reserves the units, opens round 1, creates the job
 *      and marks the request created (store.createBilledJob).
 * Complimentary jobs follow the same path when a requestId is given; without one they get a random
 * id (one job per request, as before).
 */
export async function createBilledPrintGenerationJob(meta: CreatePrintJobMeta & {
  mode: 'paid' | 'complimentary'; terms: EffectivePrintBadgeTerms | null
  requestId: string | null; quote: unknown; isOwner: boolean; nowMs?: number
}): Promise<BilledCreateResult> {
  const nowMs = meta.nowMs ?? Date.now()
  const binding = { workspaceUid: meta.organizerUid, draftId: meta.eventId, subject: createSubject(meta) }
  // The request's identity (same hash function, fixed chargeable/issuedAt): a requestId replayed
  // with a different template or selection is a different request, and is refused.
  const requestHash = badgeQuoteHash({ ...binding, chargeable: 0, issuedAt: 0 })
  if (meta.mode === 'paid' && !meta.requestId) {
    return { ok: false, status: 400, code: 'REQUEST_ID_REQUIRED', error: 'requestId is required for a job that uses prepaid ID badges' }
  }
  // The request key — the deterministic id a requestId maps to (its marker id, and the job id of
  // its first attempt). Without a requestId (complimentary only) the job id is random, as before.
  const requestKey = meta.requestId ? billedPrintJobId(meta.organizerUid, meta.requestId) : null
  const sameRequest = (j: PrintGenerationJob): BilledCreateResult =>
    j.organizerUid === meta.organizerUid && billingOf(j)?.requestHash === requestHash
      ? { ok: true, job: j, existing: true }
      : REUSED
  const existingJob = async (id: string): Promise<BilledCreateResult> => {
    const j = await getPrintGenerationJob(id)
    return j ? sameRequest(j) : IN_PROGRESS
  }
  if (requestKey) {
    // Read-only first look: a repeat is answered from the marker and writes NOTHING — it never
    // counts, seeds or reserves, so it can never add an attendee to the original job.
    const m = await readPrintJobRequest(requestKey)
    if (m) {
      if (m.organizerUid !== meta.organizerUid || m.requestHash !== requestHash) return REUSED
      if (m.status === 'created') return existingJob(m.jobId)
      if (m.status === 'seeding' && Number(m.leaseUntil) >= Date.now()) return IN_PROGRESS
      // released, or a seeder whose lease expired: fall through and take it over below.
    } else {
      // A job created before request markers existed (deterministic id, no marker).
      const ex = await getPrintGenerationJob(requestKey)
      if (ex) return sameRequest(ex)
    }
  }

  const unitPricePaise = meta.terms?.unitPricePaise ?? null
  const priceSource = meta.terms?.sources.unitPricePaise ?? null
  const clientQuote = parseClientQuote(meta.quote)
  /** Every refusal before the reservation transaction — evaluated on a count, writes nothing. */
  const gate = async (counts: { eligible: number; chargeable: number }): Promise<PrintBillingRefusal | null> => {
    if (counts.chargeable <= 0) return null
    if (!meta.isOwner) {
      return { ok: false, status: 403, code: 'OWNER_REQUIRED', error: 'Only the workspace owner can start a print job that uses prepaid ID badges.' }
    }
    const fresh = async () => makeQuote(binding, counts, (await readBadgeAvailability(meta.eventId, meta.organizerUid)).available, unitPricePaise, priceSource, nowMs)
    const check = checkQuote(clientQuote, binding, counts.chargeable, nowMs)
    if (!check.ok) return { ok: false, status: 409, code: check.code, error: QUOTE_ERRORS[check.code], quote: await fresh() }
    const q = await fresh()
    if (q.shortfall > 0) {
      return { ok: false, status: 402, code: 'INSUFFICIENT_BADGE_UNITS', error: `This job needs ${q.chargeable} ID badges; ${q.available} are available. Buy more to continue.`, quote: q }
    }
    return null
  }

  let pre = { eligible: 0, chargeable: 0 }
  if (meta.mode === 'paid') {
    pre = await countPrintSelection(meta)
    const refused = await gate(pre)
    if (refused) return refused
  }

  // Create-only ownership of the requestId BEFORE any item is written: only the owner seeds, and it
  // seeds into the job id the marker names. Everyone else is answered from the marker.
  let jobId = `pgen_${crypto.randomUUID()}`
  let request: { key: string; token: string } | null = null
  if (requestKey) {
    const claim = await claimPrintJobRequest({ key: requestKey, organizerUid: meta.organizerUid, requestHash })
    if (claim.kind === 'reused') return REUSED
    if (claim.kind === 'in_progress') return IN_PROGRESS
    if (claim.kind === 'created') return existingJob(claim.jobId)
    jobId = claim.jobId
    request = { key: requestKey, token: claim.token }
  }
  /** A refusal AFTER the claim gives the requestId back (released, never deleted) so it can retry. */
  const release = async <R,>(r: R): Promise<R> => { if (request) await releasePrintJobRequest(request.key, request.token).catch(() => false); return r }

  let seeded: { eligible: number; chargeable: number; eventName: string }
  try {
    // Seed (the recount rides along on the same pages — no second walk). The marker lease is
    // renewed after every page; losing it (taken over after an expiry) stops this seeder.
    seeded = await countPrintSelection(meta, jobId, meta.mode === 'paid', request ? async () => {
      if (!(await renewPrintJobRequest(request!.key, request!.token))) throw new RequestOwnershipLost()
    } : undefined)
  } catch (err) {
    if (err instanceof RequestOwnershipLost) return IN_PROGRESS
    await release(null)
    throw err
  }
  const chargeable = meta.mode === 'paid' ? seeded.chargeable : 0
  if (meta.mode === 'paid' && chargeable > pre.chargeable) {
    const refused = await gate({ eligible: seeded.eligible, chargeable })
    if (refused) return release(refused)
  }

  const billing: PrintJobBilling = { mode: meta.mode, round: meta.mode === 'paid' ? 1 : 0, chargeable, requestHash, unitPricePaise }
  let out: Awaited<ReturnType<typeof createBilledJob>>
  try {
    out = await createBilledJob({
      jobId, total: seeded.eligible, mode: meta.mode, draftId: meta.eventId, organizerUid: meta.organizerUid,
      eventSlug: meta.eventSlug, assetType: meta.assetType, createdBy: meta.createdBy, chargeable,
      seed: { ...printJobSeed(meta, seeded.eventName), billing },
      quote: {
        eligible: seeded.eligible, previouslyBilled: seeded.eligible - chargeable, chargeable, unitPricePaise, priceSource,
        quoteHash: clientQuote?.quoteHash ?? null, quotedChargeable: clientQuote?.chargeable ?? null, quotedAt: clientQuote?.issuedAt ?? null,
      },
      request,
    })
  } catch (err) {
    await release(null)
    throw err
  }
  if (out.kind === 'lost') return IN_PROGRESS
  if (out.kind === 'insufficient') {
    return {
      ok: false, status: 402, code: 'INSUFFICIENT_BADGE_UNITS',
      error: `This job needs ${chargeable} ID badges; ${out.available} are available. Buy more to continue.`,
      quote: makeQuote(binding, { eligible: seeded.eligible, chargeable }, out.available, unitPricePaise, priceSource, nowMs),
    }
  }
  const job = await getPrintGenerationJob(jobId)
  if (!job) throw new Error('billed print job missing after create')
  return out.kind === 'exists' ? sameRequest(job) : { ok: true, job, existing: false }
}

/** The job document's payload — shared by the free and billed create paths. */
function printJobSeed(meta: CreatePrintJobMeta, eventName: string): Record<string, unknown> {
  return {
    organizerUid: meta.organizerUid,
    createdBy:    meta.createdBy,
    templateId:   meta.templateId,
    ...(meta.templateVersion ? { templateVersion: meta.templateVersion } : {}),
    ...(meta.templateVersionHash ? { templateVersionHash: meta.templateVersionHash } : {}),
    eventId:      meta.eventId,
    eventSlug:    meta.eventSlug,
    eventName,
    assetType:    meta.assetType,
    filters:      meta.filters,
  }
}

// ─── Strategy ────────────────────────────────────────────────────────────────────

interface PrintJobContext {
  renderDoc:     RenderDocument
  eventName:     string
  eventDate:     string
  eventLocation: string
  branding:      PublicBranding | null
  eventAssets:   EventPreviewAssets   // event logo/banner/sponsor URLs (once per chunk)
  // Per-chunk asset cache (STEP 7): each unique image URL downloaded once and the
  // bytes reused across every registration in this chunk. null = fetch failed.
  assetCache: Map<string, Uint8Array | null>
}

// Event logo/banner/sponsor image URLs, read once per chunk from the event draft.
// Reuses the SAME shape the designer preview injects, so image-source resolution is
// identical across designer / preview / generation.
// Format a stored ISO/date string for display on printed assets. Empty on failure.
function fmtPrintDate(raw: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Reads the event draft ONCE per chunk and derives BOTH the image asset URLs and the
// display date/location used by the {{eventDate}} / {{eventLocation}} tokens (GA-4 S2).
async function loadEventContext(
  organizerUid: string, draftId: string,
): Promise<{ assets: EventPreviewAssets; eventDate: string; eventLocation: string }> {
  const snap = await adminDb.doc(`users/${organizerUid}/eventDrafts/${draftId}`).get()
  const d = (snap.data() ?? {}) as Record<string, unknown>
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const media   = (details.media as Record<string, unknown>) ?? {}
  const typeDet = (details.typeDetails as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}
  const logo    = (media.logo as { value?: unknown })?.value
  const banner  = (media.coverBanner as { value?: unknown })?.value
  const sponsors = Array.isArray(typeDet.sponsors) ? typeDet.sponsors as Array<{ logoUrl?: unknown }> : []
  const sponsorLogo = sponsors.find(s => typeof s?.logoUrl === 'string' && s.logoUrl)?.logoUrl
  return {
    assets: {
      logoUrl:     typeof logo === 'string' ? logo : null,
      bannerUrl:   typeof banner === 'string' ? banner : null,
      sponsorLogo: typeof sponsorLogo === 'string' ? sponsorLogo : null,
    },
    eventDate:     fmtPrintDate(str(sched.startDate)),
    eventLocation: str(info.location) || str(info.venue) || str(info.city),
  }
}

function variablesFor(item: PrintCardFields, ctx: PrintJobContext): PrintVariableSources {
  const b = ctx.branding
  const base: PrintVariableSources = {
    registration: {
      name: item.name, email: item.email, phone: item.phone,
      ticket: item.ticketCode, id: item.registrationId,
      company: item.company, designation: item.designation, category: item.category,
      bibNumber: item.bibNumber,
    },
    event:  { name: ctx.eventName, date: ctx.eventDate, location: ctx.eventLocation },
    pass:   { label: item.passName, type: item.passName },
    system: { qr: item.qrValue },
    branding: b ? { logo: b.logoUrl, primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, company: b.companyName } : undefined,
    custom: item.formResponses,
  }
  // Inject event/sponsor image URLs via the SAME helper the preview uses → parity
  // for {{sponsorLogo}}, {{custom.eventLogo}}, {{custom.eventBanner}}, {{custom.background}}.
  return mergePreviewImageSources(base, ctx.eventAssets)
}

/** One unit of work: the item (metadata) + its LIVE registration, read with the page. */
interface PrintJobUnit {
  item: PrintJobItem
  reg:  RegistrationDocument | null
}

/**
 * Whether a LIVE registration may still receive this job's card. Same three rules the
 * seed applied (owner, event, credential eligibility) — re-checked at render time,
 * because a registration can be cancelled or refunded after the job was created.
 */
function printableRegistration(
  job: Pick<PrintGenerationJob, 'organizerUid' | 'eventSlug'>, reg: RegistrationDocument | null,
): string | null {
  if (!reg) return 'Registration no longer exists'
  if (reg.organizerUid !== job.organizerUid || reg.eventSlug !== job.eventSlug) return 'Registration no longer exists'
  if (printCredentialBlockReason(reg)) return 'Registration is no longer eligible for a credential'
  return null
}

/**
 * RD-PRINT-AUDIT · what may be STORED (item/run history) or returned for a card that failed.
 * Only text authored here passes through: the renderer's own RenderError messages (design /
 * layout validation — never attendee values) and the two eligibility refusals above. Any
 * other exception — e.g. a font or PDF library error that could quote the text it failed on —
 * becomes a fixed message, and the server log records only the error's type, never its text.
 */
const SAFE_CARD_REFUSALS = new Set(['Registration no longer exists', 'Registration is no longer eligible for a credential'])
export const CARD_RENDER_FAILED_MESSAGE = 'The card could not be rendered.'
export function safeCardError(err: unknown, context: string): string {
  if (err instanceof RenderError) return err.message.slice(0, 300)
  if (err instanceof Error && SAFE_CARD_REFUSALS.has(err.message)) return err.message
  console.error(`[print] ${context} failed`, { type: err instanceof Error ? err.name : typeof err })
  return CARD_RENDER_FAILED_MESSAGE
}

/** Reads registrations by id (≤ GETALL_CHUNK per call). Missing ids map to null. */
async function readRegistrations(ids: string[]): Promise<Map<string, RegistrationDocument | null>> {
  const out = new Map<string, RegistrationDocument | null>()
  const regs = adminDb.collection('registrations')
  for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
    const chunk = ids.slice(i, i + GETALL_CHUNK)
    if (!chunk.length) continue
    const snaps = await adminDb.getAll(...chunk.map(id => regs.doc(id)))
    for (const s of snaps) out.set(s.id, s.exists ? (s.data() as RegistrationDocument) : null)
  }
  return out
}

/** The download filename for a card. Built at download time from live data — never stored. */
function cardFilename(job: Pick<PrintGenerationJob, 'assetType'>, fields: PrintCardFields): string {
  const id = (fields.ticketCode || fields.registrationId).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${job.assetType.toLowerCase()}-${id}.pdf`
}

/** Render ONE card to PDF bytes, in memory. Never uploads, never persists. */
async function renderCard(
  job: PrintGenerationJob, ctx: PrintJobContext, registrationId: string, reg: RegistrationDocument,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const fields    = printCardFieldsFor(registrationId, reg, job.eventSlug)
  const variables = variablesFor(fields, ctx)
  // Prefetch this card's images into the shared cache (download-once), then render —
  // the renderer reads bytes ONLY from the map, never fetches.
  const map = buildVariableMap(variables)
  await ensurePrintAssets(collectImageSources(ctx.renderDoc, map), ctx.assetCache, job.organizerUid)
  const bytes = await renderToPdf({ document: ctx.renderDoc, variables, assets: ctx.assetCache })
  return { bytes, filename: cardFilename(job, fields) }
}

export function printGenerationStrategy(): JobStrategy<PrintGenerationJob, PrintJobContext, PrintJobUnit> {
  return {
    // Load + validate the layout ONCE per chunk (systemic failure fails the job).
    //
    // RD-PRINT-P1 — a pinned job renders its IMMUTABLE version, never the live template:
    // editing, re-sizing, renaming or deleting the template after the job was created
    // cannot change what it prints. Only a job created before versioning (no pin) still
    // renders the live template, exactly as it always did.
    async loadContext(job) {
      let doc: RenderDocument
      if (job.templateVersion) {
        const version = await getTemplateVersion(job.templateId, job.templateVersion)
        if (!version || version.organizerUid !== job.organizerUid) {
          return { ok: false, error: 'Pinned print template version not found' }
        }
        doc = normalizeDesign({ ...version.card }, version.design, {
          templateId: job.templateId, name: version.name, assetType: version.assetType,
        })
      } else {
        const template = await getPrintTemplate(job.templateId)
        if (!template || template.organizerUid !== job.organizerUid) {
          return { ok: false, error: 'Print template not found' }
        }
        doc = normalizeDesign(template.canvas, template.design, {
          templateId: template.id, name: template.name, assetType: template.assetType,
        })
      }
      const v = validateRenderDocument(doc)
      if (!v.ok) return { ok: false, error: v.error }
      // White-label branding + event image assets, resolved ONCE per chunk.
      const branding = await resolvePublicBranding(job.organizerUid).catch(() => null)
      const evt = await loadEventContext(job.organizerUid, job.eventId)
        .catch(() => ({ assets: {} as EventPreviewAssets, eventDate: '', eventLocation: '' }))
      return { ok: true, ctx: { renderDoc: v.document, eventName: job.eventName, eventDate: evt.eventDate, eventLocation: evt.eventLocation, branding, eventAssets: evt.assets, assetCache: new Map() } }
    },

    // Page the items by document id; resume from the persisted cursor. The page's LIVE
    // registrations are read alongside (one getAll), held in memory for this chunk only.
    async fetchPage(job, _ctx, cursor, limit): Promise<JobPage<PrintJobUnit>> {
      let q = itemsCol(job.jobId).orderBy(FieldPath.documentId())
      if (cursor) q = q.startAfter(cursor)
      const snap  = await q.limit(limit).get()
      const items = snap.docs.map(d => d.data() as PrintJobItem)
      const regs  = await readRegistrations(items.map(i => i.registrationId))
      return {
        items:      items.map(item => ({ item, reg: regs.get(item.registrationId) ?? null })),
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
        hasMore:    snap.size === limit,
      }
    },

    // Render IN MEMORY to prove the card renders, discard the bytes, record metadata
    // only. Idempotent: an item already rendered is skipped. A LEGACY item (rendered
    // undefined) is re-rendered in memory — its stored file is never read or rewritten.
    //
    // RD-PRINT-BILL-P5 — a paid / complimentary job does not write `rendered` itself: after the card
    // renders, claimBadgeForItem marks it rendered in the SAME transaction that bills the attendee
    // (or finds them already billed). A card that failed to render is never billed.
    async processItem({ item, reg }, job, ctx) {
      if (item.rendered === true) return { ok: true }
      const ref = itemsCol(job.jobId).doc(item.registrationId)
      const billed = billingOf(job) !== null
      // Fix 4 — a paid partial regenerate runs only the registrations it was accepted (and quoted) for.
      if (billed && Array.isArray(job.runScope) && !job.runScope.includes(item.registrationId)) return { ok: true, skipped: true }
      try {
        const refusal = printableRegistration(job, reg)
        if (refusal) throw new Error(refusal)
        await renderCard(job, ctx, item.registrationId, reg!)
        if (billed) {
          const claim = await claimBadgeForItem(job, item.registrationId)
          return claim.ok ? { ok: true } : { ok: false, error: claim.error }
        }
        await ref.update({ rendered: true, renderedAt: FieldValue.serverTimestamp(), error: null })
        return { ok: true }
      } catch (err) {
        const message = safeCardError(err, 'card generation')
        if (billed) await markBilledItemFailed(job.jobId, item.registrationId, message).catch(() => {})
        else await ref.update({ rendered: false, error: message }).catch(() => {})
        return { ok: false, error: message }
      }
    },
    // EA-4 S3: one grouped Notification-Center entry when generation finishes.
    async onComplete(job) {
      // RD-PRINT-BILL-P5 — settle the paid round: keep a unit per attendee billed, release the rest.
      // A failure here is retried by the print-generation cron sweep; it never fails the job.
      if (billingOf(job)?.mode === 'paid') {
        await settlePrintBadgeRound(job.jobId, 'completed').catch(err =>
          console.error('[print] badge round settlement deferred to the sweep', { jobId: job.jobId, type: err instanceof Error ? err.name : typeof err }))
      }
      const j = job as unknown as { organizerUid?: string; eventSlug?: string | null; eventName?: string | null }
      if (j.organizerUid) void notifyPrintJobComplete({
        workspaceUid: j.organizerUid, jobId: job.jobId, kind: 'generation',
        eventId: j.eventSlug ?? null, eventName: j.eventName ?? null,
        succeeded: job.counts.succeeded, failed: job.counts.failed,
      })
    },
  }
}

// ─── On-demand rendering (RD-PRINT-P0) ─────────────────────────────────────────────
//
// Every download renders the card(s) now, from the job's template and the LIVE
// registration, and returns the bytes in the response. Nothing is uploaded and nothing
// about the output is written anywhere.

export type CardRenderResult =
  | { ok: true;  bytes: Uint8Array; filename: string }
  | { ok: false; status: number; error: string }

/** The job's render context (template, branding, event assets) — or why it can't render. */
export async function loadPrintRenderContext(
  job: PrintGenerationJob,
): Promise<{ ok: true; ctx: PrintJobContext } | { ok: false; error: string }> {
  return printGenerationStrategy().loadContext(job)
}

/** Render one card of `job` for `registrationId`, in memory. The item must belong to the job. */
export async function renderPrintCard(job: PrintGenerationJob, registrationId: string): Promise<CardRenderResult> {
  const item = await getPrintJobItem(job.jobId, registrationId)
  if (!item) return { ok: false, status: 404, error: 'Asset not found in this job' }
  if (!isPrintItemReady(item)) return { ok: false, status: 409, error: 'Asset is not ready yet' }
  const loaded = await loadPrintRenderContext(job)
  if (!loaded.ok) return { ok: false, status: 422, error: loaded.error }
  const reg = (await readRegistrations([registrationId])).get(registrationId) ?? null
  const refusal = printableRegistration(job, reg)
  if (refusal) return { ok: false, status: 410, error: refusal }
  try {
    const card = await renderCard(job, loaded.ctx, registrationId, reg!)
    return { ok: true, ...card }
  } catch (err) {
    return { ok: false, status: 422, error: safeCardError(err, 'card download') }
  }
}

/**
 * Render several cards of `job` in memory, in the given order, refusing (413) as soon as
 * the byte budget would be exceeded. Used by the package (ZIP) download. Cards whose
 * registration is gone or no longer eligible are reported as skipped, not rendered.
 */
export async function renderPrintCards(
  job: PrintGenerationJob, registrationIds: string[], maxBytes: number,
): Promise<
  | { ok: true; cards: { registrationId: string; bytes: Uint8Array; filename: string }[]; skipped: { registrationId: string; reason: string }[] }
  | { ok: false; status: number; error: string }
> {
  const loaded = await loadPrintRenderContext(job)
  if (!loaded.ok) return { ok: false, status: 422, error: loaded.error }
  const cards: { registrationId: string; bytes: Uint8Array; filename: string }[] = []
  const skipped: { registrationId: string; reason: string }[] = []
  let total = 0
  for (let i = 0; i < registrationIds.length; i += GETALL_CHUNK) {
    const ids  = registrationIds.slice(i, i + GETALL_CHUNK)
    const regs = await readRegistrations(ids)
    for (const id of ids) {
      const reg = regs.get(id) ?? null
      const refusal = printableRegistration(job, reg)
      if (refusal) { skipped.push({ registrationId: id, reason: refusal }); continue }
      try {
        const card = await renderCard(job, loaded.ctx, id, reg!)
        total += card.bytes.length
        if (total > maxBytes) return { ok: false, status: 413, error: 'TOO_LARGE' }
        cards.push({ registrationId: id, ...card })
      } catch (err) {
        skipped.push({ registrationId: id, reason: safeCardError(err, 'package card') })
      }
    }
  }
  return { ok: true, cards, skipped }
}

/// ─── Print sheets (RD-PRINT-P2, shared with combined runs RD-PRINT-P3) ─────────────
//
// The job's cards laid out directly on A4/A3 paper — one PDF, rendered in memory from the
// job's PINNED template version (so its card size too) and the LIVE registrations, and
// returned to the caller. Nothing is stored. Measured limits (local, branded CR80 card
// with a logo, QR and full text, A4 3×3 + crop marks): ~6 KB and ~7 ms per card, 500
// cards ≈ 2.9 MB in ≈ 3.7 s with ≈ 0.45 GB of extra memory. A request above the card
// cap is refused BEFORE rendering; the byte cap is checked on the actual output and the
// time budget during rendering — every limit refuses, none truncates.

/** Most cards one sheet PDF may hold — checked before any rendering. */
export const PRINT_SHEET_MAX_CARDS = 500
/** Largest sheet PDF one response may carry — checked on the actual output. */
export const PRINT_SHEET_MAX_BYTES = 4 * 1024 * 1024
/** Rendering stops here, well inside the route's 60 s maxDuration. */
export const PRINT_SHEET_TIME_BUDGET_MS = 45_000

export type PrintSheetsResult =
  | { ok: true; bytes: Uint8Array; filename: string; cards: number; sheets: number; perSheet: number; skipped: number }
  | { ok: false; status: number; code: string; error: string; registrationIds?: string[] }

type SheetLimits = { maxBytes?: number; timeBudgetMs?: number }

/** The sheet layout for the job's PINNED card size, or the reason it cannot be laid out. */
async function sheetLayoutForJob(job: PrintGenerationJob, spec: SheetSpec) {
  const loaded = await loadPrintRenderContext(job)
  if (!loaded.ok) return { ok: false as const, status: 422, code: 'TEMPLATE_UNAVAILABLE', error: loaded.error }
  const c = loaded.ctx.renderDoc.canvas
  const placed = computeSheetLayout(cardSizeMm({ width: c.width, height: c.height, unit: c.unit, orientation: c.orientation }), spec)
  if (!placed.ok) return { ok: false as const, status: 422, code: placed.code, error: placed.error }
  return { ok: true as const, ctx: loaded.ctx, layout: placed.layout }
}

/**
 * The shared core: render exactly `ids` (in that order) onto sheets.
 *   mode 'skip'   — a registration that can no longer receive a card is left out and
 *                   counted (the single-download behaviour of RD-PRINT-P2).
 *   mode 'strict' — ANY such registration fails the whole call with REGISTRATION_CHANGED
 *                   and the ids, so a combined run never silently loses a card.
 */
async function renderCardsOnSheets(
  job: PrintGenerationJob, ids: string[], spec: SheetSpec, mode: 'skip' | 'strict', limits?: SheetLimits,
): Promise<
  | { ok: true; bytes: Uint8Array; cards: number; sheets: number; perSheet: number; skipped: number }
  | { ok: false; status: number; code: string; error: string; registrationIds?: string[] }
> {
  const maxBytes     = limits?.maxBytes ?? PRINT_SHEET_MAX_BYTES
  const timeBudgetMs = limits?.timeBudgetMs ?? PRINT_SHEET_TIME_BUDGET_MS
  if (ids.length > PRINT_SHEET_MAX_CARDS) {
    return {
      ok: false, status: 413, code: 'TOO_MANY_CARDS',
      error: `This selection has ${ids.length.toLocaleString('en-IN')} cards — one print-sheet download holds at most ${PRINT_SHEET_MAX_CARDS.toLocaleString('en-IN')}. Select fewer cards, or filter by pass or category.`,
    }
  }
  const sheet = await sheetLayoutForJob(job, spec)
  if (!sheet.ok) return sheet
  const { ctx, layout } = sheet

  const started = Date.now()
  const cards: PrintVariableSources[] = []
  const refused: string[] = []
  for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
    const chunk = ids.slice(i, i + GETALL_CHUNK)
    const regs  = await readRegistrations(chunk)
    for (const id of chunk) {
      const reg = regs.get(id) ?? null
      if (printableRegistration(job, reg)) { refused.push(id); continue }
      const variables = variablesFor(printCardFieldsFor(id, reg!, job.eventSlug), ctx)
      await ensurePrintAssets(collectImageSources(ctx.renderDoc, buildVariableMap(variables)), ctx.assetCache, job.organizerUid)
      cards.push(variables)
    }
  }
  if (mode === 'strict' && refused.length) {
    return {
      ok: false, status: 409, code: 'REGISTRATION_CHANGED', registrationIds: refused,
      error: `${refused.length} registration${refused.length === 1 ? ' was' : 's were'} cancelled, refunded or removed after this print run was planned. Plan the print run again.`,
    }
  }
  if (cards.length === 0) return { ok: false, status: 410, code: 'NO_CARDS', error: 'None of these registrations can receive a card any more.' }

  try {
    const { bytes, sheets } = await renderSheetsToPdf({
      document: ctx.renderDoc, cards, assets: ctx.assetCache, layout, deadline: started + timeBudgetMs,
    })
    if (bytes.length > maxBytes) {
      return {
        ok: false, status: 413, code: 'TOO_LARGE',
        error: `These print sheets are larger than one download allows (${Math.round(PRINT_SHEET_MAX_BYTES / 1048576)} MB). Select fewer cards.`,
      }
    }
    return { ok: true, bytes, cards: cards.length, sheets, perSheet: layout.perSheet, skipped: refused.length }
  } catch (err) {
    if (err instanceof SheetBudgetError) {
      return { ok: false, status: 503, code: 'TIME_BUDGET', error: 'Rendering these print sheets took too long. Select fewer cards and try again.' }
    }
    return { ok: false, status: 422, code: 'RENDER_FAILED', error: safeCardError(err, 'print sheets') }
  }
}

const sheetsFilename = (job: PrintGenerationJob, spec: SheetSpec, suffix = '') =>
  `${job.assetType.toLowerCase()}-${(job.eventSlug || 'event').replace(/[^A-Za-z0-9._-]/g, '_')}-${spec.paper.toLowerCase()}-sheets${suffix}.pdf`

/** The job's ready item ids, in the job's deterministic order (document id). */
export async function readyPrintItemIds(jobId: string): Promise<string[]> {
  return (await listPrintJobItems(jobId)).filter(isPrintItemReady).map(i => i.registrationId)
}

/**
 * Render the job's ready cards (all, or `registrationIds` — only ids that are items of
 * THIS job are used) onto print sheets, leaving out — and counting — any that can no
 * longer receive a card. The caller has authorized the request and checked ownership.
 */
export async function renderPrintSheets(
  job: PrintGenerationJob,
  opts: {
    spec: SheetSpec; registrationIds?: string[]
    /** Tests only — tighter limits to exercise the refusals. The route never passes this. */
    limits?: SheetLimits
  },
): Promise<PrintSheetsResult> {
  const wanted = opts.registrationIds && opts.registrationIds.length ? new Set(opts.registrationIds) : null
  const ids = (await readyPrintItemIds(job.jobId)).filter(id => !wanted || wanted.has(id))
  if (ids.length === 0) return { ok: false, status: 409, code: 'NO_CARDS', error: 'No generated cards match this selection.' }
  const out = await renderCardsOnSheets(job, ids, opts.spec, 'skip', opts.limits)
  if (!out.ok) return out
  return { ...out, filename: sheetsFilename(job, opts.spec) }
}

/**
 * RD-PRINT-P3 — render ONE batch of a combined print run: exactly `ids`, in order, STRICT
 * (a registration that changed since planning fails the batch rather than shrinking it).
 */
export async function renderPrintRunBatch(
  job: PrintGenerationJob, ids: string[], spec: SheetSpec, batchIndex: number, limits?: SheetLimits,
): Promise<PrintSheetsResult> {
  const out = await renderCardsOnSheets(job, ids, spec, 'strict', limits)
  if (!out.ok) return out
  return { ...out, filename: sheetsFilename(job, spec, `-part${batchIndex + 1}`) }
}

/**
 * RD-PRINT-P3 — plan a combined run: which of `ids` can receive a card now (in the given
 * order), which cannot (with the reason), the sheet layout, and per-card text-overflow
 * WARNINGS (the design is never changed). Reads registrations; renders nothing.
 */
export async function analyzePrintRunCards(
  job: PrintGenerationJob, ids: string[], spec: SheetSpec,
): Promise<
  | { ok: true; eligible: string[]; skipped: { registrationId: string; reason: string }[]; perSheet: number; overflow: { registrationId: string; elementId: string; kind: 'width' | 'height' }[] }
  | { ok: false; status: number; code: string; error: string }
> {
  const sheet = await sheetLayoutForJob(job, spec)
  if (!sheet.ok) return sheet
  const measure = await createTextMeasurer()
  const eligible: string[] = []
  const skipped: { registrationId: string; reason: string }[] = []
  const overflow: { registrationId: string; elementId: string; kind: 'width' | 'height' }[] = []
  for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
    const chunk = ids.slice(i, i + GETALL_CHUNK)
    const regs  = await readRegistrations(chunk)
    for (const id of chunk) {
      const reg = regs.get(id) ?? null
      const refusal = printableRegistration(job, reg)
      if (refusal) { skipped.push({ registrationId: id, reason: refusal }); continue }
      eligible.push(id)
      const variables = variablesFor(printCardFieldsFor(id, reg!, job.eventSlug), sheet.ctx)
      for (const o of analyzeTextOverflow(sheet.ctx.renderDoc, variables, measure)) overflow.push({ registrationId: id, ...o })
    }
  }
  return { ok: true, eligible, skipped, perSheet: sheet.layout.perSheet, overflow }
}

/** Advances one chunk of a print-generation job. Safe to call repeatedly (resumes). */
export function processPrintGenerationChunk(jobId: string): Promise<ProcessResult> {
  return runJobChunk(jobId, printGenerationStrategy(), {
    collection: PRINT_GENERATION_JOBS,
    pageSize:   PRINT_PAGE_SIZE,
    budgetMs:   PRINT_BUDGET_MS,
    leaseMs:    PRINT_LEASE_MS,
  })
}

export function getPrintGenerationJob(jobId: string): Promise<PrintGenerationJob | null> {
  return getJob<PrintGenerationJob>(PRINT_GENERATION_JOBS, jobId)
}

/** A single item (for the secure per-asset download route). */
export async function getPrintJobItem(jobId: string, registrationId: string): Promise<PrintJobItem | null> {
  const snap = await itemsCol(jobId).doc(registrationId).get()
  return snap.exists ? (snap.data() as PrintJobItem) : null
}

/** All items for a job (for the results list). */
export async function listPrintJobItems(jobId: string): Promise<PrintJobItem[]> {
  const snap = await itemsCol(jobId).orderBy(FieldPath.documentId()).get()
  return snap.docs.map(d => d.data() as PrintJobItem)
}

/**
 * Retry / regeneration (GA-4 S2) — REUSES the generic runner, no duplicate records.
 *
 *   • mode 'retry'      → re-drive the SAME job; items that already produced output
 *     are skipped (processItem no-ops), so only failed/missing items re-render.
 *   • mode 'regenerate' → mark the targeted items (all, or `registrationIds`) as not
 *     rendered, so they re-render — against the job's PINNED version (RD-PRINT-P1); to
 *     print a newer design, create a new job. Nothing is stored either way (RD-PRINT-P0);
 *     a LEGACY item's old
 *     `output` field is left exactly as it was — this never rewrites legacy records'
 *     file references — and is ignored by every reader.
 *
 * Resets only the generic job-control fields (status/cursor/counts/lease) and kicks
 * the first chunk. The per-item docs (identity/snapshot) are preserved.
 */
export async function reopenPrintGenerationJob(
  jobId: string,
  opts: {
    mode: 'retry' | 'regenerate'; registrationIds?: string[]
    /** RD-PRINT-BILL-P5 — only read for a PAID job: the caller, and the quote it confirmed. */
    isOwner?: boolean; callerUid?: string; quote?: unknown; nowMs?: number
  },
): Promise<{ ok: true } | { ok: false; error: string } | PrintBillingRefusal> {
  const job = await getPrintGenerationJob(jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  const now    = Date.now()
  const locked = job.lockedUntil instanceof Timestamp ? job.lockedUntil.toMillis() : 0
  if (job.status === 'processing' && locked > now) return { ok: false, error: 'Job is currently processing' }

  if (billingOf(job)?.mode === 'paid') return reopenPaidPrintJob(job, opts)

  // Regenerate: mark the targeted items not-rendered so they re-render. Only ids that
  // are items OF THIS JOB are touched — an unknown id is ignored rather than failing the
  // whole batch (batch.update on a missing doc throws).
  if (opts.mode === 'regenerate') {
    const all = (await listPrintJobItems(jobId)).map(i => i.registrationId)
    const ids = opts.registrationIds && opts.registrationIds.length
      ? [...new Set(opts.registrationIds)].filter(id => all.includes(id))
      : all
    const col = itemsCol(jobId)
    for (let i = 0; i < ids.length; i += 400) {
      const batch = adminDb.batch()
      for (let j = i; j < Math.min(i + 400, ids.length); j++) {
        batch.update(col.doc(ids[j]), { rendered: false, error: null })
      }
      await batch.commit()
    }
  }

  // Reset the generic control fields so the runner re-leases + re-pages from the start.
  await adminDb.collection(PRINT_GENERATION_JOBS).doc(jobId).update({
    status:             'pending',
    cursor:             null,
    lockedUntil:        null,
    error:              null,
    completedAt:        null,
    'counts.processed': 0,
    'counts.succeeded': 0,
    'counts.failed':    0,
    updatedAt:          FieldValue.serverTimestamp(),
  })

  await processPrintGenerationChunk(jobId)   // kick the first chunk (cron continues the rest)
  return { ok: true }
}

/** The items a reopen would re-render: regenerate's targets, or every card not ready (retry). */
async function reopenTargets(jobId: string, opts: { mode: 'retry' | 'regenerate'; registrationIds?: string[] }) {
  const items = await listPrintJobItems(jobId)
  const all = items.map(i => i.registrationId)
  if (opts.mode === 'regenerate') {
    const ids = opts.registrationIds && opts.registrationIds.length
      ? [...new Set(opts.registrationIds)].filter(id => all.includes(id))
      : all
    return { all, targets: ids, resets: ids }
  }
  return { all, targets: items.filter(i => !isPrintItemReady(i)).map(i => i.registrationId), resets: [] as string[] }
}

/**
 * RD-PRINT-BILL-P5 — reopening a PAID job. Attendees already billed re-render free (D2). While the
 * job's round is still OPEN, the run continues in it (its reservation already covers the job). Once
 * the round has SETTLED, unbilled targets need a new quote, the owner (D3) and enough units; they
 * are reserved into round n+1 in the same transaction that resets the job (store.reopenBilledJob).
 */
async function reopenPaidPrintJob(
  job: PrintGenerationJob,
  opts: { mode: 'retry' | 'regenerate'; registrationIds?: string[]; isOwner?: boolean; callerUid?: string; quote?: unknown; nowMs?: number },
): Promise<{ ok: true } | { ok: false; error: string } | PrintBillingRefusal> {
  const nowMs = opts.nowMs ?? Date.now()
  const billing = billingOf(job)!
  // RD-PRINT-P8 (W5) — a paid job is reopened only while its organizer is still a pilot organizer. A
  // job's billing mode is never changed in place: outside the pilot the organizer starts a NEW job,
  // which runs free. Unreadable / malformed pilot setting ⇒ refused (503), never assumed either way.
  // RD-PRINT-P8.3 — read FRESH (bypassing the 60-second configuration cache): a reopen can reserve a
  // new round, so a removed organizer is refused at once, never on a stale cached membership.
  const pilot = await readPrintBadgePilot({ fresh: true })
  if (!pilot.ok) return { ok: false, status: 503, code: 'BILLING_UNAVAILABLE', error: 'ID badge billing is temporarily unavailable. Try again shortly.' }
  if (!isPilotOrganizer(pilot, job.organizerUid)) {
    return { ok: false, status: 409, code: 'PILOT_REMOVED', error: 'This job used paid ID badges, which are no longer enabled for this organizer. Create a new print job instead — it will run free.' }
  }
  const { targets, resets } = await reopenTargets(job.jobId, opts)
  const billedIds = await claimedRegistrationIds(job.eventId, targets)
  const unbilled = targets.length - billedIds.size
  const roundSnap = await roundRef(job.jobId, billing.round).get()
  const settled = !roundSnap.exists || roundSnap.get('status') === 'settled'
  const chargeable = settled ? unbilled : 0

  const subject: QuoteSubject = {
    kind: 'reopen', jobId: job.jobId, round: billing.round + 1, mode: opts.mode, registrationIds: opts.registrationIds ?? [],
  }
  const binding = { workspaceUid: job.organizerUid, draftId: job.eventId, subject }
  const fresh = async () => makeQuote(binding, { eligible: targets.length, chargeable },
    (await readBadgeAvailability(job.eventId, job.organizerUid)).available, billing.unitPricePaise, null, nowMs)
  const clientQuote = parseClientQuote(opts.quote)
  if (chargeable > 0) {
    if (opts.isOwner !== true) {
      return { ok: false, status: 403, code: 'OWNER_REQUIRED', error: 'Only the workspace owner can re-run cards that use prepaid ID badges.' }
    }
    const check = checkQuote(clientQuote, binding, chargeable, nowMs)
    if (!check.ok) return { ok: false, status: 409, code: check.code, error: QUOTE_ERRORS[check.code], quote: await fresh() }
    const q = await fresh()
    if (q.shortfall > 0) {
      return { ok: false, status: 402, code: 'INSUFFICIENT_BADGE_UNITS', error: `This run needs ${q.chargeable} ID badges; ${q.available} are available. Buy more to continue.`, quote: q }
    }
  }

  // Fix 4 — a PARTIAL regenerate runs only its accepted targets: the units reserved for them can
  // never be taken by some other not-ready card of the job. Retry and a full regenerate run the job.
  const runScope = opts.mode === 'regenerate' && opts.registrationIds && opts.registrationIds.length ? targets : null

  const r = await reopenBilledJob({
    jobId: job.jobId, expectedRound: billing.round, expectSettled: settled, chargeable,
    createdBy: opts.callerUid ?? job.organizerUid,
    // Fix 3 — cards are reset only AFTER the reopen is accepted, while the job is held.
    holdMs: resets.length ? PRINT_LEASE_MS : 0, runScope,
    quote: chargeable > 0 ? {
      eligible: targets.length, previouslyBilled: billedIds.size, chargeable, unitPricePaise: billing.unitPricePaise, priceSource: null,
      quoteHash: clientQuote?.quoteHash ?? null, quotedChargeable: clientQuote?.chargeable ?? null, quotedAt: clientQuote?.issuedAt ?? null,
    } : null,
  })
  if (r.kind === 'busy') return { ok: false, error: 'Job is currently processing' }
  if (r.kind === 'changed') {
    return { ok: false, status: 409, code: 'BILLING_STATE_CHANGED', error: 'The job changed while it was being reopened. Try again.' }
  }
  if (r.kind === 'insufficient') {
    return { ok: false, status: 402, code: 'INSUFFICIENT_BADGE_UNITS', error: `This run needs ${chargeable} ID badges; ${r.available} are available. Buy more to continue.`, quote: await fresh() }
  }
  if (r.holdTag !== null) {
    // Accepted, and the job is held: reset the regenerate targets (only ids that are items of this
    // job), then hand the job to the workers.
    const col = itemsCol(job.jobId)
    for (let i = 0; i < resets.length; i += 400) {
      const batch = adminDb.batch()
      for (let j = i; j < Math.min(i + 400, resets.length); j++) batch.update(col.doc(resets[j]), { rendered: false, error: null })
      await batch.commit()
    }
    await releaseReopenHold(job.jobId, r.holdTag)
  }
  await processPrintGenerationChunk(job.jobId)   // kick the first chunk (cron continues the rest)
  return { ok: true }
}

// ─── Client-safe views (never a storage path or URL — legacy ones included) ──────

export interface PrintGenerationJobView {
  jobId:     string
  status:    JobStatus
  counts:    JobCounts
  error?:    string | null
  templateId: string
  /** RD-PRINT-P1 — the pinned template version; null for a job created before versioning. */
  templateVersion: number | null
  eventId:   string
  eventName: string
  assetType: PrintAssetType
  createdAt: string | null
  remaining: number
  /**
   * RD-PRINT-BILL-P6 — how this job bills ID badges: `mode` and the CURRENT billing `round`
   * (paid only; 0 for complimentary). Null for a free job (every job created without billing).
   */
  billing:   { mode: 'paid' | 'complimentary'; round: number } | null
}

export interface PrintJobItemView {
  registrationId: string
  name:      string          // from the LIVE registration (RD-PRINT-P0) — '' when it is gone
  ticketCode: string         // idem
  filename:  string | null
  ready:     boolean
  error:     string | null
  expiresAt: string | null   // always null since RD-PRINT-P0 — cards render on demand
  /** RD-PRINT-BILL-P6 — billed jobs only: 'new' (billed by this job), 'prior' (free reprint), 'complimentary'. */
  billed:    'new' | 'prior' | 'complimentary' | null
}

function toIso(v: unknown): string | null {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function toPrintJobView(job: PrintGenerationJob): PrintGenerationJobView {
  return {
    jobId:     job.jobId,
    status:    job.status,
    counts:    job.counts,
    error:     typeof job.error === 'string' ? job.error : null,
    templateId: job.templateId,
    templateVersion: typeof job.templateVersion === 'number' ? job.templateVersion : null,
    eventId:   job.eventId,
    eventName: job.eventName,
    assetType: job.assetType,
    createdAt: toIso(job.createdAt),
    remaining: Math.max(0, job.counts.total - job.counts.processed),
    billing:   jobBillingView(job),
  }
}

/** Only the two approved fields — never the request hash, quote, units or claims. */
function jobBillingView(job: PrintGenerationJob): PrintGenerationJobView['billing'] {
  const b = billingOf(job)
  return b ? { mode: b.mode, round: b.round } : null
}

/**
 * The client view of an item. Display fields come from the LIVE registration, never
 * from the item (a legacy item may still hold a stale copy — it is not read). The
 * legacy `output` (path + token URL) is never part of the view.
 */
export function toPrintItemView(item: PrintJobItem, reg: RegistrationDocument | null = null): PrintJobItemView {
  const ready = isPrintItemReady(item)
  const ticketCode = str(reg?.ticketCode)
  return {
    registrationId: item.registrationId,
    name:       str(reg?.attendee?.name),
    ticketCode,
    filename:   ready ? `${item.registrationId}.pdf` : null,
    ready,
    error:      typeof item.error === 'string' ? item.error : null,
    expiresAt:  null,
    billed:     item.billed === 'new' || item.billed === 'prior' || item.billed === 'complimentary' ? item.billed : null,
  }
}

/** Item views for a job, joined to the live registrations (display only). */
export async function listPrintJobItemViews(jobId: string): Promise<PrintJobItemView[]> {
  const items = await listPrintJobItems(jobId)
  const regs  = await readRegistrations(items.map(i => i.registrationId))
  return items.map(i => toPrintItemView(i, regs.get(i.registrationId) ?? null))
}
