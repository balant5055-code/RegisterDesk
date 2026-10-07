// Print Asset generation on the generic job runner (PA-4). Server-only.
//
// Background generation of individual print assets (badge / bib / pass / ID card /
// table tent …) — ONE PDF per registration. Execution is entirely the ROE generic
// runner (lib/jobs/runner): this module supplies only the four JobStrategy hooks.
//
// REUSE — nothing is redesigned or duplicated:
//   • Generic Job Runner (runJobChunk) → lease / cursor / resume / cancel / budget.
//   • Print Renderer (renderToPdf)      → unchanged; same pipeline as the preview.
//   • Print Template + normalize/validate + Variable Resolver (PA-3).
//   • Storage (uploadServerFile)        → one stored PDF per asset + token URL.
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
import {
  normalizeDesign, validateRenderDocument, renderToPdf, RenderError,
  buildVariableMap, collectImageSources, ensurePrintAssets,
  type RenderDocument, type PrintVariableSources,
} from '@/lib/printAssets/render'
import { notifyPrintJobComplete } from '@/lib/notifications/inbox/notify'
import { uploadServerFile } from '@/lib/firebase/storage/admin'
import { buildQrValue }     from '@/lib/tickets/generate'
import { resolvePublicBranding } from '@/lib/branding/service'
import type { PublicBranding } from '@/lib/branding/types'
import { mergePreviewImageSources, type EventPreviewAssets } from '@/lib/printAssets/designer/previewData'
import type { PrintAssetType } from '@/lib/printAssets/types'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { identifierRosterVisible, ROSTER_STATUSES } from '@/lib/identifiers/eligibility'
import { checkInBlockReason }      from '@/lib/registrations/checkinEligibility'

export const PRINT_GENERATION_JOBS = 'printGenerationJobs'

// Tunables — rendering is CPU-bound, so page size stays modest; the lease covers a
// slow page and the budget yields well before a serverless timeout.
const PRINT_PAGE_SIZE  = 10
const PRINT_BUDGET_MS  = 50_000
const PRINT_LEASE_MS   = 120_000
const EXPIRY_MS        = 24 * 60 * 60 * 1000   // download links valid for 24h

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
  eventId:    string
  eventSlug:  string
  eventName:  string
  assetType:  PrintAssetType
  filters:    PrintGenerationFilters
}

// One generated asset's stored output (path is NEVER exposed to the client).
export interface PrintItemOutput {
  path:        string
  filename:    string
  contentType: string
  expiresAt:   unknown   // Firestore Timestamp
  url:         string    // storage token URL — server-side only (download route redirects)
}

// items/{registrationId} — a per-registration snapshot taken at create time, plus
// the generation result. Snapshotting makes the job resume-stable and read-free.
export interface PrintJobItem {
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
  output?:        PrintItemOutput
  error?:         string
}

type PrintItemSeed = Omit<PrintJobItem, 'output' | 'error'>

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

/** The per-registration snapshot the job carries. Pure — no I/O. */
function buildPrintItemSeed(
  registrationId: string, r: RegistrationDocument, eventSlug: string,
): PrintItemSeed {
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
    return buildPrintItemSeed(id, r, eventSlug)
  }

  /** One page in ⇒ one batch out. Never more than SEED_PAGE_SIZE docs are held. */
  const flush = async (seeds: PrintItemSeed[]): Promise<void> => {
    if (!seeds.length) return
    const batch = adminDb.batch()
    for (const s of seeds) batch.set(col.doc(s.registrationId), s)
    await batch.commit()
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
      eventId:      meta.eventId,
      eventSlug:    meta.eventSlug,
      eventName,
      assetType:    meta.assetType,
      filters:      meta.filters,
    },
    total,
  )
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

function variablesFor(item: PrintJobItem, ctx: PrintJobContext): PrintVariableSources {
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

export function printGenerationStrategy(): JobStrategy<PrintGenerationJob, PrintJobContext, PrintJobItem> {
  return {
    // Load + validate the template ONCE per chunk (systemic failure fails the job).
    async loadContext(job) {
      const template = await getPrintTemplate(job.templateId)
      if (!template || template.organizerUid !== job.organizerUid) {
        return { ok: false, error: 'Print template not found' }
      }
      const doc = normalizeDesign(template.canvas, template.design, {
        templateId: template.id, name: template.name, assetType: template.assetType,
      })
      const v = validateRenderDocument(doc)
      if (!v.ok) return { ok: false, error: v.error }
      // White-label branding + event image assets, resolved ONCE per chunk.
      const branding = await resolvePublicBranding(job.organizerUid).catch(() => null)
      const evt = await loadEventContext(job.organizerUid, job.eventId)
        .catch(() => ({ assets: {} as EventPreviewAssets, eventDate: '', eventLocation: '' }))
      return { ok: true, ctx: { renderDoc: v.document, eventName: job.eventName, eventDate: evt.eventDate, eventLocation: evt.eventLocation, branding, eventAssets: evt.assets, assetCache: new Map() } }
    },

    // Page the items snapshot by document id; resume from the persisted cursor.
    async fetchPage(job, _ctx, cursor, limit): Promise<JobPage<PrintJobItem>> {
      let q = itemsCol(job.jobId).orderBy(FieldPath.documentId())
      if (cursor) q = q.startAfter(cursor)
      const snap = await q.limit(limit).get()
      return {
        items:      snap.docs.map(d => d.data() as PrintJobItem),
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
        hasMore:    snap.size === limit,
      }
    },

    // Resolve variables → render (PA-3) → upload (Storage). Idempotent: an item that
    // already produced output is skipped (no duplicate render, no duplicate upload);
    // the deterministic path also means any re-render overwrites in place.
    async processItem(item, job, ctx) {
      if (item.output) return { ok: true }
      try {
        const variables = variablesFor(item, ctx)
        // Prefetch this item's images into the shared per-chunk cache (download-once),
        // then render — the renderer reads bytes ONLY from the map, never fetches.
        const map = buildVariableMap(variables)
        await ensurePrintAssets(collectImageSources(ctx.renderDoc, map), ctx.assetCache, job.organizerUid)
        const bytes = await renderToPdf({ document: ctx.renderDoc, variables, assets: ctx.assetCache })
        const filename = `${job.assetType.toLowerCase()}-${item.ticketCode || item.registrationId}.pdf`
        const path     = `printAssets/${job.organizerUid}/${job.jobId}/${item.registrationId}.pdf`
        const { url }  = await uploadServerFile(path, bytes, 'application/pdf')

        const output: PrintItemOutput = {
          path, filename, contentType: 'application/pdf', url,
          expiresAt: Timestamp.fromMillis(Date.now() + EXPIRY_MS),
        }
        await itemsCol(job.jobId).doc(item.registrationId).update({ output, error: null })
        return { ok: true }
      } catch (err) {
        const message = err instanceof RenderError ? err.message
          : err instanceof Error ? err.message : 'generation failed'
        await itemsCol(job.jobId).doc(item.registrationId).update({ error: message.slice(0, 300) }).catch(() => {})
        return { ok: false, error: message }
      }
    },
    // EA-4 S3: one grouped Notification-Center entry when generation finishes.
    async onComplete(job) {
      const j = job as unknown as { organizerUid?: string; eventSlug?: string | null; eventName?: string | null }
      if (j.organizerUid) void notifyPrintJobComplete({
        workspaceUid: j.organizerUid, jobId: job.jobId, kind: 'generation',
        eventId: j.eventSlug ?? null, eventName: j.eventName ?? null,
        succeeded: job.counts.succeeded, failed: job.counts.failed,
      })
    },
  }
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
 *   • mode 'regenerate' → clear the stored output on the targeted items first (all,
 *     or `registrationIds`), so they re-render against the CURRENT template (i.e.
 *     after a template update). The output path is item-keyed, so a re-render
 *     OVERWRITES the same file — never a duplicate.
 *
 * Resets only the generic job-control fields (status/cursor/counts/lease) and kicks
 * the first chunk. The per-item docs (identity/snapshot) are preserved.
 */
export async function reopenPrintGenerationJob(
  jobId: string,
  opts: { mode: 'retry' | 'regenerate'; registrationIds?: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const job = await getPrintGenerationJob(jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  const now    = Date.now()
  const locked = job.lockedUntil instanceof Timestamp ? job.lockedUntil.toMillis() : 0
  if (job.status === 'processing' && locked > now) return { ok: false, error: 'Job is currently processing' }

  // Regenerate: drop the stored output (+ error) on the targeted items so they re-render.
  if (opts.mode === 'regenerate') {
    const ids = opts.registrationIds && opts.registrationIds.length
      ? opts.registrationIds
      : (await listPrintJobItems(jobId)).map(i => i.registrationId)
    const col = itemsCol(jobId)
    for (let i = 0; i < ids.length; i += 400) {
      const batch = adminDb.batch()
      for (let j = i; j < Math.min(i + 400, ids.length); j++) {
        batch.update(col.doc(ids[j]), { output: FieldValue.delete(), error: null })
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

// ─── Client-safe views (storage token URL + path stay server-side) ──────────────

export interface PrintGenerationJobView {
  jobId:     string
  status:    JobStatus
  counts:    JobCounts
  error?:    string | null
  templateId: string
  eventId:   string
  eventName: string
  assetType: PrintAssetType
  createdAt: string | null
  remaining: number
}

export interface PrintJobItemView {
  registrationId: string
  name:      string
  ticketCode: string
  filename:  string | null
  ready:     boolean
  error:     string | null
  expiresAt: string | null
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
    eventId:   job.eventId,
    eventName: job.eventName,
    assetType: job.assetType,
    createdAt: toIso(job.createdAt),
    remaining: Math.max(0, job.counts.total - job.counts.processed),
  }
}

export function toPrintItemView(item: PrintJobItem): PrintJobItemView {
  return {
    registrationId: item.registrationId,
    name:       item.name,
    ticketCode: item.ticketCode,
    filename:   item.output?.filename ?? null,
    ready:      !!item.output,
    error:      item.error ?? null,
    expiresAt:  item.output ? toIso(item.output.expiresAt) : null,
  }
}
